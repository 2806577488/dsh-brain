/**
 * 深月桌面脑：情绪层（dsh-mood）。
 *
 * **双向建模**：
 *   - `side: 'user'` = 用户此刻的状态：valence（心情值）/ energy（精力）；
 *   - `side: 'self'` = 助手自己的状态：valence / energy / affection（对用户的好感度）
 *     / status（一句短状态，如「专注」「心疼」「轻松」）。
 *
 * 存储：SQLite（`mood_state` + `mood_history` 表，见 `src/db.js`）。每轮先做**时间衰减**
 * （距上次更新超过 `moodDecayMinutes` 时按经过时长向基线部分回归，深夜 0–6 点额外压低
 * 精力与心情值），再按关键词规则小幅更新两侧；每侧保存心情轨迹（≤ `historyLimit` 条）。
 * 零模型调用。
 */

import path from 'node:path'

import { acquireDatabase } from './db.js'
import { analyzeUserText } from './signals.js'
import { clamp01 } from './store.js'

/** 情绪的两侧。 */
export const MOOD_SIDES = Object.freeze(['user', 'self'])

/** 基线：所有衰减都朝这里回归。 */
export const MOOD_BASELINE = Object.freeze({
  user: Object.freeze({ valence: 0.55, energy: 0.6 }),
  self: Object.freeze({ valence: 0.62, energy: 0.6, affection: 0.45 }),
})

/** 空白情绪（服务内部状态形状）。 */
export function emptyMoodState() {
  const now = new Date().toISOString()
  return {
    user: { valence: MOOD_BASELINE.user.valence, energy: MOOD_BASELINE.user.energy, updatedAt: now },
    self: {
      valence: MOOD_BASELINE.self.valence,
      energy: MOOD_BASELINE.self.energy,
      affection: MOOD_BASELINE.self.affection,
      status: '平静',
      updatedAt: now,
    },
  }
}

/** 由数值推出助手侧的短状态。 */
export function selfStatus({ valence, energy, affection, signals }) {
  if (signals?.frustrated === true) return '谨慎'
  if (signals?.tired === true || signals?.sad === true) return '心疼'
  if (signals?.thanks === true) return energy > 0.55 ? '轻松' : '被夸得有点不好意思'
  if (signals?.question === true) return '专注'
  if (signals?.work === true) return '专注'
  if (energy <= 0.35) return '疲惫'
  if (valence >= 0.72 && affection >= 0.6) return '愉快'
  if (valence <= 0.4) return '低落'
  return '平静'
}

/**
 * 时间衰减：按经过时长向基线部分回归，深夜再额外扣一点。
 * @param {{user: object, self: object}} state 当前两侧状态。
 * @param {number} now 当前时间戳。
 * @param {object} [options] 选项。
 */
export function applyMoodDecay(state, now, options = {}) {
  const decayMinutes = Number.isFinite(options.decayMinutes) ? options.decayMinutes : 120
  const deepEnergy = Number.isFinite(options.deepNightEnergyPenalty) ? options.deepNightEnergyPenalty : 0.05
  const deepValence = Number.isFinite(options.deepNightValencePenalty) ? options.deepNightValencePenalty : 0.02
  const reasons = { user: [], self: [] }
  const changed = { user: false, self: false }
  const hour = new Date(now).getHours()
  const deepNight = hour >= 0 && hour < 6

  function decaySide(side, baseline) {
    const current = state[side]
    const last = Date.parse(current?.updatedAt ?? '')
    if (!Number.isFinite(last)) return
    const elapsedMinutes = Math.max(0, (now - last) / 60000)
    if (elapsedMinutes < decayMinutes) {
      reasons[side].push('fresh')
      return
    }
    const ratio = Math.min(0.6, 0.15 + (elapsedMinutes / decayMinutes - 1) * 0.1)
    reasons[side].push('mood-decay')
    for (const key of Object.keys(baseline)) {
      const value = Number.isFinite(Number(current[key])) ? Number(current[key]) : baseline[key]
      const next = value + (baseline[key] - value) * ratio
      if (Math.abs(next - current[key]) > 1e-9) changed[side] = true
      current[key] = clamp01(next, baseline[key])
    }
    if (deepNight) {
      reasons[side].push('deep-night')
      current.energy = clamp01(current.energy - deepEnergy, baseline.energy)
      current.valence = clamp01(current.valence - deepValence, baseline.valence)
      changed[side] = true
    }
    if (changed[side]) current.updatedAt = new Date(now).toISOString()
    if (side === 'self') current.status = selfStatus({ ...current, signals: undefined })
  }

  decaySide('user', MOOD_BASELINE.user)
  decaySide('self', MOOD_BASELINE.self)
  return { state, changed: changed.user || changed.self, reasons, deepNight }
}

/**
 * 一轮情绪更新（纯函数）：先衰减、再按规则更新两侧。
 * @param {{user: object, self: object}} state 当前两侧状态（会被就地更新）。
 * @param {{userText: string, assistantText?: string}} input 本轮文本。
 * @param {object} [options] 选项。
 * @returns {{reasons: object, signals: object}}
 */
export function applyMoodRules(state, input, options = {}) {
  const now = options.now ?? Date.now()
  applyMoodDecay(state, now, options)
  const userText = String(input?.userText ?? '')
  const assistantText = String(input?.assistantText ?? '')
  const signals = analyzeUserText(userText)
  const reasons = { user: [...signals.ids], self: [] }
  const user = state.user
  const self = state.self
  const userBaseline = MOOD_BASELINE.user
  const selfBaseline = MOOD_BASELINE.self

  // user 侧：用户自己的状态。
  if (signals.tired) {
    user.energy -= 0.12
    user.valence -= 0.03
  }
  if (signals.frustrated) {
    user.valence -= 0.1
    user.energy -= 0.03
  }
  if (signals.joy) {
    user.valence += 0.08
    user.energy += 0.03
  }
  if (signals.thanks) {
    user.valence += 0.04
    user.energy += 0.01
  }
  if (signals.question) user.energy -= 0.01
  if (signals.longInput) user.energy -= 0.02
  if (signals.ids.length === 0) {
    user.valence += (userBaseline.valence - user.valence) * 0.05
    user.energy += (userBaseline.energy - user.energy) * 0.05
    reasons.user.push('resting')
  }

  // self 侧：助手自己的状态。
  if (signals.thanks) {
    self.affection += 0.06
    self.valence += 0.05
    reasons.self.push('thanks')
  }
  if (signals.frustrated) {
    self.valence -= 0.06
    self.affection -= 0.02
    self.energy -= 0.02
    reasons.self.push('user-frustrated')
  }
  if (signals.tired) {
    self.valence -= 0.01
    self.energy -= 0.03
    reasons.self.push('care')
  }
  if (signals.joy) {
    self.valence += 0.04
    reasons.self.push('shared-joy')
  }
  if (signals.question || signals.work) {
    self.energy -= 0.01
    reasons.self.push('answering')
  }
  if (assistantText.length > 200) self.energy -= 0.02
  if (signals.ids.length === 0) {
    self.valence += (selfBaseline.valence - self.valence) * 0.05
    self.energy += (selfBaseline.energy - self.energy) * 0.05
    self.affection += (selfBaseline.affection - self.affection) * 0.02
    reasons.self.push('resting')
  }
  // 一点点抖动，避免每轮数值完全相同。
  user.valence += (Math.random() - 0.5) * 0.008
  self.valence += (Math.random() - 0.5) * 0.008

  user.valence = clamp01(user.valence, userBaseline.valence)
  user.energy = clamp01(user.energy, userBaseline.energy)
  self.valence = clamp01(self.valence, selfBaseline.valence)
  self.energy = clamp01(self.energy, selfBaseline.energy)
  self.affection = clamp01(self.affection, selfBaseline.affection)
  self.status = selfStatus({ ...self, signals })
  user.updatedAt = new Date(now).toISOString()
  self.updatedAt = new Date(now).toISOString()
  return { reasons, signals }
}

/** DB 行 → 服务状态。 */
function rowsToState(rows) {
  const state = emptyMoodState()
  for (const row of rows) {
    if (row.side === 'user') {
      state.user = {
        valence: Number(row.valence),
        energy: Number(row.energy),
        updatedAt: row.updated_at ?? state.user.updatedAt,
      }
    } else if (row.side === 'self') {
      state.self = {
        valence: Number(row.valence),
        energy: Number(row.energy),
        affection: Number.isFinite(row.affection) ? Number(row.affection) : MOOD_BASELINE.self.affection,
        status: typeof row.status === 'string' && row.status.length > 0 ? row.status : '平静',
        updatedAt: row.updated_at ?? state.self.updatedAt,
      }
    }
  }
  return state
}

/** 一条心情轨迹（服务对象）。 */
function rowToHistory(row) {
  return {
    at: row.at,
    valence: Number(row.valence),
    energy: Number(row.energy),
    ...(row.side === 'self'
      ? {
          affection: Number.isFinite(row.affection) ? Number(row.affection) : undefined,
          status: typeof row.name === 'string' ? row.name : row.status,
        }
      : {}),
    reason: typeof row.reason === 'string' ? row.reason : '',
  }
}

/**
 * 创建情绪层服务（`brainMood`）。
 * @param {object} options 依赖。
 * @param {Readonly<import('./config.js').DEFAULT_MOOD_CONFIG>} options.config 归一化配置。
 * @param {(event: string, data?: Record<string, unknown>) => void} options.log 日志。
 * @param {string} options.dir 数据目录。
 */
export function createMoodService({ config, log, dir }) {
  const dbFile = typeof config.dbFile === 'string' && config.dbFile.trim().length > 0
    ? config.dbFile.trim()
    : path.join(dir, 'brain.db')
  let handle
  let closed = false
  let loaded = false

  function init() {
    handle = acquireDatabase({ dbFile, dataDir: dir, log })
    // 种子：两侧基线（已存在时保留）。
    handle
      .prepare(
        `INSERT OR IGNORE INTO mood_state(side, name, status, valence, affection, energy, updated_at)
         VALUES('user', NULL, NULL, ?, NULL, ?, ?)`,
      )
      .run(MOOD_BASELINE.user.valence, MOOD_BASELINE.user.energy, new Date().toISOString())
    handle
      .prepare(
        `INSERT OR IGNORE INTO mood_state(side, name, status, valence, affection, energy, updated_at)
         VALUES('self', NULL, '平静', ?, ?, ?, ?)`,
      )
      .run(
        MOOD_BASELINE.self.valence,
        MOOD_BASELINE.self.affection,
        MOOD_BASELINE.self.energy,
        new Date().toISOString(),
      )
    loaded = true
    log('mood-loaded', { dir, dbFile, user: service.current().user, self: service.current().self })
    return service
  }

  /** 从 DB 读两侧状态。 */
  function readState() {
    return rowsToState(handle.prepare('SELECT * FROM mood_state ORDER BY side').all())
  }

  /** 写入两侧状态（事务内）。 */
  function writeState(state) {
    handle
      .prepare(
        `INSERT INTO mood_state(side, name, status, valence, affection, energy, updated_at) VALUES('user', NULL, NULL, ?, NULL, ?, ?)
         ON CONFLICT(side) DO UPDATE SET valence = excluded.valence, energy = excluded.energy, updated_at = excluded.updated_at`,
      )
      .run(state.user.valence, state.user.energy, state.user.updatedAt)
    handle
      .prepare(
        `INSERT INTO mood_state(side, name, status, valence, affection, energy, updated_at) VALUES('self', NULL, ?, ?, ?, ?, ?)
         ON CONFLICT(side) DO UPDATE SET status = excluded.status, valence = excluded.valence,
           affection = excluded.affection, energy = excluded.energy, updated_at = excluded.updated_at`,
      )
      .run(state.self.status, state.self.valence, state.self.affection, state.self.energy, state.self.updatedAt)
  }

  /** 追加轨迹并裁剪。 */
  function appendHistory(state, reason) {
    handle
      .prepare('INSERT INTO mood_history(side, at, name, valence, affection, energy, reason) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run('user', state.user.updatedAt, null, state.user.valence, null, state.user.energy, reason)
    handle
      .prepare('INSERT INTO mood_history(side, at, name, valence, affection, energy, reason) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run('self', state.self.updatedAt, state.self.status, state.self.valence, state.self.affection, state.self.energy, reason)
    for (const side of MOOD_SIDES) {
      const count = Number(handle.prepare('SELECT COUNT(*) AS c FROM mood_history WHERE side = ?').get(side)?.c) || 0
      if (count > config.historyLimit) {
        handle
          .prepare(
            `DELETE FROM mood_history WHERE id IN (
               SELECT id FROM mood_history WHERE side = ? ORDER BY id ASC LIMIT ?
             )`,
          )
          .run(side, count - config.historyLimit)
      }
    }
  }

  /** 时间衰减（会落盘并记轨迹）。 */
  function applyTimeDecay(now = Date.now()) {
    const state = readState()
    const result = applyMoodDecay(state, now, {
      decayMinutes: config.moodDecayMinutes,
      deepNightEnergyPenalty: config.deepNightEnergyPenalty,
      deepNightValencePenalty: config.deepNightValencePenalty,
    })
    if (!result.changed) return { changed: false, ...service.current() }
    handle.transaction(() => {
      writeState(state)
      appendHistory(state, [...result.reasons.user, ...result.reasons.self].join('+'))
    })
    return { changed: true, ...service.current() }
  }

  /** 一轮更新：先衰减，再按规则更新两侧。 */
  function update(input) {
    const state = readState()
    const previousStatus = state.self.status
    const result = applyMoodRules(state, input, {
      now: Date.now(),
      decayMinutes: config.moodDecayMinutes,
      deepNightEnergyPenalty: config.deepNightEnergyPenalty,
      deepNightValencePenalty: config.deepNightValencePenalty,
    })
    const reason = [...result.reasons.user, ...result.reasons.self].join('+') || 'resting'
    handle.transaction(() => {
      writeState(state)
      appendHistory(state, reason)
    })
    if (previousStatus !== state.self.status) log('mood-status', { from: previousStatus, to: state.self.status })
    return { ...service.current(), reasons: result.reasons, signals: result.signals }
  }

  /** 采集器序号持久化读。 */
  function getLastSeq(sessionId) {
    const row = handle
      .prepare("SELECT last_seq FROM collector_state WHERE session_id = ? AND layer = 'mood'")
      .get(sessionId)
    return row === undefined ? undefined : Number(row.last_seq)
  }


    /** 读取待配对的用户消息（重载后可继续配对）。 */
  function getPending(sessionId) {
    const row = handle
      .prepare("SELECT user_text, seq FROM collector_pending WHERE session_id = ? AND layer = 'mood'")
      .get(sessionId)
    return row === undefined ? undefined : { text: row.user_text, seq: Number(row.seq) }
  }

  /** 持久化待配对的用户消息。 */
  function setPending(sessionId, pending) {
    handle
      .prepare(
        "INSERT INTO collector_pending(session_id, layer, user_text, seq, at) VALUES(?, 'mood', ?, ?, ?) " +
          "ON CONFLICT(session_id, layer) DO UPDATE SET user_text = excluded.user_text, seq = excluded.seq, at = excluded.at",
      )
      .run(sessionId, pending.text, pending.seq, pending.at ?? new Date().toISOString())
  }

  /** 清除待配对的用户消息。 */
  function clearPending(sessionId) {
    handle.prepare("DELETE FROM collector_pending WHERE session_id = ? AND layer = 'mood'").run(sessionId)
  }

  /** 采集器序号持久化写。 */
  function setLastSeq(sessionId, seq) {
    handle
      .prepare(
        `INSERT INTO collector_state(session_id, layer, last_seq, updated_at) VALUES(?, 'mood', ?, ?)
         ON CONFLICT(session_id, layer) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq), updated_at = excluded.updated_at`,
      )
      .run(sessionId, seq, new Date().toISOString())
  }

  const service = {
    name: 'dsh-mood',
    config,
    dir,
    dbFile,
    init,
    close() {
      closed = true
      if (handle !== undefined) handle.release()
      handle = undefined
    },
    /** 两侧当前状态。 */
    current() {
      const state = readState()
      return {
        user: { valence: state.user.valence, energy: state.user.energy, updatedAt: state.user.updatedAt },
        self: {
          valence: state.self.valence,
          energy: state.self.energy,
          affection: state.self.affection,
          status: state.self.status,
          updatedAt: state.self.updatedAt,
        },
      }
    },
    update,
    applyTimeDecay,
    /** 某一侧的心情轨迹（新→旧返回，与服务约定一致：按时间顺序）。 */
    history(side, limit = config.historyLimit) {
      const target = MOOD_SIDES.includes(side) ? side : 'user'
      if (limit <= 0) return []
      return handle
        .prepare('SELECT * FROM mood_history WHERE side = ? ORDER BY id DESC LIMIT ?')
        .all(target, limit)
        .map(rowToHistory)
        .reverse()
    },
    /** 快照。 */
    snapshot() {
      return {
        current: service.current(),
        history: {
          user: service.history('user', config.historyLimit),
          self: service.history('self', config.historyLimit),
        },
      }
    },
    /** 重置（默认把数据库备份成 `brain.db.bak-<ts>`，再清空情绪表）。 */
    reset(options = {}) {
      const backups = []
      if (options.backup !== false) {
        const backupFile = `${dbFile}.bak-${Date.now()}`
        try {
          handle.db.exec(`VACUUM INTO '${backupFile.replaceAll("'", "''")}'`)
          backups.push(backupFile)
        } catch (error) {
          log('db-backup-failed', { message: error?.message ?? String(error) })
        }
      }
      handle.transaction(() => {
        handle.db.exec('DELETE FROM mood_history')
        handle.prepare('DELETE FROM mood_state').run()
        handle.prepare("DELETE FROM collector_state WHERE layer = 'mood'").run(); handle.prepare("DELETE FROM collector_pending WHERE layer = 'mood'").run()
        const now = new Date().toISOString()
        handle
          .prepare(
            `INSERT INTO mood_state(side, name, status, valence, affection, energy, updated_at)
             VALUES('user', NULL, NULL, ?, NULL, ?, ?)`,
          )
          .run(MOOD_BASELINE.user.valence, MOOD_BASELINE.user.energy, now)
        handle
          .prepare(
            `INSERT INTO mood_state(side, name, status, valence, affection, energy, updated_at)
             VALUES('self', NULL, '平静', ?, ?, ?, ?)`,
          )
          .run(MOOD_BASELINE.self.valence, MOOD_BASELINE.self.affection, MOOD_BASELINE.self.energy, now)
      })
      log('mood-reset', { backups: backups.length })
      return { backups }
    },
    getLastSeq,
    setLastSeq,
    getPending,
    setPending,
    clearPending,
    /** 底层句柄（工具/测试只读）。 */
    handle() {
      return handle
    },
  }
  return service
}



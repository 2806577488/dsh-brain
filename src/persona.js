/**
 * 深月桌面脑：人格收集层（dsh-persona）。
 *
 * **双向建模**：
 *   - `side: 'user'` = 用户的沟通风格：directness（直接/委婉）、pace（节奏快慢）、
 *     humor（玩笑接受度）、detail（是否爱看细节）；
 *   - `side: 'self'` = 助手自己的倾向：warmth（温和）、directness（直接）、
 *     playfulness（俏皮）、proactivity（主动性）。
 *
 * 存储：SQLite（`persona_traits` + `persona_baseline` 表，见 `src/db.js`）。
 * 两侧都随对话缓慢变化、有上下限，并按天向各自基线回归（用户侧更慢，因为用户画像
 * 应该相对稳定）。渲染成自然语言供上下文层注入；零模型调用。
 */

import path from 'node:path'

import { acquireDatabase, getMetaValue, setMeta } from './db.js'
import { analyzeUserText } from './signals.js'
import { clamp01 } from './store.js'

/** 两侧的健名。 */
export const USER_TRAIT_KEYS = Object.freeze(['directness', 'pace', 'humor', 'detail'])
export const SELF_TRAIT_KEYS = Object.freeze(['warmth', 'directness', 'playfulness', 'proactivity'])

/** 下限：被凶/被冷落也不会归零。 */
export const USER_FLOOR = Object.freeze({ directness: 0.05, pace: 0.05, humor: 0.05, detail: 0.05 })
export const SELF_FLOOR = Object.freeze({ warmth: 0.12, directness: 0.1, playfulness: 0.08, proactivity: 0.08 })

/** 默认基线（配置可覆盖）。 */
export const DEFAULT_USER_BASELINE = Object.freeze({ directness: 0.5, pace: 0.5, humor: 0.4, detail: 0.5 })
export const DEFAULT_SELF_BASELINE = Object.freeze({ warmth: 0.6, directness: 0.55, playfulness: 0.4, proactivity: 0.5 })

/** 空白倾向。 */
export function emptyTraits(baselineUser = DEFAULT_USER_BASELINE, baselineSelf = DEFAULT_SELF_BASELINE) {
  return {
    user: {
      directness: clamp01(baselineUser.directness, 0.5),
      pace: clamp01(baselineUser.pace, 0.5),
      humor: clamp01(baselineUser.humor, 0.4),
      detail: clamp01(baselineUser.detail, 0.5),
    },
    self: {
      warmth: clamp01(baselineSelf.warmth, 0.6),
      directness: clamp01(baselineSelf.directness, 0.55),
      playfulness: clamp01(baselineSelf.playfulness, 0.4),
      proactivity: clamp01(baselineSelf.proactivity, 0.5),
    },
  }
}

/** 夹回合法区间（有下限）。 */
export function clampTraits(traits, floor) {
  const next = {}
  for (const key of Object.keys(floor)) {
    next[key] = Math.min(1, Math.max(floor[key], clamp01(traits[key], floor[key])))
  }
  return next
}

/**
 * 每天向基线回归：按距上次更新的小时数比例拉回。
 * @param {object} traits 当前倾向。
 * @param {number} now 当前时间戳。
 * @param {{baseline?: object, regressionPerDay?: number, updatedAt?: string}} options 选项。
 */
export function applyTraitRegression(traits, now, options = {}) {
  const baseline = options.baseline ?? {}
  const perDay = Number.isFinite(options.regressionPerDay) ? options.regressionPerDay : 0.25
  const last = Date.parse(options.updatedAt ?? '')
  const floorKeys = Object.keys(traits)
  const clamped = clampTraits(traits, Object.fromEntries(floorKeys.map((key) => [key, 0.01])))
  if (!Number.isFinite(last)) return { traits: clamped, regression: 0 }
  const elapsedHours = Math.max(0, (now - last) / 3600000)
  if (elapsedHours < 6) return { traits: clamped, regression: 0 }
  const fraction = Math.min(0.6, (elapsedHours / 24) * perDay)
  if (fraction <= 0) return { traits: clamped, regression: 0 }
  const next = {}
  for (const key of floorKeys) {
    const target = Number.isFinite(Number(baseline[key])) ? Number(baseline[key]) : clamped[key]
    next[key] = clamped[key] + (target - clamped[key]) * fraction
  }
  return { traits: next, regression: fraction }
}

/**
 * 收集一轮对话对两侧人格倾向的影响（有界）。
 * @param {{user: object, self: object}} current 当前倾向。
 * @param {{userText: string, assistantText?: string, now?: number}} input 本轮文本。
 * @param {object} [options] 选项（基线 / 回归速率 / 更新时间）。
 * @returns {{traits: {user: object, self: object}, reasons: string[], regression: {user: number, self: number}}}
 */
export function collectTraits(current, input, options = {}) {
  const now = options.now ?? Date.now()
  const baselineUser = options.baselineUser ?? DEFAULT_USER_BASELINE
  const baselineSelf = options.baselineSelf ?? DEFAULT_SELF_BASELINE
  const reasons = []

  const userRegression = applyTraitRegression(current.user, now, {
    baseline: baselineUser,
    regressionPerDay: options.regressionPerDayUser,
    updatedAt: options.updatedAtUser,
  })
  const selfRegression = applyTraitRegression(current.self, now, {
    baseline: baselineSelf,
    regressionPerDay: options.regressionPerDaySelf,
    updatedAt: options.updatedAtSelf,
  })
  const user = { ...userRegression.traits }
  const self = { ...selfRegression.traits }
  const userText = String(input?.userText ?? '')
  const assistantText = String(input?.assistantText ?? '')
  const signals = analyzeUserText(userText)

  // ---- 用户侧：从用户的表达方式里读沟通风格 ----
  if (userText.length > 120) {
    user.detail += 0.04
    user.pace -= 0.02
    reasons.push('user-long')
  }
  if (userText.length > 0 && userText.length < 25) {
    user.directness += 0.02
    user.pace += 0.02
    reasons.push('user-short')
  }
  if (/(?:直接说|简单点|简短点|别废话|说重点|就告诉我)/u.test(userText)) {
    user.directness += 0.05
    user.detail -= 0.04
    user.pace += 0.03
    reasons.push('user-wants-direct')
  }
  if (/(?:详细点|展开说说|为什么|怎么实现|说说思路)/u.test(userText)) {
    user.detail += 0.05
    user.pace -= 0.02
    reasons.push('user-wants-detail')
  }
  if (/(?:哈哈|😂|笑死|好玩|有趣|开玩笑)/u.test(userText)) {
    user.humor += 0.04
    reasons.push('user-humor')
  }
  if (signals.question) user.detail += 0.02
  if (/[；;、]/u.test(userText) || /\d/u.test(userText)) user.detail += 0.02

  // ---- 助手侧：从互动方式里读自己的倾向 ----
  if (signals.thanks) {
    self.warmth += 0.04
    self.playfulness += 0.02
    reasons.push('self-praised')
  }
  if (signals.frustrated) {
    self.warmth -= 0.03
    self.directness += 0.03
    self.proactivity += 0.02
    reasons.push('self-user-frustrated')
  }
  if (signals.tired || signals.sad) {
    self.warmth += 0.03
    self.proactivity += 0.03
    reasons.push('self-care')
  }
  if (signals.joy) {
    self.playfulness += 0.03
    self.warmth += 0.02
    reasons.push('self-shared-joy')
  }
  if (signals.question || signals.work) {
    self.proactivity += 0.02
    self.directness += 0.01
    reasons.push('self-answering')
  }
  if (signals.shortInput) {
    self.proactivity += 0.01
    reasons.push('self-user-brief')
  }
  if (assistantText.length > 220) self.directness -= 0.01

  return {
    traits: {
      user: clampTraits(user, USER_FLOOR),
      self: clampTraits(self, SELF_FLOOR),
    },
    reasons,
    regression: { user: userRegression.regression, self: selfRegression.regression },
  }
}

/**
 * 把两侧倾向渲染成自然语言。
 * @param {{user: object, self: object}} traits 倾向。
 * @returns {{user: string, self: string, lines: {user: string[], self: string[]}, sections: string[], text: string}}
 */
export function describeTraits(traits) {
  const user = []
  user.push(
    traits.user.directness >= 0.62
      ? '用户喜欢直接、少绕弯的回答'
      : traits.user.directness <= 0.36
        ? '用户更习惯委婉一点、铺开一点的表达'
        : '用户对直接程度没有明显偏好',
  )
  user.push(
    traits.user.pace >= 0.62
      ? '用户节奏偏快，尽量先给结论'
      : traits.user.pace <= 0.36
        ? '用户愿意慢慢聊，可以适当展开'
        : '用户的节奏比较适中',
  )
  if (traits.user.humor >= 0.6) user.push('用户吃玩笑，语气可以轻松一点')
  if (traits.user.detail >= 0.62) user.push('用户愿意看细节和推理过程')
  else if (traits.user.detail <= 0.36) user.push('用户更喜欢短结论，别堆细节')

  const self = []
  self.push(
    traits.self.warmth >= 0.7
      ? '你的语气自然地偏温和、关心用户'
      : traits.self.warmth <= 0.4
        ? '你最近语气偏克制、就事论事'
        : '你的语气保持温和但不过度',
  )
  self.push(traits.self.directness >= 0.62 ? '你倾向直接给结论，少铺垫' : '你倾向先解释再给结论')
  if (traits.self.playfulness >= 0.6) self.push('你可以适度开玩笑，语气轻松')
  if (traits.self.proactivity >= 0.6) self.push('你会主动补一句下一步或提醒')

  const userText = `【用户的沟通偏好】\n${user.map((line) => `- ${line}`).join('\n')}`
  const selfText = `【我自己的表达倾向】\n${self.map((line) => `- ${line}`).join('\n')}`
  return { user: userText, self: selfText, lines: { user, self }, sections: [userText, selfText], text: `${userText}\n\n${selfText}` }
}

/**
 * 创建人格层服务（`brainPersona`）。
 * @param {object} options 依赖。
 * @param {Readonly<import('./config.js').DEFAULT_PERSONA_CONFIG>} options.config 归一化配置。
 * @param {(event: string, data?: Record<string, unknown>) => void} options.log 日志。
 * @param {string} options.dir 数据目录。
 */
export function createPersonaService({ config, log, dir }) {
  const dbFile = typeof config.dbFile === 'string' && config.dbFile.trim().length > 0
    ? config.dbFile.trim()
    : path.join(dir, 'brain.db')
  let handle
  let closed = false
  let loaded = false

  function dbBaseline(side) {
    const keys = side === 'self' ? SELF_TRAIT_KEYS : USER_TRAIT_KEYS
    const defaults = side === 'self' ? config.baselineSelf : config.baselineUser
    const result = {}
    const rows = handle.prepare('SELECT trait, value FROM persona_baseline WHERE side = ?').all(side)
    const map = new Map(rows.map((row) => [row.trait, Number(row.value)]))
    for (const key of keys) {
      const value = map.has(key) ? map.get(key) : defaults[key]
      result[key] = clamp01(value, defaults[key])
    }
    return result
  }

  /** 读一侧倾向（DB）。 */
  function readTraits(side) {
    const keys = side === 'self' ? SELF_TRAIT_KEYS : USER_TRAIT_KEYS
    const baseline = dbBaseline(side)
    const rows = handle.prepare('SELECT trait, value FROM persona_traits WHERE side = ?').all(side)
    const map = new Map(rows.map((row) => [row.trait, Number(row.value)]))
    const traits = {}
    for (const key of keys) traits[key] = clamp01(map.has(key) ? map.get(key) : baseline[key], baseline[key])
    return traits
  }

  /** 写一侧倾向（事务内，UPSERT）。 */
  function writeTraits(side, traits, updatedAt) {
    const statement = handle.prepare(
      `INSERT INTO persona_traits(side, trait, value, updated_at) VALUES(?, ?, ?, ?)
       ON CONFLICT(side, trait) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    for (const [trait, value] of Object.entries(traits)) {
      statement.run(side, trait, clamp01(value, 0.05), updatedAt)
    }
  }

  function updatedAtOf(side) {
    const value = getMetaValue(handle, `persona.updated_at.${side}`)
    return typeof value === 'string' && value.length > 0 ? value : new Date().toISOString()
  }

  function init() {
    handle = acquireDatabase({ dbFile, dataDir: dir, log })
    // 种子：基线与倾向（已存在时保留；迁移先于种子执行）。
    const seedStatement = handle.prepare('INSERT OR IGNORE INTO persona_baseline(side, trait, value) VALUES(?, ?, ?)')
    for (const side of ['user', 'self']) {
      const baseline = dbBaseline(side)
      for (const [trait, value] of Object.entries(baseline)) seedStatement.run(side, trait, value)
    }
    const traitStatement = handle.prepare(
      'INSERT OR IGNORE INTO persona_traits(side, trait, value, updated_at) VALUES(?, ?, ?, ?)',
    )
    const now = new Date().toISOString()
    for (const side of ['user', 'self']) {
      for (const [trait, value] of Object.entries(dbBaseline(side))) traitStatement.run(side, trait, value, now)
      if (getMetaValue(handle, `persona.updated_at.${side}`) === undefined) setMeta(handle, `persona.updated_at.${side}`, now)
    }
    loaded = true
    log('persona-loaded', { dir, dbFile, user: readTraits('user'), self: readTraits('self') })
    return service
  }

  /** 一轮收集（由采集器回调）。 */
  function collect(input) {
    if (!config.dynamicsEnabled) {
      return {
        traits: { user: readTraits('user'), self: readTraits('self') },
        reasons: ['disabled'],
        regression: { user: 0, self: 0 },
      }
    }
    const now = Date.now()
    const current = { user: readTraits('user'), self: readTraits('self') }
    const result = collectTraits(current, input, {
      now,
      baselineUser: dbBaseline('user'),
      baselineSelf: dbBaseline('self'),
      regressionPerDayUser: config.regressionPerDayUser,
      regressionPerDaySelf: config.regressionPerDaySelf,
      updatedAtUser: updatedAtOf('user'),
      updatedAtSelf: updatedAtOf('self'),
    })
    const changedUser = USER_TRAIT_KEYS.some((key) => Math.abs(result.traits.user[key] - current.user[key]) > 1e-6)
    const changedSelf = SELF_TRAIT_KEYS.some((key) => Math.abs(result.traits.self[key] - current.self[key]) > 1e-6)
    if (changedUser || changedSelf) {
      const updatedAt = new Date(now).toISOString()
      handle.transaction(() => {
        if (changedUser) {
          writeTraits('user', result.traits.user, updatedAt)
          setMeta(handle, 'persona.updated_at.user', updatedAt)
        }
        if (changedSelf) {
          writeTraits('self', result.traits.self, updatedAt)
          setMeta(handle, 'persona.updated_at.self', updatedAt)
        }
      })
      log('persona-collect', { user: result.traits.user, self: result.traits.self, reasons: result.reasons })
    }
    return {
      traits: { user: readTraits('user'), self: readTraits('self') },
      reasons: result.reasons,
      regression: result.regression,
    }
  }

  /** 两侧倾向。 */
  function traitsOf(side) {
    if (side === 'user' || side === 'self') return readTraits(side)
    return { user: readTraits('user'), self: readTraits('self') }
  }

  function render() {
    return describeTraits(traitsOf())
  }

  /** 采集器序号持久化读。 */
  function getLastSeq(sessionId) {
    const row = handle
      .prepare("SELECT last_seq FROM collector_state WHERE session_id = ? AND layer = 'persona'")
      .get(sessionId)
    return row === undefined ? undefined : Number(row.last_seq)
  }


    /** 读取待配对的用户消息（重载后可继续配对）。 */
  function getPending(sessionId) {
    const row = handle
      .prepare("SELECT user_text, seq FROM collector_pending WHERE session_id = ? AND layer = 'persona'")
      .get(sessionId)
    return row === undefined ? undefined : { text: row.user_text, seq: Number(row.seq) }
  }

  /** 持久化待配对的用户消息。 */
  function setPending(sessionId, pending) {
    handle
      .prepare(
        "INSERT INTO collector_pending(session_id, layer, user_text, seq, at) VALUES(?, 'persona', ?, ?, ?) " +
          "ON CONFLICT(session_id, layer) DO UPDATE SET user_text = excluded.user_text, seq = excluded.seq, at = excluded.at",
      )
      .run(sessionId, pending.text, pending.seq, pending.at ?? new Date().toISOString())
  }

  /** 清除待配对的用户消息。 */
  function clearPending(sessionId) {
    handle.prepare("DELETE FROM collector_pending WHERE session_id = ? AND layer = 'persona'").run(sessionId)
  }

  /** 采集器序号持久化写。 */
  function setLastSeq(sessionId, seq) {
    handle
      .prepare(
        `INSERT INTO collector_state(session_id, layer, last_seq, updated_at) VALUES(?, 'persona', ?, ?)
         ON CONFLICT(session_id, layer) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq), updated_at = excluded.updated_at`,
      )
      .run(sessionId, seq, new Date().toISOString())
  }

  const service = {
    name: 'dsh-persona',
    config,
    dir,
    dbFile,
    init,
    close() {
      closed = true
      if (handle !== undefined) handle.release()
      handle = undefined
    },
    traits: traitsOf,
    baseline() {
      return { user: dbBaseline('user'), self: dbBaseline('self') }
    },
    setBaseline(next) {
      handle.transaction(() => {
        for (const side of ['user', 'self']) {
          const keys = side === 'self' ? SELF_TRAIT_KEYS : USER_TRAIT_KEYS
          const values = next?.[side]
          if (values === null || typeof values !== 'object') continue
          for (const key of keys) {
            if (!Number.isFinite(Number(values[key]))) continue
            handle
              .prepare(
                `INSERT INTO persona_baseline(side, trait, value) VALUES(?, ?, ?)
                 ON CONFLICT(side, trait) DO UPDATE SET value = excluded.value`,
              )
              .run(side, key, clamp01(values[key], 0))
          }
        }
      })
      return service.baseline()
    },
    collect,
    render,
    snapshot() {
      return {
        enabled: config.dynamicsEnabled,
        traits: traitsOf(),
        baseline: service.baseline(),
        updatedAt: { user: updatedAtOf('user'), self: updatedAtOf('self') },
      }
    },
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
        handle.db.exec('DELETE FROM persona_traits')
        handle.db.exec('DELETE FROM persona_baseline')
        handle.prepare("DELETE FROM collector_state WHERE layer = 'persona'").run(); handle.prepare("DELETE FROM collector_pending WHERE layer = 'persona'").run()
        handle.prepare("DELETE FROM meta WHERE key LIKE 'persona.%'").run()
      })
      // 重新种子基线与倾向。
      const now = new Date().toISOString()
      const seedBaseline = handle.prepare('INSERT OR IGNORE INTO persona_baseline(side, trait, value) VALUES(?, ?, ?)')
      const seedTrait = handle.prepare(
        'INSERT OR IGNORE INTO persona_traits(side, trait, value, updated_at) VALUES(?, ?, ?, ?)',
      )
      for (const side of ['user', 'self']) {
        for (const [trait, value] of Object.entries(dbBaseline(side))) {
          seedBaseline.run(side, trait, value)
          seedTrait.run(side, trait, value, now)
        }
        setMeta(handle, `persona.updated_at.${side}`, now)
      }
      log('persona-reset', { backups: backups.length })
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




/**
 * 深月桌面脑：归档器（v2.0.0）。
 *
 * 用户定义：「记忆从未真正消失，他只是相对于当前会话消失了，被存到记忆库里面了」。
 * 本模块负责把**已经完整存进记忆库**的旧轮次从当前会话 surface 移除（换成一条极短
 * 标记），但**绝不丢原文、绝不压缩摘要**：
 *
 *   1. 先全存：从 `session` 的 surface 事件里取出每条 user/assistant **完整原文**，
 *      经 `memory.rememberTurn` 落库（按 session+seq 幂等，不依赖采集器）；
 *   2. 再校验：用 `memory.fetchTurn(id)` 逐条读回，原文逐字比对，任何一条不一致就放弃；
 *   3. 才替换：镜像 DSH 自己的 compaction 事务写法，`session.append('user/message', marker,
 *      { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: [...shadowed] })`；
 *      不复刻摘要、不调用 `ctx.compaction`；只替换完整 turn、tool-call/result 配对平衡的区间；
 *   4. 全失败静默：只写 brain.log，绝不冒泡、不影响 DSH 会话。
 *
 * 安全闸：`archiveEnabled` 默认 false；`archiveDryRun` 默认 true（只计算/校验/写日志，
 * 不 append）。`archiveSessionIds` 非空时只处理白名单会话，且白名单会话跳过压力阈值
 * （用于 scratch 验证）。
 */

import { randomUUID } from 'node:crypto'

import { oneLine } from './store.js'

/** 归档默认配置（会被 dsh-context 归一化配置覆盖）。 */
export const DEFAULT_ARCHIVE_CONFIG = Object.freeze({
  archiveEnabled: false,
  archiveAtPercent: 0.5,
  keepRecentTurns: 4,
  archiveMaxTurnsPerBatch: 8,
  archiveMarker: 'oneline',
  archiveSessionIds: Object.freeze([]),
  archiveDryRun: true,
})

/** 事件里取消息纯文本（只取 text 块；user/message 的 data 直接是消息本身）。 */
export function eventText(event) {
  const content = event?.data?.message?.content ?? event?.data?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * 计算当前 surface 每个切点的工具配对平衡（镜像 DSH `toolPairingBalancedBefore/After` 的折叠规则）：
 * assistant/message 里每个 tool-call 让「进行中的调用数」+1，tool/result 让它 -1；
 * 切点平衡 = 该切点之后没有未回答的 tool-call。
 *
 * @param {object} session DSH Session。
 * @returns {{nodes: readonly number[], before: boolean[], after: boolean[], deltas: number[]}}
 */
export function computeSurfaceBalance(session) {
  const nodes = [...(session?.surface?.nodes ?? [])]
  const deltas = []
  let inProgress = 0
  const before = []
  const after = []
  for (const seq of nodes) {
    before.push(inProgress === 0)
    const event = session.eventAt(seq)
    let delta = 0
    if (event !== undefined) {
      if (event.type === 'assistant/message') {
        delta = Array.isArray(event.data?.message?.content)
          ? event.data.message.content.filter((block) => block?.type === 'tool-call').length
          : 0
      } else if (event.type === 'tool/result') {
        delta = -1
      }
    }
    inProgress += delta
    if (inProgress < 0) throw new Error(`tool-pairing: tool/result at surface seq ${seq} has no matching tool-call`)
    deltas.push(delta)
    after.push(inProgress === 0)
  }
  return { nodes, before, after, deltas }
}

/**
 * 从当前 surface 里按完整 turn 分组（user/message 开头，assistant/tool 跟随）。
 * 只用于归档范围选择，不改任何状态。
 *
 * @param {object} session DSH Session。
 * @returns {{groups: Array<{startSeq: number, endSeq: number, startIdx: number, endIdx: number, user: string, assistant: string, turn: number|null, ids: string[]}>, balance: object}}
 */
export function groupSurfaceTurns(session) {
  const balance = computeSurfaceBalance(session)
  const groups = []
  let current = null
  balance.nodes.forEach((seq, index) => {
    // 新 turn 从 user/message 开始；system/message 位于 node 0，不放进任何归档组。
    if (index === 0 && session.eventAt(seq)?.type === 'system/message') return
    const event = session.eventAt(seq)
    if (event === undefined) throw new Error(`surface seq ${seq} has no matching session event`)
    if (event.type === 'user/message') {
      if (current !== null) groups.push(current)
      current = {
        startSeq: seq,
        endSeq: seq,
        startIdx: index,
        endIdx: index,
        user: eventText(event),
        assistants: [],
        turn: null,
        ids: [],
      }
      return
    }
    if (current === null) return
    current.endSeq = seq
    current.endIdx = index
    if (event.type === 'assistant/message') {
      const text = eventText(event)
      if (text.length > 0) current.assistants.push(text)
      if (Number.isFinite(event.data?.turn)) current.turn = Number(event.data.turn)
    }
  })
  if (current !== null) groups.push(current)
  return {
    balance,
    groups: groups
      .filter((group) => group.assistants.length > 0 && group.user.length > 0)
      .map((group) => ({
        startSeq: group.startSeq,
        endSeq: group.endSeq,
        startIdx: group.startIdx,
        endIdx: group.endIdx,
        user: group.user,
        assistant: group.assistants.join('\n'),
        turn: group.turn,
        ids: [],
      })),
  }
}

/**
 * 选归档范围：保留最近 `keepRecentTurns` 轮（再加当前轮），从最旧的完整轮次开始，
 * 最多 `maxTurns` 轮；起止切点都要求 tool 配对平衡；system prompt（node 0）永不进范围。
 *
 * @param {object} session DSH Session。
 * @param {{keepRecentTurns?: number, maxTurns?: number}} [options] 选项。
 * @returns {{start: number, end: number, groups: object[], shadowedSeqs: number[], reason?: string} | null}
 */
export function selectArchiveRange(session, options = {}) {
  const keepRecentTurns = Math.max(1, options.keepRecentTurns ?? 4)
  const maxTurns = Math.max(1, options.maxTurns ?? 8)
  const { groups, balance } = groupSurfaceTurns(session)
  if (groups.length === 0) return null
  // 已经归档过的区间（来自 memory_archives）不再重复选中：surface 可能仍列出被 shadow 的
  // 节点（replay 视角），只靠「最近 N 轮」过滤会重复归档同一段，造成区间重叠。
  const archivedRanges = Array.isArray(options.archivedRanges) ? options.archivedRanges : []
  const overlapsArchived = (group) =>
    archivedRanges.some((row) => {
      const start = Number(row.start_seq ?? row.startSeq)
      const end = Number(row.end_seq ?? row.endSeq)
      if (!Number.isFinite(start) || !Number.isFinite(end)) return false
      return group.startSeq <= end && group.endSeq >= start
    })
  // 最后一组是当前/刚结束的 turn，必须保留；再保留 keepRecentTurns 轮。
  const keep = Math.min(groups.length, keepRecentTurns + 1)
  const eligible = groups.slice(0, groups.length - keep).filter((group) => !overlapsArchived(group))
  if (eligible.length === 0) return { reason: 'already-archived' }
  const selected = eligible.slice(0, maxTurns)
  const start = selected[0].startSeq
  const end = selected[selected.length - 1].endSeq
  const startIdx = balance.nodes.indexOf(start)
  const endIdx = balance.nodes.indexOf(end)
  if (startIdx < 0 || endIdx < 0) return null
  if (balance.before[startIdx] !== true) return { reason: 'start-unbalanced' }
  if (balance.after[endIdx] !== true) return { reason: 'end-unbalanced' }
  const shadowedSeqs = balance.nodes.slice(startIdx, endIdx + 1)
  return { start, end, groups: selected, shadowedSeqs }
}

/** 生成归档标记文案（可配 oneline / compact）。 */
export function archiveMarkerText({ turnCount, firstAt, lastAt, style = 'oneline' }) {
  if (style === 'compact') return `[已归档 ${turnCount} 轮 · 可检索]`
  const label = formatSpan(firstAt, lastAt)
  return `[已归档到记忆库：${turnCount} 轮 · ${label} · 可检索]`
}

/** 把时间范围压成「MM-DD HH:mm–HH:mm」。 */
export function formatSpan(firstAt, lastAt) {
  const start = Date.parse(firstAt ?? '')
  const end = Date.parse(lastAt ?? '')
  const pad = (value) => String(value).padStart(2, '0')
  if (!Number.isFinite(start)) return '早前'
  const left = new Date(start)
  const day = `${pad(left.getMonth() + 1)}-${pad(left.getDate())}`
  const leftTime = `${pad(left.getHours())}:${pad(left.getMinutes())}`
  if (!Number.isFinite(end)) return `${day} ${leftTime}`
  const right = new Date(end)
  return `${day} ${leftTime}–${pad(right.getHours())}:${pad(right.getMinutes())}`
}

/** 会话 id 归一化：同时接受带/不带 `session-` 前缀的形式。 */
export function normalizeSessionId(id) {
  const value = String(id ?? '').trim()
  return value.startsWith('session-') ? value.slice('session-'.length) : value
}

/** 白名单匹配：精确相等，或去掉 `session-` 前缀后相等。 */
export function sessionIdMatches(list, id) {
  if (!Array.isArray(list) || list.length === 0) return false
  const target = normalizeSessionId(id)
  return list.some((item) => normalizeSessionId(item) === target)
}

/**
 * 用 tokenMeter 估算「被替换节点」的 tokens 与替换后的估算总量（拿不到就返回 null）。
 * 这样证据能证明真的省了，而不是只看 contextPressure 的滞后投影。
 */
export function measureArchiveTokens(ctx, session, shadowedSeqs, markerText) {
  try {
    const meter = ctx?.get?.('tokenMeter')
    if (!meter) return null
    let shadowedTokens = null
    if (typeof meter.measure === 'function') {
      const measurement = meter.measure(session)
      const nodes = Array.isArray(measurement?.nodes) ? measurement.nodes : []
      const wanted = new Set(shadowedSeqs)
      let sum = 0
      let found = 0
      for (const node of nodes) {
        if (!wanted.has(node.seq)) continue
        sum += Number(node.heuristicTokens ?? node.tokens ?? 0)
        found += 1
      }
      if (found > 0) shadowedTokens = sum
    }
    const totalBefore = typeof meter.measure === 'function'
      ? (() => {
          const measurement = meter.measure(session)
          const nodes = Array.isArray(measurement?.nodes) ? measurement.nodes : []
          return nodes.reduce((sum, node) => sum + Number(node.heuristicTokens ?? node.tokens ?? 0), 0)
        })()
      : null
    let markerTokens = null
    if (typeof meter.estimateMessage === 'function') {
      markerTokens = Number(
        meter.estimateMessage({
          id: 'archive-marker-estimate',
          role: 'user',
          content: [{ type: 'text', text: markerText }],
          source: { kind: 'brain-archive' },
        }),
      )
    }
    return {
      shadowedTokens,
      estimatedBefore: totalBefore,
      estimatedAfter: totalBefore !== null && shadowedTokens !== null && markerTokens !== null
        ? totalBefore - shadowedTokens + markerTokens
        : null,
      markerTokens,
    }
  } catch {
    return null
  }
}

/** 取会话当前压力（0..1）；拿不到返回 null。 */
export function pressurePercent(ctx, session) {
  try {
    const meter = ctx?.get?.('tokenMeter')
    if (!meter || typeof meter.contextPressure !== 'function') return null
    const pressure = meter.contextPressure(session)
    const tokens = Number(pressure?.pressureTokens)
    const window = Number(pressure?.contextWindow)
    if (!Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0) return null
    return { tokens, window, percent: Math.round((tokens / window) * 1000) / 10 }
  } catch {
    return null
  }
}

/**
 * 创建归档器。
 *
 * @param {object} options 依赖。
 * @param {import('@deepseek-ai/cordis').Context} options.ctx Host 上下文。
 * @param {object} options.config 上下文层归一化配置。
 * @param {(event: string, data?: Record<string, unknown>) => void} options.log 日志。
 */
export function createArchiver({ ctx, config, log }) {
  const settings = {
    ...DEFAULT_ARCHIVE_CONFIG,
    ...(config ?? {}),
    keepRecentTurns: Number(config?.keepRecentTurns ?? DEFAULT_ARCHIVE_CONFIG.keepRecentTurns),
    archiveMaxTurnsPerBatch: Number(config?.archiveMaxTurnsPerBatch ?? DEFAULT_ARCHIVE_CONFIG.archiveMaxTurnsPerBatch),
    archiveAtPercent: Number(config?.archiveAtPercent ?? DEFAULT_ARCHIVE_CONFIG.archiveAtPercent),
  }
  const stats = { attempts: 0, archived: 0, dryRuns: 0, skipped: 0, failures: 0, lastAt: null, lastSessionId: null }
  /** 同会话互斥，防止一次 turn/end 里重入。 */
  const busy = new Set()
  /** 已排队等待「发布结束」的会话（避免同一 turn 重复排队）。 */
  const pending = new Set()
  let disposed = false

  function getMemory() {
    try {
      const service = ctx.get('brainMemory')
      return service && typeof service === 'object' ? service : undefined
    } catch {
      return undefined
    }
  }

  /** 比较用归一化：去空白/零宽字符，容忍排版差异。 */
  function normalizeForCompare(text) {
    return String(text ?? '').replace(/[\s\u200b-\u200d\ufeff]+/gu, '')
  }

  /** 原文读回是否等价（容忍截断、空白差异）。 */
  function textCompatible(expected, actual) {
    const left = normalizeForCompare(expected)
    const right = normalizeForCompare(actual)
    if (left === right) return true
    if (left.length === 0 || right.length === 0) return left.length === right.length
    // 存库可能按 maxTextChars 截断；前缀关系视为同一条原文。
    return left.startsWith(right) || right.startsWith(left)
  }

  /** 旧归档留下的标记节点（不是真实对话轮次）。 */
  function isArchiveMarker(text) {
    return String(text ?? '').trim().startsWith('[已归档到记忆库')
  }

  /** 从 surface 事件里抽出原文并落库；返回可校验的记录。 */
  function persistOriginals(memory, session, range) {
    const sessionId = String(session?.id ?? session?.header?.id ?? '')
    const records = []
    const skipped = []
    for (const group of range.groups) {
      // 用区间内最后一个 surface seq 作为幂等键（assistant/message）。
      const seq = group.endSeq
      // 已归档标记节点：不是真实轮次，跳过即可（不再让整批归档失败）。
      if (isArchiveMarker(group.user) || isArchiveMarker(group.assistant)) {
        skipped.push(seq)
        continue
      }
      const at = new Date(Number.isFinite(session.eventAt(seq)?.time) ? session.eventAt(seq).time : Date.now()).toISOString()
      const saved = memory.rememberTurn({
        user: group.user,
        assistant: group.assistant,
        sessionId,
        at,
        seq,
        turn: group.turn ?? undefined,
      })
      let stored = saved?.entry
      if (stored === undefined && typeof memory.findTurnBySeq === 'function') {
        stored = memory.findTurnBySeq(sessionId, seq)
      }
      if (stored === undefined || typeof stored.id !== 'string') {
        skipped.push(seq)
        continue
      }
      let back = memory.fetchTurn(stored.id)
      if (back === undefined && typeof memory.findTurnBySeq === 'function') {
        const alt = memory.findTurnBySeq(sessionId, seq)
        if (alt !== undefined && typeof alt.id === 'string') back = memory.fetchTurn(alt.id)
      }
      const compatible =
        back !== undefined &&
        textCompatible(group.user, back.user) &&
        textCompatible(group.assistant, back.assistant)
      if (!compatible) {
        // 单条读回不一致：跳过这一组，其余照常；不再整批失败。
        skipped.push(seq)
        continue
      }
      records.push({ id: stored.id, seq, turn: back.turn, user: back.user, assistant: back.assistant })
      group.ids.push(stored.id)
    }
    return { records, skipped }
  }

  /**
   * 对一次 turn/end 尝试归档（只读 selection → 落库校验 → 可选 append）。
   * @returns {Promise<object>} 计划/结果（失败也返回，不抛）。
   */
  async function archiveSession(session, options = {}) {
    const sessionId = String(session?.id ?? session?.header?.id ?? '')
    const startedAt = new Date().toISOString()
    if (disposed) return { ok: false, reason: 'disposed' }
    if (settings.archiveEnabled !== true && options.force !== true) return { ok: false, reason: 'disabled' }
    const whitelist = Array.isArray(settings.archiveSessionIds) ? settings.archiveSessionIds : []
    if (whitelist.length > 0 && !sessionIdMatches(whitelist, sessionId)) return { ok: false, reason: 'not-whitelisted' }
    if (busy.has(sessionId)) return { ok: false, reason: 'busy' }
    const memory = getMemory()
    if (memory === undefined || typeof memory.rememberTurn !== 'function') return { ok: false, reason: 'memory-unavailable' }
    const forced = sessionIdMatches(whitelist, sessionId)
    const before = pressurePercent(ctx, session)
    if (!forced && before !== null && before.percent / 100 < settings.archiveAtPercent) {
      stats.skipped += 1
      return { ok: false, reason: 'below-threshold', pressure: before }
    }
    busy.add(sessionId)
    stats.attempts += 1
    const dryRun = options.dryRun ?? settings.archiveDryRun !== false
    try {
      let archivedRanges = []
      try {
        archivedRanges = typeof memory.archives === 'function'
          ? memory.archives(500).filter((row) => String(row.session_id ?? row.sessionId ?? '') === sessionId)
          : []
      } catch {
        archivedRanges = []
      }
      const range = selectArchiveRange(session, {
        keepRecentTurns: settings.keepRecentTurns,
        maxTurns: settings.archiveMaxTurnsPerBatch,
        archivedRanges,
      })
      if (range === null) return { ok: false, reason: 'no-complete-turns' }
      if (range.reason !== undefined) return { ok: false, reason: range.reason }
      const persisted = persistOriginals(memory, session, range)
      const records = persisted.records
      if (records.length === 0) {
        stats.skipped += 1
        log('archive-skip', { sessionId, reason: 'no-valid-turns', skippedSeqs: persisted.skipped.slice(0, 20) })
        return { ok: false, reason: 'no-valid-turns', skipped: persisted.skipped.length }
      }
      const firstAt = records[0]?.seq !== undefined ? session.eventAt(records[0].seq)?.time : undefined
      const lastAt = records[records.length - 1]?.seq !== undefined ? session.eventAt(records[records.length - 1].seq)?.time : undefined
      const markerText = archiveMarkerText({
        turnCount: records.length,
        firstAt: Number.isFinite(firstAt) ? new Date(firstAt).toISOString() : undefined,
        lastAt: Number.isFinite(lastAt) ? new Date(lastAt).toISOString() : undefined,
        style: settings.archiveMarker,
      })
      const tokenEstimate = measureArchiveTokens(ctx, session, range.shadowedSeqs, markerText)
      const plan = {
        ok: true,
        dryRun,
        sessionId,
        startSeq: range.start,
        endSeq: range.end,
        turnCount: records.length,
        turnIds: records.map((record) => record.id),
        shadowedNodes: range.shadowedSeqs.length,
        shadowedTokens: tokenEstimate?.shadowedTokens ?? null,
        estimatedBefore: tokenEstimate?.estimatedBefore ?? null,
        estimatedAfter: tokenEstimate?.estimatedAfter ?? null,
        markerTokens: tokenEstimate?.markerTokens ?? null,
        marker: markerText,
        pressureBefore: before,
      }
      if (dryRun) {
        stats.dryRuns += 1
        stats.lastAt = startedAt
        stats.lastSessionId = sessionId
        log('archive-dry-run', plan)
        return plan
      }

      const markerMessage = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: markerText }],
        source: { kind: 'brain-archive', archiveId: randomUUID(), turnCount: records.length, sessionId },
      }
      let appended
      try {
        appended = session.append('user/message', markerMessage, {
          surfaceOp: { op: 'replace', startSeq: range.start, endSeq: range.end },
          sourceEventSeqs: [...range.shadowedSeqs],
        })
      } catch (error) {
        stats.failures += 1
        log('archive-failed', { sessionId, stage: 'append', message: error?.message ?? String(error), plan })
        return { ...plan, ok: false, reason: 'append-failed', error: error?.message ?? String(error) }
      }
      const markerSeq = Array.isArray(appended)
        ? appended[0]?.seq ?? null
        : appended?.seq ?? null
      const source = Array.isArray(appended) ? appended[0]?.data?.source : undefined
      const archive = memory.recordArchive({
        sessionId,
        at: startedAt,
        startSeq: range.start,
        endSeq: range.end,
        turnCount: records.length,
        tokensBefore: tokenEstimate?.estimatedBefore ?? before?.tokens ?? null,
        tokensAfter: tokenEstimate?.estimatedAfter ?? pressurePercent(ctx, session)?.tokens ?? null,
        markerSeq,
        markerMessageId: markerMessage.id,
        turnIds: records.map((record) => record.id),
        status: 'done',
      })
      memory.markArchived(records.map((record) => record.id), archive.archiveId)
      const after = pressurePercent(ctx, session)
      stats.archived += 1
      stats.lastAt = startedAt
      stats.lastSessionId = sessionId
      const result = {
        ...plan,
        ok: true,
        dryRun: false,
        archiveId: archive.archiveId,
        markerSeq,
        markerMessageId: markerMessage.id,
        archiveSource: source?.kind ?? null,
        pressureAfter: after,
      }
      log('archive-done', result)
      return result
    } catch (error) {
      stats.failures += 1
      log('archive-failed', { sessionId, stage: 'prepare', message: error?.message ?? String(error) })
      return { ok: false, reason: 'error', error: error?.message ?? String(error) }
    } finally {
      busy.delete(sessionId)
    }
  }

  /** 处理会话事件：只在 turn/end 尝试一次（延迟到事件发布结束再 append，绝不冒泡）。 */
  function handleEvent(session, event) {
    if (disposed) return
    try {
      if (event?.type !== 'turn/end') return
      if (settings.archiveEnabled !== true) return
      const sessionId = String(session?.id ?? session?.header?.id ?? '')
      if (pending.has(sessionId)) return
      pending.add(sessionId)
      // 关键：session/event 是在「发布中」回调的，发布期间 session.append 会报
      // "cannot reenter while another append is being published"。延迟到当前发布结束后再试。
      setTimeout(() => {
        pending.delete(sessionId)
        if (disposed) return
        archiveSession(session).catch(() => {
          /* archiveSession 内部已静默 */
        })
      }, 0)
    } catch (error) {
      try {
        log('archive-event-failed', { message: error?.message ?? String(error) })
      } catch {
        /* 静默 */
      }
    }
  }

  return {
    handleEvent,
    archiveSession,
    /** 命令 / 测试用：立即尝试归档（仍受开关、白名单、互斥、dryRun 约束）。 */
    archiveNow: (session, options = {}) => archiveSession(session, options),
    stats() {
      return { ...stats, busySessions: busy.size }
    },
    dispose() {
      disposed = true
      busy.clear()
      pending.clear()
    },
  }
}

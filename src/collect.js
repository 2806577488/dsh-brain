/**
 * 深月桌面脑：DSH 会话事件采集。
 *
 * 监听 Host 事件 `'session/event'`（post-commit 只读投递），把「一轮用户消息 +
 * 对应助手回复」配对后交给各层（记忆 / 情绪 / 人格）。硬要求：
 *   1. **绝不影响 DSH**：监听回调同步 try/catch，任何后续处理都放到脱离的
 *      Promise 里做，失败只写 brain.log，绝不抛回事件总线；
 *   2. **幂等 + 可恢复**：每会话持久化 `(session_id, layer).last_seq`；用户消息在
 *      等助手回复期间也写入 `collector_pending`，插件重载/DSH 重启后下一轮助手回复
 *      仍能配对（不会丢人类消息）；
 *   3. **可诊断**：`collect-filtered` 每会话前 3 条 + 每 200 条汇总；`collect-skip`
 *      记录跳过原因（不落消息内容，只落 sessionId/seq/type/原因/长度/字数），
 *      默认开启，便于排查「为什么没采到」；
 *   4. **过滤**：默认跳过 subagent 子会话、按 `excludeSessionIdPattern` /
 *      `includeSessions` 过滤会话、跳过合成的 runtime-context 注入消息，
 *      并把超长消息截断到 `maxTextChars`。
 *   5. **角色隔离（v2.1.0）**：按 message 的 role / source.kind + 文本特征判定
 *      user / assistant / system；系统/工具文本不配成 turn、永不进 user 侧，
 *      只在 `includeSystemEvents: true` 时落 `memory_events`。
 */

import { classifyMessage, looksSystemText } from './roles.js'
import { oneLine } from './store.js'

/** 从消息内容块里抽纯文本（只取 text 块，忽略图片 / 工具调用）。 */
export function extractMessageText(message) {
  if (message === null || message === undefined || typeof message !== 'object') return ''
  const content = message.content
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
 * 是否是「用户侧输入」（真人 / 或显式允许的子代理消息）。
 *
 * v2.1.0 起统一走 `src/roles.js` 的 role/source 判定：system / developer / runtime-context /
 * agent-message（未开启 collectSubagents 时）等一律不是用户侧。
 */
export function isUserAuthored(message, config = {}) {
  return classifyMessage(message, config) === 'user'
}

/**
 * 判断文本是否像系统/插件合成的上下文注入。
 * v2.1.0 起与历史清洗、召回过滤共用 `roles.js` 的同一套特征。
 */
export function looksSynthetic(text) {
  return looksSystemText(text)
}

/** 正则安全编译：非法正则退化成字面量包含判断。 */
function matchesPattern(value, pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) return false
  try {
    return new RegExp(pattern, 'u').test(value)
  } catch {
    return value.includes(pattern)
  }
}

/**
 * 是否采集这个会话。
 * @param {{id?: string, header?: object}} session DSH Session。
 * @param {{collectSubagents: boolean, excludeSessionIdPattern: string, includeSessions: readonly string[]}} config 采集配置。
 * @returns {{include: boolean, reason: string}}
 */
export function sessionIncluded(session, config) {
  const header = session?.header ?? {}
  const id = String(session?.id ?? header.id ?? '')
  if (header.origin === 'subagent' || header.parentSession !== undefined || Number(header.delegationDepth) > 0) {
    return config.collectSubagents ? { include: true, reason: 'subagent-allowed' } : { include: false, reason: 'subagent' }
  }
  if (Array.isArray(config.includeSessions) && config.includeSessions.length > 0) {
    const included = config.includeSessions.some((pattern) => matchesPattern(id, pattern))
    if (!included) return { include: false, reason: 'not-in-include-list' }
    return { include: true, reason: 'included' }
  }
  if (matchesPattern(id, config.excludeSessionIdPattern)) return { include: false, reason: 'excluded-pattern' }
  if (matchesPattern(String(header.cwd ?? ''), config.excludeSessionIdPattern)) {
    return { include: false, reason: 'excluded-cwd-pattern' }
  }
  return { include: true, reason: 'default' }
}

/** 截断并校验一条消息文本；不合格返回 undefined。 */
export function admitText(rawText, config) {
  const text = String(rawText ?? '').trim()
  if (text.length < config.minTextChars) return undefined
  return text.length <= config.maxTextChars ? text : text.slice(0, config.maxTextChars)
}

/** 每会话 / 每原因的限流日志计数器。 */
function createRateLimiter() {
  const counters = new Map()
  const keyOf = (sessionId, reason) => `${sessionId}\u0000${reason}`
  return {
    /** 前 `first` 条 + 每 `every` 条汇总 1 条；返回 {shouldLog, count}。 */
    hit(sessionId, reason, first = 3, every = 200) {
      const key = keyOf(sessionId, reason)
      const count = (counters.get(key) ?? 0) + 1
      counters.set(key, count)
      const shouldLog = count <= first || count % every === 0
      return { shouldLog, count }
    },
    snapshot() {
      return Object.fromEntries(counters)
    },
  }
}

/**
 * 创建采集器：把 DSH 会话事件配对成 turn，回调给某一层。
 *
 * @param {object} options 依赖。
 * @param {import('@deepseek-ai/cordis').Context} options.ctx Host 上下文。
 * @param {object} options.config 本层采集配置。
 * @param {(event: string, data?: Record<string, unknown>) => void} options.log 日志。
 * @param {(turn: {user: string, assistant: string, sessionId: string, at: string, seq: number}) => void} options.onTurn 一轮完成后的回调。
 * @param {(sessionId: string) => number | undefined} [options.getLastSeq] 读取已处理的最后序号。
 * @param {(sessionId: string, seq: number) => void} [options.setLastSeq] 记录已处理的最后序号。
 * @param {(sessionId: string) => {text: string, seq: number} | undefined} [options.getPending] 读取待配对的用户消息。
 * @param {(sessionId: string, pending: {text: string, seq: number, at: string}) => void} [options.setPending] 持久化待配对用户消息。
 * @param {(sessionId: string) => void} [options.clearPending] 清除待配对用户消息。
 * @param {(event: {sessionId: string, seq: number, at: string, kind: string, text: string, meta?: object}) => void} [options.onSystemEvent] 系统/工具事件回调（只在 includeSystemEvents 时调用）。
 */
export function createCollector({ ctx, config, log, onTurn, onSystemEvent, getLastSeq, setLastSeq, getPending, setPending, clearPending }) {
  /** 每个会话的内存待配对用户消息（DB 为持久化兜底）。 */
  const pending = new Map()
  /** 每个会话已处理到的事件序号（内存高水位）。 */
  const highWater = new Map()
  const limiter = createRateLimiter()
  let disposed = false
  const stats = { collected: 0, events: 0, filtered: 0, skipped: 0, skippedByReason: {}, filteredByReason: {} }

  /** 跳过日志（默认开启；不落消息内容，只落原因与长度）。 */
  function logSkip(sessionId, event, reason, extra = {}) {
    stats.skipped += 1
    stats.skippedByReason[reason] = (stats.skippedByReason[reason] ?? 0) + 1
    const { shouldLog, count } = limiter.hit(sessionId, `skip:${reason}`, 3, 200)
    if (!shouldLog) return
    log('collect-skip', {
      sessionId,
      seq: Number.isFinite(event?.seq) ? event.seq : null,
      type: typeof event?.type === 'string' ? event.type : null,
      reason,
      count,
      ...extra,
    })
  }

  /** 过滤日志（每会话前 3 条 + 每 200 条汇总）。 */
  function logFiltered(sessionId, reason) {
    stats.filtered += 1
    stats.filteredByReason[reason] = (stats.filteredByReason[reason] ?? 0) + 1
    const { shouldLog, count } = limiter.hit(sessionId, `filtered:${reason}`, 3, 200)
    if (!shouldLog) return
    log('collect-filtered', { sessionId, reason, count })
  }

  /** 读出该会话的持久化序号（首次时从数据层取）。 */
  function lastSeqOf(sessionId) {
    if (highWater.has(sessionId)) return highWater.get(sessionId)
    const stored = typeof getLastSeq === 'function' ? Number(getLastSeq(sessionId)) : Number.NaN
    const value = Number.isFinite(stored) ? stored : -1
    highWater.set(sessionId, value)
    return value
  }

  /** 读待配对用户消息：内存优先，其次 DB（重载/重启后可续）。 */
  function pendingOf(sessionId) {
    if (pending.has(sessionId)) return pending.get(sessionId)
    const stored = typeof getPending === 'function' ? getPending(sessionId) : undefined
    if (stored !== undefined && stored !== null && typeof stored.text === 'string' && stored.text.length > 0) {
      const value = { text: stored.text, seq: Number(stored.seq) }
      pending.set(sessionId, value)
      return value
    }
    return undefined
  }

  /** 记住待配对用户消息并落库。 */
  function rememberPending(sessionId, text, seq) {
    pending.set(sessionId, { text, seq })
    try {
      setPending?.(sessionId, { text, seq, at: new Date().toISOString() })
    } catch (error) {
      log('collect-pending-failed', { sessionId, message: error?.message ?? String(error) })
    }
  }

  /** 清掉待配对用户消息。 */
  function dropPending(sessionId) {
    pending.delete(sessionId)
    try {
      clearPending?.(sessionId)
    } catch {
      /* 清理失败不影响主流程 */
    }
  }

  /** 处理一条事件（同步；绝不抛出）。 */
  function handleEvent(session, event) {
    if (disposed) return
    try {
      if (event === null || typeof event !== 'object') {
        log('collect-skip', { sessionId: null, reason: 'not-an-event', type: null, seq: null })
        return
      }
      const sessionId = String(session?.id ?? session?.header?.id ?? '')
      if (sessionId.length === 0) {
        logSkip('(none)', event, 'empty-session-id')
        return
      }
      const included = sessionIncluded(session, config)
      if (!included.include) {
        logFiltered(sessionId, included.reason)
        return
      }
      if (typeof event.seq !== 'number' || !Number.isFinite(event.seq)) {
        logSkip(sessionId, event, 'invalid-seq')
        return
      }
      const last = lastSeqOf(sessionId)
      if (event.seq <= last) {
        logSkip(sessionId, event, 'seq-already-processed', { lastSeq: last })
        return
      }

      if (event.type === 'user/message') {
        const message = event.data
        const rawText = extractMessageText(message)
        const length = rawText.length
        const role = classifyMessage(message, config)
        // v2.1.0 角色隔离：role 判定为 system，或“用户 role”但文本是运行时注入块，
        // 都不进 user 侧；只在 includeSystemEvents 时落 memory_events。
        const system = role === 'system' || (role === 'user' && looksSynthetic(rawText))
        if (system) {
          recordSystemEvent(sessionId, event, 'system', rawText, {
            sourceKind: message?.source?.kind ?? null,
            role: message?.role ?? null,
            classifiedRole: role,
          })
          logSkip(sessionId, event, role === 'assistant' ? 'assistant-on-user-event' : 'system-source', {
            length,
            sourceKind: message?.source?.kind ?? null,
          })
          return
        }
        const text = admitText(rawText, config)
        if (text === undefined) {
          logSkip(sessionId, event, 'text-too-short-or-empty', { length })
          return
        }
        // 人类消息：无条件记为待配对并推进水位（即使这一轮助手回复迟/丢失，也不丢用户消息）。
        rememberPending(sessionId, text, event.seq)
        highWater.set(sessionId, event.seq)
        try {
          setLastSeq?.(sessionId, event.seq)
        } catch {
          /* 水位持久化失败不阻塞采集 */
        }
        return
      }

      if (event.type === 'assistant/message') {
        const rawText = extractMessageText(event.data?.message)
        const text = admitText(rawText, config)
        const queued = pendingOf(sessionId)
        highWater.set(sessionId, event.seq)
        try {
          setLastSeq?.(sessionId, event.seq)
        } catch {
          /* 同上 */
        }
        if (queued === undefined) {
          logSkip(sessionId, event, 'no-pending-user', { length: rawText.length })
          return
        }
        if (text === undefined) {
          logSkip(sessionId, event, 'assistant-text-empty', { length: rawText.length })
          return
        }
        dropPending(sessionId)
        stats.collected += 1
        const turn = {
          user: queued.text,
          assistant: text,
          sessionId,
          at: new Date(Number.isFinite(event.time) ? event.time : Date.now()).toISOString(),
          seq: event.seq,
          // v2.0.0：记下会话内的 turn 号，召回时可按「turn #12」标注来源。
          turn: Number.isFinite(event.data?.turn) ? Number(event.data.turn) : null,
          // v2.1.0：真人 user 侧（历史库里的 system 行会被清洗为 'system'）。
          origin: 'user',
        }
        try {
          onTurn(turn)
        } catch (error) {
          log('collect-turn-failed', { message: error?.message ?? String(error) })
        }
        return
      }

      // v2.1.0：工具事件只做隔离记录（不参与配对；默认 includeSystemEvents:false 时丢弃）。
      if (typeof event.type === 'string' && event.type.startsWith('tool/')) {
        recordSystemEvent(sessionId, event, 'tool', oneLine(describeToolEvent(event), 500), {
          type: event.type,
          tool: event.data?.toolName ?? event.data?.name ?? event.data?.tool ?? null,
          status: event.data?.status ?? event.data?.outcome?.kind ?? null,
        })
        return
      }

      // 其余事件（turn/start、step/*、request/* …）不参与配对，静默忽略。
    } catch (error) {
      log('collect-event-failed', { message: error?.message ?? String(error) })
    }
  }

  /** 系统/工具事件：推进水位；includeSystemEvents 时回调记忆层落 memory_events。 */
  function recordSystemEvent(sessionId, event, kind, text, meta) {
    highWater.set(sessionId, event.seq)
    try {
      setLastSeq?.(sessionId, event.seq)
    } catch {
      /* 水位持久化失败不阻塞采集 */
    }
    if (config.includeSystemEvents !== true || typeof text !== 'string' || text.length === 0) return
    stats.events += 1
    try {
      onSystemEvent?.({
        sessionId,
        seq: event.seq,
        at: new Date(Number.isFinite(event.time) ? event.time : Date.now()).toISOString(),
        kind,
        text,
        meta: { ...meta, salience: 0.05 },
      })
    } catch (error) {
      log('collect-system-event-failed', { message: error?.message ?? String(error) })
    }
  }

  /** 把工具事件压成一句人类可读的短文本（不含完整输出，避免把工具大块内容抄进记忆）。 */
  function describeToolEvent(event) {
    const data = event?.data ?? {}
    const name = data.toolName ?? data.name ?? data.tool ?? '(tool)'
    const status = data.status ?? data.outcome?.kind ?? data.result?.kind ?? ''
    return [`${event.type}`, name, status].filter((part) => typeof part === 'string' && part.length > 0).join(' ')
  }

  /** 订阅事件（用 ctx.effect 保证卸载时注销）。 */
  function subscribe() {
    ctx.effect(() => ctx.on('session/event', (session, event) => handleEvent(session, event)))
    log('collector-subscribed', {
      collectSubagents: config.collectSubagents,
      excludeSessionIdPattern: config.excludeSessionIdPattern,
      includeSessions: [...config.includeSessions],
      maxTextChars: config.maxTextChars,
    })
  }

  return {
    subscribe,
    /** 测试用：直接喂一条事件。 */
    handleEvent,
    /** 采集统计（原因分布），供 /brain 或诊断工具打印。 */
    stats() {
      return {
        collected: stats.collected,
        events: stats.events,
        filtered: stats.filtered,
        skipped: stats.skipped,
        skippedByReason: { ...stats.skippedByReason },
        filteredByReason: { ...stats.filteredByReason },
        pendingSessions: pending.size,
      }
    },
    dispose() {
      disposed = true
      pending.clear()
    },
  }
}


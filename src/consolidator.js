/**
 * 深月桌面脑：后台「静默消化」（consolidator）。
 *
 * 用户对「上下文整理」的定义是**记忆的分流**，不是压缩：
 *   - 后台静默把表意识（会话原文）里的内容压入长期记忆（记忆层 = 潜意识）；
 *   - 需要时再从长期记忆里把相关记忆捞到工作记忆（见 context.js）。
 *
 * 本模块只做前一半，而且**严格只读 DSH 会话**：
 *   - 不写任何 DSH 会话事件、不改 session surface、不调 compaction、不产生用户可见输出；
 *   - 只读 `memory_turns`（采集层已经落库的原文），产出事实 / 情节记忆 / 滚动摘要；
 *   - 原文永不删除，只把处理过的轮次标记 `consolidated = 1`，保持「无损、可回溯」。
 *
 * 触发：
 *   1. `session/event` 的 `turn/end` 累计到 `consolidateEveryTurns`（默认 4）轮；
 *   2. 或在 `turn/end` 后等 `idleConsolidateMs`（默认 90s）会话空闲时补一次；期间
 *      又出现新 turn（`turn/start` / `user/message`）就取消重排。
 * 同一会话互斥（running 时直接跳过），所有异常只写 brain.log，绝不冒泡。
 */

import { completeText, resolveRoute } from './llm.js'
import { runCharacterStep } from './character.js'
import { buildEntityExtractMessages, parseEntityExtraction } from './entities.js'
import { isNoiseTurn } from './memory.js'
import { CONSOLIDATE_SYSTEM_PROMPT } from './prompts.js'
import { clamp01, oneLine } from './store.js'

/** 后台消化的默认配置（会被 `dsh-context` 的归一化配置覆盖）。 */
export const DEFAULT_CONSOLIDATE_CONFIG = Object.freeze({
  /** 是否启用后台消化（关闭后只保留采集，不产生情节记忆）。 */
  consolidateEnabled: true,
  /** 累计多少轮 turn/end 后触发一次。 */
  consolidateEveryTurns: 4,
  /** 会话空闲多久后补一次（毫秒；0 表示不按空闲触发）。 */
  idleConsolidateMs: 90000,
  /** 消化方式：rule（纯规则，零模型调用）| llm（LLM 产出摘要与事实，失败回退规则）。 */
  consolidateMode: 'rule',
  /** 单次最多消化多少轮原文。 */
  consolidateMaxTurns: 12,
  /** 少于多少轮先不消化（继续攒）。 */
  consolidateMinTurns: 1,
  /** 一条情节摘要的最大字数。 */
  consolidateEpisodeMaxChars: 160,
  /** 滚动摘要每侧最大字数。 */
  summaryAppendMaxChars: 600,
  /** 诊断日志：每次消化打一条 consolidate-debug。 */
  debugConsolidate: false,
})

/** 句读切分（中英文标点）。 */
const CLAUSE_SPLIT = /[。！？!?；;\n\r]+/u

/** 强个人信息线索（命中说明「值得长期记住」）。 */
const PERSONAL_PATTERN = /(?:我叫|我的名字|我是|我在做|我在准备|我喜欢|我讨厌|我答应|我们说好|记住|别忘了|生日|住在)/u

/** 强情绪线索。 */
const EMOTION_PATTERN = /(?:累|烦|难过|开心|害怕|紧张|谢谢|喜欢|生气|焦虑|失望|兴奋|委屈)/u

/** 承诺线索。 */
const PROMISE_PATTERN = /(?:答应|约好|说好|保证|承诺|发誓|提醒)/u

/** 关系/陪伴线索（好感度高时优先召回这类情节）。 */
export const RELATION_PATTERN = /(?:答应|约好|关系|陪|一起|喜欢|谢谢|信任|承诺|想你|晚安)/u

/** 抽文本里的检索项：中文二元组 + 拉丁词（≥2 字符），去重、限长。 */
export function extractTerms(text, limit = 40) {
  const flat = String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
  const terms = new Set()
  for (let index = 0; index + 1 < flat.length; index += 1) {
    const gram = flat.slice(index, index + 2)
    if (/[\u4e00-\u9fa5]{2}/u.test(gram)) terms.add(gram)
  }
  for (const word of String(text ?? '').toLowerCase().match(/[a-z0-9_]{2,}/gu) ?? []) terms.add(word)
  return [...terms].slice(0, limit)
}

/** 把一段文本切成「有信息量」的分句。 */
function informativeClauses(text) {
  const result = []
  for (const sentence of String(text ?? '').split(CLAUSE_SPLIT)) {
    for (const piece of sentence.split(/[，,]/u)) {
      const clause = piece.trim()
      if (clause.length < 5 || clause.length > 80) continue
      if (/(?:吗|么|呢|嘛)\s*$/u.test(clause)) continue
      result.push(clause)
    }
  }
  return result
}

/**
 * 计算一条情节的 salience（0..1，重要度）。纯规则、可解释：
 *   - 基础 0.3；
 *   - 个人信息 +0.2；承诺 +0.12；强情绪 +0.12；
 *   - 同一检索项在 ≥2 轮里出现（被反复提到）+0.08；
 *   - 文本信息量足够（用户侧总字数 ≥ 60）+0.05。
 * 最终夹在 [0.05, 0.95]，保留两位小数。
 */
export function scoreSalience(turns, terms = []) {
  const texts = (Array.isArray(turns) ? turns : []).map((turn) => `${turn.user ?? ''} ${turn.assistant ?? ''}`)
  const joined = texts.join('\n')
  let score = 0.3
  if (PERSONAL_PATTERN.test(joined)) score += 0.2
  if (PROMISE_PATTERN.test(joined)) score += 0.12
  if (EMOTION_PATTERN.test(joined)) score += 0.12
  let repeated = false
  for (const term of Array.isArray(terms) ? terms.slice(0, 30) : []) {
    let seen = 0
    for (const text of texts) if (text.includes(term)) seen += 1
    if (seen >= 2) {
      repeated = true
      break
    }
  }
  if (repeated) score += 0.08
  const userChars = (Array.isArray(turns) ? turns : []).reduce((total, turn) => total + String(turn.user ?? '').length, 0)
  if (userChars >= 60) score += 0.05
  return Math.round(Math.min(0.95, Math.max(0.05, score)) * 100) / 100
}

/**
 * 规则版情节摘要：从一组轮次里抽 1–2 个用户分句 + 1 个助手分句，
 * 组成第三人称小摘要（≤ maxChars）。纯规则、零模型调用、可单测。
 *
 * @param {readonly {user?: string, assistant?: string}[]} turns 一组原文轮次。
 * @param {{maxChars?: number}} [options] 选项。
 * @returns {{summary: string, terms: string, salience: number, userHighlights: string[], assistantHighlight: string}}
 */
export function buildEpisode(turns, options = {}) {
  const maxChars = Math.max(40, options.maxChars ?? 160)
  const list = Array.isArray(turns) ? turns : []
  const userHighlights = []
  for (const turn of list) {
    for (const clause of informativeClauses(turn.user)) {
      if (userHighlights.length >= 2) break
      if (!userHighlights.some((item) => item === clause)) userHighlights.push(clause)
    }
  }
  let assistantHighlight = ''
  for (let index = list.length - 1; index >= 0 && assistantHighlight.length === 0; index -= 1) {
    const clauses = informativeClauses(list[index]?.assistant)
    if (clauses.length > 0) assistantHighlight = clauses[0]
  }
  const parts = []
  let userPart = userHighlights.join('；')
  if (userPart.length === 0) {
    // 太短的轮次（例如「第一轮」）抽不出分句：退化成原文首句，保证仍有索引摘要。
    userPart = oneLine(
      list
        .map((turn) => String(turn.user ?? '').trim())
        .filter((text) => text.length > 0)
        .join('；'),
      Math.max(20, maxChars - 24),
    )
  }
  if (userPart.length > 0) parts.push(`用户和助手聊到：${userPart}`)
  if (assistantHighlight.length > 0) parts.push(`助手回应：${assistantHighlight}`)
  const summary = oneLine(parts.join('。'), maxChars)
  const termsText = [...list.map((turn) => turn.user), ...list.map((turn) => turn.assistant)].join(' ')
  const terms = extractTerms(termsText)
  return {
    summary,
    terms: terms.join(' '),
    salience: scoreSalience(list, terms),
    userHighlights,
    assistantHighlight,
  }
}

/** 安全解析 LLM 返回的消化 JSON；失败返回 undefined。 */
export function parseConsolidation(text) {
  const match = /\{[\s\S]*\}/u.exec(String(text ?? ''))
  if (match === null) return undefined
  try {
    const value = JSON.parse(match[0])
    const pickFacts = (items) =>
      Array.isArray(items)
        ? items
            .filter((item) => item !== null && typeof item === 'object' && typeof item.text === 'string')
            .slice(0, 3)
            .map((item) => ({
              text: String(item.text).trim(),
              kind: typeof item.kind === 'string' ? item.kind : undefined,
              weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : undefined,
            }))
        : []
    const episode = value.episode !== null && typeof value.episode === 'object' ? value.episode : {}
    return {
      facts: { user: pickFacts(value.facts?.user), self: pickFacts(value.facts?.self) },
      episode: {
        summary: typeof episode.summary === 'string' ? episode.summary.trim() : '',
        salience: Number.isFinite(Number(episode.salience)) ? Number(episode.salience) : undefined,
        terms: Array.isArray(episode.terms) ? episode.terms.filter((term) => typeof term === 'string') : [],
      },
    }
  } catch {
    return undefined
  }
}

/**
 * 创建后台消化器。
 *
 * @param {object} options 依赖。
 * @param {import('@deepseek-ai/cordis').Context} options.ctx Host 上下文（只读 `brainMemory` / `brainMood` / `llm`）。
 * @param {object} options.config 上下文层归一化配置。
 * @param {(event: string, data?: Record<string, unknown>) => void} options.log 日志。
 */
export function createConsolidator({ ctx, config, log }) {
  const settings = { ...DEFAULT_CONSOLIDATE_CONFIG, ...(config ?? {}) }
  /** sessionId → { pending, timer, running, lastRunAt }。 */
  const sessions = new Map()
  const stats = { runs: 0, episodes: 0, factsAdded: 0, turnsMarked: 0, failures: 0, lastAt: null, lastSessionId: null }
  let disposed = false
  let memoryMissingLogged = false
  /** 角色修订同一时刻只跑一个（模型调用慢，避免攒一堆排队）。 */
  let characterBusy = false
  /** 实体结构化抽取同一时刻只跑一个。 */
  let entityExtractBusy = false

  /** 取记忆层服务（动态，允许单独停用记忆层）。 */
  function getMemory() {
    try {
      const service = ctx.get('brainMemory')
      return service && typeof service === 'object' ? service : undefined
    } catch {
      return undefined
    }
  }

  /**
   * v2.2.0：「睡眠期」顺带维护「我是谁」。
   *
   * 角色由对话塑造：第一批证据到了就 bootstrap，之后每攒够 `characterReviseEveryTurns`
   * 轮再让模型改写一版。这里**不 await**（模型慢，不能拖住整理），失败只写日志；
   * 同一时刻只跑一个，避免堆积。
   */
  function maybeUpdateCharacter(memory, turns, sessionId) {
    if (config?.characterEnabled === false || characterBusy) return
    if (!memory || typeof memory.characterNeedsRevision !== 'function') return
    const totalTurns = typeof memory.counts === 'function' ? Number(memory.counts().turns) || 0 : 0
    const everyTurns = Math.max(1, Number(config?.characterReviseEveryTurns) || 6)
    let decision
    try {
      decision = memory.characterNeedsRevision(totalTurns, everyTurns)
    } catch {
      return
    }
    if (!decision?.needed) return
    characterBusy = true
    const evidenceTexts = (Array.isArray(turns) ? turns : [])
      .slice(-8)
      .map((turn) => `用户：${oneLine(turn.user, 120)}\n助手：${oneLine(turn.assistant, 120)}`)
    const lastEvidenceSeq = (Array.isArray(turns) ? turns : []).reduce(
      (max, turn) => (Number.isFinite(Number(turn.seq)) ? Math.max(max, Number(turn.seq)) : max),
      0,
    )
    Promise.resolve()
      .then(() =>
        runCharacterStep({
          ctx,
          config,
          memory,
          log,
          sessionId,
          mode: decision.bootstrap ? 'bootstrap' : 'revise',
          payload: {
            name: typeof memory.characterRow === 'function' ? memory.characterRow()?.name ?? '' : '',
            evidenceTurns: totalTurns,
            evidenceTexts,
            lastEvidenceSeq,
          },
        }),
      )
      .catch((error) => log('character-step-failed', { message: error?.message ?? String(error) }))
      .finally(() => {
        characterBusy = false
      })
  }

  /**
   * v2.3.0：睡眠期结构化巩固 —— 把对话抽成「主诉 / 辨证 / 处方 / 复诊」这类字段。
   *
   * 规则抽取只能存原话片段；字段化必须靠一次低频 LLM（`entityExtractMode: 'llm'`）。
   * 同样**不 await**、同一时刻只跑一个、失败只写日志；只接受已知对象名，
   * 模型写出的不在名单里的对象一律丢弃。
   */
  function maybeExtractEntityFacts(memory, turns, sessionId) {
    if (String(config?.entityExtractMode ?? 'rule') !== 'llm') return
    if (entityExtractBusy) return
    if (!memory || typeof memory.entityList !== 'function' || typeof memory.entityResolve !== 'function') return
    const roster = memory.entityList(50)
    if (!Array.isArray(roster) || roster.length === 0) return
    const names = roster.map((entity) => entity.name).filter((name) => typeof name === 'string' && name.length > 0)
    if (names.length === 0) return
    const mentioned = new Set()
    for (const turn of Array.isArray(turns) ? turns : []) {
      const text = `${turn.user ?? ''}\n${turn.assistant ?? ''}`
      for (const entity of memory.entityResolve(text, 5)) {
        if (names.includes(entity.name)) mentioned.add(entity.name)
      }
    }
    const targets = [...mentioned]
    if (targets.length === 0) return

    entityExtractBusy = true
    Promise.resolve()
      .then(async () => {
        const route = resolveRoute(ctx, config)
        const request = buildEntityExtractMessages({ turns: turns.slice(-12), names: targets })
        const text = await completeText(ctx, {
          route,
          system: request.system,
          messages: request.messages,
          temperature: 0.2,
          maxTokens: 700,
          ...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}),
        })
        const parsed = parseEntityExtraction(text)
        let applied = 0
        for (const item of parsed) {
          if (!targets.includes(item.name)) continue
          applied += Number(memory.entityApplyExtraction?.(item.name, item.facts)) || 0
        }
        log('entity-extract-done', { targets: targets.length, parsed: parsed.length, applied })
      })
      .catch((error) => log('entity-extract-failed', { message: error?.message ?? String(error) }))
      .finally(() => {
        entityExtractBusy = false
      })
  }

  /** 取某一侧的当前情绪快照（失败就不带）。 */
  function moodSnapshot() {
    try {
      const mood = ctx.get('brainMood')
      if (!mood || typeof mood.current !== 'function') return null
      const current = mood.current()
      if (current === null || typeof current !== 'object') return null
      return {
        user: current.user ? { valence: current.user.valence, energy: current.user.energy } : undefined,
        self: current.self
          ? {
              valence: current.self.valence,
              energy: current.self.energy,
              affection: current.self.affection,
              status: current.self.status,
            }
          : undefined,
        at: new Date().toISOString(),
      }
    } catch {
      return null
    }
  }

  /** 取（或建）会话状态。 */
  function stateOf(sessionId) {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = { pending: 0, timer: null, running: false, lastRunAt: 0 }
      sessions.set(sessionId, state)
    }
    return state
  }

  /** 取消会话的空闲定时器。 */
  function clearTimer(sessionId) {
    const state = sessions.get(sessionId)
    if (!state || state.timer === null) return
    try {
      clearTimeout(state.timer)
    } catch {
      /* 取消失败不影响主流程 */
    }
    state.timer = null
  }

  /** 安排一次空闲消化（期间有新 turn 会取消重排）。 */
  function scheduleIdle(sessionId) {
    const delay = Number(settings.idleConsolidateMs) || 0
    if (delay <= 0 || disposed) return
    clearTimer(sessionId)
    const state = stateOf(sessionId)
    state.timer = setTimeout(() => {
      state.timer = null
      if (disposed) return
      // 空闲时不再看 pending 计数，直接补一次（失败静默）。
      void run(sessionId, 'idle')
    }, delay)
    // 插件卸载后不要因为定时器让进程保持存活。
    if (typeof state.timer?.unref === 'function') state.timer.unref()
  }

  /** LLM 模式：一次调用同时产出事实补充与情节摘要（失败返回 undefined，回退规则）。 */
  async function askLlm(turns) {
    if (settings.consolidateMode !== 'llm') return undefined
    if (!ctx || typeof ctx.get !== 'function') return undefined
    try {
      const route = resolveRoute(ctx, {})
      const output = await completeText(ctx, {
        route,
        system: CONSOLIDATE_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: turns.map((turn) => `用户：${turn.user}\n助手：${turn.assistant}`).join('\n\n'),
              },
            ],
          },
        ],
        temperature: 0.2,
        maxTokens: 500,
        signal: AbortSignal.timeout(30000),
      })
      return parseConsolidation(output)
    } catch (error) {
      log('consolidate-llm-failed', { message: error?.message ?? String(error) })
      return undefined
    }
  }

  /**
   * 消化一个会话里未处理的轮次。
   * @param {string} sessionId 会话 id。
   * @param {'turns'|'idle'|'manual'} reason 触发原因（仅用于日志）。
   * @returns {Promise<{ok: boolean, reason?: string, turns?: number, factsAdded?: number, episodeId?: string|null, summaryChars?: number, error?: string}>}
   */
  async function run(sessionId, reason = 'turns') {
    if (disposed) return { ok: false, reason: 'disposed' }
    if (settings.consolidateEnabled === false) return { ok: false, reason: 'disabled' }
    if (typeof sessionId !== 'string' || sessionId.length === 0) return { ok: false, reason: 'no-session' }
    const memory = getMemory()
    if (memory === undefined || typeof memory.unconsolidatedTurns !== 'function') {
      if (!memoryMissingLogged) {
        memoryMissingLogged = true
        log('consolidate-skip', { reason: 'memory-unavailable' })
      }
      return { ok: false, reason: 'memory-unavailable' }
    }
    const state = stateOf(sessionId)
    if (state.running) return { ok: false, reason: 'busy' }
    state.running = true
    clearTimer(sessionId)
    const startedAt = new Date().toISOString()
    try {
      const limit = Math.max(1, Number(settings.consolidateMaxTurns) || 12)
      const turns = memory.unconsolidatedTurns(sessionId, limit)
      const minTurns = Math.max(1, Number(settings.consolidateMinTurns) || 1)
      if (turns.length === 0) {
        state.pending = 0
        return { ok: false, reason: 'nothing' }
      }
      if (turns.length < minTurns) return { ok: false, reason: 'not-enough' }
      // 噪声轮次（时间戳/代理消息等）不做摘要与事实，但标记为已处理，避免反复重试。
      const cleanTurns = turns.filter((turn) => !isNoiseTurn(turn))
      if (cleanTurns.length === 0) {
        if (typeof memory.markConsolidated === 'function') {
          memory.markConsolidated(turns.map((turn) => turn.id), { at: startedAt })
        }
        state.pending = 0
        log('consolidate-noise-skip', { sessionId, turns: turns.length })
        return { ok: false, reason: 'noise-only' }
      }
      if (settings.debugConsolidate) {
        log('consolidate-debug', { sessionId, reason, turns: cleanTurns.length, mode: settings.consolidateMode, startedAt })
      }

      const llm = await askLlm(cleanTurns)
      const userTexts = cleanTurns.map((turn) => turn.user)
      const selfTexts = cleanTurns.map((turn) => turn.assistant)
      let facts = { user: { added: 0, merged: 0 }, self: { added: 0, merged: 0 } }
      if (typeof memory.applyFacts === 'function') {
        facts = memory.applyFacts(userTexts, selfTexts, llm?.facts)
      }

      const rule = buildEpisode(cleanTurns, { maxChars: Number(settings.consolidateEpisodeMaxChars) || 160 })
      const llmEpisode = llm?.episode ?? {}
      const summary = llmEpisode.summary && llmEpisode.summary.length > 0
        ? oneLine(llmEpisode.summary, Number(settings.consolidateEpisodeMaxChars) || 160)
        : rule.summary
      const salience = Number.isFinite(llmEpisode.salience)
        ? Math.min(0.95, Math.max(0.05, llmEpisode.salience))
        : rule.salience
      const terms = Array.isArray(llmEpisode.terms) && llmEpisode.terms.length > 0
        ? llmEpisode.terms.slice(0, 40).join(' ')
        : rule.terms

      let episodeId = null
      if (typeof memory.rememberEpisode === 'function' && summary.length > 0) {
        const at = turns[turns.length - 1]?.at ?? startedAt
        const episode = memory.rememberEpisode({
          sessionId,
          at,
          summary,
          turnIds: turns.map((turn) => turn.id),
          mood: moodSnapshot(),
          salience,
          terms,
        })
        episodeId = episode?.episodeId ?? null
      }

      // 滚动摘要：把这段对话的「小摘要」并进长期摘要（规则模式不调模型，失败静默）。
      let summaryChars = 0
      if (typeof memory.appendSummary === 'function') {
        const maxChars = Math.max(120, Number(settings.summaryAppendMaxChars) || 600)
        try {
          summaryChars += String(memory.appendSummary('user', summary, { maxChars }) ?? '').length
          if (rule.assistantHighlight) {
            summaryChars += String(memory.appendSummary('self', `你回应：${rule.assistantHighlight}`, { maxChars }) ?? '').length
          }
        } catch (error) {
          log('consolidate-summary-failed', { sessionId, message: error?.message ?? String(error) })
        }
      }

      const changed = typeof memory.markConsolidated === 'function'
        ? memory.markConsolidated(
            turns.map((turn) => turn.id),
            { at: startedAt },
          )
        : 0
      state.pending = 0
      stats.runs += 1
      stats.episodes += episodeId === null ? 0 : 1
      stats.factsAdded += (Number(facts?.user?.added) || 0) + (Number(facts?.self?.added) || 0)
      stats.turnsMarked += Number(changed) || 0
      stats.lastAt = startedAt
      stats.lastSessionId = sessionId
      log('consolidate-done', {
        sessionId,
        reason,
        mode: settings.consolidateMode,
        turns: turns.length,
        episodeId,
        salience,
        summaryChars,
        facts: { user: facts?.user?.added ?? 0, self: facts?.self?.added ?? 0 },
        marked: changed,
      })
      // v2.3.0：实体层——把这批轮次挂到患者/客户/项目档案上（规则抽取、宁缺毋滥、
      // 纯 DB，快；失败不影响整理）。
      try {
        if (typeof memory.entityIngest === 'function') memory.entityIngest(turns)
      } catch (error) {
        log('entity-ingest-failed', { sessionId, message: error?.message ?? String(error) })
      }

      // v2.2.0：睡眠期顺带维护「我是谁」（不 await：模型慢，不能拖住整理）。
      maybeUpdateCharacter(memory, turns, sessionId)
      // v2.3.0：睡眠期结构化巩固（把对话抽成对象字段；只受 entityExtractMode 控制）。
      maybeExtractEntityFacts(memory, turns, sessionId)

      return { ok: true, turns: turns.length, factsAdded: stats.factsAdded, episodeId, summaryChars, salience }
    } catch (error) {
      stats.failures += 1
      log('consolidate-failed', { sessionId, reason, message: error?.message ?? String(error) })
      return { ok: false, reason: 'error', error: error?.message ?? String(error) }
    } finally {
      state.running = false
      state.lastRunAt = Date.now()
    }
  }

  /** 处理一条会话事件（同步、绝不抛出、不做任何会话写操作）。 */
  function handleEvent(session, event) {
    if (disposed) return
    try {
      const sessionId = String(session?.id ?? session?.header?.id ?? '')
      if (sessionId.length === 0) return
      if (event?.type === 'turn/start' || event?.type === 'user/message') {
        // 新 turn 开始：取消空闲补消化，重新计时。
        clearTimer(sessionId)
        return
      }
      if (event?.type !== 'turn/end') return
      if (settings.consolidateEnabled === false) return
      const state = stateOf(sessionId)
      state.pending += 1
      clearTimer(sessionId)
      const every = Math.max(1, Number(settings.consolidateEveryTurns) || 4)
      if (state.pending >= every) {
        void run(sessionId, 'turns')
      } else {
        scheduleIdle(sessionId)
      }
    } catch (error) {
      try {
        log('consolidate-event-failed', { message: error?.message ?? String(error) })
      } catch {
        /* 静默 */
      }
    }
  }

  /** 订阅 `session/event`；返回注销函数。 */
  function subscribe() {
    const dispose = ctx.on('session/event', (session, event) => handleEvent(session, event))
    log('consolidator-subscribed', {
      everyTurns: settings.consolidateEveryTurns,
      idleMs: settings.idleConsolidateMs,
      mode: settings.consolidateMode,
    })
    return () => {
      try {
        dispose?.()
      } catch {
        /* 注销失败忽略 */
      }
    }
  }

  return {
    subscribe,
    /** 测试用：直接喂一条事件。 */
    handleEvent,
    /** 测试 / 命令用：立即整理一次（仍受互斥与开关约束）。 */
    consolidateNow: (sessionId, options = {}) => run(sessionId, options.reason ?? 'manual'),
    /** 测试用：某个会话的待整理计数。 */
    pendingOf(sessionId) {
      return sessions.get(sessionId)?.pending ?? 0
    },
    stats() {
      return { ...stats, sessions: sessions.size }
    },
    dispose() {
      disposed = true
      for (const state of sessions.values()) {
        if (state.timer !== null) {
          try {
            clearTimeout(state.timer)
          } catch {
            /* 忽略 */
          }
          state.timer = null
        }
      }
      sessions.clear()
    },
  }
}

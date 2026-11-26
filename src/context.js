/**
 * 深月桌面脑：工作记忆层（dsh-context）—— 决定这一轮上下文里有什么。
 *
 * 把记忆 / 情绪 / 人格三层的**双向**内容整理成一段可注入 DSH system prompt 的
 * 自然语言上下文，并注册 `/brain` 观测命令：
 *
 *   【关于你（用户）】 画像要点 / 最近状态 / 沟通偏好 / 相关记忆
 *   【关于我（这个助手）】 表达倾向 / 当前状态 / 我记得的承诺
 *
 * 注入方式：`ctx.systemPrompt.section({ name, order, text })`，文本由 provider 在
 * 每次组装 prompt 时现算；**任何异常都返回空字符串**，绝不让 DSH 的 prompt 组装
 * 失败。`enabled: false` 时不注册。三层都是可选依赖（`ctx.get()` 动态取），
 * 单独停某一层时只少对应内容，不影响注入本身。
 *
 * 命令：`/brain`、`/brain memory`、`/brain mood`、`/brain persona`、
 * `/brain reset`（需要 `confirm` 参数）。命令输出中文、短。
 */

import { extractMessageText, looksSynthetic } from './collect.js'
import { RELATION_PATTERN } from './consolidator.js'
import {
  attributeUse,
  detectForgetSignal,
  forgetTopicTerms,
  judgeAttribution,
  splitTerms,
} from './learning.js'
import { buildRoleText, roleSummary, ROLE_SECTION_NAME } from './role.js'
import { renderCharacterSection, runCharacterStep } from './character.js'
import { renderEntitySection } from './entities.js'
import { classifyMessage } from './roles.js'
import { oneLine } from './store.js'

/** 注入段的默认名字与排序位置（可用 config.sectionOrder 覆盖）。 */
export const SECTION_NAME = 'dsh-brain:context'

/** v2.2.0：角色段（"我是谁"，模型从对话里写出来的自我定义）。 */
export const CHARACTER_SECTION_NAME = 'dsh-brain:self'

/** 工作记忆段的标题（召回内容统一挂在这里）。 */
export const WORK_MEMORY_HEADER = '【工作记忆 · 相关回忆】（只在你自然用得上的时候提，不要复述）'

/** 注入文本的收尾提示（现有行为保持不变）。 */
const PROMPT_HINT = '（以上只是背景，不必主动复述，也不要报出具体数值。）'

/** 取一层服务；不存在返回 undefined。 */
function layer(ctx, name) {
  try {
    const service = ctx.get(name)
    return service && typeof service === 'object' ? service : undefined
  } catch {
    return undefined
  }
}

/** 用文字描述「心情值 / 精力」的高低，不暴露数值。 */
export function describeLevel(value, labels) {
  const number = Number(value)
  if (!Number.isFinite(number)) return labels.mid
  if (number >= 0.68) return labels.high
  // low 阈值从 0.36 收到 0.30：0.31~0.36 只是「略低」，说成「有点累」证据不足。
  if (number <= 0.30) return labels.low
  return labels.mid
}

/** 把一段文本压成一行、限长。 */
function line(text, max = 60) {
  return oneLine(String(text ?? '').replace(/^[-•]\s*/u, ''), max)
}

/** 归一化文本（检索/冷却判断用：去空白与标点）。 */
function normalizeQueryText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 字符二元组集合（轻量相关度，不引入依赖）。 */
function bigramsOf(text) {
  const value = normalizeQueryText(text)
  const grams = new Set()
  for (let index = 0; index + 1 < value.length; index += 1) grams.add(value.slice(index, index + 2))
  return grams
}

/** 把 ISO 时间压成「月-日」短标签（召回原文时标注来源时间）；解析失败给「早前」。 */
function dayLabel(at) {
  const time = Date.parse(at ?? '')
  if (!Number.isFinite(time)) return '早前'
  const date = new Date(time)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 原文召回来源标签：`11-21 14:30`（解析失败给「早前」）。
 * 召回条目按 lead 要求带「时间 + turn id」，方便人工核对来源。
 */
function recallTimeLabel(at) {
  const time = Date.parse(at ?? '')
  if (!Number.isFinite(time)) return '早前'
  const date = new Date(time)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 召回来源标签：优先会话内 turn 号，其次 seq。 */
function turnLabelOf(turn) {
  if (Number.isFinite(turn?.turn)) return `turn #${turn.turn}`
  if (Number.isFinite(turn?.seq)) return `seq ${turn.seq}`
  return '早前'
}

/**
 * 计算本轮「工作记忆」的字符预算（按人格/情绪做简单权重）。
 *
 * - `persona.traits('user').detail` 高 → 用户希望细节，预算最多 +45%；低 → 收紧；
 * - `directness` 高 → 用户偏好直接，预算最多 -15%；
 * - `mood.self.affection` ≥ 0.6 → 关系类记忆更值得提，预算 +10%。
 * 最终预算还会被全局 `maxChars` 再夹一次（见 pack 阶段），保证不撑爆 prompt。
 */
function workingBudgetOf(config, moodState, traitsUser) {
  const base = Math.max(200, Number(config.recallMaxChars ?? config.workingMemoryMaxChars ?? 1200))
  const detail = Number(traitsUser?.detail ?? 0.5)
  const directness = Number(traitsUser?.directness ?? 0.5)
  const factor = Math.min(1.45, Math.max(0.6, 0.9 + 0.45 * detail - 0.15 * directness))
  const affection = Number(moodState?.self?.affection ?? 0.5)
  const relationBonus = affection >= 0.6 ? 1.1 : 1
  return Math.round(base * factor * relationBonus)
}

/**
 * 组装注入文本（纯函数，便于单测）。
 *
 * 结构（顺序即展示顺序）：
 *   【工作记忆 · 相关回忆】 从长期记忆捞出的相关情节 / 旧对话（有上限、带去重冷却）
 *   【关于你（用户）】      名字 / 画像事实 / 更早的印象 / 此刻状态 / 沟通偏好
 *   【关于我（这个助手）】  表达倾向 / 当前状态 / 我记得的承诺 / 关系进展
 *
 * 预算裁剪优先级（高的先留）：画像事实 > 相关记忆 > 摘要 > 情绪/人格。
 * `recallState` 是调用方持有的冷却状态（{round, seen}）：同一记忆默认 3 轮内不重复
 * 注入；本轮再次提到它的关键词时允许刷新。
 *
 * @param {object} input 输入。
 * @param {object} input.config 上下文配置（可只给部分字段，函数内补默认值）。
 * @param {object} [input.memory] brainMemory 服务。
 * @param {object} [input.mood] brainMood 服务。
 * @param {object} [input.persona] brainPersona 服务。
 * @param {string} [input.userText] 本轮用户输入（用于相关度）。
 * @param {string[]} [input.recentUserTexts] 最近 1–2 轮用户输入（扩展检索词）。
 * @param {{round: number, seen: Map<string, {round: number}>}} [input.recallState] 注入冷却状态。
 * @returns {{text: string, sections: string[], stats: object}}
 */
export function buildContextText(input) {
  const { config = {}, memory, mood, persona, userText = '', recentUserTexts = [], recallState } = input ?? {}
  const maxChars = Math.max(200, Number(config.maxChars ?? 1800))
  const factLimit = Number(config.factLimit ?? 6)
  const recallLimit = Math.max(0, Number(config.recallLimit ?? 3))
  const turnRecallLimit = Math.max(0, Number(config.turnRecallLimit ?? 2))
  const cooldownTurns = Math.max(0, Number(config.recallCooldownTurns ?? 3))
  const stats = {
    facts: { user: 0, self: 0 },
    hasSummary: false,
    mood: false,
    persona: false,
    layers: { memory: Boolean(memory), mood: Boolean(mood), persona: Boolean(persona) },
    workingMemory: { count: 0, chars: 0, ids: [], queryChars: 0 },
    recalls: { count: 0, candidates: 0 },
  }

  const moodState = mood && typeof mood.current === 'function' ? mood.current() : undefined
  const personaRender = persona && typeof persona.render === 'function' ? persona.render() : undefined
  let traitsUser
  try {
    traitsUser = persona && typeof persona.traits === 'function' ? persona.traits('user') : undefined
  } catch {
    traitsUser = undefined
  }
  const factsUser =
    memory && typeof memory.factsForPrompt === 'function' ? memory.factsForPrompt('user', userText, factLimit) : []
  const factsSelf =
    memory && typeof memory.factsForPrompt === 'function' ? memory.factsForPrompt('self', userText, factLimit) : []
  const summaries = memory && typeof memory.summaries === 'function' ? memory.summaries() : undefined
  const profile = memory && typeof memory.profile === 'function' ? memory.profile() : undefined

  // ---- v2.3.0：实体优先 + 表意识槽位 + 激活扩散 ----
  // 本轮点了名就用它；没点名就用本会话最近焦点（「他今天怎么样」）；再顺带给出相关对象。
  let entityProfiles = []
  let entityRelated = []
  let entityViaFocus = false
  if (config.entityEnabled !== false && memory && typeof memory.entityResolveForTurn === 'function') {
    try {
      const resolved = memory.entityResolveForTurn({
        sessionId: input?.sessionId,
        text: userText,
        limit: Math.max(1, Number(config.entityLimit ?? 2)),
        factLimit: Math.max(1, Number(config.entityFactLimit ?? 6)),
        turnLimit: Math.max(1, Number(config.entityTurnLimit ?? 3)),
        ttlMs: Math.max(60, Number(config.entityFocusTtlMinutes ?? 30)) * 60 * 1000,
        spread: config.entitySpreadEnabled !== false,
      })
      entityProfiles = resolved?.profiles ?? []
      entityRelated = resolved?.related ?? []
      entityViaFocus = resolved?.viaFocus === true
    } catch {
      entityProfiles = []
    }
  }
  stats.entities = entityProfiles.length
  stats.entityViaFocus = entityViaFocus

  // ---- 检索查询：本轮输入 + 最近 1–2 轮（扩展召回面）----
  const query = [userText, ...(Array.isArray(recentUserTexts) ? recentUserTexts : [])]
    .map((value) => String(value ?? '').trim())
    .filter((value) => value.length > 0)
    .join(' ')
  const queryNorm = normalizeQueryText(query)
  const queryGrams = bigramsOf(query)
  stats.workingMemory.queryChars = query.length

  // ---- 注入冷却状态（同一记忆不要每轮重复注入）----
  const state = recallState ?? { round: 0, seen: new Map() }
  state.round = (Number(state.round) || 0) + 1
  /** 是否因为「刚注入过且本轮没再提到」而应跳过。 */
  function cooling(id, termsText) {
    const seen = state.seen.get(id)
    if (seen === undefined) return false
    if (state.round - seen.round >= cooldownTurns) return false
    if (queryNorm.length === 0) return true
    const terms = String(termsText ?? '')
      .split(/\s+/u)
      .filter((term) => term.length >= 2)
    const mentioned = terms.some((term) => queryNorm.includes(normalizeQueryText(term)))
    return !mentioned
  }

  // ---- 候选：相关情节（episodes）----
  let episodeCandidates = []
  if (memory && typeof memory.recallEpisodes === 'function' && queryGrams.size > 0 && recallLimit > 0) {
    episodeCandidates = memory.recallEpisodes(query, { limit: Math.max(1, recallLimit * 2) }) ?? []
  }
  const affection = Number(moodState?.self?.affection ?? 0.5)
  const featureWeights =
    memory && typeof memory.recallFeatureWeights === 'function'
      ? memory.recallFeatureWeights()
      : { relevance: 1, salience: 1, recency: 1, topic: 1, affection: 1 }
  if (affection >= 0.6) {
    // 好感度高 → 关系/陪伴类情节优先（学习到的 affection 特征权重可放大/收窄）。
    const boost = 0.08 * Number(featureWeights.affection ?? 1)
    for (const candidate of episodeCandidates) {
      if (RELATION_PATTERN.test(String(candidate.summary ?? ''))) candidate.score += boost
    }
  }
  episodeCandidates = [...episodeCandidates].sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
  stats.recalls.candidates += episodeCandidates.length

  // ---- 候选：相关原文（v2.0.0 重点，返回的是原文片段而不是摘要）----
  // 打分：字符 bigram + IDF + 时间衰减 + 归档加成 + 话题连续性；归档段与当前话题无关时不召回。
  let oldTurns = []
  if (memory && typeof memory.recallOriginals === 'function' && queryGrams.size > 0 && turnRecallLimit > 0) {
    try {
      oldTurns =
        memory.recallOriginals(query, {
          limit: Math.max(recallLimit, turnRecallLimit),
          recentTexts: (Array.isArray(recentUserTexts) ? recentUserTexts : []).join(' '),
          topicShiftEnabled: config.topicShiftEnabled !== false,
        }) ?? []
    } catch {
      oldTurns = []
    }
  } else if (memory && typeof memory.recall === 'function' && queryGrams.size > 0 && recallLimit > 0) {
    try {
      oldTurns = memory.recall(query, { limit: recallLimit }) ?? []
    } catch {
      oldTurns = []
    }
  }

  // ---- 组装候选行（带优先级 tier / 段落 / 估算长度）----
  const items = []
  function push(text, tier, section, id) {
    const value = String(text ?? '').trim()
    if (value.length === 0) return
    items.push({ text: value, tier, section, id, cost: value.length + 3 })
  }

  if (profile && typeof profile.userName === 'string' && profile.userName.length > 0) {
    push(`名字：${profile.userName}`, 0, 'user')
  }
  if (factsUser.length > 0) {
    stats.facts.user = factsUser.length
    for (const fact of factsUser) push(line(fact.text, 60), 1, 'user')
  }
  if (factsSelf.length > 0) {
    stats.facts.self = factsSelf.length
    for (const fact of factsSelf) push(line(fact.text, 60), 1, 'self')
  }
  // 相关记忆（tier 2）：先情节（摘要索引），再旧对话原文兜底。
  // 原文永远在 memory_turns 里，这里注入的是「原文片段 + 来源标签」。
  const sources = []
  let workCount = 0
  for (const candidate of episodeCandidates) {
    if (workCount >= recallLimit) break
    const id = `ep:${candidate.id}`
    if (cooling(id, candidate.terms)) continue
    push(`你们之前聊到：${oneLine(candidate.summary, 110)}`, 2, 'work', id)
    sources.push({
      id: candidate.id,
      kind: 'episode',
      at: candidate.at,
      turnIds: Array.isArray(candidate.turnIds) ? candidate.turnIds : [],
      snippet: oneLine(candidate.summary, 110),
      // v2.1.0：召回学习用（注入的是哪些词、预测分与各特征值）。
      terms: splitTerms(candidate.terms),
      score: Number(candidate.score) || 0,
      relevance: Number(candidate.relevance) || 0,
      learnedTerm: Number(candidate.learnedTerm) || 1,
      components: candidate.components ?? null,
      features: {
        relevance: Number(candidate.relevance) || 0,
        salience: Number(candidate.salience) || 0.5,
        recency: Number(candidate.recency) || 0,
        topic: 0,
        affection: RELATION_PATTERN.test(String(candidate.summary ?? '')) && affection >= 0.6 ? 1 : 0,
      },
    })
    workCount += 1
  }
  if (workCount < recallLimit && typeof turnRecallLimit === 'number' && turnRecallLimit > 0) {
    let turnCount = 0
    for (const turn of oldTurns) {
      if (workCount >= recallLimit || turnCount >= turnRecallLimit) break
      const id = `turn:${turn.id}`
      if (cooling(id, '')) continue
      const snippet = oneLine(turn.snippet ?? turn.user, 120)
      // 格式：你以前说过（11-21 14:30，turn #12）："……原文片段……"
      push(`你以前说过（${recallTimeLabel(turn.at)}，${turnLabelOf(turn)}）："${snippet}"`, 2, 'work', id)
      sources.push({
        id: turn.id,
        kind: 'turn',
        at: turn.at,
        sessionId: turn.sessionId,
        seq: turn.seq,
        turn: turn.turn ?? null,
        archived: turn.archived === 1,
        score: turn.score ?? null,
        relevance: turn.relevance ?? null,
        topicOverlap: turn.topicOverlap ?? null,
        snippet,
        // v2.1.0：召回学习用。
        terms: splitTerms(turn.terms),
        learnedTerm: Number(turn.learnedTerm) || 1,
        components: turn.components ?? null,
        features: {
          relevance: Number(turn.relevance) || 0,
          salience: 0.5,
          recency: Number(turn.recency) || 0,
          topic: Number(turn.topicOverlap) || 0,
          affection: 0,
        },
      })
      workCount += 1
      turnCount += 1
    }
  }
  if (summaries && summaries.user && summaries.user.text.length > 0) {
    stats.hasSummary = true
    push(`更早的印象：${line(summaries.user.text, 120)}`, 3, 'user')
  }
  if (summaries && summaries.self && summaries.self.text.length > 0) {
    stats.hasSummary = true
    push(`更早的印象：${line(summaries.self.text, 120)}`, 3, 'self')
  }
  if (moodState && moodState.user) {
    // 不再注入「此刻状态」：用户累不累由用户自己说，不从一个随时间衰减的
    // 数值替他下结论（工作会话里这行是噪音，还会误导助手去「关心」）。
    stats.mood = true
  }
  if (personaRender && Array.isArray(personaRender.lines?.user)) {
    stats.persona = true
    for (const traitLine of personaRender.lines.user.slice(0, 3)) push(traitLine, 4, 'user')
  }
  if (moodState && moodState.self) {
    // 助手自己的状态行同样不再注入。
    stats.mood = true
  }
  if (personaRender && Array.isArray(personaRender.lines?.self)) {
    stats.persona = true
    for (const traitLine of personaRender.lines.self.slice(0, 3)) push(traitLine, 4, 'self')
  }

  // ---- 预算裁剪：按 tier 从高优先级到低优先级装箱 ----
  const budget = maxChars - PROMPT_HINT.length
  const headerCost = { work: WORK_MEMORY_HEADER.length + 1, user: 14, self: 20 }
  const headerAdded = { work: false, user: false, self: false }
  const included = { work: [], user: [], self: [] }
  const includedIds = []
  const workCap = Math.min(budget, workingBudgetOf(config, moodState, traitsUser))
  let used = 0
  let workUsed = 0
  for (const tier of [0, 1, 2, 3, 4]) {
    for (const item of items) {
      if (item.tier !== tier) continue
      if (item.section === 'user' && config.includeUser === false) continue
      if (item.section === 'self' && config.includeSelf === false) continue
      const extra = headerAdded[item.section] ? 0 : headerCost[item.section]
      if (used + item.cost + extra > budget) continue
      if (item.section === 'work' && workUsed + item.cost + extra > workCap) continue
      included[item.section].push(item.text)
      if (item.id !== undefined) includedIds.push(item.id)
      used += item.cost + extra
      if (item.section === 'work') workUsed += item.cost + extra
      headerAdded[item.section] = true
    }
  }

  // ---- 渲染 ----
  const sections = []
  // v2.3.0：实体优先（本轮提到的对象档案）放在最前面 —— 预算不够时先保它。
  const entitySection = renderEntitySection(entityProfiles, {
    maxChars: Math.max(80, Number(config.entityMaxChars ?? 400)),
    turnLimit: Math.max(1, Number(config.entityTurnLimit ?? 3)),
    related: entityRelated,
  })
  if (entitySection.length > 0) sections.push(entitySection)
  if (included.work.length > 0) {
    sections.push([WORK_MEMORY_HEADER, ...included.work.map((item) => `- ${item}`)].join('\n'))
  }
  if (config.includeUser !== false && included.user.length > 0) {
    sections.push(['【关于你（用户）】', ...included.user.map((item) => `- ${item}`)].join('\n'))
  }
  if (config.includeSelf !== false && included.self.length > 0) {
    sections.push(['【关于我（这个助手）】', ...included.self.map((item) => `- ${item}`)].join('\n'))
  }
  if (sections.length === 0) return { text: '', sections: [], stats }

  const text = [...sections, PROMPT_HINT].join('\n\n').slice(0, maxChars)
  stats.chars = text.length
  stats.workingMemory.count = included.work.length
  stats.workingMemory.ids = includedIds
  stats.workingMemory.chars = included.work.reduce((total, item) => total + item.length + 3, 0)
  // 来源元数据：episode 给 turnIds 指针，旧对话给 turn id / sessionId / seq / 时间——
  // 需要原文时调用 brainMemory.fetchTurn(id) / fetchRange(sessionId, from, to) 精确取回。
  const includedSet = new Set(includedIds)
  stats.workingMemory.sources = sources.filter(
    (source) => includedSet.has(`ep:${source.id}`) || includedSet.has(`turn:${source.id}`),
  )
  stats.recalls.count = included.work.length
  // 记录本轮真正注入过的记忆：下一轮起按冷却窗口抑制重复注入。
  const round = state.round
  for (const id of includedIds) state.seen.set(id, { round })
  return { text, sections, stats }
}

/**
 * 创建上下文整理层服务（`brainContext`）。
 * @param {object} options 依赖。
 * @param {import('@deepseek-ai/cordis').Context} options.ctx Host 上下文。
 * @param {Readonly<import('./config.js').DEFAULT_CONTEXT_CONFIG>} options.config 归一化配置。
 * @param {(event: string, data?: Record<string, unknown>) => void} options.log 日志。
 */
export function createContextService({ ctx, config, log }) {
  const instanceId = `ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  let registered = false
  /** v2.2.0 域角色段是否已注册（与 context 段独立）。 */
  let roleRegistered = false
  /** v2.2.0 角色段（"我是谁"）是否已注册。 */
  let characterRegistered = false
  /** 最近用户消息（sessionId → 最近 3 条文本），用于工作记忆检索。 */
  const recentUserBySession = new Map()
  let latestUserText = ''
  let latestUserAt = 0
  /** 注入冷却状态：同一记忆 3 轮内不重复注入，被再次提到时刷新。 */
  const recallState = { round: 0, seen: new Map() }
  /** 最近注入的工作记忆（供 /brain 与 snapshot 观测）。 */
  let lastRecall = { count: 0, chars: 0, ids: [], sources: [], queryChars: 0, at: null }
  /** 当前正在组装的会话（sectionText 没有 sessionId 参数，用最近一条用户消息的会话）。 */
  let activeSessionId = ''
  /** v2.1.0：上一轮注入、等待归因的片段（sessionId → {items, at, assistantText}）。 */
  const pendingInjections = new Map()
  /** llm judge 单轮最多 1 次（并发保护）。 */
  let judgeInFlight = false
  /** 后台消化器（由插件入口挂上；没有时 /brain consolidate 给中文原因）。 */
  let consolidator = null
  /** 归档器（由插件入口挂上；没有时 /brain archive 状态显示不可用）。 */
  let archiver = null

  /** 记录一条用户消息（只用于检索，不落任何会话数据）。 */
  function rememberUserText(sessionId, text, at) {
    const value = String(text ?? '').trim()
    if (value.length === 0) return
    const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : '(unknown)'
    const list = recentUserBySession.get(key) ?? []
    list.push(value)
    while (list.length > 3) list.shift()
    recentUserBySession.set(key, list)
    activeSessionId = key
    latestUserText = value
    latestUserAt = Number.isFinite(at) ? at : Date.now()
  }

  /** 上一轮用户文本（遗忘信号补充主题词用）。 */
  function previousUserText(sessionId) {
    const list = typeof sessionId === 'string' ? recentUserBySession.get(sessionId) : undefined
    return Array.isArray(list) && list.length > 0 ? list[list.length - 1] : ''
  }

  /**
   * v2.1.0：记录本轮注入（只记注入计数 + 留待下一轮归因）。
   * @param {object} memory brainMemory。
   * @param {string} sessionId 当前会话。
   * @param {object} result buildContextText 的返回值。
   */
  function noteInjection(memory, sessionId, result) {
    const sources = Array.isArray(result?.stats?.workingMemory?.sources) ? result.stats.workingMemory.sources : []
    if (sources.length === 0) return
    const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : activeSessionId
    try {
      if (memory && typeof memory.recordRecallInjection === 'function') memory.recordRecallInjection(sources)
    } catch (error) {
      log('recall-injection-failed', { message: error?.message ?? String(error) })
    }
    if (typeof key === 'string' && key.length > 0) {
      pendingInjections.set(key, { items: sources, at: Date.now(), assistantText: '' })
    }
  }

  /** 把 rule 归因 + （可选）judge 结果应用掉。 */
  function applyAttribution(memory, items, attribution, sessionId) {
    try {
      memory.applyRecallAttribution({ items, attribution })
      if (Array.isArray(attribution.missedTopicTerms) && attribution.missedTopicTerms.length > 0) {
        memory.recordRecallMiss({
          sessionId,
          at: new Date().toISOString(),
          terms: attribution.missedTopicTerms,
          sourceText: 'judge-missed-topic',
        })
      }
    } catch (error) {
      log('recall-attribution-failed', { message: error?.message ?? String(error) })
    }
  }

  /**
   * 下一轮用户消息到达时，给上一轮注入做归因。
   * rule 同步；llm 模式最多 1 次异步 judge（失败退回 rule）。
   */
  function finalizeInjection(memory, sessionId, nextUserText) {
    const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : activeSessionId
    const pending = pendingInjections.get(key)
    if (pending === undefined) return
    pendingInjections.delete(key)
    const info = memory && typeof memory.recallLearning === 'function' ? memory.recallLearning() : { enabled: false }
    if (info.enabled !== true) return
    const items = pending.items
    const attribution = attributeUse({
      injectedItems: items,
      assistantText: pending.assistantText,
      nextUserText,
      mode: info.mode,
    })
    if (info.mode !== 'llm' || judgeInFlight) {
      applyAttribution(memory, items, attribution, key)
      return
    }
    judgeInFlight = true
    judgeAttribution({ ctx, items, assistantText: pending.assistantText, nextUserText })
      .then((judged) => {
        if (judged !== undefined && judged !== null) {
          const scores = { ...attribution.scores }
          for (const id of judged.usedIds) scores[id] = 1
          for (const id of judged.ignoredIds) scores[id] = 0
          attribution.usedIds = [...new Set([...attribution.usedIds, ...judged.usedIds])]
          attribution.echoIds = attribution.echoIds.filter((id) => !judged.usedIds.includes(id))
          attribution.ignoredIds = [...new Set([...attribution.ignoredIds, ...judged.ignoredIds])].filter(
            (id) => !attribution.usedIds.includes(id),
          )
          attribution.scores = scores
          attribution.missedTopicTerms = judged.missedTopicTerms
        }
        applyAttribution(memory, items, attribution, key)
      })
      .catch((error) => {
        log('recall-judge-failed', { message: error?.message ?? String(error) })
        applyAttribution(memory, items, attribution, key)
      })
      .finally(() => {
        judgeInFlight = false
      })
  }

  /** 取本轮检索用的用户文本：优先事件跟踪，其次记忆层最近一轮（5 分钟内）。 */
  function queryTextFor(sessionId, memory) {
    const own = typeof sessionId === 'string' ? recentUserBySession.get(sessionId) : undefined
    if (own !== undefined && own.length > 0) return own[own.length - 1]
    if (latestUserText.length > 0 && Date.now() - latestUserAt < 5 * 60 * 1000) return latestUserText
    const latest = memory && typeof memory.recentTurns === 'function' ? memory.recentTurns(1)[0] : undefined
    return typeof latest?.user === 'string' ? latest.user : ''
  }

  /** 取最近 1–2 轮用户文本（扩展检索词；去掉本轮那条）。 */
  function recentTextsFor(sessionId, memory, currentText) {
    const own = typeof sessionId === 'string' ? recentUserBySession.get(sessionId) : undefined
    if (own !== undefined && own.length > 1) {
      return own.slice(0, -1).slice(-2).filter((text) => text !== currentText)
    }
    if (memory && typeof memory.recentTurns === 'function') {
      return memory
        .recentTurns(3)
        .map((turn) => turn.user)
        .filter((text) => typeof text === 'string' && text.length > 0 && text !== currentText)
        .slice(-2)
    }
    return []
  }

  /** 订阅用户消息（只读事件，带回执 disposer）。 */
  function trackUserMessages() {
    if (!ctx || typeof ctx.on !== 'function') return () => {}
    let dispose
    try {
      dispose = ctx.on('session/event', (session, event) => {
        try {
          const sessionId = String(session?.id ?? session?.header?.id ?? '')
          const at = Number(event?.time) || Date.now()
          if (event?.type === 'assistant/message') {
            // 记下助手回复，等下一轮用户消息到达时再一起归因（单轮最多 1 次 judge）。
            const text = extractMessageText(event.data?.message)
            const pending = pendingInjections.get(sessionId)
            if (pending !== undefined && text.length > 0) pending.assistantText = text
            return
          }
          if (event?.type !== 'user/message') return
          const text = extractMessageText(event.data)
          if (text.length === 0 || looksSynthetic(text)) return
          if (classifyMessage(event.data, { collectSubagents: false }) !== 'user') return
          const memory = layer(ctx, 'brainMemory')
          // 1) 上一轮注入的归因（用本轮 user 文本 + 上一轮 assistant 回复）。
          finalizeInjection(memory, sessionId, text)
          // 2) 遗忘信号：记 miss 并加权相关词，下一轮召回优先。
          if (memory && typeof memory.recordRecallMiss === 'function') {
            const signal = detectForgetSignal(text)
            if (signal !== null) {
              const terms = forgetTopicTerms(text, previousUserText(sessionId))
              if (terms.length > 0) {
                memory.recordRecallMiss({
                  sessionId,
                  turn: Number.isFinite(event.data?.turn) ? Number(event.data.turn) : null,
                  at: new Date(at).toISOString(),
                  terms,
                  sourceText: signal,
                })
              }
            }
          }
          rememberUserText(sessionId, text, at)
        } catch {
          /* 跟踪失败不影响任何流程 */
        }
      })
    } catch (error) {
      log('user-track-failed', { instanceId, message: error?.message ?? String(error) })
      return () => {}
    }
    return () => {
      try {
        dispose?.()
      } catch {
        /* 注销失败忽略 */
      }
    }
  }

  /** 现算一次注入文本（异常返回 ''）。 */
  function sectionText(sessionId) {
    let memory
    let mood
    let persona
    try {
      memory = layer(ctx, 'brainMemory')
      mood = layer(ctx, 'brainMood')
      persona = layer(ctx, 'brainPersona')
      // system prompt 的 section 回调不带 sessionId；用最近一条用户消息的会话兜底，
      // 否则表意识槽位（"眼下在说谁"）拿不到会话就失效了。
      const effectiveSession = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : activeSessionId
      const userText = queryTextFor(effectiveSession, memory)
      const recentUserTexts = recentTextsFor(effectiveSession, memory, userText)
      const result = buildContextText({
        config,
        memory,
        mood,
        persona,
        userText,
        recentUserTexts,
        recallState,
        sessionId: effectiveSession,
      })
      noteInjection(memory, sessionId, result)
      lastRecall = {
        count: result.stats.workingMemory.count,
        chars: result.stats.workingMemory.chars,
        ids: result.stats.workingMemory.ids,
        sources: result.stats.workingMemory.sources ?? [],
        queryChars: result.stats.workingMemory.queryChars,
        at: new Date().toISOString(),
      }
      if (config?.debugSection) {
        log('section-text', {
          instanceId,
          chars: result.text.length,
          sections: result.sections.length,
          layers: { memory: Boolean(memory), mood: Boolean(mood), persona: Boolean(persona) },
          latestUserChars: userText.length,
          workingMemory: lastRecall,
          stats: result.stats,
        })
      }
      return result.text
    } catch (error) {
      try {
        log('context-text-failed', {
          instanceId,
          message: error?.message ?? String(error),
          layers: { memory: Boolean(memory), mood: Boolean(mood), persona: Boolean(persona) },
        })
      } catch {
        /* 连日志都失败就彻底静默 */
      }
      return ''
    }
  }

  /** 组装一次完整上下文（供其它插件 / 命令 / 测试使用）。 */
  function assemble(input = {}) {
    const memory = layer(ctx, 'brainMemory')
    const mood = layer(ctx, 'brainMood')
    const persona = layer(ctx, 'brainPersona')
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : undefined
    const userText =
      typeof input.userText === 'string' && input.userText.length > 0 ? input.userText : queryTextFor(sessionId, memory)
    const recentUserTexts = Array.isArray(input.recentUserTexts)
      ? input.recentUserTexts
      : recentTextsFor(sessionId, memory, userText)
    const result = buildContextText({
      config,
      memory,
      mood,
      persona,
      userText,
      recentUserTexts,
      recallState,
      sessionId,
    })
    noteInjection(memory, sessionId, result)
    lastRecall = {
      count: result.stats.workingMemory.count,
      chars: result.stats.workingMemory.chars,
      ids: result.stats.workingMemory.ids,
      queryChars: result.stats.workingMemory.queryChars,
      at: new Date().toISOString(),
    }
    return {
      systemSections: result.sections,
      text: result.text,
      stats: { ...result.stats, sessionId: sessionId ?? null, layers: result.stats.layers },
    }
  }

  /** 预览（命令 / 调试用）。 */
  function preview() {
    const assembled = assemble({})
    return {
      text: assembled.text,
      sections: assembled.systemSections,
      stats: assembled.stats,
      sectionName: SECTION_NAME,
      order: config.sectionOrder,
      role: {
        name: ROLE_SECTION_NAME,
        enabled: config.roleEnabled,
        registered: roleRegistered,
        order: config.roleSectionOrder,
        text: roleSectionText(),
      },
      character: {
        name: CHARACTER_SECTION_NAME,
        enabled: config.characterEnabled,
        registered: characterRegistered,
        order: config.characterSectionOrder,
        text: characterSectionText(),
      },
    }
  }

  /** 挂上后台消化器（插件入口调用；保持上下文层不直接依赖具体实现）。 */
  function attachConsolidator(instance) {
    consolidator = instance
  }

  /** 挂上归档器（插件入口调用）。 */
  function attachArchiver(instance) {
    archiver = instance
  }

  /** 归档器统计（/brain 与 snapshot 用）。 */
  function archiveStats() {
    return archiver && typeof archiver.stats === 'function' ? archiver.stats() : null
  }

  /**
   * 立即整理一个会话（只触发后台消化，不写会话、不压缩）。
   * @param {string} sessionId 会话 id。
   * @returns {Promise<{ok: boolean, reason?: string, turns?: number, episodeId?: string|null, error?: string}>}
   */
  async function consolidateNow(sessionId) {
    if (consolidator === null || typeof consolidator.consolidateNow !== 'function') {
      return { ok: false, reason: 'unavailable' }
    }
    return consolidator.consolidateNow(sessionId, { reason: 'manual' })
  }

  /** 最近一次工作记忆注入统计（/brain 与 snapshot 用）。 */
  function lastRecallStats() {
    return { ...lastRecall, ids: [...lastRecall.ids], sources: [...(lastRecall.sources ?? [])] }
  }

  /** 长期记忆 / 整理状态（失败给空值，不影响命令）。 */
  function memoryStatus() {
    try {
      const memory = layer(ctx, 'brainMemory')
      if (memory === undefined || typeof memory.counts !== 'function') return null
      return memory.counts()
    } catch {
      return null
    }
  }

  /**
   * 域角色注入文本（v2.2.0）。
   *
   * 纯静态：配置不变，文本就不变 → 适合放在动态 context 段之前，让 system prompt
   * 前缀稳定、能命中缓存。异常一律返回空串（宁可少一段，不能让组装失败）。
   */
  function roleSectionText() {
    try {
      if (!config.roleEnabled) return ''
      return buildRoleText(config.role)
    } catch (error) {
      try {
        log('role-text-failed', { instanceId, message: error?.message ?? String(error) })
      } catch {
        /* 连日志都失败就彻底静默 */
      }
      return ''
    }
  }

  /**
   * 角色段注入文本（v2.2.0，"我是谁"）。
   *
   * 内容来自 DB 里模型写出的自我定义（不是配置里的人设）；还没 bootstrap 时返回空串。
   * 定义变化很慢（攒够证据才修订），所以放在静态规范之后、动态上下文之前。
   */
  function characterSectionText() {
    try {
      if (!config.characterEnabled) return ''
      const memory = layer(ctx, 'brainMemory')
      const character = memory && typeof memory.characterRow === 'function' ? memory.characterRow() : null
      if (!character) return ''
      return renderCharacterSection(character, { maxChars: config.characterMaxChars })
    } catch (error) {
      try {
        log('character-text-failed', { instanceId, message: error?.message ?? String(error) })
      } catch {
        /* 静默 */
      }
      return ''
    }
  }

  /**
   * 注册 system prompt 注入段。由插件入口调用；返回 disposer（未注册时返回 undefined）。
   *
   * v2.2.0 起注册**两段**：
   *   - `dsh-brain:role`（静态域角色，order 默认 90，更靠前）；
   *   - `dsh-brain:context`（每轮现算的工作记忆，order 默认 100）。
   * 静态段放前面，动态段变化时不会把稳定前缀一起打掉。
   */
  function registerPromptSection() {
    if (!config.enabled || registered) return undefined
    try {
      const systemPrompt = ctx.get('systemPrompt')
      if (!systemPrompt || typeof systemPrompt.section !== 'function') {
        log('section-skip', { reason: 'systemPrompt 不可用' })
        return undefined
      }
      const disposers = []
      const disposer = systemPrompt.section({
        name: SECTION_NAME,
        order: config.sectionOrder,
        text: () => sectionText(),
      })
      disposers.push(disposer)
      registered = true
      log('section-registered', { instanceId, name: SECTION_NAME, order: config.sectionOrder, maxChars: config.maxChars })

      // v2.2.0：角色段（模型写出的自我定义，慢变）放在静态规范与动态上下文之间。
      //
      // **无条件注册**：bootstrap 发生在注册之后（第一次后台整理才写第一版）。
      // 早先版本在注册时检查「已有定义」，结果本轮永远挂不上这一段，必须重启才生效。
      // 文本回调是现算的：没定义时返回空串，不会注入空段。
      if (config.characterEnabled) {
        try {
          disposers.push(
            systemPrompt.section({
              name: CHARACTER_SECTION_NAME,
              order: config.characterSectionOrder,
              text: () => characterSectionText(),
            }),
          )
          characterRegistered = true
          log('character-section-registered', {
            instanceId,
            name: CHARACTER_SECTION_NAME,
            order: config.characterSectionOrder,
            chars: characterSectionText().length,
          })
        } catch (error) {
          log('character-section-failed', { instanceId, message: error?.message ?? String(error) })
        }
      }

      if (config.roleEnabled) {
        const roleText = roleSectionText()
        if (roleText.length > 0) {
          try {
            disposers.push(
              systemPrompt.section({
                name: ROLE_SECTION_NAME,
                order: config.roleSectionOrder,
                text: () => roleText,
              }),
            )
            roleRegistered = true
            log('role-section-registered', {
              instanceId,
              name: ROLE_SECTION_NAME,
              order: config.roleSectionOrder,
              chars: roleText.length,
            })
          } catch (error) {
            log('role-section-failed', { instanceId, message: error?.message ?? String(error) })
          }
        } else {
          log('role-section-skip', { reason: 'role 配置为空' })
        }
      }

      return () => {
        registered = false
        roleRegistered = false
        characterRegistered = false
        log('section-disposed', { instanceId, name: SECTION_NAME })
        for (const dispose of disposers) {
          try {
            dispose?.()
          } catch {
            /* 注销失败不影响卸载 */
          }
        }
      }
    } catch (error) {
      log('section-failed', { instanceId, message: error?.message ?? String(error) })
      return undefined
    }
  }

  const service = {
    name: 'dsh-context',
    config,
    assemble,
    preview,
    registerPromptSection,
    sectionText,
    trackUserMessages,
    attachConsolidator,
    attachArchiver,
    consolidateNow,
    lastRecallStats,
    archiveStats,
    memoryStatus,
    snapshot() {
      const counts = memoryStatus()
      const organization = consolidator && typeof consolidator.stats === 'function' ? consolidator.stats() : null
      return {
        enabled: config.enabled,
        sectionName: SECTION_NAME,
        order: config.sectionOrder,
        maxChars: config.maxChars,
        workingMemoryMaxChars: config.workingMemoryMaxChars,
        registered,
        // v2.2.0：域角色段（静态，单独观测）。
        role: {
          name: ROLE_SECTION_NAME,
          enabled: config.roleEnabled,
          registered: roleRegistered,
          order: config.roleSectionOrder,
          chars: roleSectionText().length,
          summary: roleSummary(config.role, { enabled: config.roleEnabled, order: config.roleSectionOrder }),
        },
        // v2.2.0：角色段（模型写出的自我定义，慢变）。
        character: {
          name: CHARACTER_SECTION_NAME,
          enabled: config.characterEnabled,
          registered: characterRegistered,
          order: config.characterSectionOrder,
          chars: characterSectionText().length,
        },
        consolidated: counts?.consolidated ?? 0,
        unconsolidated: counts?.unconsolidated ?? 0,
        episodes: counts?.episodes ?? 0,
        lastConsolidateAt: counts?.lastConsolidateAt ?? null,
        workingMemory: lastRecallStats(),
        organization,
        archive: {
          enabled: config.archiveEnabled === true,
          dryRun: config.archiveDryRun !== false,
          archivedTurns: counts?.archived ?? 0,
          archives: counts?.archives ?? 0,
          stats: archiveStats(),
        },
        learning: (() => {
          const memory = layer(ctx, 'brainMemory')
          return memory && typeof memory.learningStats === 'function' ? memory.learningStats() : null
        })(),
        layers: {
          memory: Boolean(layer(ctx, 'brainMemory')),
          mood: Boolean(layer(ctx, 'brainMood')),
          persona: Boolean(layer(ctx, 'brainPersona')),
        },
      }
    },
  }
  return service
}

/** 一层不可用时的中文提示。 */
function missing(layerName) {
  return `（${layerName}层当前不可用）`
}

/**
 * 构造 `/brain` 命令定义（由上下文层插件注册）。
 * @param {object} options 依赖。
 * @param {import('@deepseek-ai/cordis').Context} options.ctx Host 上下文。
 * @param {Readonly<import('./config.js').DEFAULT_CONTEXT_CONFIG>} options.config 上下文配置。
 * @param {(event: string, data?: Record<string, unknown>) => void} options.log 日志。
 * @returns {object} CommandDefinition
 */
export function buildCommandDefinition({ ctx, config, log }) {
  /** 执行一条 /brain 子命令（绝不抛出）。 */
  async function execute(invocation) {
    const rawInput = invocation?.rawInput
    const sessionId = typeof invocation?.agent?.id === 'string' ? invocation.agent.id : ''
    try {
      const args = String(rawInput ?? '').trim().toLowerCase().split(/\s+/u).filter((item) => item.length > 0)
      const command = args[0] ?? ''
      const memory = layer(ctx, 'brainMemory')
      const mood = layer(ctx, 'brainMood')
      const persona = layer(ctx, 'brainPersona')
      const context = layer(ctx, 'brainContext')

      if (command === '' || command === 'status') return overview({ memory, mood, persona, context, config })
      if (command === 'memory') {
        const query = args.slice(1).join(' ').trim()
        return query.length > 0 ? memorySearchView({ memory, query }) : memoryView({ memory, context })
      }
      if (command === 'recall') {
        const query = args.slice(1).join(' ').trim()
        return recallView({ memory, context, query })
      }
      if (command === 'learn' || command === '学习') return learningView({ memory })
      if (command === 'mood') return moodView({ mood })
      if (command === 'persona') return personaView({ persona })
      if (command === 'profile' || command === '角色') return profileView({ config })
      if (command === 'who' || command === '我') {
        return whoView({ ctx, memory, config, log, args: args.slice(1) })
      }
      if (command === 'patient' || command === 'entity' || command === '对象') {
        return patientView({ memory, args: args.slice(1) })
      }
      if (command === 'consolidate' || command === '整理') {
        return consolidateView({ context, sessionId })
      }
      if (command === 'reset') {
        if (!args.includes('confirm') && !args.includes('确认')) {
          return { kind: 'error', text: '重置需要确认：/brain reset confirm' }
        }
        return resetAll({ memory, mood, persona })
      }
      return {
        kind: 'error',
        text: '用法：/brain [memory|recall|learn|mood|persona|profile|who|patient|consolidate|reset confirm]',
      }
    } catch (error) {
      log('command-failed', { message: error?.message ?? String(error) })
      return { kind: 'error', text: `brain 命令执行失败：${error?.message ?? String(error)}` }
    }
  }

  return {
    name: 'brain',
    description: '查看/整理 DSH 助手大脑（双向记忆、情绪、人格、域角色、角色自我定义、工作记忆、召回学习）',
    input: { hint: '[memory|recall|learn|mood|persona|profile|who|patient|consolidate|reset confirm]' },
    handler: (invocation) => execute(invocation),
  }
}

/** `/brain consolidate`：只触发后台消化，不写会话、不压缩。 */
async function consolidateView({ context, sessionId }) {
  if (!context || typeof context.consolidateNow !== 'function') {
    return { kind: 'error', text: missing('上下文整理') }
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { kind: 'error', text: '拿不到当前会话 id，暂时无法整理。' }
  }
  const result = await context.consolidateNow(sessionId)
  if (result?.ok === true) {
    const pieces = [`已整理 ${result.turns ?? 0} 轮原文`]
    if (result.episodeId !== undefined && result.episodeId !== null) pieces.push('新增 1 条情节记忆')
    pieces.push('长期摘要已更新（原文无损保留，未改任何会话内容）')
    return { kind: 'success', text: `后台整理完成：${pieces.join('，')}。` }
  }
  const reasons = {
    nothing: '没有待整理的轮次（都整理过了）。',
    'not-enough': '待整理的轮次还不够，再聊几轮会自动整理。',
    busy: '这个会话正在整理中，稍后再试。',
    disabled: '后台整理已在配置里关闭（consolidateEnabled: false）。',
    'memory-unavailable': '记忆层当前不可用，无法整理。',
    disposed: '插件正在卸载，稍后再试。',
    unavailable: '整理器没有挂载（上下文层可能被单独停用）。',
    'no-session': '拿不到当前会话 id。',
  }
  const reason = reasons[result?.reason] ?? `整理没有完成（${result?.reason ?? '未知原因'}）。`
  return { kind: 'error', text: reason }
}

/** `/brain` 总览。 */
function overview({ memory, mood, persona, context, config }) {
  const lines = ['DSH 助手大脑']
  if (memory && typeof memory.snapshot === 'function') {
    const snapshot = memory.snapshot()
    const counts = snapshot.counts
    lines.push(`记忆：${counts.turns} 轮，user 侧 ${counts.facts.user} 条事实，self 侧 ${counts.facts.self} 条事实`)
    const summaries = memory.summaries()
    lines.push(`摘要：user ${summaries.user.text.length} 字 / self ${summaries.self.text.length} 字`)
    const parts = [
      `长期记忆：事实 ${counts.facts.user + counts.facts.self} / 情节 ${counts.episodes ?? 0} / 摘要 ${summaries.user.text.length + summaries.self.text.length} 字`,
      `上次整理：${counts.lastConsolidateAt ?? '（还没有）'}`,
    ]
    if (context && typeof context.lastRecallStats === 'function') {
      const recall = context.lastRecallStats()
      parts.push(`本轮工作记忆注入：${recall.count} 条 ${recall.chars} 字`)
    }
    lines.push(parts.join(' · '))
    lines.push(
      `角色隔离：system/工具轮 ${counts.systemTurns ?? 0} 条（隔离事件 ${counts.events ?? 0}） · 召回学习：${snapshot.learning?.enabled ? `开（${snapshot.learning.mode}）` : '关'}`,
    )
    lines.push(
      `归档：${counts.archived ?? 0} 轮已从会话移除（${counts.archives ?? 0} 次，原文全存） · 开关 ${config.archiveEnabled ? '开' : '关'}${config.archiveDryRun ? ' · dryRun' : ''}`,
    )
  } else {
    lines.push(`记忆：${missing('记忆')}`)
  }
  if (mood && typeof mood.current === 'function') {
    const state = mood.current()
    lines.push(`用户情绪：${levelWord(state.user)}；助手状态：${state.self.status}`)
  } else {
    lines.push(`情绪：${missing('情绪')}`)
  }
  if (persona && typeof persona.traits === 'function') {
    lines.push(`人格：用户沟通偏好已收集，助手倾向已收集`)
  } else {
    lines.push(`人格：${missing('人格')}`)
  }
  if (context && typeof context.preview === 'function') {
    const preview = context.preview()
    lines.push(`注入：${config.enabled ? '已注册' : '已关闭'}，${preview.text.length} 字${preview.text.length > 0 ? '' : '（当前为空）'}`)
    const role = preview.role
    if (role && role.enabled) {
      lines.push(
        role.text.length > 0
          ? `域角色：${config?.role?.title || config?.role?.domain || '已配置'}（${role.text.length} 字，order ${role.order}${role.registered ? '' : '，未注册'}）`
          : '域角色：已开启但内容为空（/brain profile 看详情）',
      )
    } else {
      lines.push('域角色：未开启（roleEnabled: false）')
    }
    const self = preview.character
    if (self && self.enabled) {
      lines.push(
        self.text.length > 0
          ? `角色（我是谁）：已有定义 ${self.text.length} 字（order ${self.order}${self.registered ? '' : '，未注册'}）· /brain who 看全文`
          : '角色（我是谁）：还没有定义（等后台整理 bootstrap）· /brain who revise 可立即生成',
      )
    } else {
      lines.push('角色（我是谁）：未开启（characterEnabled: false）')
    }
  }
  lines.push(
    '明细：/brain memory | /brain mood | /brain persona | /brain profile | /brain who | /brain consolidate（立即整理一次）',
  )
  return { kind: 'success', text: lines.join('\n') }
}

/** 用文字描述一侧情绪（不暴露数值）。 */
function levelWord(state) {
  if (!state) return '未知'
  const energy = describeLevel(state.energy, { high: '精力不错', mid: '精力一般', low: '有点累' })
  const valence = describeLevel(state.valence, { high: '心情不错', mid: '心情平稳', low: '心情偏低' })
  return `${energy}，${valence}`
}

/** `/brain recall <关键词>`：召回调试（显示打分构成与原文片段）。 */
function recallView({ memory, context, query }) {
  if (query.length === 0) return { kind: 'error', text: '用法：/brain recall <关键词>（看召回打分与原文片段）' }
  if (!memory || typeof memory.recallOriginals !== 'function') return { kind: 'error', text: missing('记忆') }
  let results = []
  try {
    results = memory.recallOriginals(query, { limit: 8, recentTexts: '', topicShiftEnabled: false }) ?? []
  } catch (error) {
    return { kind: 'error', text: `召回失败：${error?.message ?? String(error)}` }
  }
  const lines = [`召回调试：${oneLine(query, 50)}（未开话题过滤，便于看全量候选）`]
  if (results.length === 0) {
    lines.push('没有命中任何原文；换更短的关键词试试（记忆库是全存的）。')
  }
  for (const result of results) {
    const components = result.components
    const parts = []
    if (components !== null && typeof components === 'object') {
      parts.push(`相关 ${Number(components.relevance ?? 0).toFixed(2)}`)
      if (result.kind === 'episode') parts.push(`重要 ${Number(components.salience ?? 0).toFixed(2)}`)
      parts.push(`话题 ${Number(components.topic ?? 0).toFixed(2)}`)
      parts.push(`新近 ${Number(components.recency ?? 0).toFixed(2)}`)
      parts.push(`学习词 ×${Number(result.learnedTerm ?? 1).toFixed(2)}`)
    } else {
      parts.push(`相关 ${Number(result.relevance).toFixed(2)}`)
      parts.push(`话题 ${Number(result.topicOverlap).toFixed(2)}`)
    }
    lines.push(
      `- [${recallTimeLabel(result.at)} · ${turnLabelOf(result)} · ${result.archived === 1 ? '已归档' : '在库'}] ` +
        `score ${Number(result.score).toFixed(3)}（${parts.join(' · ')}）`,
    )
    lines.push(`  "${oneLine(result.snippet, 100)}"`)
  }
  lines.push('提示：实际注入会按话题连续性过滤无关归档，并受 recallMaxChars 预算限制；学习词 ×N 为自学习 term 权重倍率。')
  return { kind: 'success', text: lines.join('\n') }
}

/** `/brain learn`：召回自学习效果（命中率 / top 学到的词 / 最近 misses / 特征权重）。 */
function learningView({ memory }) {
  if (!memory || typeof memory.learningStats !== 'function') return { kind: 'error', text: missing('记忆') }
  let stats
  try {
    stats = memory.learningStats()
  } catch (error) {
    return { kind: 'error', text: `读取学习统计失败：${error?.message ?? String(error)}` }
  }
  const lines = ['召回学习']
  if (stats.enabled !== true) {
    lines.push('状态：已关闭（memory 配置 recallLearningEnabled: false）')
    return { kind: 'success', text: lines.join('\n') }
  }
  const items = stats.items ?? {}
  lines.push(
    `状态：开（${stats.mode === 'llm' ? 'llm judge' : 'rule 归因'}）· 跟踪 ${items.tracked ?? 0} 条 · ` +
      `注入 ${items.injected ?? 0} 次 · 命中率 ${(Number(items.hitRate ?? 0) * 100).toFixed(0)}%（used ${items.used ?? 0} / ignored ${items.ignored ?? 0}）`,
  )
  const top = Array.isArray(stats.topTerms) ? stats.topTerms : []
  if (top.length === 0) {
    lines.push('学到的词：（还没有；多聊几轮、召回被接话后会开始学）')
  } else {
    lines.push(
      `学到的词：${top
        .slice(0, 6)
        .map((entry) => `${entry.term}×${Number(entry.weight).toFixed(2)}(${entry.hits}/${entry.misses})`)
        .join(' · ')}`,
    )
  }
  const features = stats.features ?? {}
  lines.push(
    `特征权重：相关 ${Number(features.relevance ?? 1).toFixed(2)} · 重要 ${Number(features.salience ?? 1).toFixed(2)} · ` +
      `新近 ${Number(features.recency ?? 1).toFixed(2)} · 话题 ${Number(features.topic ?? 1).toFixed(2)} · 好感 ${Number(features.affection ?? 1).toFixed(2)}`,
  )
  const misses = Array.isArray(stats.recentMisses) ? stats.recentMisses : []
  if (misses.length === 0) {
    lines.push('最近的 miss：（无）')
  } else {
    lines.push('最近的 miss：')
    for (const miss of misses.slice(0, 3)) {
      lines.push(`  - [${recallTimeLabel(miss.at)}] ${miss.terms.join(' / ')}${miss.sourceText ? ` ← ${oneLine(miss.sourceText, 50)}` : ''}`)
    }
  }
  lines.push(`已记录 ${stats.misses ?? 0} 次「你忘了/不记得」信号；关闭学习：memory 配置 recallLearningEnabled: false。`)
  return { kind: 'success', text: lines.join('\n') }
}

/** `/brain memory <关键词>`：按关键词列出原文（截断展示，供人工核查）。 */
function memorySearchView({ memory, query }) {
  if (!memory || typeof memory.searchTurns !== 'function') return { kind: 'error', text: missing('记忆') }
  let rows = []
  try {
    rows = memory.searchTurns(query, { limit: 5 }) ?? []
  } catch (error) {
    return { kind: 'error', text: `原文检索失败：${error?.message ?? String(error)}` }
  }
  if (rows.length === 0) {
    return {
      kind: 'success',
      text: `没有在原文里找到「${oneLine(query, 40)}」。原文都在 memory_turns 里，可以换更短的关键词再试。`,
    }
  }
  const lines = [`原文检索：${oneLine(query, 40)}（命中 ${rows.length} 轮）`]
  for (const turn of rows) {
    lines.push(
      `- [${dayLabel(turn.at)} · ${turn.sessionId ?? '未知会话'} · seq ${turn.seq ?? '-'}] 用户：${oneLine(turn.user, 80)}`,
    )
    lines.push(`  助手：${oneLine(turn.assistant, 80)}`)
    lines.push(`  id：${turn.id}（原文完整保留，可按 id 精确取回）`)
  }
  lines.push('提示：/brain memory 看长期记忆概览；关键词越短越容易命中。')
  return { kind: 'success', text: lines.join('\n') }
}

/** `/brain memory`。 */
function memoryView({ memory, context }) {
  if (!memory || typeof memory.snapshot !== 'function') return { kind: 'error', text: missing('记忆') }
  const snapshot = memory.snapshot()
  const memoryConfig = memory.config ?? {}
  const lines = ['记忆层']
  lines.push(`采集：${snapshot.counts.collected} 轮（原文保留 ${snapshot.counts.turns} 轮；system 隔离 ${snapshot.counts.systemTurns ?? 0} 条 / 事件 ${snapshot.counts.events ?? 0}）`)
  const kindList = (facts) =>
    facts.length === 0
      ? '（空）'
      : facts
          .slice(0, 8)
          .map((fact) => `  - [${fact.kind}] ${oneLine(fact.text, 50)}`)
          .join('\n')
  lines.push(`用户侧事实：\n${kindList(snapshot.facts.user)}`)
  lines.push(`助手侧事实：\n${kindList(snapshot.facts.self)}`)
  if (snapshot.summaries.user.text.length > 0) lines.push(`用户侧摘要：${oneLine(snapshot.summaries.user.text, 120)}`)
  if (snapshot.summaries.self.text.length > 0) lines.push(`助手侧摘要：${oneLine(snapshot.summaries.self.text, 120)}`)
  // 情节记忆：后台消化产出的小摘要（原文仍在 memory_turns，这里只是指针摘要）。
  const counts = snapshot.counts
  lines.push(
    `长期记忆：已整理 ${counts.consolidated ?? 0} 轮 / 待整理 ${counts.unconsolidated ?? 0} 轮，情节 ${counts.episodes ?? 0} 条`,
  )
  const episodes = Array.isArray(snapshot.episodes) ? snapshot.episodes : []
  if (episodes.length === 0) {
    lines.push('情节记忆：（空）')
  } else {
    lines.push('情节记忆：')
    for (const episode of episodes.slice(0, 3)) {
      lines.push(`  - [${episode.at}] ${oneLine(episode.summary, 90)}（重要度 ${episode.salience.toFixed(2)}）`)
    }
  }
  if (context && typeof context.lastRecallStats === 'function') {
    const recall = context.lastRecallStats()
    lines.push(`本轮工作记忆：注入 ${recall.count} 条 ${recall.chars} 字${recall.ids.length > 0 ? `（${recall.ids.join(', ')}）` : ''}`)
  }
  lines.push(
    `采集模式：每 ${memoryConfig.factExtractInterval ?? 3} 轮抽取一次；过滤 subagent=${memoryConfig.collectSubagents ? '是' : '否'}`,
  )
  const collector = snapshot.counts.collector
  if (collector !== undefined && collector !== null) {
    const skipReasons = Object.entries(collector.skippedByReason ?? {})
      .sort((left, right) => right[1] - left[1])
      .slice(0, 4)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(' ')
    const filterReasons = Object.entries(collector.filteredByReason ?? {})
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(' ')
    lines.push(
      `采集诊断：已采 ${collector.collected}${skipReasons.length > 0 ? `，跳过 ${skipReasons}` : ''}${filterReasons.length > 0 ? `，过滤 ${filterReasons}` : ''}`,
    )
  }
  lines.push('原文检索：/brain memory <关键词>（按关键词列出原文，截断展示）')
  return { kind: 'success', text: lines.join('\n') }
}

/** `/brain mood`。 */
function moodView({ mood }) {
  if (!mood || typeof mood.current !== 'function') return { kind: 'error', text: missing('情绪') }
  const state = mood.current()
  const lines = ['情绪层']
  lines.push(`用户：${levelWord(state.user)}`)
  lines.push(`助手：状态「${state.self.status}」，${describeLevel(state.self.energy, { high: '精力充沛', mid: '精力一般', low: '有点疲惫' })}，${describeLevel(state.self.affection, { high: '和用户很熟', mid: '和用户相处自然', low: '和用户还在熟悉中' })}`)
  const userHistory = mood.history('user', 3)
  const selfHistory = mood.history('self', 3)
  if (userHistory.length > 0) lines.push(`用户近期：${userHistory.map((entry) => entry.reason || '平稳').join(' → ')}`)
  if (selfHistory.length > 0) {
    lines.push(`助手近期：${selfHistory.map((entry) => `${entry.status}(${entry.reason || '平稳'})`).join(' → ')}`)
  }
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * `/brain who`（v2.2.0 角色层）：看"我是谁"。
 *
 * - `/brain who`            当前定义 + 版本 + 证据轮数 + 最近几版
 * - `/brain who revise`     立刻让模型按对话重写一版（bootstrap 或 revise 自判）
 * - `/brain who name 名字`   改角色名（不产生新版本）
 */
async function whoView({ ctx, memory, config, log, args }) {
  const store = memory && typeof memory.characters === 'function' ? memory.characters() : null
  if (!store) return { kind: 'error', text: missing('记忆') }
  const sub = String(args?.[0] ?? '').toLowerCase()

  if (sub === 'name' || sub === '改名' || sub === 'rename') {
    const name = String(args.slice(1).join(' ') ?? '').trim()
    if (name.length === 0) return { kind: 'error', text: '用法：/brain who name <角色名>' }
    memory.renameCharacter({ name })
    return { kind: 'success', text: `角色名已改为「${name}」（定义不变）。` }
  }

  if (sub === 'revise' || sub === '重写') {
    const counts = memory.counts()
    const turns = memory.recentOriginal(8)
    const evidenceTexts = turns.map((turn) => `用户：${oneLine(turn.user ?? '', 120)}\n助手：${oneLine(turn.assistant ?? '', 120)}`)
    const current = memory.characterRow()
    const mode = current && current.version > 0 ? 'revise' : 'bootstrap'
    const result = await runCharacterStep({
      ctx,
      config,
      memory,
      log,
      mode,
      payload: {
        name: current?.name ?? '',
        evidenceTurns: counts.turns,
        evidenceTexts,
        lastEvidenceSeq: 0,
      },
    })
    if (!result.ok) return { kind: 'error', text: `重写失败：${result.reason ?? '未知原因'}` }
    return {
      kind: 'success',
      text: [
        `已按 ${counts.turns} 轮对话${mode === 'bootstrap' ? '写出第一版' : '重写一版'}（来源：${result.source === 'llm' ? '模型' : '规则兜底'}，v${result.character.version}）。`,
        '',
        result.character.definition,
      ].join('\n'),
    }
  }

  const character = memory.characterRow()
  if (!character || character.version === 0 || character.definition.trim().length === 0) {
    return {
      kind: 'info',
      text: [
        '角色还没有定义（等第一轮后台整理后，由模型按对话写出第一版）。',
        `开关：characterEnabled = ${config?.characterEnabled === false ? '关' : '开'}；攒够 ${config?.characterReviseEveryTurns ?? 6} 轮证据才修订一次。`,
        '想立刻生成：/brain who revise',
      ].join('\n'),
    }
  }
  const lines = [
    `角色：${character.name || '（未命名）'} · v${character.version} · 来自${character.source === 'llm' ? '模型' : character.source === 'fallback' ? '规则兜底' : character.source} · 证据 ${character.evidenceTurns} 轮`,
    '',
    character.definition,
  ]
  const versions = memory.characterVersions(3)
  if (versions.length > 1) {
    lines.push('', `历史版本：${versions.filter((item) => item.version !== character.version).map((item) => `v${item.version}(${item.reason})`).join(' · ')}`)
  }
  lines.push('', '操作：/brain who revise（立刻重写） · /brain who name <名字>')
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * `/brain patient [名字]`（v2.3.0 实体层）。
 *
 * - 不带参数：列出已知对象（类型、被聊过的轮数）
 * - 带名字：这个对象的档案（带时间要点 + 最近聊到的原文片段）
 */
function patientView({ memory, args }) {
  if (!memory || typeof memory.entityList !== 'function') return { kind: 'error', text: missing('记忆') }
  const query = String(args?.join(' ') ?? '').trim()
  if (query.length === 0) {
    const items = memory.entityList(20)
    if (items.length === 0) {
      return {
        kind: 'info',
        text: '还没有识别出任何对象。规则只认明确信号（「患者张三」「客户：李姐」「张三先生」），宁缺毋滥。',
      }
    }
    const lines = [`已知对象 ${items.length} 个：`]
    for (const entity of items) {
      const profile = memory.entityProfile(entity.id, { factLimit: 0, turnLimit: 0 })
      lines.push(`- ${entity.name}（${labelOfKind(entity.kind)}，聊过 ${profile?.turnCount ?? 0} 轮）`)
    }
    lines.push('', '看详情：/brain patient <名字>')
    return { kind: 'success', text: lines.join('\n') }
  }
  const profile = memory.entityProfile(query, { factLimit: 8, turnLimit: 4 })
  if (!profile) return { kind: 'error', text: `没有找到对象「${query}」。` }
  const lines = [`${profile.name}（${labelOfKind(profile.kind)}）· 关联 ${profile.turnCount} 轮`]
  if (profile.facts.length > 0) {
    lines.push('', '带时间的要点：')
    for (const fact of profile.facts) {
      lines.push(`- ${String(fact.at ?? '').slice(0, 16)} ${oneLine(fact.text, 100)}`)
    }
  }
  if (profile.turns.length > 0) {
    lines.push('', '最近聊到：')
    for (const turn of profile.turns) {
      lines.push(`- ${String(turn.at ?? '').slice(0, 16)} ${oneLine(turn.user, 80)}`)
    }
  }
  return { kind: 'success', text: lines.join('\n') }
}

/** 实体类型的中文名（命令输出用）。 */
function labelOfKind(kind) {
  switch (kind) {
    case 'patient':
      return '患者'
    case 'client':
      return '客户'
    case 'project':
      return '项目'
    case 'pet':
      return '宠物'
    default:
      return '对象'
  }
}

/**
 * `/brain profile`（v2.2.0 域角色）：把**实际会注入的原文**打出来。
 *
 * 为什么要能看原文：角色/红线是"模型看到的东西"，如果只能看配置，很容易出现
 * 「以为写了红线，其实这一段没注册」的情况。
 */
function profileView({ config }) {
  const role = config?.role
  const lines = [roleSummary(role, { enabled: config?.roleEnabled, order: config?.roleSectionOrder })]
  const text = config?.roleEnabled ? buildRoleText(role) : ''
  if (text.length === 0) {
    lines.push('')
    lines.push(
      '这一层没有注入任何内容。在 `dsh-context` 的 config 里填 `roleEnabled: true` + `role`（domain / title / identity / expertise / rules / redlines / referrals）后生效。',
    )
    return { kind: 'info', text: lines.join('\n') }
  }
  lines.push('')
  lines.push(`—— 注入原文（${text.length} 字，order ${config?.roleSectionOrder}）——`)
  lines.push(text)
  return { kind: 'success', text: lines.join('\n') }
}

/** `/brain persona`。 */
function personaView({ persona }) {
  if (!persona || typeof persona.render !== 'function') return { kind: 'error', text: missing('人格') }
  const rendered = persona.render()
  return { kind: 'success', text: ['人格层', rendered.text].join('\n') }
}

/** `/brain reset confirm`。 */
function resetAll({ memory, mood, persona }) {
  const backups = []
  const details = []
  for (const [name, service] of [
    ['记忆', memory],
    ['情绪', mood],
    ['人格', persona],
  ]) {
    if (!service || typeof service.reset !== 'function') {
      details.push(`${name}：不可用，跳过`)
      continue
    }
    try {
      const result = service.reset({ backup: true })
      backups.push(...(result?.backups ?? []))
      details.push(`${name}：已重置`)
    } catch (error) {
      details.push(`${name}：重置失败（${error?.message ?? String(error)}）`)
    }
  }
  return {
    kind: 'success',
    text: ['已重置大脑（已备份原文件）', ...details, backups.length > 0 ? `备份：${backups.length} 个文件` : '备份：无'].join('\n'),
  }
}

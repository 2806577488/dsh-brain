/**
 * 深月桌面脑：记忆层（dsh-memory）。
 *
 * **双向建模**：
 *   - `side: 'user'` = 关于用户（对助手而言是「你」）：身份画像、偏好、在做的项目、
 *     约定、事件、沟通风格；
 *   - `side: 'self'` = 关于助手自己（对插件而言是「我」）：记下的承诺、关系进展、
 *     表达习惯。
 *
 * 存储：SQLite（`brain.db`，见 `src/db.js`）。原文轮次、双向结构化事实、双向摘要、
 * 采集序号全部落库；事实按归一化文本相似度去重（≥0.8 视为同一条，DB 里另有
 * `UNIQUE(side, norm)` 兜底），每侧条数受 `maxFactsPerSide` 约束，按权重 × 新近度淘汰。
 *
 * 本层不暴露原始文本给外部（除服务 API 与本地文件）；采集由 `src/collect.js` 驱动，
 * 低频摘要/LLM 事实补充异步执行、失败静默，不影响 DSH 主链路。
 */

import fs from 'node:fs'
import path from 'node:path'

import { acquireDatabase, getMetaValue, normalizeForDb, setMeta } from './db.js'
import { createCharacterStore } from './character.js'
import { createEntityStore } from './entities.js'
import { createLearningStore } from './learning.js'
import { completeText, resolveRoute } from './llm.js'
import { FACT_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT } from './prompts.js'
import { clamp01, oneLine, shortId } from './store.js'

/** 事实的两侧。 */
export const FACT_SIDES = Object.freeze(['user', 'self'])

/** user 侧（关于用户）允许的事实类型。 */
export const USER_FACT_KINDS = Object.freeze(['profile', 'preference', 'project', 'promise', 'event', 'style', 'other'])

/** self 侧（关于助手自己）允许的事实类型。 */
export const SELF_FACT_KINDS = Object.freeze(['memory', 'promise', 'relation', 'habit', 'other'])

/** 每侧各类型的初始权重。 */
const KIND_WEIGHT = Object.freeze({
  profile: 0.9,
  promise: 0.85,
  project: 0.8,
  preference: 0.72,
  style: 0.7,
  event: 0.6,
  memory: 0.7,
  relation: 0.65,
  habit: 0.6,
  other: 0.5,
})

/** 每侧各类型在提示词里的优先级。 */
const KIND_PRIORITY = Object.freeze({
  profile: 1,
  promise: 0.85,
  project: 0.8,
  preference: 0.76,
  style: 0.72,
  memory: 0.7,
  relation: 0.68,
  habit: 0.6,
  event: 0.5,
  other: 0.3,
})

const FILLER_PREFIX =
  /^(?:其实|其实呢|而且|然后|不过|但是|可是|所以|对了|那个|就是|还有|另外|反正|总之|好吧|话说|嗯+|哦+|唉)[，,、\s]*/u
const TAIL_PARTICLES = /[了啊呀呢吧哦哈啦嘛诶]+$/u

/** 把一段文本拆成分句。 */
function splitClauses(text) {
  const result = []
  for (const sentence of String(text ?? '').split(/[。！？!?\n\r]+/u)) {
    for (const piece of sentence.split(/[；;，,]/u)) {
      const clause = piece.trim()
      if (clause.length > 0) result.push(clause)
    }
  }
  return result
}

/** 问句 / 反问句不能抽成事实。 */
function looksLikeQuestion(clause) {
  if (/[?？]\s*$/u.test(clause)) return true
  if (/(?:吗|么|呢|嘛)\s*$/u.test(clause)) return true
  if (/^(?:你|您)/u.test(clause)) return true
  return false
}

/** user 侧：把第一人称改写成「用户」视角。 */
function toUserVoice(clause) {
  let value = clause.replace(FILLER_PREFIX, '').trim()
  value = value.replace(/^我(?!们)/u, '用户').replace(/^俺/u, '用户')
  if (!/^用户/u.test(value)) value = `用户${value}`
  value = value.replace(TAIL_PARTICLES, '').trim()
  return value.replace(/[「」“”"']/gu, '').replace(/\s+/gu, ' ').trim()
}

/** self 侧：保持助手第一人称（「我答应…」），去掉语气词。 */
function toSelfVoice(clause) {
  let value = clause.replace(FILLER_PREFIX, '').trim()
  value = value.replace(TAIL_PARTICLES, '').trim()
  return value.replace(/[「」“”"']/gu, '').replace(/\s+/gu, ' ').trim()
}

/**
 * 从用户文本里抽 user 侧事实（纯规则）。
 * @param {string} text 用户消息。
 * @returns {{text: string, kind: string, weight: number}[]}
 */
export function extractUserFacts(text) {
  const facts = []
  const seen = new Set()
  for (const clause of splitClauses(text)) {
    const raw = clause.trim()
    if (raw.length < 4 || raw.length > 80 || looksLikeQuestion(raw)) continue
    let fact

    // profile：名字 / 身份
    const nameMatch =
      /(?:^我(?:的名字)?(?:叫|是叫)|^叫我|^我名字(?:叫|是))\s*[「“"']?([\u4e00-\u9fa5A-Za-z0-9_·]{1,12})/u.exec(raw)
    if (nameMatch) {
      fact = { text: `用户叫${nameMatch[1].replace(/[」”"']/gu, '')}`, kind: 'profile', weight: 0.92 }
    }
    if (!fact) {
      const occupation = /(?:主播|程序员|学生|设计师|老师|工程师|上班族|自由职业|写代码的|up主|UP主|博主)/u.exec(raw)
      if (occupation && /^我是/u.test(raw)) fact = { text: `用户是${occupation[0]}`, kind: 'profile', weight: 0.88 }
    }
    // style：沟通习惯
    if (!fact && /(?:直接说|简单点|简短点|别废话|说重点|详细点|展开说说|不要太长)/u.test(raw)) {
      const style = /(?:直接说|简单点|简短点|别废话|说重点)/u.test(raw) ? '直接、简短' : '希望回答更详细'
      fact = { text: `用户偏好${style}的回答`, kind: 'style', weight: 0.72 }
    }
    // preference：喜欢 / 讨厌（排除对助手表白式的「喜欢你」）
    if (
      !fact &&
      /(?:喜欢|讨厌|偏爱|受不了|爱吃|爱喝|不爱|最喜欢|不太喜欢|不喜欢)/u.test(raw) &&
      /^我/u.test(raw) &&
      !/(?:喜欢|爱)(?:你|您)/u.test(raw)
    ) {
      fact = { text: toUserVoice(raw), kind: 'preference', weight: 0.74 }
    }
    // project：正在做的事
    if (
      !fact &&
      (/(?:^|，)?我(?:最近|这几天|这阵子|目前|一直|这两天)?在(?:做|忙|准备|写|搞|弄|开发|学|练|赶)/u.test(raw) ||
        /^我(?:最近|这几天|这阵子|目前|这两天)/u.test(raw))
    ) {
      fact = { text: toUserVoice(raw), kind: 'project', weight: 0.82 }
    }
    // promise：答应 / 约好
    if (!fact && /^我/u.test(raw) && /(?:答应|约好|说好|保证|承诺|发誓)/u.test(raw)) {
      fact = { text: toUserVoice(raw), kind: 'promise', weight: 0.86 }
    }
    // event：带时间的具体事件
    if (
      !fact &&
      /(?:今天|昨天|明天|后天|周末|今晚|下周|下个月|待会儿|一会|月底|年底)/u.test(raw) &&
      /(?:面试|考试|开会|会议|直播|生日|搬家|出差|旅行|发布|上线|体检|答辩|汇报|加班|聚餐)/u.test(raw)
    ) {
      fact = { text: toUserVoice(raw), kind: 'event', weight: 0.62 }
    }
    if (!fact) continue
    const key = normalizeFactText(fact.text)
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    facts.push(fact)
  }
  return facts
}

/**
 * 从助手文本里抽 self 侧事实（纯规则）。
 * @param {string} text 助手回复。
 * @returns {{text: string, kind: string, weight: number}[]}
 */
export function extractSelfFacts(text) {
  const facts = []
  for (const clause of splitClauses(text)) {
    const raw = clause.trim()
    if (raw.length < 4 || raw.length > 80) continue
    if (/(?:我)(?:答应|保证|承诺|会记住|记下了|记着|记住)/u.test(raw)) {
      facts.push({ text: toSelfVoice(raw), kind: 'promise', weight: 0.8 })
      continue
    }
    if (/(?:我记得你|记得你说过|你上次说过)/u.test(raw)) {
      facts.push({ text: toSelfVoice(raw), kind: 'memory', weight: 0.72 })
      continue
    }
    if (/(?:我们|咱俩)(?:已经|又|一起)/u.test(raw) && /(?:聊|做|弄|完成|开始)/u.test(raw)) {
      facts.push({ text: toSelfVoice(raw), kind: 'relation', weight: 0.6 })
    }
  }
  return facts.slice(0, 3)
}

/** 从文本里抽用户名字。 */
export function extractUserName(text) {
  const match = /我(?:的名字)?叫\s*[「“"']?([\u4e00-\u9fa5A-Za-z0-9_·]{1,12})/u.exec(String(text ?? ''))
  if (!match) return undefined
  const name = match[1].replace(/[」”"']/gu, '')
  return name.length > 0 ? name : undefined
}

/** 归一化事实文本，只用于相似度比较。 */
export function normalizeFactText(text) {
  return normalizeForDb(text)
}

/** 取字符二元组集合。 */
function bigrams(text) {
  const grams = new Set()
  for (let index = 0; index + 1 < text.length; index += 1) grams.add(text.slice(index, index + 2))
  return grams
}

/** 两条事实的相似度（Dice 系数，0..1）。 */
export function factSimilarity(left, right) {
  const a = normalizeFactText(left)
  const b = normalizeFactText(right)
  if (a.length === 0 || b.length === 0) return 0
  if (a === b) return 1
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return 0.85
  const leftGrams = bigrams(a)
  const rightGrams = bigrams(b)
  if (leftGrams.size === 0 || rightGrams.size === 0) return 0
  let overlap = 0
  for (const gram of leftGrams) if (rightGrams.has(gram)) overlap += 1
  return (2 * overlap) / (leftGrams.size + rightGrams.size)
}

/** 截断并压平一条事实文本。 */
export function trimFactText(text, maxChars) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  if (flat.length === 0) return ''
  return flat.length <= maxChars ? flat : `${flat.slice(0, Math.max(1, maxChars - 1))}…`
}

/** 事实保留分数：权重 × 新近度 + 类型微调。 */
function factKeepScore(fact, now) {
  const lastSeen = Date.parse(fact.lastSeenAt ?? fact.createdAt ?? '')
  const ageDays = Number.isFinite(lastSeen) ? Math.max(0, (now - lastSeen) / 86400000) : 30
  const recency = 1 / (1 + ageDays / 14)
  return clamp01(fact.weight, 0.5) * recency + (KIND_PRIORITY[fact.kind] ?? 0.3) * 0.05
}

/**
 * 纯函数版事实合并（保留给单测 / 离线工具；服务层走 DB 的 mergeIntoDb）。
 * 相似即合并（lastSeenAt 更新、weight 微增、hits+1），超出上限按保留分数淘汰。
 */
export function mergeFacts(existing, incoming, options) {
  const now = options.now ?? Date.now()
  const side = options.side ?? 'user'
  const allowed = side === 'self' ? SELF_FACT_KINDS : USER_FACT_KINDS
  const maxFacts = Math.max(1, options.maxFacts)
  const maxFactChars = options.maxFactChars ?? 60
  const facts = existing.map((fact) => ({ ...fact }))
  let added = 0
  let merged = 0

  for (const item of incoming) {
    const text = trimFactText(item.text, maxFactChars)
    if (text.length === 0) continue
    const kind = allowed.includes(item.kind) ? item.kind : 'other'
    const weight = clamp01(item.weight ?? KIND_WEIGHT[kind], KIND_WEIGHT[kind])
    const index = facts.findIndex((fact) => factSimilarity(fact.text, text) >= 0.8)
    if (index >= 0) {
      const target = facts[index]
      target.lastSeenAt = new Date(now).toISOString()
      target.hits = (Number(target.hits) || 1) + 1
      target.weight = Math.min(1, (Number(target.weight) || 0.5) + 0.04)
      if (text.length > String(target.text).length && factSimilarity(target.text, text) >= 0.8) target.text = text
      merged += 1
      continue
    }
    facts.push({
      id: shortId('fact'),
      side,
      text,
      kind,
      weight,
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      hits: 1,
    })
    added += 1
  }

  const evicted = []
  while (facts.length > maxFacts) {
    let worst = 0
    let worstScore = Number.POSITIVE_INFINITY
    facts.forEach((fact, index) => {
      const score = factKeepScore(fact, now)
      if (score < worstScore) {
        worstScore = score
        worst = index
      }
    })
    evicted.push(facts.splice(worst, 1)[0])
  }
  return { facts, added, merged, evicted }
}

/**
 * 按相关度 + 权重挑出要注入的事实。
 * @param {readonly object[]} facts 一侧的事实（DB 行，字段兼容 camelCase）。
 * @param {string} query 当前用户输入（用于相关度）。
 * @param {number} limit 最多几条。
 * @param {number} [now] 当前时间戳。
 */
export function selectFacts(facts, query, limit, now = Date.now()) {
  if (!Array.isArray(facts) || facts.length === 0 || limit <= 0) return []
  const queryGrams = bigrams(normalizeFactText(query))
  const scored = facts.map((fact) => {
    const factGrams = bigrams(normalizeFactText(fact.text))
    let overlap = 0
    for (const gram of queryGrams) if (factGrams.has(gram)) overlap += 1
    const relevance = queryGrams.size > 0 && factGrams.size > 0 ? overlap / Math.min(queryGrams.size, factGrams.size) : 0
    const lastSeen = Date.parse(fact.lastSeenAt ?? fact.createdAt ?? '')
    const ageDays = Number.isFinite(lastSeen) ? Math.max(0, (now - lastSeen) / 86400000) : 30
    const recency = 1 / (1 + ageDays / 14)
    const score =
      clamp01(fact.weight, 0.5) * 0.45 + relevance * 0.35 + (KIND_PRIORITY[fact.kind] ?? 0.3) * 0.15 + recency * 0.05
    return { fact, score }
  })
  scored.sort((left, right) => right.score - left.score)
  return scored.slice(0, limit).map((item) => item.fact)
}

/** DB 行 → 服务层事实对象（camelCase）。 */
function rowToFact(row) {
  if (row === undefined || row === null) return undefined
  return {
    id: row.id,
    side: row.side,
    text: row.text,
    kind: row.kind,
    weight: Number(row.weight),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    hits: Number(row.hits),
  }
}

/** DB 行 → 轮次对象（camelCase）。 */
function rowToTurn(row) {
  return {
    id: row.id,
    at: row.at,
    sessionId: row.session_id,
    user: row.user_text,
    assistant: row.assistant_text,
    mood: row.mood,
    provider: row.provider,
    model: row.model,
    seq: row.seq,
    // 旧库没有该列时按 0 处理（后台消化会把它补进整理队列）。
    consolidated: Number(row.consolidated) || 0,
    turn: Number.isFinite(Number(row.turn)) && row.turn !== null ? Number(row.turn) : null,
    archived: Number(row.archived) || 0,
    archiveId: typeof row.archive_id === 'string' ? row.archive_id : null,
    // v2.1.0：user | assistant | system | unknown（旧库未清洗时按 user 兜底）。
    origin: typeof row.origin === 'string' && row.origin.length > 0 ? row.origin : 'user',
  }
}

/** DB 行 → 情节记忆对象（camelCase；turn_ids / mood 是 JSON 字符串）。 */
function rowToEpisode(row) {
  let turnIds = []
  try {
    const parsed = JSON.parse(row.turn_ids ?? '[]')
    if (Array.isArray(parsed)) turnIds = parsed.filter((item) => typeof item === 'string')
  } catch {
    turnIds = []
  }
  let mood
  try {
    mood = row.mood ? JSON.parse(row.mood) : null
  } catch {
    mood = null
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    at: row.at,
    summary: row.summary,
    turnIds,
    mood,
    salience: Number(row.salience) || 0.5,
    terms: typeof row.terms === 'string' ? row.terms : '',
    createdAt: row.created_at,
  }
}

/**
 * 情节记忆检索打分（纯函数，便于单测）。
 *
 * 三个来源按权重相加：
 *   - 相关度 0.55：query 的字符二元组命中 episode.terms 或摘要文本的比例；
 *   - 重要度 0.30：消化时按「个人信息 / 情绪 / 承诺 / 反复提及」打的 salience；
 *   - 新近度 0.15：14 天半衰期，避免老情节永远压住新情节。
 * 相关度为 0 直接丢弃（宁可不召回，也不要塞无关记忆）。
 */
export function scoreEpisode(episode, query, now = Date.now()) {
  const queryGrams = bigrams(normalizeFactText(query))
  if (queryGrams.size === 0) return 0
  const terms = String(episode?.terms ?? '')
    .split(/\s+/u)
    .filter((term) => term.length > 0)
  const summaryNorm = normalizeFactText(episode?.summary)
  let overlap = 0
  for (const gram of queryGrams) if (terms.includes(gram) || summaryNorm.includes(gram)) overlap += 1
  const relevance = Math.min(1, overlap / Math.max(1, Math.min(queryGrams.size, 12)))
  if (relevance <= 0) return 0
  const last = Date.parse(episode?.at ?? episode?.createdAt ?? '')
  const ageDays = Number.isFinite(last) ? Math.max(0, (now - last) / 86400000) : 14
  const recency = 1 / (1 + ageDays / 14)
  return relevance * 0.55 + clamp01(episode?.salience, 0.5) * 0.3 + recency * 0.15
}

/** 安全解析模型返回的双侧 JSON；失败返回空对象。 */
export function parseDualFactList(text) {
  const match = /\{[\s\S]*\}/u.exec(String(text ?? ''))
  if (match === null) return { user: [], self: [] }
  try {
    const value = JSON.parse(match[0])
    const pick = (list) =>
      Array.isArray(list)
        ? list
            .filter((item) => item !== null && typeof item === 'object' && typeof item.text === 'string')
            .slice(0, 3)
            .map((item) => ({
              text: String(item.text).trim(),
              kind: typeof item.kind === 'string' ? item.kind : undefined,
              weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : undefined,
            }))
        : []
    return { user: pick(value.user), self: pick(value.self) }
  } catch {
    return { user: [], self: [] }
  }
}

/** 安全解析模型返回的摘要 JSON。 */
export function parseDualSummary(text) {
  const match = /\{[\s\S]*\}/u.exec(String(text ?? ''))
  if (match === null) return undefined
  try {
    const value = JSON.parse(match[0])
    return {
      user: typeof value.user === 'string' ? value.user.trim() : '',
      self: typeof value.self === 'string' ? value.self.trim() : '',
    }
  } catch {
    return undefined
  }
}

/** 模板化噪声（不是用户记忆）：召回时直接跳过，避免把系统时间戳/代理消息当回忆。 */
const NOISE_TURN = /^(?:Time sampled while|You are an AI agent|You are a coding agent|Agent [^\n]{0,80} sent a message|Current runtime context|<system-reminder>|<[a-z-]+>)/u

/** 摘要/情节里的噪声句子（历史摘要清洗用）。 */
const NOISE_SUMMARY = /(?:Time sampled while|You are an AI agent|You are a coding agent|Agent [^\n]{0,80} sent a message|Browser time zone for this request|Elapsed since the preceding|Current runtime context|^\s*step \d+[:：]|Asia\/[A-Za-z_]+)/u

/** 一条原文轮次是否是模板化噪声。 */
export function isNoiseTurn(turn) {
  return NOISE_TURN.test(String(turn?.user ?? '').trim())
}

/** 一段文本是否含模板化噪声（摘要/情节清洗用）。 */
export function isNoiseText(text) {
  return NOISE_SUMMARY.test(String(text ?? ''))
}

/** 去掉文本里含噪声的分句（摘要/事实入库前强制清洗）。 */
export function stripNoisePieces(text) {
  return String(text ?? '')
    .split(/[；。]/u)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0 && !NOISE_SUMMARY.test(piece))
    .join('；')
}

/**
 * 创建记忆层服务（`brainMemory`）。
 * @param {object} options 依赖。
 * @param {import('@deepseek-ai/cordis').Context} [options.ctx] Host 上下文（LLM 用）。
 * @param {Readonly<import('./config.js').DEFAULT_MEMORY_CONFIG>} options.config 归一化配置。
 * @param {(event: string, data?: Record<string, unknown>) => void} options.log 日志。
 * @param {string} options.dir 数据目录。
 */
export function createMemoryService({ ctx, config, log, dir }) {
  const dbFile = typeof config.dbFile === 'string' && config.dbFile.trim().length > 0
    ? config.dbFile.trim()
    : path.join(dir, 'brain.db')
  const markdownFile = path.join(dir, 'brain.md')
  let handle
  let learning
  let characters
  let entities
  let closed = false
  let loaded = false
  let extracting = false
  let summarizing = false
  let collectorStatsProvider = null

  /** 取 meta 数字。 */
  function metaNumber(key) {
    const value = Number(getMetaValue(handle, key))
    return Number.isFinite(value) ? value : 0
  }

  /** 当前最大 turn rowid（抽取/摘要水位线）。 */
  function maxTurnRowid() {
    const row = handle.prepare('SELECT COALESCE(MAX(rowid), 0) AS value FROM memory_turns').get()
    return Number(row?.value) || 0
  }

  /** 自水位线之后新增的轮数。 */
  function turnsSince(key) {
    const row = handle
      .prepare('SELECT COUNT(*) AS count FROM memory_turns WHERE rowid > ?')
      .get(metaNumber(key))
    return Number(row?.count) || 0
  }

  function init() {
    handle = acquireDatabase({ dbFile, dataDir: dir, log })
    // v2.1.0：召回自学习仓库（共用同一连接；enabled=false 时所有写入都是 no-op）。
    learning = createLearningStore({ handle, config, log })
    // v2.2.0：角色层（"我是谁"）。懒创建是为了让测试能在 init 前拿到 service。
    characters = null
    // v2.3.0：实体层（患者/客户/项目…）。
    entities = null
    loaded = true
    // 一次性清洗历史摘要/情节里混入的模板化噪声（幂等）。
    scrubSummaryNoise()
    scrubEpisodeNoise()
    writeMarkdown()
    const counts = service.counts()
    log('memory-loaded', { dir, dbFile, turns: counts.turns, userFacts: counts.facts.user, selfFacts: counts.facts.self, userName: service.profile().userName, events: counts.events, systemTurns: counts.systemTurns, learning: config.recallLearningEnabled !== false })
    return service
  }

  /** 计数汇总。 */
  function counts() {
    const turns = Number(handle.prepare('SELECT COUNT(*) AS c FROM memory_turns').get()?.c) || 0
    const systemTurns = Number(handle.prepare("SELECT COUNT(*) AS c FROM memory_turns WHERE origin = 'system'").get()?.c) || 0
    const events = Number(handle.prepare('SELECT COUNT(*) AS c FROM memory_events').get()?.c) || 0
    const facts = {
      user: Number(handle.prepare("SELECT COUNT(*) AS c FROM memory_facts WHERE side = 'user'").get()?.c) || 0,
      self: Number(handle.prepare("SELECT COUNT(*) AS c FROM memory_facts WHERE side = 'self'").get()?.c) || 0,
    }
    const summaryChars = {
      user: 0,
      self: 0,
    }
    for (const row of handle.prepare('SELECT side, chars FROM memory_summaries').all()) {
      summaryChars[row.side] = Number(row.chars) || 0
    }
    const lastTurnAt = handle.prepare('SELECT at FROM memory_turns ORDER BY rowid DESC LIMIT 1').get()?.at ?? null
    const episodes = Number(handle.prepare('SELECT COUNT(*) AS c FROM memory_episodes').get()?.c) || 0
    const unconsolidated = Number(handle.prepare('SELECT COUNT(*) AS c FROM memory_turns WHERE consolidated = 0').get()?.c) || 0
    const consolidated = Number(handle.prepare('SELECT COUNT(*) AS c FROM memory_turns WHERE consolidated <> 0').get()?.c) || 0
    const archived = Number(handle.prepare('SELECT COUNT(*) AS c FROM memory_turns WHERE archived <> 0').get()?.c) || 0
    const archives = Number(handle.prepare('SELECT COUNT(*) AS c FROM memory_archives').get()?.c) || 0
    return {
      turns,
      systemTurns,
      events,
      facts,
      summaryChars,
      collected: turns,
      lastTurnAt,
      episodes,
      unconsolidated,
      consolidated,
      archived,
      archives,
      lastConsolidateAt: getMetaValue(handle, 'memory.last_consolidate_at') ?? null,
    }
  }

  /** 写入 brain.md 镜像（从 DB 读取）。 */
  function writeMarkdown() {
    if (!config.writeMarkdown) return
    try {
      const kindLabel = {
        profile: '身份',
        preference: '偏好',
        project: '在做的事',
        promise: '约定',
        event: '事件',
        style: '沟通风格',
        memory: '记忆',
        relation: '关系',
        habit: '习惯',
        other: '其它',
      }
      const lines = [
        '# DSH 助手大脑 · 双向记忆',
        '',
        `> 由 DSH 插件 @shenyue/dsh-brain（SQLite 存储）自动生成，最近更新：${new Date().toISOString()}`,
        `> 数据库：${dbFile}`,
        '> 情绪与人格请查 `/brain mood`、`/brain persona`。',
        '',
        '## 关于用户（user 侧）',
        '',
      ]
      const userFacts = handle
        .prepare("SELECT * FROM memory_facts WHERE side = 'user' ORDER BY weight DESC, last_seen_at DESC")
        .all()
        .map(rowToFact)
      if (userFacts.length === 0) lines.push('（还没有抽取到关于用户的事实）')
      for (const fact of userFacts) {
        lines.push(`- [${kindLabel[fact.kind] ?? '其它'}] ${oneLine(fact.text, 120)}（权重 ${fact.weight.toFixed(2)}，见过 ${fact.hits} 次）`)
      }
      lines.push('', '## 关于我自己（self 侧）', '')
      const selfFacts = handle
        .prepare("SELECT * FROM memory_facts WHERE side = 'self' ORDER BY weight DESC, last_seen_at DESC")
        .all()
        .map(rowToFact)
      if (selfFacts.length === 0) lines.push('（还没有抽取到关于助手自己的事实）')
      for (const fact of selfFacts) {
        lines.push(`- [${kindLabel[fact.kind] ?? '其它'}] ${oneLine(fact.text, 120)}（权重 ${fact.weight.toFixed(2)}，见过 ${fact.hits} 次）`)
      }
      const summaries = service.summaries()
      lines.push('', '## 长期记忆摘要（user 侧）', '', summaries.user.text.length > 0 ? summaries.user.text : '（还没有生成）')
      lines.push('', '## 长期记忆摘要（self 侧）', '', summaries.self.text.length > 0 ? summaries.self.text : '（还没有生成）')
      // 情节记忆：后台消化产出的「小摘要 + 原文指针」，供工作记忆检索。
      const episodes = service.episodes(12)
      lines.push('', '## 情节记忆（最近）', '')
      if (episodes.length === 0) lines.push('（还没有生成情节记忆；后台消化会在攒够几轮后静默进行）')
      for (const episode of episodes) {
        lines.push(
          `- [${episode.at}] ${oneLine(episode.summary, 160)}（重要度 ${episode.salience.toFixed(2)}，涉及 ${episode.turnIds.length} 轮）`,
        )
      }
      const countsNow = service.counts()
      lines.push('', `> 上次整理：${countsNow.lastConsolidateAt ?? '（还没有）'}；未整理轮次 ${countsNow.unconsolidated} 轮。`)
      lines.push('', '## 最近对话', '')
      const turns = handle
        .prepare('SELECT * FROM memory_turns ORDER BY rowid DESC LIMIT 20')
        .all()
        .map(rowToTurn)
        .filter((turn) => turn.origin !== 'system')
        .reverse()
      if (turns.length === 0) lines.push('（还没有采集到对话）')
      for (const turn of turns) {
        lines.push(`- [${turn.at}] 用户：${oneLine(turn.user, 400)}`)
        lines.push(`  - 助手：${oneLine(turn.assistant, 400)}`)
      }
      lines.push('')
      fs.writeFileSync(markdownFile, lines.join('\n'), 'utf8')
    } catch (error) {
      log('markdown-failed', { message: error?.message ?? String(error) })
    }
  }

  /** 记录一轮（采集器回调；事务内写轮次 + relation 事实 + 裁剪 + 采集序号）。 */
  function rememberTurn(turn) {
    const entry = {
      id: shortId('turn'),
      at: typeof turn.at === 'string' ? turn.at : new Date().toISOString(),
      sessionId: typeof turn.sessionId === 'string' ? turn.sessionId : null,
      user: String(turn.user ?? ''),
      assistant: String(turn.assistant ?? ''),
      mood: typeof turn.mood === 'string' ? turn.mood : null,
      seq: Number.isFinite(turn.seq) ? turn.seq : null,
      turn: Number.isFinite(turn.turn) ? Math.round(turn.turn) : null,
      origin: turn.origin === 'system' ? 'system' : turn.origin === 'assistant' ? 'assistant' : 'user',
    }
    let inserted = 0
    let evicted = 0
    handle.transaction(() => {
      if (entry.seq === null) {
        // 无 seq 的轮次（手工写入）不做 UNIQUE 幂等，直接插入。
        const result = handle
          .prepare(
            `INSERT INTO memory_turns(id, session_id, seq, turn, at, user_text, assistant_text, mood, provider, model, origin)
             VALUES(?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(entry.id, entry.sessionId, entry.turn, entry.at, entry.user, entry.assistant, entry.mood, null, null, entry.origin)
        inserted = Number(result.changes) || 0
      } else {
        const result = handle
          .prepare(
            `INSERT OR IGNORE INTO memory_turns(id, session_id, seq, turn, at, user_text, assistant_text, mood, provider, model, origin)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(entry.id, entry.sessionId, entry.seq, entry.turn, entry.at, entry.user, entry.assistant, entry.mood, null, null, entry.origin)
        inserted = Number(result.changes) || 0
      }
      if (inserted === 0) return

      // 关系进展：self 侧维护一条 relation 事实，随轮数缓慢加权。
      const relation = handle
        .prepare("SELECT * FROM memory_facts WHERE side = 'self' AND kind = 'relation' LIMIT 1")
        .get()
      const totalTurns = Number(handle.prepare('SELECT COUNT(*) AS c FROM memory_turns').get()?.c) || 1
      if (relation === undefined) {
        insertFactRow({
          id: shortId('fact'),
          side: 'self',
          text: '和用户的关系在慢慢变熟',
          kind: 'relation',
          weight: 0.35,
          createdAt: entry.at,
          lastSeenAt: entry.at,
          hits: 1,
        })
      } else {
        handle
          .prepare('UPDATE memory_facts SET hits = hits + 1, weight = ?, last_seen_at = ? WHERE id = ?')
          .run(Math.min(0.95, 0.3 + totalTurns * 0.01), entry.at, relation.id)
      }

      // 原文轮次裁剪（保留最近 maxTurns 条）。
      const overflow = Number(handle.prepare('SELECT COUNT(*) AS c FROM memory_turns').get()?.c) - config.maxTurns
      if (overflow > 0) {
        const result = handle
          .prepare('DELETE FROM memory_turns WHERE rowid IN (SELECT rowid FROM memory_turns ORDER BY rowid ASC LIMIT ?)')
          .run(overflow)
        evicted = Number(result.changes) || 0
      }
    })
    if (inserted > 0) {
      writeMarkdown()
      log('memory-turn', { turnId: entry.id, sessionId: entry.sessionId, seq: entry.seq, evicted })
    }
    return { entry: inserted > 0 ? entry : undefined, evicted, turns: counts().turns, inserted }
  }

  /**
   * 记录一条系统/工具事件（v2.1.0 隔离区；永不进 user 侧、也不参与召回）。
   * @param {{id?: string, sessionId?: string, seq?: number, at?: string, kind?: string, text: string, meta?: object}} event
   */
  function rememberEvent(event) {
    const text = String(event?.text ?? '').trim()
    if (text.length === 0) return { inserted: 0 }
    const id =
      typeof event?.id === 'string' && event.id.length > 0
        ? event.id
        : shortId(`evt-${typeof event?.kind === 'string' ? event.kind : 'system'}`)
    try {
      const result = handle
        .prepare(
          `INSERT OR IGNORE INTO memory_events(id, session_id, seq, at, kind, text, meta)
           VALUES(?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          typeof event?.sessionId === 'string' ? event.sessionId : null,
          Number.isFinite(Number(event?.seq)) ? Number(event.seq) : null,
          typeof event?.at === 'string' ? event.at : new Date().toISOString(),
          typeof event?.kind === 'string' && event.kind.length > 0 ? event.kind : 'system',
          text,
          event?.meta === undefined ? null : JSON.stringify(event.meta),
        )
      const inserted = Number(result.changes) || 0
      if (inserted > 0) log('memory-event', { kind: event?.kind ?? 'system', sessionId: event?.sessionId ?? null, seq: event?.seq ?? null })
      return { inserted, id }
    } catch (error) {
      log('memory-event-failed', { message: error?.message ?? String(error) })
      return { inserted: 0, id }
    }
  }

  /** 最近的系统/工具事件（新→旧；只读观测用）。 */
  function events(limit = 10) {
    if (limit <= 0) return []
    return handle
      .prepare('SELECT * FROM memory_events ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(limit)
      .map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        seq: row.seq,
        at: row.at,
        kind: row.kind,
        text: row.text,
        meta: (() => {
          try {
            return row.meta ? JSON.parse(row.meta) : null
          } catch {
            return null
          }
        })(),
      }))
  }

  /** 插入一条事实（不做相似度合并，调用方负责判断）。 */
  function insertFactRow(fact) {    const norm = normalizeFactText(fact.text)
    handle
      .prepare(
        `INSERT OR IGNORE INTO memory_facts(id, side, text, norm, kind, weight, hits, created_at, last_seen_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(fact.id, fact.side, fact.text, norm, fact.kind, fact.weight, fact.hits, fact.createdAt, fact.lastSeenAt)
  }

  /** 一侧全部事实（DB 行 → 服务对象）。 */
  function facts(side) {
    if (side === undefined) return { user: facts('user'), self: facts('self') }
    if (!FACT_SIDES.includes(side)) return []
    return handle
      .prepare('SELECT * FROM memory_facts WHERE side = ? ORDER BY weight DESC, last_seen_at DESC')
      .all(side)
      .map(rowToFact)
  }

  /** 一侧给提示词挑选的事实。 */
  function factsForPrompt(side, query, limit) {
    const pool = FACT_SIDES.includes(side) ? facts(side) : []
    return selectFacts(pool, query, limit)
  }

  /**
   * 把一条事实并入一侧：相似度 ≥0.8 合并，否则插入；每侧超出上限时淘汰最弱的一条。
   * @returns {{added: number, merged: number, evicted: number}}
   */
  function mergeIntoDb(side, incoming) {
    const allowed = side === 'self' ? SELF_FACT_KINDS : USER_FACT_KINDS
    let added = 0
    let merged = 0
    let evicted = 0
    const rows = facts(side)
    const now = new Date().toISOString()
    for (const item of incoming) {
      const text = trimFactText(item.text, config.maxFactChars)
      if (text.length === 0) continue
      const kind = allowed.includes(item.kind) ? item.kind : 'other'
      const weight = clamp01(item.weight ?? KIND_WEIGHT[kind], KIND_WEIGHT[kind])
      const match = rows.find((row) => factSimilarity(row.text, text) >= 0.8)
      if (match !== undefined) {
        const nextWeight = Math.min(1, (Number(match.weight) || 0.5) + 0.04)
        const nextHits = (Number(match.hits) || 1) + 1
        const nextText = text.length > match.text.length && factSimilarity(match.text, text) >= 0.8 ? text : match.text
        handle
          .prepare('UPDATE memory_facts SET text = ?, norm = ?, weight = ?, hits = ?, last_seen_at = ? WHERE id = ?')
          .run(nextText, normalizeFactText(nextText), nextWeight, nextHits, now, match.id)
        Object.assign(match, { text: nextText, weight: nextWeight, hits: nextHits })
        merged += 1
        continue
      }
      const fact = {
        id: shortId('fact'),
        side,
        text,
        kind,
        weight,
        createdAt: now,
        lastSeenAt: now,
        hits: 1,
      }
      insertFactRow(fact)
      rows.push(fact)
      added += 1
    }
    // 每侧上限：按保留分数淘汰。
    while (rows.length > config.maxFactsPerSide) {
      let worst = 0
      let worstScore = Number.POSITIVE_INFINITY
      rows.forEach((row, index) => {
        const score = factKeepScore(row, Date.now())
        if (score < worstScore) {
          worstScore = score
          worst = index
        }
      })
      const [removed] = rows.splice(worst, 1)
      handle.prepare('DELETE FROM memory_facts WHERE id = ?').run(removed.id)
      evicted += 1
    }
    return { added, merged, evicted }
  }

  /** 手动新增 / 合并一条事实。 */
  function upsertFact(input) {
    const side = FACT_SIDES.includes(input?.side) ? input.side : 'user'
    const text = trimFactText(input?.text, config.maxFactChars)
    if (text.length === 0) throw new Error('事实文本不能为空')
    const before = new Set(facts(side).map((fact) => fact.id))
    const result = mergeIntoDb(side, [{ ...input, text }])
    const userName = extractUserName(text)
    if (side === 'user' && userName) setMeta(handle, 'profile.user_name', userName)
    writeMarkdown()
    log('fact-upsert', { side, added: result.added, merged: result.merged, total: facts(side).length })
    const after = facts(side)
    const addedFact = after.find((fact) => !before.has(fact.id))
    const bestMatch = [...after].sort((left, right) => factSimilarity(right.text, text) - factSimilarity(left.text, text))[0]
    return { fact: addedFact ?? bestMatch ?? null, added: result.added, merged: result.merged, evicted: result.evicted }
  }

  /** 删除一条事实（两侧都找）。 */
  function removeFact(id) {
    for (const side of FACT_SIDES) {
      const result = handle.prepare('DELETE FROM memory_facts WHERE id = ? AND side = ?').run(id, side)
      if ((Number(result.changes) || 0) > 0) {
        writeMarkdown()
        log('fact-remove', { side, id })
        return true
      }
    }
    return false
  }

  /** 上一轮文本（给上下文层算相关度）。 */
  function recentTurns(limit) {
    if (limit <= 0) return []
    return handle
      .prepare('SELECT * FROM memory_turns ORDER BY rowid DESC LIMIT ?')
      .all(limit)
      .map(rowToTurn)
      .reverse()
  }

  /** 全部轮次（旧接口，按插入顺序）。 */
  function turns() {
    return handle.prepare('SELECT * FROM memory_turns ORDER BY rowid ASC').all().map(rowToTurn)
  }

  /**
   * 按 id 取回一轮原文（含 user/assistant 全文、sessionId、seq、时间、mood）。
   * 「原文永不丢」的对外入口：episode 只存 turn_ids 指针，需要时用这里取回。
   * @param {string} id 轮次 id。
   * @returns {object|undefined}
   */
  function fetchTurn(id) {
    if (typeof id !== 'string' || id.length === 0) return undefined
    const row = handle.prepare('SELECT * FROM memory_turns WHERE id = ?').get(id)
    return row === undefined ? undefined : rowToTurn(row)
  }

  /**
   * 按会话 + seq 区间取回原文（两端都包含；seq 为空的行不参与）。
   * @param {string} sessionId 会话 id。
   * @param {number} fromSeq 起始 seq。
   * @param {number} toSeq 结束 seq。
   * @returns {object[]}
   */
  function fetchRange(sessionId, fromSeq, toSeq) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return []
    const from = Number(fromSeq)
    const to = Number(toSeq)
    if (!Number.isFinite(from) || !Number.isFinite(to)) return []
    const low = Math.min(from, to)
    const high = Math.max(from, to)
    return handle
      .prepare('SELECT * FROM memory_turns WHERE session_id = ? AND seq IS NOT NULL AND seq BETWEEN ? AND ? ORDER BY seq ASC, rowid ASC')
      .all(sessionId, low, high)
      .map(rowToTurn)
  }

  /**
   * 原文关键词检索（给 `/brain memory <关键词>` 与工作记忆兜底召回用）。
   * 打分 = 二元组重叠比例 + 新近度微调；只返回命中的原文轮次。
   *
   * @param {string} query 关键词/句子。
   * @param {{limit?: number, sessionId?: string, since?: string, until?: string}} [options] 选项。
   * @returns {Array<object & {score: number}>}
   */
  function searchTurns(query, options = {}) {
    const limit = options.limit ?? 5
    if (limit <= 0) return []
    const queryGrams = bigrams(normalizeFactText(query))
    if (queryGrams.size === 0) return []
    const where = []
    const params = []
    if (typeof options.sessionId === 'string' && options.sessionId.length > 0) {
      where.push('session_id = ?')
      params.push(options.sessionId)
    }
    if (typeof options.since === 'string' && options.since.length > 0) {
      where.push('at >= ?')
      params.push(options.since)
    }
    if (typeof options.until === 'string' && options.until.length > 0) {
      where.push('at <= ?')
      params.push(options.until)
    }
    const sql = `SELECT * FROM memory_turns ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid DESC LIMIT 1000`
    const rows = handle.prepare(sql).all(...params).map(rowToTurn).reverse().filter((turn) => turn.origin !== 'system')
    const scored = []
    rows.forEach((turn, index) => {
      const grams = bigrams(normalizeFactText(`${turn.user} ${turn.assistant}`))
      let overlap = 0
      for (const gram of queryGrams) if (grams.has(gram)) overlap += 1
      if (overlap === 0) return
      const relevance = Math.min(1, overlap / Math.max(1, Math.min(queryGrams.size, 12)))
      const recency = index / Math.max(1, rows.length - 1)
      scored.push({ ...turn, score: Math.round((relevance * 0.85 + recency * 0.15) * 1000) / 1000 })
    })
    scored.sort((left, right) => right.score - left.score)
    return scored.slice(0, limit)
  }

  /** 按会话 + seq 找一轮（归档器幂等校验用）。 */
  function findTurnBySeq(sessionId, seq) {
    if (typeof sessionId !== 'string' || !Number.isFinite(Number(seq))) return undefined
    const row = handle.prepare('SELECT * FROM memory_turns WHERE session_id = ? AND seq = ?').get(sessionId, Number(seq))
    return row === undefined ? undefined : rowToTurn(row)
  }

  /** 最近 N 轮原文（人工核查 / 调试用；不截断）。 */
  function recentOriginal(limit = 10) {
    return recentTurns(limit)
  }

  /**
   * 归档记录（原文仍在 memory_turns，这里记录「哪段被换成了标记」）。
   * @returns {{inserted: number, archiveId: string}}
   */
  function recordArchive(input) {
    const entry = {
      id: typeof input?.id === 'string' && input.id.length > 0 ? input.id : shortId('arc'),
      sessionId: String(input?.sessionId ?? ''),
      at: typeof input?.at === 'string' ? input.at : new Date().toISOString(),
      startSeq: Number(input?.startSeq) || 0,
      endSeq: Number(input?.endSeq) || 0,
      turnCount: Number(input?.turnCount) || 0,
      tokensBefore: Number.isFinite(input?.tokensBefore) ? Math.round(input.tokensBefore) : null,
      tokensAfter: Number.isFinite(input?.tokensAfter) ? Math.round(input.tokensAfter) : null,
      markerSeq: Number.isFinite(input?.markerSeq) ? Math.round(input.markerSeq) : null,
      markerMessageId: typeof input?.markerMessageId === 'string' ? input.markerMessageId : null,
      turnIds: Array.isArray(input?.turnIds) ? input.turnIds.filter((id) => typeof id === 'string') : [],
      status: typeof input?.status === 'string' ? input.status : 'done',
    }
    const result = handle
      .prepare(
        `INSERT OR IGNORE INTO memory_archives(id, session_id, at, start_seq, end_seq, turn_count, tokens_before, tokens_after, marker_seq, marker_message_id, turn_ids, status, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.sessionId,
        entry.at,
        entry.startSeq,
        entry.endSeq,
        entry.turnCount,
        entry.tokensBefore,
        entry.tokensAfter,
        entry.markerSeq,
        entry.markerMessageId,
        JSON.stringify(entry.turnIds),
        entry.status,
        new Date().toISOString(),
      )
    if ((Number(result.changes) || 0) > 0) writeMarkdown()
    return { inserted: Number(result.changes) || 0, archiveId: entry.id }
  }

  /** 把一批轮次标记为「已归档到记忆库（当前会话里已换成标记）」。 */
  function markArchived(ids, archiveId) {
    const unique = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id.length > 0))]
    if (unique.length === 0) return 0
    const placeholders = unique.map(() => '?').join(',')
    const result = handle
      .prepare(`UPDATE memory_turns SET archived = 1, archive_id = ? WHERE id IN (${placeholders})`)
      .run(typeof archiveId === 'string' ? archiveId : null, ...unique)
    return Number(result.changes) || 0
  }

  /** 最近的归档记录（新→旧）。 */
  function archives(limit = 20) {
    if (limit <= 0) return []
    return handle
      .prepare('SELECT * FROM memory_archives ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(limit)
      .map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        at: row.at,
        startSeq: row.start_seq,
        endSeq: row.end_seq,
        turnCount: row.turn_count,
        tokensBefore: row.tokens_before,
        tokensAfter: row.tokens_after,
        markerSeq: row.marker_seq,
        markerMessageId: row.marker_message_id,
        turnIds: (() => {
          try {
            const parsed = JSON.parse(row.turn_ids ?? '[]')
            return Array.isArray(parsed) ? parsed : []
          } catch {
            return []
          }
        })(),
        status: row.status,
        createdAt: row.created_at,
      }))
  }

  /**
   * 通用续接词（不构成「话题」）：只靠它们命中的归档段不注入。
   */
  const GENERIC_BIGRAMS = new Set(['继续', '然后', '还有', '好的', '嗯嗯', '这个', '那个', '怎么', '什么', '可以', '现在', '开始', '一下', '我们', '你们'])

  /**
   * 原文召回（v2.0.0 重点）：按字符 bigram + IDF 打分，返回**原文片段**而不是摘要。
   *
   * 打分 = 相关度(0.55, IDF 加权) + 话题连续性(0.20) + 时间衰减(0.15) + 归档加成(0.12)。
   * 「话题连续性」用最近几轮用户输入的词分布判断：与当前话题完全无关的归档段不召回
   * （`topicShiftEnabled` 可关）；用户点名的关键词命中会因 IDF 高而强加权。
   *
   * @param {string} query 本轮用户输入。
   * @param {{limit?: number, recentTexts?: string, topicShiftEnabled?: boolean, now?: number, snippetChars?: number}} [options]
   * @returns {Array<object & {score: number, relevance: number, topicOverlap: number, snippet: string}>}
   */
  function recallOriginals(query, options = {}) {
    const limit = options.limit ?? 4
    if (limit <= 0) return []
    const queryGrams = bigrams(normalizeFactText(query))
    if (queryGrams.size === 0) return []
    // 拉丁词/数字（如 8720）不参与中文 bigram，但作为独立 term 也应有学习权重。
    const queryTokens = String(query ?? '')
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_+.-]{1,23}/gu) ?? []
    const topicGrams =
      options.topicShiftEnabled === false ? new Set() : bigrams(normalizeFactText(options.recentTexts ?? ''))
    const rows = handle
      .prepare('SELECT * FROM memory_turns ORDER BY rowid DESC LIMIT 2000')
      .all()
      .map(rowToTurn)
    if (rows.length === 0) return []
    // 每行一条「文档」算 IDF：越少见的词越值钱，避免「用户/助手」这类高频词主导。
    const gramsByTurn = new Map()
    const df = new Map()
    for (const turn of rows) {
      const grams = bigrams(normalizeFactText(`${turn.user} ${turn.assistant}`))
      gramsByTurn.set(turn.id, grams)
      for (const gram of grams) df.set(gram, (df.get(gram) ?? 0) + 1)
    }
    const total = rows.length
    const idfOf = (gram) => Math.log(1 + total / Math.max(1, df.get(gram) ?? 1))
    const now = options.now ?? Date.now()
    const snippetChars = options.snippetChars ?? 120
    // v2.1.0：召回打分乘上学习到的 term / 特征权重（没有学习数据时全为 1）。
    const featureWeights = learning !== undefined ? learning.featureWeights() : { relevance: 1, salience: 1, recency: 1, topic: 1, affection: 1 }
    const scored = []
    for (const turn of rows) {
      if (isNoiseTurn(turn)) continue
      // 系统/工具文本永不进 user 侧召回。
      if (turn.origin === 'system') continue
      const grams = gramsByTurn.get(turn.id)
      if (grams === undefined) continue
      let idfScore = 0
      let hits = 0
      for (const gram of queryGrams) {
        if (!grams.has(gram)) continue
        hits += 1
        idfScore += idfOf(gram)
      }
      if (hits === 0) continue
      const relevance = Math.min(1, idfScore / Math.max(1, queryGrams.size))
      let topicOverlap = 0
      if (topicGrams.size > 0) {
        let overlap = 0
        for (const gram of topicGrams) if (grams.has(gram)) overlap += 1
        topicOverlap = overlap / Math.max(1, Math.min(topicGrams.size, 20))
      }
      // 话题连续性：与当前话题零重叠、且只靠「继续/然后」这类通用词命中的旧/归档段不注入；
      // 用户点名了具体主题（非通用词命中）时照常召回。
      const isOld = turn.archived === 1
      if (options.topicShiftEnabled !== false && topicGrams.size > 0 && isOld && topicOverlap === 0) {
        const specificHit = [...queryGrams].some((gram) => !GENERIC_BIGRAMS.has(gram) && grams.has(gram))
        if (!specificHit) continue
      }
      const last = Date.parse(turn.at ?? '')
      const ageDays = Number.isFinite(last) ? Math.max(0, (now - last) / 86400000) : 30
      const recency = 1 / (1 + ageDays / 14)
      // 先放拉丁词/数字（更具体），再放中文 bigram；都限制在 10 个以内。
      const matchedTerms = []
      if (queryTokens.length > 0) {
        const haystack = normalizeFactText(`${turn.user} ${turn.assistant}`)
        for (const token of queryTokens) if (haystack.includes(token)) matchedTerms.push(token)
      }
      for (const gram of queryGrams) if (grams.has(gram)) matchedTerms.push(gram)
      const uniqueMatchedTerms = [...new Set(matchedTerms)].slice(0, 10)
      const learnedTerm = learning !== undefined ? learning.termFactor(uniqueMatchedTerms) : 1
      const baseScore =
        featureWeights.relevance * relevance * 0.55 +
        featureWeights.topic * topicOverlap * 0.2 +
        featureWeights.recency * recency * 0.15 +
        (isOld ? 0.12 : 0)
      const score = baseScore * learnedTerm
      // 原文片段：优先取命中关键词的那一段，其次用户原文。
      const userClauses = String(turn.user ?? '').split(/[。！？!?\n\r]+/u)
      const hitClause = userClauses.find((clause) =>
        [...queryGrams].some((gram) => normalizeFactText(clause).includes(gram)),
      )
      const snippet = oneLine((hitClause ?? turn.user ?? '').trim(), snippetChars)
      scored.push({
        ...turn,
        score: Math.round(score * 1000) / 1000,
        relevance: Math.round(relevance * 1000) / 1000,
        topicOverlap: Math.round(topicOverlap * 1000) / 1000,
        recency: Math.round(recency * 1000) / 1000,
        learnedTerm: Math.round(learnedTerm * 1000) / 1000,
        terms: uniqueMatchedTerms.join(' '),
        components: {
          relevance: Math.round(featureWeights.relevance * relevance * 0.55 * 1000) / 1000,
          topic: Math.round(featureWeights.topic * topicOverlap * 0.2 * 1000) / 1000,
          recency: Math.round(featureWeights.recency * recency * 0.15 * 1000) / 1000,
          learnedTerm: Math.round(learnedTerm * 1000) / 1000,
          featureWeights,
        },
        snippet,
      })
    }
    scored.sort((left, right) => right.score - left.score)
    return scored.slice(0, limit)
  }

  /**
   * 某个会话里还没被后台消化过的轮次（按写入顺序取最早的 N 轮）。
   * 消化只读这些原文，然后把它们标记为 consolidated；原文永不删除。
   */
  function unconsolidatedTurns(sessionId, limit = 12) {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || limit <= 0) return []
    return handle
      .prepare('SELECT * FROM memory_turns WHERE session_id = ? AND consolidated = 0 ORDER BY rowid ASC LIMIT ?')
      .all(sessionId, limit)
      .map(rowToTurn)
  }

  /** 把一批轮次标记为「已后台消化」。返回实际更新行数。 */
  function markConsolidated(ids, options = {}) {
    const unique = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id.length > 0))]
    if (unique.length === 0) return 0
    const placeholders = unique.map(() => '?').join(',')
    const result = handle
      .prepare(`UPDATE memory_turns SET consolidated = 1 WHERE id IN (${placeholders})`)
      .run(...unique)
    const changed = Number(result.changes) || 0
    const at = typeof options.at === 'string' ? options.at : new Date().toISOString()
    setMeta(handle, 'memory.last_consolidate_at', at)
    setMeta(handle, 'memory.last_consolidate_count', String(changed))
    return changed
  }

  /** 写入一条情节记忆（幂等：同 id 忽略）。 */
  function rememberEpisode(input) {
    const at = typeof input?.at === 'string' ? input.at : new Date().toISOString()
    const summary = String(input?.summary ?? '').trim()
    if (summary.length === 0) return { inserted: 0, episodeId: null }
    const entry = {
      id: typeof input?.id === 'string' && input.id.length > 0 ? input.id : shortId('ep'),
      sessionId: typeof input?.sessionId === 'string' ? input.sessionId : null,
      at,
      summary: summary.length <= 400 ? summary : `${summary.slice(0, 399)}…`,
      turnIds: Array.isArray(input?.turnIds) ? input.turnIds.filter((id) => typeof id === 'string') : [],
      mood: input?.mood ?? null,
      salience: clamp01(input?.salience, 0.5),
      terms: String(input?.terms ?? '').trim(),
      createdAt: typeof input?.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
    }
    const result = handle
      .prepare(
        `INSERT OR IGNORE INTO memory_episodes(id, session_id, at, summary, turn_ids, mood, salience, terms, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.sessionId,
        entry.at,
        entry.summary,
        JSON.stringify(entry.turnIds),
        entry.mood === null ? null : JSON.stringify(entry.mood),
        entry.salience,
        entry.terms,
        entry.createdAt,
      )
    if ((Number(result.changes) || 0) > 0) writeMarkdown()
    return { inserted: Number(result.changes) || 0, episodeId: entry.id }
  }

  /** 最近的情节记忆（新→旧）。 */
  function episodes(limit = 20) {
    if (limit <= 0) return []
    return handle
      .prepare('SELECT * FROM memory_episodes ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(limit)
      .map(rowToEpisode)
  }

  /**
   * 按相关度检索情节记忆（工作记忆召回用）。
   * @returns {Array<object & {score: number}>} 按分数从高到低；相关度为 0 的不返回。
   */
  function recallEpisodes(query, options = {}) {
    const limit = options.limit ?? 4
    if (limit <= 0) return []
    const now = options.now ?? Date.now()
    const queryGrams = bigrams(normalizeFactText(query))
    if (queryGrams.size === 0) return []
    const featureWeights = learning !== undefined ? learning.featureWeights() : { relevance: 1, salience: 1, recency: 1, topic: 1, affection: 1 }
    const rows = handle
      .prepare('SELECT * FROM memory_episodes ORDER BY at DESC, rowid DESC LIMIT 400')
      .all()
      .map(rowToEpisode)
    const scored = []
    for (const episode of rows) {
      const terms = String(episode.terms ?? '')
        .split(/\s+/u)
        .filter((term) => term.length > 0)
      const summaryNorm = normalizeFactText(episode.summary)
      let overlap = 0
      for (const gram of queryGrams) if (terms.includes(gram) || summaryNorm.includes(gram)) overlap += 1
      const relevance = Math.min(1, overlap / Math.max(1, Math.min(queryGrams.size, 12)))
      if (relevance <= 0) continue
      const last = Date.parse(episode.at ?? episode.createdAt ?? '')
      const ageDays = Number.isFinite(last) ? Math.max(0, (now - last) / 86400000) : 14
      const recency = 1 / (1 + ageDays / 14)
      const salience = clamp01(episode.salience, 0.5)
      const matchedTerms = terms.filter((term) => queryGrams.has(term) || normalizeFactText(query).includes(term)).slice(0, 8)
      const learnedTerm = learning !== undefined ? learning.termFactor(matchedTerms) : 1
      const baseScore =
        featureWeights.relevance * relevance * 0.55 + featureWeights.salience * salience * 0.3 + featureWeights.recency * recency * 0.15
      const score = baseScore * learnedTerm
      scored.push({
        ...episode,
        score: Math.round(score * 1000) / 1000,
        relevance: Math.round(relevance * 1000) / 1000,
        recency: Math.round(recency * 1000) / 1000,
        learnedTerm: Math.round(learnedTerm * 1000) / 1000,
        terms: terms.join(' '),
        components: {
          relevance: Math.round(featureWeights.relevance * relevance * 0.55 * 1000) / 1000,
          salience: Math.round(featureWeights.salience * salience * 0.3 * 1000) / 1000,
          recency: Math.round(featureWeights.recency * recency * 0.15 * 1000) / 1000,
          learnedTerm: Math.round(learnedTerm * 1000) / 1000,
          featureWeights,
        },
      })
    }
    scored.sort((left, right) => right.score - left.score)
    return scored.slice(0, limit)
  }

  /**
   * 把一段新内容追加进某一侧的滚动摘要（后台消化用；不做 LLM 调用）。
   * - 已包含同一段内容时直接跳过，避免重复膨胀；
   * - 超出 `maxChars` 时保留尾部（最新的记忆更重要），并在开头加省略号。
   */
  function appendSummary(side, text, options = {}) {
    const target = FACT_SIDES.includes(side) ? side : 'user'
    const limit = Math.max(60, options.maxChars ?? 600)
    const value = String(text ?? '')
      .replace(/\s+/gu, ' ')
      .trim()
    if (value.length === 0) return summaries()[target].text
    const previous = summaries()[target].text
    if (previous.includes(value)) return previous
    const piece = value.length <= Math.max(24, limit / 3) ? value : `${value.slice(0, Math.max(23, Math.floor(limit / 3) - 1))}…`
    let next = previous.length > 0 ? `${previous}；${piece}` : piece
    if (next.length > limit) next = `…${next.slice(next.length - limit + 1)}`
    setSummary(target, next)
    return next
  }

  /** 按关键词召回（side 可指定 user / self / both）。 */
  function recall(query, options = {}) {
    const side = options.side ?? 'user'
    const limit = options.limit ?? 4
    if (limit <= 0) return []
    const queryGrams = bigrams(normalizeFactText(query))
    if (queryGrams.size === 0) return []
    const rows = handle.prepare('SELECT * FROM memory_turns ORDER BY rowid DESC LIMIT 500').all().map(rowToTurn).reverse()
    const scored = []
    rows.forEach((turn, index) => {
      if (turn.origin === 'system') return
      const text = side === 'self' ? turn.assistant : side === 'user' ? turn.user : `${turn.user} ${turn.assistant}`
      const grams = bigrams(normalizeFactText(text))
      let overlap = 0
      for (const gram of queryGrams) if (grams.has(gram)) overlap += 1
      if (overlap === 0) return
      const recency = index / Math.max(1, rows.length - 1)
      scored.push({ turn, score: overlap + recency * 0.5 })
    })
    scored.sort((left, right) => right.score - left.score)
    return scored.slice(0, limit).map((item) => item.turn)
  }

  /** 双向摘要。 */
  function summaries() {
    const result = {
      user: { text: '', updatedAt: null },
      self: { text: '', updatedAt: null },
    }
    for (const row of handle.prepare('SELECT * FROM memory_summaries').all()) {
      if (result[row.side] !== undefined) result[row.side] = { text: row.summary, updatedAt: row.updated_at }
    }
    return result
  }

  /** 清洗历史摘要里混入的模板化噪声（一次性、幂等；返回是否改动）。 */
  function scrubSummaryNoise() {
    try {
      const current = summaries()
      let changed = false
      for (const side of FACT_SIDES) {
        const text = current[side].text
        if (text.length === 0) continue
        const kept = text
          .split(/[；。]/u)
          .map((piece) => piece.trim())
          .filter((piece) => piece.length > 0 && !NOISE_SUMMARY.test(piece))
        const next = kept.join('；').slice(0, 600)
        if (next !== text) {
          setSummary(side, next)
          changed = true
        }
      }
      if (changed) log('summary-noise-scrubbed', { user: summaries().user.text.length, self: summaries().self.text.length })
      return changed
    } catch {
      return false
    }
  }

  /** 清洗情节记忆里含模板化噪声的条目（只删索引，不动原文）。 */
  function scrubEpisodeNoise() {
    try {
      const rows = handle.prepare('SELECT id, summary FROM memory_episodes').all()
      let deleted = 0
      for (const row of rows) {
        if (!NOISE_SUMMARY.test(String(row.summary ?? ''))) continue
        handle.prepare('DELETE FROM memory_episodes WHERE id = ?').run(row.id)
        deleted += 1
      }
      if (deleted > 0) log('episode-noise-scrubbed', { deleted })
      return deleted
    } catch {
      return 0
    }
  }

  /** 覆盖摘要（入库前强制去除噪声分句）。 */
  function setSummary(side, text) {
    const target = FACT_SIDES.includes(side) ? side : 'user'
    const value = stripNoisePieces(String(text ?? '')).trim()
    const updatedAt = new Date().toISOString()
    handle
      .prepare(
        `INSERT INTO memory_summaries(side, summary, chars, updated_at) VALUES(?, ?, ?, ?)
         ON CONFLICT(side) DO UPDATE SET summary = excluded.summary, chars = excluded.chars, updated_at = excluded.updated_at`,
      )
      .run(target, value, value.length, updatedAt)
    writeMarkdown()
    return summaries()
  }

  /** 是否该做一次事实抽取。 */
  function dueForFacts() {
    return config.factExtractMode !== 'off' && turnsSince('memory.last_extract_rowid') >= config.factExtractInterval
  }

  /** 是否该做一次滚动摘要。 */
  function dueForSummary() {
    return (
      config.summaryEnabled &&
      turnsSince('memory.last_summary_rowid') >= config.summaryThreshold &&
      Number(handle.prepare('SELECT COUNT(*) AS c FROM memory_turns').get()?.c) >= Math.min(config.summaryThreshold, 2)
    )
  }

  /** 规则抽取 + 可选 LLM 补充并写入 DB。 */
  function applyFacts(userTexts, selfTexts, llmFacts) {
    let userResult = { added: 0, merged: 0, evicted: 0 }
    let selfResult = { added: 0, merged: 0, evicted: 0 }
    handle.transaction(() => {
      const userIncoming = []
      for (const text of userTexts) userIncoming.push(...extractUserFacts(text))
      const selfIncoming = []
      for (const text of selfTexts) selfIncoming.push(...extractSelfFacts(text))
      userResult = mergeIntoDb('user', [...userIncoming, ...(llmFacts?.user ?? [])])
      selfResult = mergeIntoDb('self', [...selfIncoming, ...(llmFacts?.self ?? [])])
      for (const text of userTexts) {
        const userName = extractUserName(text)
        if (userName) setMeta(handle, 'profile.user_name', userName)
      }
      setMeta(handle, 'memory.last_extract_rowid', maxTurnRowid())
    })
    writeMarkdown()
    log('fact-extract', {
      mode: config.factExtractMode,
      user: { added: userResult.added, merged: userResult.merged, total: facts('user').length },
      self: { added: selfResult.added, merged: selfResult.merged, total: facts('self').length },
    })
    return { user: userResult, self: selfResult }
  }

  /** 跑一次事实抽取：规则同步生效；`llm` 模式追加一次异步 LLM 补充（失败静默）。 */
  async function runFactExtraction() {
    if (extracting || closed) return
    extracting = true
    try {
      const count = Math.min(config.factExtractInterval, Number(handle.prepare('SELECT COUNT(*) AS c FROM memory_turns').get()?.c) || 0)
      if (count <= 0) return
      const recent = recentTurns(count).filter((turn) => !isNoiseTurn(turn) && turn.origin !== 'system')
      if (recent.length === 0) return
      let llmFacts
      if (config.factExtractMode === 'llm' && ctx !== undefined) {
        try {
          const route = resolveRoute(ctx, {})
          const output = await completeText(ctx, {
            route,
            system: FACT_SYSTEM_PROMPT,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: recent.map((turn) => `用户：${turn.user}\n助手：${turn.assistant}`).join('\n\n'),
                  },
                ],
              },
            ],
            temperature: 0.2,
            maxTokens: 400,
            signal: AbortSignal.timeout(30000),
          })
          llmFacts = parseDualFactList(output)
        } catch (error) {
          log('fact-llm-failed', { message: error?.message ?? String(error) })
        }
      }
      applyFacts(
        recent.map((turn) => turn.user),
        recent.map((turn) => turn.assistant),
        llmFacts,
      )
    } finally {
      extracting = false
    }
  }

  /** 跑一次滚动摘要：一次 LLM 调用同时产出 user / self 两份摘要（失败静默）。 */
  async function runSummary() {
    if (summarizing || closed) return
    summarizing = true
    try {
      if (!ctx) return
      const turns = recentTurns(Math.min(config.summaryThreshold, 60)).filter(
        (turn) => !isNoiseTurn(turn) && turn.origin !== 'system',
      )
      const previous = summaries()
      const route = resolveRoute(ctx, {})
      const output = await completeText(ctx, {
        route,
        system: SUMMARY_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: [
                  `已有 user 侧摘要：${previous.user.text.length > 0 ? previous.user.text : '（还没有）'}`,
                  `已有 self 侧摘要：${previous.self.text.length > 0 ? previous.self.text : '（还没有）'}`,
                  '',
                  '需要并入摘要的最近对话：',
                  turns.map((turn) => `用户：${turn.user}\n助手：${turn.assistant}`).join('\n\n'),
                  '',
                  '请输出合并后的双侧摘要 JSON。',
                ].join('\n'),
              },
            ],
          },
        ],
        temperature: 0.2,
        maxTokens: 600,
        signal: AbortSignal.timeout(30000),
      })
      const parsed = parseDualSummary(output)
      if (!parsed) return
      if (parsed.user.length > 0) setSummary('user', parsed.user)
      if (parsed.self.length > 0) setSummary('self', parsed.self)
      setMeta(handle, 'memory.last_summary_rowid', maxTurnRowid())
      log('summary-updated', { user: parsed.user.length, self: parsed.self.length })
    } catch (error) {
      log('summary-failed', { message: error?.message ?? String(error) })
    } finally {
      summarizing = false
    }
  }

  /** 采集器序号持久化读。 */
  function getLastSeq(sessionId) {
    const row = handle
      .prepare("SELECT last_seq FROM collector_state WHERE session_id = ? AND layer = 'memory'")
      .get(sessionId)
    return row === undefined ? undefined : Number(row.last_seq)
  }


    /** 读取待配对的用户消息（重载后可继续配对）。 */
  function getPending(sessionId) {
    const row = handle
      .prepare("SELECT user_text, seq FROM collector_pending WHERE session_id = ? AND layer = 'memory'")
      .get(sessionId)
    return row === undefined ? undefined : { text: row.user_text, seq: Number(row.seq) }
  }

  /** 持久化待配对的用户消息。 */
  function setPending(sessionId, pending) {
    handle
      .prepare(
        "INSERT INTO collector_pending(session_id, layer, user_text, seq, at) VALUES(?, 'memory', ?, ?, ?) " +
          "ON CONFLICT(session_id, layer) DO UPDATE SET user_text = excluded.user_text, seq = excluded.seq, at = excluded.at",
      )
      .run(sessionId, pending.text, pending.seq, pending.at ?? new Date().toISOString())
  }

  /** 清除待配对的用户消息。 */
  function clearPending(sessionId) {
    handle.prepare("DELETE FROM collector_pending WHERE session_id = ? AND layer = 'memory'").run(sessionId)
  }

  /** 采集器序号持久化写。 */
  function setLastSeq(sessionId, seq) {
    handle
      .prepare(
        `INSERT INTO collector_state(session_id, layer, last_seq, updated_at) VALUES(?, 'memory', ?, ?)
         ON CONFLICT(session_id, layer) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq), updated_at = excluded.updated_at`,
      )
      .run(sessionId, seq, new Date().toISOString())
  }

  /** 快照（命令 / 测试 / 其它插件用）。 */
  function snapshot() {
    const summary = summaries()
    return {
      summaries: summary,
      facts: { user: facts('user'), self: facts('self') },
      profile: service.profile(),
      episodes: episodes(20),
      recentTurns: recentTurns(20),
      events: events(10),
      learning: learning !== undefined ? learning.stats() : null,
      counts: { ...counts(), collector: service.collectorStats() },
    }
  }

  /** 重置（默认不备份 DB；删除三张记忆表与采集状态）。 */
  function reset(options = {}) {
    const backups = []
    if (options.backup !== false) {
      try {
        const backupFile = `${dbFile}.bak-${Date.now()}`
        handle.db.exec(`VACUUM INTO '${backupFile.replaceAll("'", "''")}'`)
        backups.push(backupFile)
      } catch (error) {
        log('db-backup-failed', { message: error?.message ?? String(error) })
      }
    }
    handle.transaction(() => {
      handle.db.exec('DELETE FROM memory_turns')
      handle.db.exec('DELETE FROM memory_facts')
      handle.db.exec('DELETE FROM memory_summaries')
      handle.db.exec('DELETE FROM memory_episodes')
      handle.db.exec('DELETE FROM memory_events')
      handle.prepare('DELETE FROM collector_state WHERE layer = ?').run('memory')
      handle.prepare('DELETE FROM collector_pending WHERE layer = ?').run('memory')
      handle.prepare("DELETE FROM meta WHERE key LIKE 'memory.%' OR key = 'profile.user_name'").run()
    })
    learning?.reset()
    writeMarkdown()
    log('memory-reset', { backups: backups.length })
    return { backups }
  }

  const service = {
    name: 'dsh-memory',
    config,
    dir,
    dbFile,
    init,
    close() {
      closed = true
      characters = null
      entities = null
      if (handle !== undefined) handle.release()
      handle = undefined
    },
    rememberTurn,
    rememberEvent,
    events,
    // v2.1.0：召回自学习（context 层调用；enabled=false 时全是 no-op）。
    recallLearning() {
      return { enabled: learning?.enabled === true, mode: learning?.mode ?? 'rule' }
    },
    recallFeatureWeights() {
      return learning?.featureWeights() ?? { relevance: 1, salience: 1, recency: 1, topic: 1, affection: 1 }
    },
    recallTermFactor(terms) {
      return learning?.termFactor(terms) ?? 1
    },
    recordRecallInjection(items) {
      return learning?.recordInjection(items) ?? 0
    },
    applyRecallAttribution(input) {
      return learning?.applyAttribution(input) ?? { ok: false, reason: 'disabled' }
    },
    recordRecallMiss(input) {
      return learning?.recordMiss(input) ?? { ok: false, reason: 'disabled' }
    },
    learningStats() {
      return learning?.stats() ?? { enabled: false }
    },
    resetRecallLearning() {
      return learning?.reset() ?? false
    },
    recentTurns,
    turns,
    fetchTurn,
    fetchRange,
    findTurnBySeq,
    searchTurns,
    recentOriginal,
    recallOriginals,
    recordArchive,
    markArchived,
    archives,
    unconsolidatedTurns,
    markConsolidated,
    rememberEpisode,
    episodes,
    recallEpisodes,
    appendSummary,
    recall,
    facts,
    factsForPrompt,
    upsertFact,
    removeFact,
    summaries,
    setSummary,
    profile() {
      const value = getMetaValue(handle, 'profile.user_name')
      return { userName: typeof value === 'string' && value.length > 0 ? value : null }
    },
    snapshot,
    reset,
    /** 采集器统计注入（插件在创建 collector 后调用）。 */
    setCollectorStats(fn) {
      collectorStatsProvider = fn
    },
    collectorStats() {
      return typeof collectorStatsProvider === 'function' ? collectorStatsProvider() : undefined
    },
    // 采集 / 低频任务内部接口（插件与测试使用）
    dueForFacts,
    dueForSummary,
    runFactExtraction,
    runSummary,
    applyFacts,
    // v2.2.0：角色层（"我是谁"）。定义由模型按对话写出，存在 DB 里并保留版本历史。
    characters() {
      if (!handle) return null
      if (characters === null || characters === undefined) {
        characters = createCharacterStore({ db: handle.db, log })
        characters.ensure({ name: '' })
      }
      return characters
    },
    character() {
      const store = service.characters()
      return store ? store.get() : null
    },
    characterVersions(limit = 10) {
      const store = service.characters()
      return store ? store.versions(limit) : []
    },
    saveCharacter(input) {
      const store = service.characters()
      return store ? store.save(input) : { ok: false, reason: 'no-store' }
    },
    renameCharacter({ name, emoji } = {}) {
      const store = service.characters()
      return store ? store.setMeta({ name, emoji }) : null
    },
    characterNeedsRevision(evidenceTurns, everyTurns = 6) {
      const store = service.characters()
      return store ? store.needsRevision({ evidenceTurns, everyTurns }) : { needed: false }
    },
    /** 角色定义（给 context 层渲染注入段用）。 */
    characterRow() {
      return service.character()
    },
    // v2.3.0：实体层（患者 / 客户 / 项目…）。规则抽取，宁缺毋滥。
    entities() {
      if (!handle) return null
      if (entities === null || entities === undefined) {
        entities = createEntityStore({ db: handle.db, log })
      }
      return entities
    },
    entityList(limit = 50) {
      const store = service.entities()
      return store ? store.list(limit) : []
    },
    /** 按名字或 id 取档案（`/brain patient <名字>`）。 */
    entityProfile(nameOrId, options = {}) {
      const store = service.entities()
      if (!store) return null
      const key = String(nameOrId ?? '').trim()
      if (key.length === 0) return null
      const byId = store.get(key)
      const entity = byId ?? store.findByName(key)
      return entity ? store.profile(entity.id, options) : null
    },
    /** 从一批轮次里抽实体并建关联（后台整理时调用；同步、纯 DB）。 */
    entityIngest(turns) {
      const store = service.entities()
      if (!store) return { entities: 0, links: 0 }
      try {
        return store.ingestTurns(turns)
      } catch (error) {
        log('entity-ingest-failed', { message: error?.message ?? String(error) })
        return { entities: 0, links: 0 }
      }
    },
    /** 本轮文本里提到的已知实体（注入"当前对象"用）。 */
    entityResolve(text, limit = 2) {
      const store = service.entities()
      return store ? store.resolveMentions(text, limit) : []
    },
    /**
     * v2.3.0 表意识槽位 + 激活扩散：本轮在说谁。
     *
     * 点名优先；没点名就用本会话焦点（「他今天怎么样」能接上）；顺带给出相关对象。
     */
    entityResolveForTurn({ sessionId, text, limit = 2, factLimit = 6, turnLimit = 3, ttlMs, spread = true } = {}) {
      const store = service.entities()
      if (!store) return { profiles: [], viaFocus: false, related: [] }
      try {
        return store.resolveForTurn({ sessionId, text, limit, factLimit, turnLimit, ttlMs, spread })
      } catch (error) {
        log('entity-resolve-failed', { message: error?.message ?? String(error) })
        return { profiles: [], viaFocus: false, related: [] }
      }
    },
    /** 直接给 context 层用的档案列表（已带最近轮次与要点）。 */
    entityProfilesForPrompt(text, { limit = 2, factLimit = 6, turnLimit = 3 } = {}) {
      const store = service.entities()
      if (!store) return []
      return store
        .resolveMentions(text, limit)
        .map((entity) => store.profile(entity.id, { factLimit, turnLimit }))
        .filter(Boolean)
    },
    /**
     * v2.3.0 睡眠期结构化巩固：把模型抽出的字段（主诉 / 辨证 / 处方 / 复诊…）
     * 写进对象档案。只接受已知对象，同文本去重。
     */
    entityApplyExtraction(name, items) {
      const store = service.entities()
      return store ? store.applyExtraction(name, items) : 0
    },
    getLastSeq,
    setLastSeq,
    getPending,
    setPending,
    clearPending,
    counts,
    /** 底层句柄（工具/测试只读）。 */
    handle() {
      return handle
    },
  }
  return service
}





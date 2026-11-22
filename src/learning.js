/**
 * 深月桌面脑：召回自学习（v2.1.0，核心）。
 *
 * 目标：召回层自己学「怎么召回」——哪条记忆真被用上、哪些检索词是好触发词、
 * 哪个打分特征更可靠；用户说「你忘了」时留下 miss 并加权，让下一轮更容易捞回来。
 *
 * 关键设计（防自我强化）：
 *   - 归因只看「内容级命中」：本轮 assistant 回复或下一轮 user 文本里真的出现了
 *     片段/关键词才算；仅 assistant 复述注入内容按 0.5（echo）计，不能算满分 used；
 *   - 单条 usefulness 用 EMA（α=0.3）；term 权重每轮最多 ±lr（默认 0.05），
 *     clamp [0.1,3]，并每天 ×0.95 向 1 回落，不可能单调放大；
 *   - 全局特征权重用小步误差更新（默认 0.05），同样 clamp；
 *   - 归因失败静默（只写日志），不影响会话/归档；llm judge 单轮最多 1 次。
 *
 * 存储：`recall_item_stats` / `recall_term_weights` / `recall_misses` /
 * `recall_feature_weights`（schema 5，见 src/db.js）。本模块不直接读 memory_turns。
 */

import { completeText, resolveRoute } from './llm.js'
import { clamp } from './store.js'

/** 自学习默认参数（memory 层 config 可覆盖）。 */
export const LEARNING_DEFAULTS = Object.freeze({
  enabled: true,
  mode: 'rule',
  // 学习率调小：归因有噪声时宁可少学，也不要整体塌陷。
  learningRate: 0.03,
  usefulnessAlpha: 0.3,
  featureRate: 0.02,
  decayPerDay: 0.95,
  missBoost: 1.5,
  weightMin: 0.4,
  weightMax: 3,
  // 全局特征权重有独立地板/天花板：ignored 再多也不允许把相关性/新近打到 0.2。
  featureWeightMin: 0.5,
  featureWeightMax: 1.5,
})

/** 遗忘信号：用户明确表示「你忘了 / 不记得 / 之前说过 / 上次 / 我记得 / 忘了吗」。 */
export const FORGET_PATTERN = /你忘了|不记得|之前说过|上次|我记得|忘了吗/gu

/** 全局特征名（与 recall_feature_weights 初始行一致）。 */
export const FEATURE_NAMES = Object.freeze(['relevance', 'salience', 'recency', 'topic', 'affection'])

/** 检索词噪声：这些词不作为可学习 term（太泛，学不出信息）。 */
const STOP_TERMS = new Set([
  '我们',
  '你们',
  '他们',
  '这个',
  '那个',
  '就是',
  '还是',
  '可以',
  '什么',
  '怎么',
  '因为',
  '所以',
  '但是',
  '然后',
  '现在',
  '已经',
  '一个',
  '没有',
  '不是',
  '知道',
  '觉得',
  '时候',
  '东西',
  '事情',
  '这样',
  '那样',
  '真的',
  '其实',
  '如果',
  '而且',
  '还有',
  '或者',
  '以及',
  '关于',
  '自己',
  '用户',
  '助手',
  '一下',
  '一点',
  '这些',
  '那些',
])

// 运行时补充的常见二元组/虚词：这些词做 term 只会污染权重，不携带检索信息。
for (const noise of [
  '上下',
  '下文',
  '上面',
  '下面',
  '我的',
  '你的',
  '不会',
  '一轮',
  '两句',
  '一句',
  '说到',
  '看到',
  '想到',
  '做了',
  '用的',
  '这个',
  '那个',
  '时候',
  '问题',
  '东西',
]) {
  STOP_TERMS.add(noise)
}

/** 小写 + 去空白/标点（用于包含判断）。 */
export function normalizeTerm(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 中文二元组集合（用于片段覆盖判断）。 */
function bigramsOf(text) {
  const value = normalizeTerm(text)
  const grams = new Set()
  for (let index = 0; index + 1 < value.length; index += 1) grams.add(value.slice(index, index + 2))
  return grams
}

/**
 * 从一段文本抽可学习检索词：中文二元组 + 拉丁词；过滤泛词，去重，限长。
 * @param {string} text 文本。
 * @param {number} [max] 最多几个词。
 * @returns {string[]}
 */
export function termsOf(text, max = 12) {
  const raw = String(text ?? '')
  const terms = new Set()
  const push = (term) => {
    const value = normalizeTerm(term)
    if (value.length < 2 || value.length > 24) return
    if (STOP_TERMS.has(value)) return
    terms.add(value)
  }
  for (const segment of raw.match(/[\u3400-\u9fff]+/gu) ?? []) {
    for (let index = 0; index + 1 < segment.length; index += 1) push(segment.slice(index, index + 2))
  }
  for (const word of raw.toLowerCase().match(/[a-z0-9][a-z0-9_+.-]{1,23}/gu) ?? []) push(word)
  return [...terms].slice(0, max)
}

/** 把 space-separated 的 terms 字符串拆开。 */
export function splitTerms(terms) {
  return String(terms ?? '')
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
}

/**
 * 一条注入片段与一段文本的「内容级」匹配分（0..1）。
 * 取 term 命中率与片段 bigram 覆盖率的最大值：不要求逐字复述，也不能只靠模板词。
 */
export function itemMatchScore(item, text) {
  const normText = normalizeTerm(text)
  if (normText.length === 0) return 0
  const terms = (Array.isArray(item?.terms) ? item.terms : [])
    .map(normalizeTerm)
    .filter((term) => term.length >= 2)
  let termRatio = 0
  if (terms.length > 0) {
    let hits = 0
    for (const term of terms) if (normText.includes(term)) hits += 1
    termRatio = hits / Math.min(terms.length, 6)
  }
  const snippetGrams = bigramsOf(item?.snippet ?? '')
  let coverage = 0
  if (snippetGrams.size > 0) {
    let hits = 0
    for (const gram of snippetGrams) if (normText.includes(gram)) hits += 1
    coverage = hits / Math.min(snippetGrams.size, 24)
  }
  return Math.max(termRatio, coverage * 0.9)
}

/** 纯函数：rule 模式归因（不写库，便于单测）。 */
export function attributeUse({ injectedItems, assistantText, nextUserText, mode = 'rule' } = {}) {
  const items = (Array.isArray(injectedItems) ? injectedItems : []).filter(
    (item) => item !== null && typeof item === 'object' && typeof item.id === 'string' && item.id.length > 0,
  )
  const usedIds = []
  const echoIds = []
  const ignoredIds = []
  const usedTerms = []
  const echoTerms = []
  const ignoredTerms = []
  const scores = {}
  const termUsed = new Set()
  const termEcho = new Set()
  const termIgnored = new Set()
  const normAssistant = normalizeTerm(assistantText)
  const normUser = normalizeTerm(nextUserText)

  for (const item of items) {
    const userScore = itemMatchScore(item, nextUserText)
    const assistantScore = itemMatchScore(item, assistantText)
    // 下一轮用户接话 → 满分；只是助手复述 → 0.5（echo，不强化）；否则 ignored。
    const score = userScore >= 0.34 ? 1 : assistantScore >= 0.5 ? 0.5 : 0
    scores[item.id] = score
    if (score === 1) usedIds.push(item.id)
    else if (score === 0.5) echoIds.push(item.id)
    else ignoredIds.push(item.id)

    const itemTerms = (Array.isArray(item.terms) ? item.terms : [])
      .map(normalizeTerm)
      .filter((term) => term.length >= 2)
    if (score === 1) {
      // 只有真的出现在「下一轮用户话里」的词才算被用户确认。
      for (const term of itemTerms) if (normUser.includes(term)) termUsed.add(term)
    } else if (score === 0.5) {
      // 助手复述（用户没接话）：单独标记，归因时按 ignored 处理（防自我强化）。
      for (const term of itemTerms) if (normAssistant.includes(term)) termEcho.add(term)
    } else {
      for (const term of itemTerms) termIgnored.add(term)
    }
  }

  for (const term of termUsed) usedTerms.push({ term, score: 1 })
  for (const term of termEcho) if (!termUsed.has(term)) echoTerms.push(term)
  for (const term of termIgnored) {
    if (!termUsed.has(term) && !termEcho.has(term)) ignoredTerms.push(term)
  }
  return { mode, usedIds, echoIds, ignoredIds, usedTerms, echoTerms, ignoredTerms, scores, missedTopicTerms: [] }
}

/** 安全解析 judge 输出。 */
export function parseJudgeOutput(text) {
  const match = /\{[\s\S]*\}/u.exec(String(text ?? ''))
  if (match === null) return undefined
  try {
    const value = JSON.parse(match[0])
    const pickIds = (list) =>
      Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item.length > 0) : []
    const pickTerms = (list) =>
      Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item.trim().length > 0) : []
    return {
      usedIds: pickIds(value.used ?? value.usedIds),
      ignoredIds: pickIds(value.ignored ?? value.ignoredIds),
      missedTopicTerms: pickTerms(value.missedTopicTerms ?? value.missed),
    }
  } catch {
    return undefined
  }
}

/**
 * 低预算 judge：单轮最多 1 次模型调用，判断哪些注入片段真被用上、哪些主题没召回。
 * 失败/无法解析返回 undefined（调用方退回 rule 结果）。
 */
export async function judgeAttribution({ ctx, items, assistantText, nextUserText, maxTokens = 240 } = {}) {
  if (ctx === undefined || typeof ctx.get !== 'function') return undefined
  const list = (Array.isArray(items) ? items : []).slice(0, 8)
  if (list.length === 0) return undefined
  const compact = list.map((item) => ({
    id: item.id,
    snippet: String(item.snippet ?? '').slice(0, 120),
    terms: Array.isArray(item.terms) ? item.terms.slice(0, 8) : [],
  }))
  const route = resolveRoute(ctx, {})
  const output = await completeText(ctx, {
    route,
    system: '你是记忆召回质量判定器。只输出 JSON，不要解释。',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              '下面是本轮注入给助手的记忆片段：',
              JSON.stringify(compact),
              '',
              '助手回复（节选）：',
              String(assistantText ?? '').slice(0, 1200),
              '',
              '用户下一轮消息（节选）：',
              String(nextUserText ?? '').slice(0, 800),
              '',
              '判断：user 下一轮继续了该记忆的话题、或助手回复确实利用了该内容 → used；',
              '既没出现在回复里、也没被用户接续 → ignored；',
              '用户抱怨「忘了/不记得」且该主题没被召回 → 放进 missedTopicTerms。',
              '输出 JSON：{"used":["id"],"ignored":["id"],"missedTopicTerms":["词"]}',
            ].join('\n'),
          },
        ],
      },
    ],
    temperature: 0,
    maxTokens,
    signal: AbortSignal.timeout(15000),
  })
  return parseJudgeOutput(output)
}

/** 权重按天向 1 回落（decayPerDay^days）。 */
export function decayWeight(weight, updatedAt, now = Date.now(), decayPerDay = LEARNING_DEFAULTS.decayPerDay) {
  const value = Number(weight)
  if (!Number.isFinite(value)) return 1
  const last = Date.parse(updatedAt ?? '')
  const days = Number.isFinite(last) ? Math.max(0, (now - last) / 86400000) : 0
  const factor = Math.pow(decayPerDay, days)
  return 1 + (value - 1) * factor
}

/** usefulness EMA（α=0.3）。 */
export function nextUsefulness(previous, target, alpha = LEARNING_DEFAULTS.usefulnessAlpha) {
  const base = Number.isFinite(Number(previous)) ? Number(previous) : 0.5
  const goal = Number.isFinite(Number(target)) ? clamp(Number(target), 0, 1) : 0
  return clamp(base + alpha * (goal - base), 0, 1)
}

/** 检测遗忘信号；返回命中的片段（没有则 null）。 */
export function detectForgetSignal(text) {
  const value = String(text ?? '')
  FORGET_PATTERN.lastIndex = 0
  const match = FORGET_PATTERN.exec(value)
  if (match === null) return null
  const start = Math.max(0, match.index - 40)
  const end = Math.min(value.length, match.index + match[0].length + 80)
  return value.slice(start, end)
}

/** 遗忘信号句里不该当作主题词的元词/虚词片段。 */
const FORGET_META_PATTERN = /[你我他她它吗呢吧了啊呀的得地这那哪]/u

/**
 * 从遗忘信号句 + 上一轮用户文本抽「没召回的主题词」。
 * 去掉「你忘了/不记得」等元词与虚词片段，只留内容词。
 */
export function forgetTopicTerms(text, previousText = '') {
  const sentence = String(text ?? '').replace(FORGET_PATTERN, ' ')
  return termsOf(`${sentence} ${previousText}`, 12)
    .filter((term) => term.length >= 2 && !FORGET_META_PATTERN.test(term))
    .slice(0, 10)
}

/** 读特征权重（缺行按 1）。 */
export function readFeatureWeights(handle) {
  const result = {}
  for (const feature of FEATURE_NAMES) result[feature] = 1
  try {
    for (const row of handle.db.prepare('SELECT feature, weight FROM recall_feature_weights').all()) {
      if (FEATURE_NAMES.includes(row.feature) && Number.isFinite(Number(row.weight))) {
        result[row.feature] = Number(row.weight)
      }
    }
  } catch {
    /* 旧库/缺表时按默认 1 */
  }
  return result
}

/**
 * 创建召回学习仓库（挂在记忆层上，共用同一个 DB 句柄）。
 * @param {{handle: object, config: object, log: (event: string, data?: object) => void}} options
 */
export function createLearningStore({ handle, config = {}, log = () => {} }) {
  const enabled = config.recallLearningEnabled !== false
  const mode = config.recallLearningMode === 'llm' ? 'llm' : 'rule'
  const learningRate = clamp(Number(config.recallLearningRate) || LEARNING_DEFAULTS.learningRate, 0.01, 0.5)
  const usefulnessAlpha = clamp(Number(config.recallUsefulnessAlpha) || LEARNING_DEFAULTS.usefulnessAlpha, 0.05, 0.9)
  const featureRate = clamp(Number(config.recallFeatureRate) || LEARNING_DEFAULTS.featureRate, 0.01, 0.5)
  const decayPerDay = clamp(Number(config.recallWeightDecayPerDay) || LEARNING_DEFAULTS.decayPerDay, 0.5, 1)
  const missBoost = clamp(Number(config.recallMissBoost) || LEARNING_DEFAULTS.missBoost, 1, 3)
  const weightMin = LEARNING_DEFAULTS.weightMin
  const weightMax = LEARNING_DEFAULTS.weightMax

  /** 当前特征权重。 */
  function featureWeights() {
    return readFeatureWeights(handle)
  }

  /** 查询若干 term 已学到的权重（只返回库里有的）。 */
  function termWeights(terms) {
    const unique = [...new Set((Array.isArray(terms) ? terms : []).map(normalizeTerm).filter((term) => term.length >= 2))].slice(
      0,
      40,
    )
    const result = new Map()
    if (unique.length === 0) return result
    try {
      const placeholders = unique.map(() => '?').join(',')
      for (const row of handle.db
        .prepare(`SELECT term, weight FROM recall_term_weights WHERE term IN (${placeholders})`)
        .all(...unique)) {
        result.set(row.term, Number(row.weight))
      }
    } catch {
      /* 缺表时按 1 */
    }
    return result
  }

  /**
   * 把一个记忆片段的检索词折算成整体倍率（几何平均；未学过的词不影响）。
   * 例：两个词 1.2 / 0.8 → 0.98；一个词 1.5 → 1.5。
   */
  function termFactor(terms) {
    const weights = [...termWeights(terms).values()].filter((weight) => Number.isFinite(weight) && weight > 0)
    if (weights.length === 0) return 1
    const meanLog = weights.reduce((total, weight) => total + Math.log(weight), 0) / weights.length
    return clamp(Math.exp(meanLog), 0.25, 3)
  }

  /** 注入计数（只记注入，归因在下一轮做）。 */
  function recordInjection(items) {
    if (!enabled) return 0
    let recorded = 0
    const at = new Date().toISOString()
    for (const item of Array.isArray(items) ? items : []) {
      if (item === null || typeof item !== 'object' || typeof item.id !== 'string' || item.id.length === 0) continue
      try {
        handle.db
          .prepare(
            `INSERT INTO recall_item_stats(memory_id, injected, used, ignored, usefulness, updated_at)
             VALUES(?, 1, 0, 0, 0.5, ?)
             ON CONFLICT(memory_id) DO UPDATE SET injected = injected + 1, updated_at = excluded.updated_at`,
          )
          .run(item.id, at)
        recorded += 1
      } catch (error) {
        log('recall-injection-record-failed', { message: error?.message ?? String(error) })
      }
    }
    return recorded
  }

  /** 读一条 term 行（不存在返回 undefined）。 */
  function readTerm(term) {
    try {
      return handle.db.prepare('SELECT * FROM recall_term_weights WHERE term = ?').get(term)
    } catch {
      return undefined
    }
  }

  /** 写一条 term（按天衰减后套用 fn）。 */
  function writeTerm(term, fn, field) {
    const normalized = normalizeTerm(term)
    if (normalized.length < 2) return
    const row = readTerm(normalized)
    const now = Date.now()
    const base = decayWeight(row?.weight ?? 1, row?.updated_at, now, decayPerDay)
    // term 权重用 weightMin（0.4）做地板，避免通用词被压到 0.19 后挤掉真正有用的词。
    const next = clamp(fn(base), weightMin, weightMax)
    const hits = (Number(row?.hits) || 0) + (field === 'hits' ? 1 : 0)
    const misses = (Number(row?.misses) || 0) + (field === 'misses' ? 1 : 0)
    try {
      handle.db
        .prepare(
          `INSERT INTO recall_term_weights(term, weight, hits, misses, updated_at) VALUES(?, ?, ?, ?, ?)
           ON CONFLICT(term) DO UPDATE SET weight = excluded.weight, hits = excluded.hits,
             misses = excluded.misses, updated_at = excluded.updated_at`,
        )
        .run(normalized, next, hits, misses, new Date(now).toISOString())
    } catch (error) {
      log('recall-term-write-failed', { message: error?.message ?? String(error) })
    }
  }

  /**
   * 应用一次归因：单条 usefulness + term 权重 + 全局特征权重。
   * @param {{items: object[], attribution: object, assistantText?: string, nextUserText?: string}} input
   */
  function applyAttribution({ items, attribution }) {
    if (!enabled || attribution === undefined || attribution === null) return { ok: false, reason: 'disabled' }
    const list = (Array.isArray(items) ? items : []).filter((item) => typeof item?.id === 'string')
    if (list.length === 0) return { ok: false, reason: 'no-items' }
    const scores = attribution.scores ?? {}
    const usedIds = new Set(attribution.usedIds ?? [])
    const ignoredIds = new Set(attribution.ignoredIds ?? [])
    const at = new Date().toISOString()
    let updatedItems = 0
    let updatedTerms = 0
    let updatedFeatures = 0
    try {
      handle.transaction(() => {
        // 1) 单条记忆注入/命中/忽略 + usefulness EMA。
        const itemStatement = handle.db.prepare(
          `INSERT INTO recall_item_stats(memory_id, injected, used, ignored, usefulness, updated_at)
           VALUES(?, 0, ?, ?, ?, ?)
           ON CONFLICT(memory_id) DO UPDATE SET
             used = used + excluded.used,
             ignored = ignored + excluded.ignored,
             usefulness = excluded.usefulness,
             updated_at = excluded.updated_at`,
        )
        for (const item of list) {
          const score = Number.isFinite(Number(scores[item.id]))
            ? clamp(Number(scores[item.id]), 0, 1)
            : usedIds.has(item.id)
              ? 1
              : 0
          const row = handle.db.prepare('SELECT usefulness FROM recall_item_stats WHERE memory_id = ?').get(item.id)
          const usefulness = nextUsefulness(row?.usefulness ?? 0.5, score, usefulnessAlpha)
          itemStatement.run(item.id, score > 0 ? 1 : 0, score > 0 ? 0 : 1, usefulness, at)
          updatedItems += 1
          // 2) 全局特征权重：预测分（注入时得分）vs 实际 use 的误差。
          const predicted = clamp(Number(item.score) || 0, 0, 1)
          const error = score - predicted
          if (Math.abs(error) >= 0.02 && item.features !== null && typeof item.features === 'object') {
            for (const [feature, value] of Object.entries(item.features)) {
              if (!FEATURE_NAMES.includes(feature) || !Number.isFinite(Number(value))) continue
              const current = featureWeights()[feature] ?? 1
              // 不对称更新：ignored 只轻轻降（×0.5），used 正常升；并限制在 [0.5,1.5]。
              const effectiveError = error < 0 ? error * 0.5 : error
              const next = clamp(
                current + featureRate * effectiveError * clamp(Number(value), 0, 1),
                LEARNING_DEFAULTS.featureWeightMin,
                LEARNING_DEFAULTS.featureWeightMax,
              )
              if (Math.abs(next - current) < 0.0001) continue
              handle.db
                .prepare(
                  `INSERT INTO recall_feature_weights(feature, weight, updated_at) VALUES(?, ?, ?)
                   ON CONFLICT(feature) DO UPDATE SET weight = excluded.weight, updated_at = excluded.updated_at`,
                )
                .run(feature, next, at)
              updatedFeatures += 1
            }
          }
          // 3) 该条记忆的 term 在循环外统一处理（避免同一词被 used/ignored 双写）。
        }
        // 3) 检索词权重：用户确认 → 变强；助手复述（用户没接话）/ 忽略 → 变弱。
        //    echo 也按 ignored 处理，这是防「注入→复述→更强」自我强化的关键。
        const usedTermSet = new Set()
        for (const entry of Array.isArray(attribution.usedTerms) ? attribution.usedTerms : []) {
          const term = normalizeTerm(entry?.term)
          if (term.length >= 2) usedTermSet.add(term)
        }
        for (const term of usedTermSet) {
          writeTerm(term, (weight) => weight * (1 + learningRate), 'hits')
          updatedTerms += 1
        }
        const demoted = new Set()
        for (const entry of Array.isArray(attribution.echoTerms) ? attribution.echoTerms : []) {
          const term = normalizeTerm(entry)
          if (term.length >= 2) demoted.add(term)
        }
        for (const entry of Array.isArray(attribution.ignoredTerms) ? attribution.ignoredTerms : []) {
          const term = normalizeTerm(entry)
          if (term.length >= 2) demoted.add(term)
        }
        for (const term of demoted) {
          if (usedTermSet.has(term)) continue
          writeTerm(term, (weight) => weight * (1 - learningRate), 'misses')
          updatedTerms += 1
        }
      })
      log('recall-attribution', {
        mode,
        items: updatedItems,
        terms: updatedTerms,
        features: updatedFeatures,
        used: usedIds.size,
        ignored: ignoredIds.size,
      })
      return { ok: true, items: updatedItems, terms: updatedTerms, features: updatedFeatures }
    } catch (error) {
      log('recall-attribution-failed', { message: error?.message ?? String(error) })
      return { ok: false, reason: 'error' }
    }
  }

  /** 记录遗忘信号并加权相关词（下一轮召回优先）。 */
  function recordMiss({ sessionId, turn, at, terms, sourceText }) {
    const list = (Array.isArray(terms) ? terms : [])
      .map(normalizeTerm)
      .filter((term) => term.length >= 2)
      .slice(0, 10)
    if (list.length === 0) return { ok: false, reason: 'no-terms' }
    try {
      handle.db
        .prepare('INSERT INTO recall_misses(session_id, turn, at, terms, source_text) VALUES(?, ?, ?, ?, ?)')
        .run(
          typeof sessionId === 'string' ? sessionId : null,
          Number.isFinite(Number(turn)) ? Math.round(Number(turn)) : null,
          typeof at === 'string' ? at : new Date().toISOString(),
          list.join(' '),
          String(sourceText ?? '').slice(0, 400),
        )
      for (const term of list) writeTerm(term, (weight) => weight * missBoost, 'misses')
      log('recall-miss', { terms: list, sourceChars: String(sourceText ?? '').length })
      return { ok: true, terms: list }
    } catch (error) {
      log('recall-miss-failed', { message: error?.message ?? String(error) })
      return { ok: false, reason: 'error' }
    }
  }

  /** 最近 miss（新→旧）。 */
  function recentMisses(limit = 5) {
    if (limit <= 0) return []
    try {
      return handle.db
        .prepare('SELECT * FROM recall_misses ORDER BY id DESC LIMIT ?')
        .all(limit)
        .map((row) => ({
          at: row.at,
          sessionId: row.session_id,
          turn: row.turn,
          terms: splitTerms(row.terms),
          sourceText: row.source_text,
        }))
    } catch {
      return []
    }
  }

  /** top 学到的词（偏离 1 最多的）。 */
  function topTerms(limit = 8) {
    try {
      return handle.db
        .prepare(
          'SELECT term, weight, hits, misses FROM recall_term_weights ORDER BY ABS(weight - 1) DESC, weight DESC LIMIT ?',
        )
        .all(limit)
        .map((row) => ({
          term: row.term,
          weight: Number(row.weight),
          hits: Number(row.hits),
          misses: Number(row.misses),
        }))
    } catch {
      return []
    }
  }

  /** 学习统计（/brain learn 与 snapshot）。 */
  function stats() {
    const result = {
      enabled,
      mode,
      learningRate,
      featureRate,
      decayPerDay,
      missBoost,
      items: { tracked: 0, injected: 0, used: 0, ignored: 0, hitRate: 0 },
      features: featureWeights(),
      topTerms: topTerms(8),
      recentMisses: recentMisses(5),
    }
    if (!enabled) return result
    try {
      const row = handle.db
        .prepare('SELECT COUNT(*) AS tracked, COALESCE(SUM(injected),0) AS injected, COALESCE(SUM(used),0) AS used, COALESCE(SUM(ignored),0) AS ignored FROM recall_item_stats')
        .get()
      result.items.tracked = Number(row?.tracked) || 0
      result.items.injected = Number(row?.injected) || 0
      result.items.used = Number(row?.used) || 0
      result.items.ignored = Number(row?.ignored) || 0
      const judgments = result.items.used + result.items.ignored
      result.items.hitRate = judgments > 0 ? result.items.used / judgments : 0
      const misses = handle.db.prepare('SELECT COUNT(*) AS c FROM recall_misses').get()
      result.misses = Number(misses?.c) || 0
    } catch {
      /* 缺表时返回空统计 */
    }
    return result
  }

  /** 清空学习数据（/brain reset confirm 用）。 */
  function reset() {
    try {
      handle.db.exec('DELETE FROM recall_item_stats')
      handle.db.exec('DELETE FROM recall_term_weights')
      handle.db.exec('DELETE FROM recall_misses')
      handle.db.exec('DELETE FROM recall_feature_weights')
      for (const feature of FEATURE_NAMES) {
        handle.db
          .prepare('INSERT OR IGNORE INTO recall_feature_weights(feature, weight, updated_at) VALUES(?, 1, ?)')
          .run(feature, new Date().toISOString())
      }
      return true
    } catch (error) {
      log('recall-learning-reset-failed', { message: error?.message ?? String(error) })
      return false
    }
  }

  return {
    enabled,
    mode,
    featureWeights,
    termWeights,
    termFactor,
    recordInjection,
    applyAttribution,
    recordMiss,
    recentMisses,
    topTerms,
    stats,
    reset,
  }
}

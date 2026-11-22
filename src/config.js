/**
 * 深月桌面脑（dsh-brain）：四层配置的默认值与归一化。
 *
 * 本包零依赖（本地 link 安装，解析不到 `@deepseek-ai/schemastery`），因此不导出
 * schemastery `Config`；每层入口在 `apply` 里调用自己的 normalize 函数：补默认值、
 * 收敛类型、挡住越界值，并把不认识的字段记成 warning（不报错）。
 *
 * 四层：memory / mood / persona / context；每层有独立 config，可单独 enable/disable。
 * 采集过滤（哪些 DSH 会话进入记忆）在三层各有一份同名配置，默认值一致。
 */

import { DEFAULT_CONSOLIDATE_CONFIG } from './consolidator.js'
import { booleanOr, clamp, integerOr, numberOr, stringOr } from './store.js'

/** 采集过滤的默认值（memory / mood / persona 三层各有一份同名配置）。 */
export const COLLECT_DEFAULTS = Object.freeze({
  /** 是否采集 subagent 子会话（默认不采集，避免子代理的自动输出反噬记忆）。 */
  collectSubagents: false,
  /** 会话 id 命中该正则时跳过（默认跳过名字里带 pet 的会话）。 */
  excludeSessionIdPattern: 'pet',
  /** 只采集这些会话 id（正则数组，空数组表示全采集；与 exclude 同时命中时以 include 优先）。 */
  includeSessions: Object.freeze([]),
  /** 单条消息采集时的最大字符数（v2.0.0：默认 20000，记忆库要「全存」）。 */
  maxTextChars: 20000,
  /** 短于该长度的消息不采集（例如「嗯」「好」）。 */
  minTextChars: 2,
  /** v2.1.0：是否把系统/工具事件落到 `memory_events`（默认 false，只隔离不存）。 */
  includeSystemEvents: false,
})

/** 记忆层默认值。 */
export const DEFAULT_MEMORY_CONFIG = Object.freeze({
  dataDir: '',
  /** SQLite 数据库文件；空字符串表示 `<dataDir>/brain.db`。 */
  dbFile: '',
  /** 是否启用本层（与行 enable/disable 互为补充，便于在 patch 里单独关掉采集）。 */
  enabled: true,
  /** 记忆里保留的最近对话轮数。 */
  maxTurns: 60,
  /** 滚动摘要：每累计多少轮尝试一次（LLM，异步、失败静默）。 */
  summaryThreshold: 24,
  /** 是否启用滚动摘要（关闭后只保留原文与事实）。 */
  summaryEnabled: true,
  /** 每隔几轮对话做一次结构化事实抽取。 */
  factExtractInterval: 3,
  /** 事实抽取方式：rule（纯规则，零模型调用）| llm（规则 + LLM 补充）| off。 */
  factExtractMode: 'rule',
  /** 每一侧（user / self）的事实总条数上限。 */
  maxFactsPerSide: 80,
  /** 单条事实最长字符数。 */
  maxFactChars: 60,
  /** 是否写 brain.md 镜像。 */
  writeMarkdown: true,
  /**
   * v2.1.0：召回自学习（默认开；改 false 一键关闭，不写任何 recall_* 表）。
   * rule = 纯规则归因（零模型调用）；llm = 低预算 judge（单轮最多 1 次调用）。
   */
  recallLearningEnabled: true,
  recallLearningMode: 'rule',
  /** 检索词权重学习率（每轮 ±lr，clamp [0.1,3]，按天 ×0.95 回归 1）。 */
  recallLearningRate: 0.05,
  /** 单条记忆 usefulness 的 EMA 系数。 */
  recallUsefulnessAlpha: 0.3,
  /** 全局特征权重学习率。 */
  recallFeatureRate: 0.05,
  /** 权重每天向 1 回落的因子。 */
  recallWeightDecayPerDay: 0.95,
  /** 用户说「你忘了」时相关词的加权倍数。 */
  recallMissBoost: 1.5,
  /** 采集过滤。 */
  ...COLLECT_DEFAULTS,
})

/** 情绪层默认值。 */
export const DEFAULT_MOOD_CONFIG = Object.freeze({
  dataDir: '',
  /** SQLite 数据库文件；空字符串表示 `<dataDir>/brain.db`。 */
  dbFile: '',
  enabled: true,
  /** 距上次更新超过这么多分钟才做时间衰减回归。 */
  moodDecayMinutes: 120,
  /** 每一侧心情轨迹保留条数。 */
  historyLimit: 30,
  /** 深夜（0–6 点）额外扣的精力。 */
  deepNightEnergyPenalty: 0.05,
  /** 深夜额外扣的心情值。 */
  deepNightValencePenalty: 0.02,
  ...COLLECT_DEFAULTS,
})

/** 人格层默认值。 */
export const DEFAULT_PERSONA_CONFIG = Object.freeze({
  dataDir: '',
  /** SQLite 数据库文件；空字符串表示 `<dataDir>/brain.db`。 */
  dbFile: '',
  enabled: true,
  /** 是否启用动态倾向（false 时固定用基线渲染）。 */
  dynamicsEnabled: true,
  /** 用户侧倾向基线：directness / pace / humor / detail。 */
  baselineUser: Object.freeze({ directness: 0.5, pace: 0.5, humor: 0.4, detail: 0.5 }),
  /** 助手侧倾向基线：warmth / directness / playfulness / proactivity。 */
  baselineSelf: Object.freeze({ warmth: 0.6, directness: 0.55, playfulness: 0.4, proactivity: 0.5 }),
  /** 助手侧每天向基线回归的比例。 */
  regressionPerDaySelf: 0.3,
  /** 用户侧每天向基线回归的比例（更慢，用户画像应相对稳定）。 */
  regressionPerDayUser: 0.12,
  ...COLLECT_DEFAULTS,
})

/** 上下文整理层默认值。 */
export const DEFAULT_CONTEXT_CONFIG = Object.freeze({
  dataDir: '',
  /** 是否注册 system prompt 注入段（false 时不注入，也不注册命令）。 */
  enabled: true,
  /** 对用户的称呼（注入文案里用「你/用户」，这里只影响少量措辞）。 */
  userName: '用户',
  /** 对助手自己的称呼。 */
  agentName: '助手',
  /** 注入文本总长上限（字符）。 */
  maxChars: 1800,
  /** 每侧最多注入几条事实。 */
  factLimit: 6,
  /** 工作记忆（从长期记忆捞出的相关回忆）单次注入的字符预算。 */
  workingMemoryMaxChars: 1200,
  /** v2.0.0 起召回预算的主名字（与 workingMemoryMaxChars 同义，优先读它）。 */
  recallMaxChars: 1200,
  /** 最多注入几条相关情节记忆。 */
  recallLimit: 4,
  /** 情节不够时，最多再补几条「相关旧对话/归档原文」。 */
  turnRecallLimit: 3,
  /** 同一条记忆多少轮内不重复注入（被再次提到时会刷新）。 */
  recallCooldownTurns: 3,
  /** 话题连续性：用最近几轮用户输入判断当前话题。 */
  topicShiftEnabled: true,
  recallTopicTurns: 2,
  /** 归档（把已全存的旧轮次从当前会话 surface 移除，替换成一条极短标记）。 */
  archiveEnabled: false,
  /** 归档触发：上下文占用超过该比例（0..1）才考虑归档。 */
  archiveAtPercent: 0.5,
  /** 归档时保留最近多少轮（再加当前轮）。 */
  keepRecentTurns: 4,
  /** 单次最多归档多少轮。 */
  archiveMaxTurnsPerBatch: 8,
  /** 归档标记文案：oneline（一行完整）| compact（极短）。 */
  archiveMarker: 'oneline',
  /** 只归档这些会话（空数组=全部；验证时用白名单）。 */
  archiveSessionIds: Object.freeze([]),
  /** 安全闸：true 时只计算/校验/写日志，不 append（验证期默认 true）。 */
  archiveDryRun: true,
  /** 是否注入用户侧（关于你）。 */
  includeUser: true,
  /** 是否注入助手侧（关于我）。 */
  includeSelf: true,
  /** system prompt 段的排序位置（越大越靠后）。 */
  sectionOrder: 100,
  /** 是否注册 /brain 命令。 */
  commandEnabled: true,
  /** 诊断：每次 sectionText() 被调用时写 section-text 日志（默认关）。 */
  debugSection: false,
  /** 后台消化相关（详见 consolidator.js 的 DEFAULT_CONSOLIDATE_CONFIG）。 */
  ...DEFAULT_CONSOLIDATE_CONFIG,
})

/** 通用：把原始 config 转对象并收集未知字段。 */
function prepare(raw, defaults, layer) {
  const warnings = []
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (raw !== null && raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw))) {
    warnings.push(`${layer} config 不是对象，已按默认值处理`)
  }
  const known = new Set(Object.keys(defaults))
  for (const key of Object.keys(input)) {
    if (!known.has(key)) warnings.push(`${layer} 未知配置项 ${key} 已忽略`)
  }
  return { input, warnings }
}

/** 收采集过滤配置。 */
function collectConfig(input) {
  const includeSessions = Array.isArray(input.includeSessions)
    ? input.includeSessions.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : COLLECT_DEFAULTS.includeSessions
  return {
    collectSubagents: booleanOr(input.collectSubagents, COLLECT_DEFAULTS.collectSubagents),
    excludeSessionIdPattern: stringOr(input.excludeSessionIdPattern, COLLECT_DEFAULTS.excludeSessionIdPattern),
    includeSessions: Object.freeze([...includeSessions]),
    maxTextChars: integerOr(input.maxTextChars, COLLECT_DEFAULTS.maxTextChars, 50, 200000),
    minTextChars: integerOr(input.minTextChars, COLLECT_DEFAULTS.minTextChars, 1, 100),
    includeSystemEvents: booleanOr(input.includeSystemEvents, COLLECT_DEFAULTS.includeSystemEvents),
  }
}

/** 归一化记忆层配置。 */
export function normalizeMemoryConfig(raw) {
  const { input, warnings } = prepare(raw, DEFAULT_MEMORY_CONFIG, 'dsh-memory')
  return {
    warnings,
    config: Object.freeze({
      dataDir: typeof input.dataDir === 'string' ? input.dataDir.trim() : DEFAULT_MEMORY_CONFIG.dataDir,
      dbFile: typeof input.dbFile === 'string' ? input.dbFile.trim() : DEFAULT_MEMORY_CONFIG.dbFile,
      enabled: booleanOr(input.enabled, DEFAULT_MEMORY_CONFIG.enabled),
      maxTurns: integerOr(input.maxTurns, DEFAULT_MEMORY_CONFIG.maxTurns, 2, 500),
      summaryThreshold: integerOr(input.summaryThreshold, DEFAULT_MEMORY_CONFIG.summaryThreshold, 2, 500),
      summaryEnabled: booleanOr(input.summaryEnabled, DEFAULT_MEMORY_CONFIG.summaryEnabled),
      factExtractInterval: integerOr(input.factExtractInterval, DEFAULT_MEMORY_CONFIG.factExtractInterval, 1, 100),
      factExtractMode: ['rule', 'llm', 'off'].includes(input.factExtractMode)
        ? input.factExtractMode
        : DEFAULT_MEMORY_CONFIG.factExtractMode,
      maxFactsPerSide: integerOr(input.maxFactsPerSide, DEFAULT_MEMORY_CONFIG.maxFactsPerSide, 5, 1000),
      maxFactChars: integerOr(input.maxFactChars, DEFAULT_MEMORY_CONFIG.maxFactChars, 20, 200),
      writeMarkdown: booleanOr(input.writeMarkdown, DEFAULT_MEMORY_CONFIG.writeMarkdown),
      recallLearningEnabled: booleanOr(input.recallLearningEnabled, DEFAULT_MEMORY_CONFIG.recallLearningEnabled),
      recallLearningMode: ['rule', 'llm'].includes(input.recallLearningMode)
        ? input.recallLearningMode
        : DEFAULT_MEMORY_CONFIG.recallLearningMode,
      recallLearningRate: clamp(
        numberOr(input.recallLearningRate, DEFAULT_MEMORY_CONFIG.recallLearningRate),
        0.01,
        0.5,
      ),
      recallUsefulnessAlpha: clamp(
        numberOr(input.recallUsefulnessAlpha, DEFAULT_MEMORY_CONFIG.recallUsefulnessAlpha),
        0.05,
        0.9,
      ),
      recallFeatureRate: clamp(
        numberOr(input.recallFeatureRate, DEFAULT_MEMORY_CONFIG.recallFeatureRate),
        0.01,
        0.5,
      ),
      recallWeightDecayPerDay: clamp(
        numberOr(input.recallWeightDecayPerDay, DEFAULT_MEMORY_CONFIG.recallWeightDecayPerDay),
        0.5,
        1,
      ),
      recallMissBoost: clamp(numberOr(input.recallMissBoost, DEFAULT_MEMORY_CONFIG.recallMissBoost), 1, 3),
      ...collectConfig(input),
    }),
  }
}

/** 归一化情绪层配置。 */
export function normalizeMoodConfig(raw) {
  const { input, warnings } = prepare(raw, DEFAULT_MOOD_CONFIG, 'dsh-mood')
  return {
    warnings,
    config: Object.freeze({
      dataDir: typeof input.dataDir === 'string' ? input.dataDir.trim() : DEFAULT_MOOD_CONFIG.dataDir,
      dbFile: typeof input.dbFile === 'string' ? input.dbFile.trim() : DEFAULT_MOOD_CONFIG.dbFile,
      enabled: booleanOr(input.enabled, DEFAULT_MOOD_CONFIG.enabled),
      moodDecayMinutes: integerOr(input.moodDecayMinutes, DEFAULT_MOOD_CONFIG.moodDecayMinutes, 10, 10080),
      historyLimit: integerOr(input.historyLimit, DEFAULT_MOOD_CONFIG.historyLimit, 5, 500),
      deepNightEnergyPenalty: clamp(
        numberOr(input.deepNightEnergyPenalty, DEFAULT_MOOD_CONFIG.deepNightEnergyPenalty),
        0,
        0.5,
      ),
      deepNightValencePenalty: clamp(
        numberOr(input.deepNightValencePenalty, DEFAULT_MOOD_CONFIG.deepNightValencePenalty),
        0,
        0.5,
      ),
      ...collectConfig(input),
    }),
  }
}

/** 归一化人格层配置。 */
export function normalizePersonaConfig(raw) {
  const { input, warnings } = prepare(raw, DEFAULT_PERSONA_CONFIG, 'dsh-persona')
  const userInput = input.baselineUser !== null && typeof input.baselineUser === 'object' ? input.baselineUser : {}
  const selfInput = input.baselineSelf !== null && typeof input.baselineSelf === 'object' ? input.baselineSelf : {}
  const userBase = DEFAULT_PERSONA_CONFIG.baselineUser
  const selfBase = DEFAULT_PERSONA_CONFIG.baselineSelf
  return {
    warnings,
    config: Object.freeze({
      dataDir: typeof input.dataDir === 'string' ? input.dataDir.trim() : DEFAULT_PERSONA_CONFIG.dataDir,
      dbFile: typeof input.dbFile === 'string' ? input.dbFile.trim() : DEFAULT_PERSONA_CONFIG.dbFile,
      enabled: booleanOr(input.enabled, DEFAULT_PERSONA_CONFIG.enabled),
      dynamicsEnabled: booleanOr(input.dynamicsEnabled, DEFAULT_PERSONA_CONFIG.dynamicsEnabled),
      baselineUser: Object.freeze({
        directness: clamp(numberOr(userInput.directness, userBase.directness), 0, 1),
        pace: clamp(numberOr(userInput.pace, userBase.pace), 0, 1),
        humor: clamp(numberOr(userInput.humor, userBase.humor), 0, 1),
        detail: clamp(numberOr(userInput.detail, userBase.detail), 0, 1),
      }),
      baselineSelf: Object.freeze({
        warmth: clamp(numberOr(selfInput.warmth, selfBase.warmth), 0, 1),
        directness: clamp(numberOr(selfInput.directness, selfBase.directness), 0, 1),
        playfulness: clamp(numberOr(selfInput.playfulness, selfBase.playfulness), 0, 1),
        proactivity: clamp(numberOr(selfInput.proactivity, selfBase.proactivity), 0, 1),
      }),
      regressionPerDaySelf: clamp(
        numberOr(input.regressionPerDaySelf, DEFAULT_PERSONA_CONFIG.regressionPerDaySelf),
        0,
        1,
      ),
      regressionPerDayUser: clamp(
        numberOr(input.regressionPerDayUser, DEFAULT_PERSONA_CONFIG.regressionPerDayUser),
        0,
        1,
      ),
      ...collectConfig(input),
    }),
  }
}

/** 归一化上下文整理层配置。 */
export function normalizeContextConfig(raw) {
  const { input, warnings } = prepare(raw, DEFAULT_CONTEXT_CONFIG, 'dsh-context')
  return {
    warnings,
    config: Object.freeze({
      dataDir: typeof input.dataDir === 'string' ? input.dataDir.trim() : DEFAULT_CONTEXT_CONFIG.dataDir,
      enabled: booleanOr(input.enabled, DEFAULT_CONTEXT_CONFIG.enabled),
      userName: stringOr(input.userName, DEFAULT_CONTEXT_CONFIG.userName),
      agentName: stringOr(input.agentName, DEFAULT_CONTEXT_CONFIG.agentName),
      maxChars: integerOr(input.maxChars, DEFAULT_CONTEXT_CONFIG.maxChars, 200, 20000),
      factLimit: integerOr(input.factLimit, DEFAULT_CONTEXT_CONFIG.factLimit, 0, 50),
      workingMemoryMaxChars: integerOr(
        input.workingMemoryMaxChars,
        DEFAULT_CONTEXT_CONFIG.workingMemoryMaxChars,
        200,
        8000,
      ),
      recallMaxChars: integerOr(input.recallMaxChars, DEFAULT_CONTEXT_CONFIG.recallMaxChars, 200, 8000),
      recallLimit: integerOr(input.recallLimit, DEFAULT_CONTEXT_CONFIG.recallLimit, 0, 10),
      turnRecallLimit: integerOr(input.turnRecallLimit, DEFAULT_CONTEXT_CONFIG.turnRecallLimit, 0, 10),
      recallCooldownTurns: integerOr(input.recallCooldownTurns, DEFAULT_CONTEXT_CONFIG.recallCooldownTurns, 0, 20),
      topicShiftEnabled: booleanOr(input.topicShiftEnabled, DEFAULT_CONTEXT_CONFIG.topicShiftEnabled),
      recallTopicTurns: integerOr(input.recallTopicTurns, DEFAULT_CONTEXT_CONFIG.recallTopicTurns, 0, 5),
      archiveEnabled: booleanOr(input.archiveEnabled, DEFAULT_CONTEXT_CONFIG.archiveEnabled),
      archiveAtPercent: clamp(numberOr(input.archiveAtPercent, DEFAULT_CONTEXT_CONFIG.archiveAtPercent), 0.1, 0.95),
      keepRecentTurns: integerOr(input.keepRecentTurns, DEFAULT_CONTEXT_CONFIG.keepRecentTurns, 1, 50),
      archiveMaxTurnsPerBatch: integerOr(
        input.archiveMaxTurnsPerBatch,
        DEFAULT_CONTEXT_CONFIG.archiveMaxTurnsPerBatch,
        1,
        100,
      ),
      archiveMarker: ['oneline', 'compact'].includes(input.archiveMarker)
        ? input.archiveMarker
        : DEFAULT_CONTEXT_CONFIG.archiveMarker,
      archiveSessionIds: Object.freeze(
        Array.isArray(input.archiveSessionIds)
          ? input.archiveSessionIds.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
          : [...DEFAULT_CONTEXT_CONFIG.archiveSessionIds],
      ),
      archiveDryRun: booleanOr(input.archiveDryRun, DEFAULT_CONTEXT_CONFIG.archiveDryRun),
      includeUser: booleanOr(input.includeUser, DEFAULT_CONTEXT_CONFIG.includeUser),
      includeSelf: booleanOr(input.includeSelf, DEFAULT_CONTEXT_CONFIG.includeSelf),
      sectionOrder: numberOr(input.sectionOrder, DEFAULT_CONTEXT_CONFIG.sectionOrder),
      commandEnabled: booleanOr(input.commandEnabled, DEFAULT_CONTEXT_CONFIG.commandEnabled),
      debugSection: booleanOr(input.debugSection, DEFAULT_CONTEXT_CONFIG.debugSection),
      consolidateEnabled: booleanOr(input.consolidateEnabled, DEFAULT_CONTEXT_CONFIG.consolidateEnabled),
      consolidateEveryTurns: integerOr(
        input.consolidateEveryTurns,
        DEFAULT_CONTEXT_CONFIG.consolidateEveryTurns,
        1,
        100,
      ),
      idleConsolidateMs: integerOr(input.idleConsolidateMs, DEFAULT_CONTEXT_CONFIG.idleConsolidateMs, 0, 3600000),
      consolidateMode: ['rule', 'llm', 'off'].includes(input.consolidateMode)
        ? input.consolidateMode
        : DEFAULT_CONTEXT_CONFIG.consolidateMode,
      consolidateMaxTurns: integerOr(input.consolidateMaxTurns, DEFAULT_CONTEXT_CONFIG.consolidateMaxTurns, 1, 100),
      consolidateMinTurns: integerOr(input.consolidateMinTurns, DEFAULT_CONTEXT_CONFIG.consolidateMinTurns, 1, 100),
      consolidateEpisodeMaxChars: integerOr(
        input.consolidateEpisodeMaxChars,
        DEFAULT_CONTEXT_CONFIG.consolidateEpisodeMaxChars,
        40,
        400,
      ),
      summaryAppendMaxChars: integerOr(
        input.summaryAppendMaxChars,
        DEFAULT_CONTEXT_CONFIG.summaryAppendMaxChars,
        120,
        4000,
      ),
      debugConsolidate: booleanOr(input.debugConsolidate, DEFAULT_CONTEXT_CONFIG.debugConsolidate),
    }),
  }
}



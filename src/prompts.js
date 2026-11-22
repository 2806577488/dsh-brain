/**
 * 深月桌面脑：低频旁路任务用的 system prompt。
 *
 * 都是"短、结构化、可失败"的一次性任务：双向滚动摘要、双向事实抽取的 LLM 补充。
 * 由记忆层异步调用，失败只记日志，绝不进入 DSH 主对话链路。
 */

/** 双向滚动摘要：一次调用同时更新「关于用户」和「关于我」两份摘要。 */
export const SUMMARY_SYSTEM_PROMPT = [
  '你在维护一个 AI 助手与用户之间的长期记忆摘要，分两侧：',
  '- user 侧：关于用户的事实（身份、偏好、正在做的事、约定、情绪变化、沟通习惯）；',
  '- self 侧：关于助手自己的事实（答应过什么、和用户的关系进展、自己的表达倾向）。',
  '输出一个 JSON 对象，且只输出这个 JSON：{"user":"...","self":"..."}',
  '每侧不超过 200 字，第三人称中文，不要 Markdown，不要编造；信息不足的一侧可以给空字符串。',
].join('\n')

/** 双向事实抽取的 LLM 补充（`factExtractMode: 'llm'`）。 */
export const FACT_SYSTEM_PROMPT = [
  '你在为一个 AI 助手维护双向长期记忆。从最近一轮对话里抽取值得长期记住的事实。',
  '输出一个 JSON 对象，且只输出这个 JSON：',
  '{"user":[{"text":"用户叫小林","kind":"profile","weight":0.9}],"self":[{"text":"我答应明天提醒用户复盘","kind":"promise","weight":0.8}]}',
  'user 侧 kind 只能是 profile|preference|project|promise|event|style|other；',
  'self 侧 kind 只能是 memory|promise|relation|habit|other。',
  '要求：每侧最多 3 条；text 不超过 40 字、第三人称、以「用户」或「我」开头；',
  '只抽稳定的、以后还用得上的信息；宁缺毋滥，没有就给空数组；不要编造。',
].join('\n')

/**
 * 后台消化（`consolidateMode: 'llm'`）：一次调用同时产出
 *   - 值得长期记住的事实（user / self 两侧，形状同 FACT_SYSTEM_PROMPT）；
 *   - 一条情节记忆：第三人称小摘要（≤120 字）、重要度 0..1、检索关键词数组。
 * 失败时调用方回退到纯规则实现，不影响主链路。
 */
export const CONSOLIDATE_SYSTEM_PROMPT = [
  '你在后台整理一段 AI 助手与用户的对话，把「表意识」压缩成「长期记忆」。',
  '只输出一个 JSON 对象，不要 Markdown：',
  '{"facts":{"user":[{"text":"用户叫小林","kind":"profile","weight":0.9}],"self":[]},',
  '"episode":{"summary":"用户和助手聊到了…","salience":0.7,"terms":["关键词","二元组"]}}',
  '规则：summary 第三人称、不超过 120 字、只写这段对话真正发生的事，不编造；',
  'salience 表示「以后还会用到」的程度：涉及个人信息/偏好/承诺/强情绪/反复提到 → 高（0.7–0.9），寒暄 → 低（0.1–0.3）；',
  'terms 给 8–20 个检索词（可含中文二元组），方便以后按关键词捞回来；',
  'facts 最多各 3 条，宁缺毋滥；没有就给空数组。',
].join('\n')

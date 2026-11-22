/**
 * 深月桌面脑：消息角色判定（采集 / 历史清洗 / 召回共用）。
 *
 * DSH 的 `session/event` 里一条 message 同时带 `role`（user / assistant / system /
 * developer）与 `source.kind`（user / model / runtime-context / agent-message …）。
 * v2.1.0 起记忆层只把「真人说的」当 user 侧，其余（系统注入、runtime context、
 * 工具/代理消息、归档标记注入）一律视为 system：
 *   - 采集时：system 不配成 turn，永不进 user 侧；
 *   - 历史清洗：旧库里被误配成 turn 的 system 文本迁到 `memory_events` 并标 origin；
 *   - 召回时：`origin = 'system'` 的轮次不参与「你以前说过」。
 *
 * 这里只做纯函数判断，不依赖 DB / DSH，方便单测与迁移复用。
 */

/** 系统/工具文本特征（不是用户本人说的话）。 */
export const SYSTEM_TEXT_PATTERNS = Object.freeze([
  // v2.1.0 用户点名的运行时噪声
  /^Time sampled while/u,
  /^Browser time zone/u,
  /^Elapsed since/u,
  /^Agent [^\n]* sent a message/u,
  /^Background subagent [^\n]* finished/u,
  /^\[已归档到记忆库/u,
  // system prompt / 运行时上下文注入块
  /^<system-reminder>/u,
  /^<[a-z-]+>/u,
  /^You are an AI agent/u,
  /^You are a coding agent/u,
  /^Current runtime context/u,
  /^The following (?:content|files)/u,
  /^AGENTS\.md\b/u,
  /^Skill[:：]/u,
  /^Context[:：]\s/u,
  /^File changes?:/u,
])

/** 从 DSH `MessageSourceMap` 里整理出的「非真人」来源。 */
export const SYSTEM_SOURCE_KINDS = Object.freeze([
  'system',
  'developer',
  'system-prompt',
  'runtime-context',
  'model-selection',
  'tool-registry',
  'action-cards',
  'working-directory',
  'user-approval',
  'skill-invocation',
  'skill-catalog',
  'compact-checkpoint',
  'cordis-host-runner',
  'goal',
  'plan-mode',
  'schedule',
  'session-reference',
  'webhook',
  'ptc-mode',
])

const SYSTEM_SOURCE_SET = new Set(SYSTEM_SOURCE_KINDS)

/** 一段文本是否像系统/插件合成的上下文注入。 */
export function looksSystemText(text) {
  const value = String(text ?? '').trim()
  if (value.length === 0) return true
  return SYSTEM_TEXT_PATTERNS.some((pattern) => pattern.test(value))
}

/**
 * 只按文本判定一轮的 user 侧来源（历史清洗用）。
 * @param {string} text `memory_turns.user_text`
 * @returns {'user'|'system'}
 */
export function classifyTextOrigin(text) {
  return looksSystemText(text) ? 'system' : 'user'
}

/**
 * 按 message 的 role / source.kind 判定来源。
 *
 * 说明：`agent-message` / `subagent-settled` / `team-message` 只有在显式
 * `collectSubagents: true` 时才当 user 侧（那是用户有意让子代理进记忆），否则是 system。
 *
 * @param {object} message DSH message。
 * @param {{collectSubagents?: boolean}} [config] 采集配置。
 * @returns {'user'|'assistant'|'system'}
 */
export function classifyMessage(message, config = {}) {
  const role = message?.role
  const kind = message?.source?.kind
  if (role === 'system' || role === 'developer' || kind === 'system' || kind === 'developer') return 'system'
  if (kind === 'agent-message' || kind === 'subagent-settled' || kind === 'team-message' || kind === 'subagent-report' || kind === 'coordinator') {
    return config.collectSubagents === true ? 'user' : 'system'
  }
  if (SYSTEM_SOURCE_SET.has(kind)) return 'system'
  if (kind === 'user' || kind === 'user-rpc' || kind === 'retry-rpc' || kind === 'user-question-reply') return 'user'
  if (kind === 'model' || role === 'assistant') return 'assistant'
  if (role === 'user') return 'user'
  // 老事件/极简测试事件没有 role 与 source：`user/message` 默认按用户处理。
  if (kind === undefined) return 'user'
  return 'system'
}

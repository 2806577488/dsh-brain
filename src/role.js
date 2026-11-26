/**
 * 深月桌面脑：**域角色层**（v2.2.0，`dsh-context` 的一部分，不新增表、不改 schema）。
 *
 * ## 为什么要有这一层
 *
 * v2.1.0 之前，这个"大脑"只有双向记忆（user/self）+ 情绪 + 人格数值。它能记住
 * 「用户喜欢直接一点」，但**没有任何地方可以写**「你是一位临床协作助手，必须守
 * 剂量与配伍规矩」——换成法务、代码评审、教育，同样是这个缺口。
 *
 * **这一层是通用的**：它只认 domain / title / identity / 画像 / rules / redlines /
 * referrals / uncertainty 这些字段，不认识任何具体行业；填什么就是什么。
 * 现成配方见 `examples/profiles/`（中医临床、代码评审）。
 *
 * 这一层把「角色」变成**可配置、可检查、稳定不变**的一段注入文本：
 *
 *   【角色 · 中医临床助手】      你是谁 + 这个域里"一个角色一份记忆"
 *   【用户画像】                 擅长 / 习惯 / 偏好（给"按我的习惯回复"用）
 *   【专业规范 · 必须遵守】       该域的操作规范
 *   【红线 · 违反就不要给答案】    硬约束（剂量上限、配伍禁忌、孕哺儿童…）
 *   【红转人工 / 线下确认】     风险出口（通用措辞，不写行业专用词）
 *   【不确定时】                 兜底策略（先问、给依据、不编造）
 *
 * ## 为什么单独成段，而不是塞进 context 段
 *
 * - **它是静态的**：角色/红线不会每轮变。DSH 的 system prompt 前缀越稳定，
 *   命中缓存的概率越高；把它放在动态的 `dsh-brain:context` **之前**（order 更小），
 *   动态部分变化时不会把静态前缀一起打掉。
 * - **它可以单独关**：`roleEnabled: false` 就不注册这一段，其它三层照旧。
 * - **它可被检查**：`/brain profile` 直接把注入原文打出来，不用猜模型看到了什么。
 *
 * 这一层和记忆层的分工：**角色说"该怎么答"，记忆说"关于谁、答什么"**。
 */

/** 域角色注入段的 name（`ctx.systemPrompt.section`）。 */
export const ROLE_SECTION_NAME = 'dsh-brain:role'

/** 注入段默认 order：比 `dsh-brain:context`（默认 100）更靠前。 */
export const DEFAULT_ROLE_SECTION_ORDER = 90

/** 单个条目最大字符数（防止把一整段 prompt 塞进一条）。 */
const MAX_ITEM_CHARS = 160

/** 每个列表最多取几条。 */
const MAX_ITEMS = Object.freeze({
  expertise: 6,
  habits: 6,
  preferences: 6,
  rules: 12,
  redlines: 12,
  referrals: 8,
  uncertainty: 4,
})

/** 空角色（全部为空时 `buildRoleText` 返回空串，调用方据此不注册注入段）。 */
export const EMPTY_ROLE = Object.freeze({
  domain: '',
  title: '',
  identity: '',
  /** 是否输出「所有会话共享同一份记忆」那句（多患者场景它很重要）。 */
  sharedMemoryNote: true,
  expertise: Object.freeze([]),
  habits: Object.freeze([]),
  preferences: Object.freeze([]),
  rules: Object.freeze([]),
  redlines: Object.freeze([]),
  referrals: Object.freeze([]),
  uncertainty: Object.freeze([]),
})

/** 默认兜底策略：不写死具体专业，只约束"怎么答"。 */
const DEFAULT_UNCERTAINTY = Object.freeze([
  '关键信息不足时先问，不要假设；宁可少答一条，不要编一条。',
  '给方案时说清依据与前提；剂量、配伍、疗程必须可核对。',
])

function cleanText(value, maxChars = MAX_ITEM_CHARS) {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim()
  if (flat.length === 0) return ''
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`
}

function cleanList(value, limit) {
  if (!Array.isArray(value)) return Object.freeze([])
  const out = []
  for (const item of value) {
    const text = cleanText(item)
    if (text.length === 0) continue
    if (out.includes(text)) continue
    out.push(text)
    if (out.length >= limit) break
  }
  return Object.freeze(out)
}

/**
 * 规范化 `role` 配置（幂等、永不抛）。
 *
 * @param {unknown} raw 原始配置（可能是 undefined / 字符串 / 数组）。
 * @param {object} [defaults] 兜底值（一般是 `DEFAULT_ROLE_CONFIG`）。
 * @returns {object} 规范化后的 role（全部字段都是安全类型）。
 */
export function normalizeRoleConfig(raw, defaults = EMPTY_ROLE) {
  const base = defaults && typeof defaults === 'object' ? defaults : EMPTY_ROLE
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const pick = (key) => (input[key] !== undefined ? input[key] : base[key])
  return {
    domain: cleanText(pick('domain'), 40),
    title: cleanText(pick('title'), 40),
    identity: cleanText(pick('identity'), 400),
    sharedMemoryNote: input.sharedMemoryNote === undefined
      ? Boolean(base.sharedMemoryNote)
      : input.sharedMemoryNote !== false,
    expertise: cleanList(pick('expertise'), MAX_ITEMS.expertise),
    habits: cleanList(pick('habits'), MAX_ITEMS.habits),
    preferences: cleanList(pick('preferences'), MAX_ITEMS.preferences),
    rules: cleanList(pick('rules'), MAX_ITEMS.rules),
    redlines: cleanList(pick('redlines'), MAX_ITEMS.redlines),
    referrals: cleanList(pick('referrals'), MAX_ITEMS.referrals),
    uncertainty: cleanList(pick('uncertainty'), MAX_ITEMS.uncertainty),
  }
}

/** 角色是否"有内容"（决定要不要注册注入段）。 */
export function roleHasContent(role) {
  if (!role || typeof role !== 'object') return false
  if (role.domain || role.title || role.identity) return true
  return ['expertise', 'habits', 'preferences', 'rules', 'redlines', 'referrals', 'uncertainty'].some(
    (key) => Array.isArray(role[key]) && role[key].length > 0,
  )
}

/** 身份说明里已经自己讲了「共享记忆」就不要再补一句（否则同义句重复，白占预算）。 */
function identityCoversSharedMemory(identity) {
  if (!identity) return false
  const mentionsShare = identity.includes('共享') || identity.includes('同一份') || identity.includes('同一套')
  const mentionsMemory = identity.includes('记忆') || identity.includes('档案')
  return mentionsShare && mentionsMemory
}

function headingOf(role) {
  const title = role.title || (role.domain ? `${role.domain}协作助手` : '')
  return title ? `【角色 · ${title}】` : '【角色】'
}

/**
 * 组装域角色注入文本（纯函数，便于单测）。
 *
 * 预算：`maxChars`（默认 900）。超长时按「不确定性 > 偏好 > 习惯 > 擅长」的顺序
 * 丢条目——**红线与专业规范永远不丢**。
 *
 * @param {object} role `normalizeRoleConfig` 的产物。
 * @param {{maxChars?: number}} [options] 选项。
 * @returns {string} 注入文本；角色为空时返回空串。
 */
export function buildRoleText(role, options = {}) {
  if (!roleHasContent(role)) return ''
  const maxChars = Math.max(200, Number(options.maxChars ?? 900))

  const uncertainty = role.uncertainty.length > 0 ? role.uncertainty : DEFAULT_UNCERTAINTY
  // 可丢的部分（优先级从低到高），红线 / 规范 / 身份不在此列。
  const droppable = ['preferences', 'habits', 'expertise']
  const dropped = new Set()

  const render = () => {
    const lines = [headingOf(role)]
    if (role.identity) lines.push(role.identity)
    if (role.sharedMemoryNote && !identityCoversSharedMemory(role.identity)) {
      lines.push(
        '所有会话共享同一份记忆与记录：不要按会话分身，也不要把不同对象的记录互相套用。',
      )
    }
    const block = (title, items) => {
      if (!items || items.length === 0) return
      lines.push('', title)
      for (const item of items) lines.push(`- ${item}`)
    }
    block('【用户画像 · 擅长】', dropped.has('expertise') ? [] : role.expertise)
    block('【用户画像 · 习惯】', dropped.has('habits') ? [] : role.habits)
    block('【用户画像 · 偏好】', dropped.has('preferences') ? [] : role.preferences)
    block('【专业规范 · 必须遵守】', role.rules)
    block('【红线 · 违反就不要给答案】', role.redlines)
    // 字段名是 referrals；标题必须通用（不能写成「红旗症状」那种医疗词）。
    block('【必须转人工 / 线下确认】', role.referrals)
    block('【不确定时】', uncertainty)
    return lines.join('\n')
  }

  let text = render()
  for (const key of droppable) {
    if (text.length <= maxChars) break
    dropped.add(key)
    text = render()
  }
  if (text.length > maxChars) {
    const cut = text.lastIndexOf('\n', maxChars)
    text = `${text.slice(0, cut > 0 ? cut : maxChars)}`
  }
  return text.trim()
}

/**
 * `/brain profile` 用的摘要（不含正文）。
 * @param {object} role
 * @param {{enabled?: boolean, order?: number}} [meta]
 * @returns {string}
 */
export function roleSummary(role, meta = {}) {
  if (!roleHasContent(role)) {
    return '域角色：未配置（`roleEnabled` 或 `role` 为空，这一层不注入）。'
  }
  const counts = [
    ['擅长', role.expertise.length],
    ['习惯', role.habits.length],
    ['偏好', role.preferences.length],
    ['规范', role.rules.length],
    ['红线', role.redlines.length],
    ['转人工', role.referrals.length],
  ]
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label} ${count}`)
  return [
    `域角色：${role.title || role.domain || '（未命名）'}（${meta.enabled === false ? '已停用' : `order ${meta.order ?? DEFAULT_ROLE_SECTION_ORDER}`}）`,
    `条目：${counts.length > 0 ? counts.join(' · ') : '只有身份说明'}`,
  ].join('\n')
}

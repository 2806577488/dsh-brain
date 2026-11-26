/**
 * 深月桌面脑：**实体层**（v2.3.0，schema 6）。
 *
 * ## 解决什么
 *
 * 记忆层是「关于用户」「关于我」两条平铺的线：张三的主诉、李四的处方、你妈的复诊
 * 全混在 `user` 侧的事实里，取回时只能靠字面相似度碰运气。真实工作里对象是**分开的**：
 * 一个患者一条时间线，换个会话照样能接着上次说。
 *
 * 这一层把「对象」抽出来：
 *   - `entities`：患者 / 客户 / 项目 / 宠物…（带别名）
 *   - `entity_turns`：这个对象在哪几轮里被聊过（原文溯源到 memory_turns）
 *   - `entity_facts`：挂在对象上的带时间要点（主诉 / 处方 / 复诊…；v2.3.0 先留接口，
 *     规则只写"轮次关联"，结构化要点留给低频 LLM 或手工补）
 *
 * ## 抽取策略：宁缺毋滥
 *
 * 中文人名没有分隔符，硬抽会把「今天」「这个」当成人名。所以规则只认**明确信号**：
 *   - 身份前缀：`患者张三` / `病人：李姐` / `客户王先生`;
 *   - 敬称后缀：`张三先生` / `李姐`（且整体不是常用词）；
 *   - 已有实体的名字或别名在本轮出现（用于"接着上次说"）。
 *
 * 抽不出来的，不会造假数据；宁可这个对象只被"说过一次"，也不建一张错档案。
 */

import { shortId } from './store.js'

/** 实体类型（按身份前缀推断）。 */
export const ENTITY_KINDS = Object.freeze({
  患者: 'patient',
  病人: 'patient',
  病号: 'patient',
  客户: 'client',
  来访者: 'client',
  案主: 'client',
  项目: 'project',
  宠物: 'pet',
})

/**
 * 结构化字段的白名单（v2.3.0「睡眠期巩固」用）。
 *
 * 规则抽取只能记住"原话片段"；真正有用的是字段化的东西：主诉、辨证、方药、复诊。
 * 这些由后台的低频 LLM 抽取，这里约束它只许写这几类，避免模型自由发挥出一堆没人看的键。
 */
export const ENTITY_FACT_KINDS = Object.freeze([
  '主诉',
  '症状',
  '辨证',
  '治法',
  '处方',
  '医嘱',
  '复诊',
  '检查',
  '过敏',
  '备注',
])

/** 结构化抽取的 system prompt。 */
export const ENTITY_EXTRACT_PROMPT = [
  '你在后台整理一段医患/客户对话里的对象要点。给你若干轮对话和一份已知对象名单。',
  '只输出一个 JSON 对象，不要 Markdown：',
  '{"entities":[{"name":"张三","facts":[{"kind":"主诉","text":"咳嗽三天，夜间加重"},{"kind":"处方","text":"止嗽散加减：紫菀10g、百部10g"}]}]}',
  `kind 只能取：${ENTITY_FACT_KINDS.join(' / ')}。`,
  '要求：只写对话里明确出现的信息；每条 ≤ 40 字；不确定就不写；',
  'name 必须来自给定名单；没有可整理的返回 {"entities":[]}。',
].join('\n')

/** 组装结构化抽取的 messages（纯函数）。 */
export function buildEntityExtractMessages({ turns = [], names = [] } = {}) {
  const body = [
    `已知对象：${names.join('、')}`,
    '',
    '对话：',
    ...turns.slice(0, 12).map((turn, index) => {
      const user = flatten(turn?.user ?? '', 300)
      const assistant = flatten(turn?.assistant ?? '', 300)
      return `${index + 1}. 用户：${user}\n   助手：${assistant}`
    }),
  ].join('\n')
  return { system: ENTITY_EXTRACT_PROMPT, messages: [{ role: 'user', content: body }] }
}

/** 解析模型返回的抽取 JSON（失败返回空数组，绝不抛）。 */
export function parseEntityExtraction(text) {
  const raw = String(text ?? '').replace(/```[a-zA-Z]*\n?/g, '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let decoded
  try {
    decoded = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  if (!decoded || typeof decoded !== 'object' || !Array.isArray(decoded.entities)) return []
  const out = []
  for (const item of decoded.entities) {
    if (!item || typeof item !== 'object') continue
    const name = String(item.name ?? '').trim()
    if (name.length === 0) continue
    const facts = []
    for (const fact of Array.isArray(item.facts) ? item.facts : []) {
      if (!fact || typeof fact !== 'object') continue
      const kindRaw = String(fact.kind ?? '').trim()
      const kind = ENTITY_FACT_KINDS.includes(kindRaw) ? kindRaw : '备注'
      const factText = flatten(fact.text ?? '', 120)
      if (factText.length === 0) continue
      facts.push({ kind, text: factText })
      if (facts.length >= 8) break
    }
    if (facts.length > 0) out.push({ name, facts })
  }
  return out
}

/** 敬称后缀 → 该后缀不算名字的一部分。 */
const HONORIFICS = ['先生', '女士', '老师', '阿姨', '叔叔', '伯伯', '婶婶', '大姐', '大哥', '哥', '姐']

/** 明显不是名字的词（防止「今天先生」这种误抽）。 */
const NOT_NAMES = new Set([
  '今天', '明天', '昨天', '上午', '下午', '晚上', '这个', '那个', '现在', '刚才',
  '情况', '问题', '时候', '样子', '地方', '东西', '病历', '处方', '复诊', '随访',
])

/**
 * 名字里不该出现的常用字（动词/代词/虚词）。
 *
 * 中文没有分隔符，`患者张三今天来复诊` 用正则会把整串都吃掉；于是先取 1–3 字候选，
 * 再按「首字是姓 + 不含这些常用字」筛一遍，宁可退回短名字也不建错档案。
 */
const STOP_NAME_CHARS = new Set(
  '的了在是我你他她它们这那今明昨上下上来去说问讲要会能想把被给和与就都也很还不没个之其所以因为但如果已经过着到从对为以时候情况问题复诊随访'.split(
    '',
  ),
)

/** 常见姓氏（只用于 2 字以上的名字做首字校验）。 */
const SURNAMES = new Set(
  '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤欧阳司马诸葛'.split(
    '',
  ),
)

/** 名字长度上限（汉字/字母都算一个字符）。 */
const MAX_NAME_CHARS = 12

/** 去掉名字末尾的敬称。 */
function stripHonorific(name) {
  let value = String(name ?? '').trim()
  // 只去**多字**敬称（先生/女士/老师…）；「李姐」「王哥」这种单字称呼本身就是代号，保留。
  for (const honorific of HONORIFICS) {
    if (honorific.length < 2) continue
    if (value.length > honorific.length && value.endsWith(honorific)) {
      value = value.slice(0, -honorific.length)
      break
    }
  }
  return value
}

/** 复姓（3 字名只在这些前缀下启用）。 */
const COMPOUND_SURNAMES = [
  '欧阳', '司马', '诸葛', '上官', '东方', '独孤', '南宫', '西门', '夏侯', '皇甫',
  '尉迟', '公孙', '长孙', '宇文', '司徒', '令狐', '慕容', '端木', '百里', '东郭',
]

/** 名字片段是否干净（不含常用字/停用词）。 */
function isCleanName(candidate) {
  if (candidate.length === 0) return false
  if ([...candidate].some((char) => STOP_NAME_CHARS.has(char))) return false
  return !NOT_NAMES.has(candidate)
}

/**
 * 从一段连续汉字里挑一个像名字的片段。
 *
 * 为什么**优先 2 字**：中文没分隔符，`患者张三主诉咳嗽` 取 3 字会变成「张三主」。
 * 2 字（姓 + 单名）是多数情况，且**同一个人每次都会被截成同样的名字**，档案不会裂。
 * 3 字只在复姓（欧阳/司马…）或「姓 + 多字敬称」（王先生）时启用。
 *
 * @param {string} raw 连续字符（已排除标点/空白）。
 * @param {{requireSurname?: boolean}} [options]
 */
function pickName(raw, { requireSurname = true } = {}) {
  const text = String(raw ?? '')
  if (text.length === 0) return ''

  if (requireSurname) {
    // 1) 姓 + 多字敬称：王先生 / 李女士（敬称是代号的一部分）
    for (const honorific of HONORIFICS) {
      if (honorific.length < 2) continue
      if (SURNAMES.has(text[0]) && text.startsWith(honorific, 1)) {
        return text.slice(0, 1 + honorific.length)
      }
    }
    // 2) 复姓 + 单名：欧阳明
    for (const compound of COMPOUND_SURNAMES) {
      if (!text.startsWith(compound)) continue
      const candidate = text.slice(0, compound.length + 1)
      if (candidate.length === compound.length + 1 && isCleanName(candidate)) return candidate
    }
    // 3) 姓 + 单名：张三
    if (text.length >= 2 && SURNAMES.has(text[0]) && isCleanName(text.slice(0, 2))) {
      return text.slice(0, 2)
    }
    // 4) 单字兜底（如「患者王…」）
    if (isCleanName(text[0])) return text[0]
    return ''
  }

  // 项目/宠物：2 字优先，其次 3 字，再退单字。
  for (const length of [2, 3]) {
    if (text.length >= length && isCleanName(text.slice(0, length))) return text.slice(0, length)
  }
  return isCleanName(text[0]) ? text[0] : ''
}

/** 把文本压成一行（用于事实/片段展示）。 */
export function flatten(text, maxChars = 120) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, maxChars - 1)}…`
}

/** 从一句话里抽「候选实体」（规则；只认明确信号）。 */
export function extractEntityCandidates(text) {
  const source = String(text ?? '')
  if (source.trim().length === 0) return []
  const found = new Map()

  const add = (kind, name) => {
    const clean = name.replace(/\s+/g, '').trim()
    if (clean.length < 1 || clean.length > MAX_NAME_CHARS) return
    if (NOT_NAMES.has(clean)) return
    if (/^[\d.]+$/.test(clean)) return
    const key = `${kind}:${clean}`
    if (found.has(key)) return
    found.set(key, { kind, name: clean })
  }

  // 1) 身份前缀：患者张三 / 病人：李姐 / 客户王先生
  const prefixPattern =
    /(患者|病人|病号|客户|来访者|案主|项目|宠物)\s*[:：]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9]{1,11})/gu
  for (const match of source.matchAll(prefixPattern)) {
    const kind = ENTITY_KINDS[match[1]] ?? 'person'
    // 只有「人」才要求首字是常见姓氏；项目/宠物名字随便叫。
    const requireSurname = kind === 'patient' || kind === 'client' || kind === 'person'
    const name = pickName(match[2], { requireSurname })
    if (name.length > 0) add(kind, name)
  }

  // 2) 敬称后缀：张三先生 / 李姐（前缀已经抓到的会去重）
  const prefixChars = '患者病人号客户来访案主项目宠物'
  const suffixPattern = /([\u4e00-\u9fa5]{2,3})(先生|女士|老师|阿姨|叔叔|伯伯|婶婶|大姐|大哥)/gu
  for (const match of source.matchAll(suffixPattern)) {
    const start = match.index ?? 0
    const candidate = match[1]
    // 紧跟在身份前缀后面、或本身以身份字开头（「客户王先生」）时交给规则 1 处理，
    // 否则会被抽成「户王」「客户王」这种假名字。
    if (candidate.length > 0 && prefixChars.includes(candidate[0])) continue
    if (start > 0 && prefixChars.includes(source[start - 1])) continue
    add('person', candidate)
  }

  return [...found.values()]
}

/** 实体名归一化（比较用）。 */
export function normalizeEntityName(name) {
  return String(name ?? '')
    .replace(/\s+/g, '')
    .replace(/[「」“”'"《》()（）]/g, '')
    .trim()
    .toLowerCase()
}

/** 行 → 对象。 */
export function rowToEntity(row) {
  if (!row) return null
  return {
    id: row.id,
    kind: row.kind ?? 'person',
    name: row.name ?? '',
    aliases: String(row.aliases ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
    attrs: row.attrs ?? '{}',
    source: row.source ?? 'rule',
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

/** 渲染「当前对象」注入段（纯函数）。 */
export function renderEntitySection(profiles, { maxChars = 400, turnLimit = 3, related = [] } = {}) {
  if (!Array.isArray(profiles) || profiles.length === 0) return ''
  const lines = []
  for (const profile of profiles.slice(0, 3)) {
    const header = `【当前对象 · ${profile.name}${profile.kindLabel ? `（${profile.kindLabel}）` : ''}】`
    lines.push(header)
    for (const fact of (profile.facts ?? []).slice(0, 6)) {
      const at = fact.at ? `${String(fact.at).slice(5, 10)} ` : ''
      lines.push(`- ${at}${flatten(fact.text, 80)}`)
    }
    for (const turn of (profile.turns ?? []).slice(0, turnLimit)) {
      const at = turn.at ? `${String(turn.at).slice(5, 10)} ` : ''
      lines.push(`- ${at}聊到：${flatten(turn.user, 70)}`)
    }
    lines.push('')
  }
  // v2.3.0 激活扩散：当前对象牵扯到的其他对象（同一段对话里一起出现过）。
  if (Array.isArray(related) && related.length > 0) {
    lines.push('【相关对象】')
    for (const item of related.slice(0, 3)) {
      const reason = item.reason ? `（${item.reason}）` : ''
      lines.push(`- ${item.name}${reason}`)
    }
  }
  const text = lines.join('\n').trim()
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

/** 类型的中文名（渲染用）。 */
export function kindLabelOf(kind) {
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
 * 实体存取（只碰数据库）。
 *
 * @param {{db: import('node:sqlite').DatabaseSync, log?: Function, now?: () => string}} input
 */
export function createEntityStore({ db, log, now = () => new Date().toISOString() }) {
  const selectAll = db.prepare('SELECT * FROM entities ORDER BY updated_at DESC LIMIT ?')
  const selectOne = db.prepare('SELECT * FROM entities WHERE id = ?')
  const selectByName = db.prepare('SELECT * FROM entities WHERE name = ?')
  const insert = db.prepare(
    'INSERT INTO entities(id, kind, name, aliases, attrs, source, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const touch = db.prepare('UPDATE entities SET updated_at = ? WHERE id = ?')
  const linkTurnStmt = db.prepare(
    'INSERT OR IGNORE INTO entity_turns(entity_id, turn_id, at, session_id) VALUES(?, ?, ?, ?)',
  )
  const insertFactStmt = db.prepare(
    'INSERT INTO entity_facts(id, entity_id, kind, text, at, turn_id, session_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const factsStmt = db.prepare(
    'SELECT * FROM entity_facts WHERE entity_id = ? ORDER BY COALESCE(at, created_at) DESC LIMIT ?',
  )
  const turnsStmt = db.prepare(
    `SELECT t.id AS turn_id, t.at AS at, t.user_text AS user_text, t.assistant_text AS assistant_text, et.session_id AS session_id
       FROM entity_turns et JOIN memory_turns t ON t.id = et.turn_id
      WHERE et.entity_id = ?
      ORDER BY COALESCE(et.at, t.at) DESC
      LIMIT ?`,
  )
  const countTurnsStmt = db.prepare('SELECT COUNT(*) AS count FROM entity_turns WHERE entity_id = ?')

  function list(limit = 50) {
    return selectAll.all(Math.max(1, Number(limit) || 50)).map(rowToEntity)
  }

  function get(id) {
    return rowToEntity(selectOne.get(String(id ?? '')))
  }

  /** 按名字（或别名）找；找不到返回 null。 */
  function findByName(name) {
    const target = normalizeEntityName(name)
    if (target.length === 0) return null
    const exact = rowToEntity(selectByName.get(String(name ?? '').trim()))
    if (exact) return exact
    for (const entity of list(200)) {
      if (normalizeEntityName(entity.name) === target) return entity
      if (entity.aliases.some((alias) => normalizeEntityName(alias) === target)) return entity
    }
    return null
  }

  /** 建或取一个实体（按归一化名字）。 */
  function upsert({ kind = 'person', name, aliases = [], source = 'rule' } = {}) {
    const cleanName = String(name ?? '').trim()
    if (cleanName.length === 0 || cleanName.length > MAX_NAME_CHARS) return null
    const existing = findByName(cleanName)
    if (existing) {
      if (existing.kind !== kind && kind !== 'person') {
        db.prepare('UPDATE entities SET kind = ? WHERE id = ?').run(kind, existing.id)
      }
      touch.run(now(), existing.id)
      return get(existing.id)
    }
    const id = `ent-${shortId()}`
    const at = now()
    insert.run(id, kind, cleanName, aliases.join(','), '{}', source, at, at)
    log?.('entity-created', { id, kind, name: cleanName })
    return get(id)
  }

  /** 把一轮挂到实体上（幂等）。 */
  function linkTurn(entityId, { turnId, at, sessionId } = {}) {
    if (!entityId || !turnId) return 0
    const result = linkTurnStmt.run(entityId, turnId, at ?? now(), sessionId ?? null)
    touch.run(now(), entityId)
    return Number(result.changes) || 0
  }

  /** 记一条实体事实（带时间；同一实体同一文本不重复）。 */
  function addFact(entityId, { kind = 'note', text, at, turnId, sessionId } = {}) {
    const clean = flatten(text, 200)
    if (!entityId || clean.length === 0) return null
    const existing = factsStmt.all(entityId, 200).find((row) => row.text === clean)
    if (existing) return existing.id
    const id = `efact-${shortId()}`
    const stamp = at ?? now()
    insertFactStmt.run(id, entityId, kind, clean, stamp, turnId ?? null, sessionId ?? null, now())
    touch.run(now(), entityId)
    return id
  }

  function facts(entityId, limit = 10) {
    return factsStmt.all(entityId, Math.max(1, Number(limit) || 10)).map((row) => ({
      id: row.id,
      kind: row.kind,
      text: row.text,
      at: row.at,
      turnId: row.turn_id,
      sessionId: row.session_id,
    }))
  }

  function recentTurns(entityId, limit = 3) {
    return turnsStmt.all(entityId, Math.max(1, Number(limit) || 3)).map((row) => ({
      turnId: row.turn_id,
      at: row.at,
      sessionId: row.session_id,
      user: row.user_text ?? '',
      assistant: row.assistant_text ?? '',
    }))
  }

  /** 档案（`/brain patient <名字>` 与注入段共用）。 */
  function profile(entityId, { factLimit = 6, turnLimit = 3 } = {}) {
    const entity = get(entityId)
    if (!entity) return null
    return {
      ...entity,
      kindLabel: kindLabelOf(entity.kind),
      turns: recentTurns(entityId, turnLimit),
      facts: facts(entityId, factLimit),
      turnCount: Number(countTurnsStmt.get(entityId)?.count) || 0,
    }
  }

  /**
   * 从一批轮次里抽取实体并建立关联（规则；幂等）。
   *
   * 两类都要挂：
   *   1. 本轮**新出现**的对象（「患者张三…」）；
   *   2. 本轮**只提到名字**的既有对象（「张三复诊…」）——这才是"接着上次说"。
   *
   * @param {Array<{id: string, at: string, user: string, assistant: string, sessionId?: string}>} turns
   * @returns {{entities: number, links: number}}
   */
  function ingestTurns(turns) {
    let created = 0
    let links = 0
    const seenByTurn = new Map()
    const handleOne = (entity, turn) => {
      const key = `${turn.id}:${entity.id}`
      if (seenByTurn.has(key)) return
      seenByTurn.set(key, true)
      try {
        links += linkTurn(entity.id, { turnId: turn.id, at: turn.at, sessionId: turn.sessionId })
        addFact(entity.id, {
          kind: 'mention',
          text: flatten(turn.user, 120),
          at: turn.at,
          turnId: turn.id,
          sessionId: turn.sessionId,
        })
      } catch (error) {
        log?.('entity-ingest-link-failed', { message: error?.message ?? String(error) })
      }
    }

    for (const turn of Array.isArray(turns) ? turns : []) {
      const text = `${turn.user ?? ''}\n${turn.assistant ?? ''}`
      if (text.trim().length === 0) continue
      for (const candidate of extractEntityCandidates(text)) {
        const before = findByName(candidate.name)
        const entity = upsert({ kind: candidate.kind, name: candidate.name })
        if (!entity) continue
        if (!before) created += 1
        handleOne(entity, turn)
      }
      for (const entity of resolveMentions(text, 5)) {
        handleOne(entity, turn)
      }
    }
    return { entities: created, links }
  }

  /** 本轮文本里出现的已知实体（按名字/别名；长名优先）。 */
  function resolveMentions(text, limit = 2) {
    const source = String(text ?? '')
    if (source.trim().length === 0) return []
    const hits = []
    for (const entity of list(500)) {
      const names = [entity.name, ...entity.aliases].filter((name) => name.length >= 2)
      for (const name of names) {
        if (source.includes(name)) {
          hits.push({ entity, hit: name.length })
          break
        }
      }
    }
    return hits
      .sort((left, right) => right.hit - left.hit)
      .slice(0, Math.max(1, limit))
      .map((item) => item.entity)
  }

  // ---------------------------------------------------------------------------
  // v2.3.0 激活扩散 + 表意识槽位
  // ---------------------------------------------------------------------------

  const relatedStmt = db.prepare(
    `SELECT e.*, COUNT(*) AS shared
       FROM entity_turns a
       JOIN entity_turns b ON b.turn_id = a.turn_id AND b.entity_id <> a.entity_id
       JOIN entities e ON e.id = b.entity_id
      WHERE a.entity_id = ?
      GROUP BY e.id
      ORDER BY shared DESC
      LIMIT ?`,
  )

  /** 跟某个对象一起出现过的其他对象（同一轮对话里共同出现 = 有牵连）。 */
  function related(entityId, limit = 3) {
    if (!entityId) return []
    return relatedStmt.all(entityId, Math.max(1, Number(limit) || 3)).map((row) => ({
      ...rowToEntity(row),
      sharedTurns: Number(row.shared) || 0,
    }))
  }

  const selectFocus = db.prepare("SELECT * FROM wm_state WHERE session_id = ? AND kind = 'entity'")
  const upsertFocus = db.prepare(
    `INSERT INTO wm_state(session_id, kind, data, updated_at) VALUES(?, 'entity', ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  )

  /** 记下"眼下在说谁"（最多 3 个，最近优先）。 */
  function rememberFocus(sessionId, ids) {
    const key = String(sessionId ?? '').trim()
    if (key.length === 0) return
    const clean = (Array.isArray(ids) ? ids : [])
      .filter((id) => typeof id === 'string' && id.length > 0)
      .slice(0, 3)
    upsertFocus.run(key, JSON.stringify({ ids: clean, at: now() }), now())
  }

  /** 取回焦点（有 TTL：隔太久再提「他」，不该还接回上一个患者）。 */
  function focusEntities(sessionId, { ttlMs = 30 * 60 * 1000 } = {}) {
    const key = String(sessionId ?? '').trim()
    if (key.length === 0) return []
    const row = selectFocus.get(key)
    if (!row) return []
    let data
    try {
      data = JSON.parse(row.data ?? '{}')
    } catch {
      return []
    }
    const ids = Array.isArray(data?.ids) ? data.ids : []
    const at = Date.parse(data?.at ?? row.updated_at ?? '')
    if (!Number.isFinite(at)) return []
    if (Date.now() - at > Math.max(1000, Number(ttlMs) || 0)) return []
    return ids.map((id) => get(id)).filter(Boolean)
  }

  /**
   * 本轮「在说谁」的完整解析（表意识）。
   *
   * 1. 用户这一句点了名 → 用它，并把焦点记下来；
   * 2. 没点名 → 用本会话最近的焦点（所以「他今天怎么样」能接上）；
   * 3. 顺带给出相关对象（激活扩散）。
   */
  function resolveForTurn({
    sessionId,
    text,
    limit = 2,
    factLimit = 6,
    turnLimit = 3,
    ttlMs,
    spread = true,
  } = {}) {
    const mentioned = resolveMentions(text, limit)
    let viaFocus = false
    let entities = mentioned
    if (entities.length > 0) {
      rememberFocus(sessionId, entities.map((entity) => entity.id))
    } else {
      entities = focusEntities(sessionId, ttlMs === undefined ? {} : { ttlMs })
      viaFocus = entities.length > 0
    }
    const profiles = entities.map((entity) => profile(entity.id, { factLimit, turnLimit })).filter(Boolean)
    let relatedList = []
    if (spread && entities.length > 0) {
      const activeIds = new Set(entities.map((entity) => entity.id))
      const seen = new Set()
      for (const entity of entities) {
        for (const item of related(entity.id, 3)) {
          if (activeIds.has(item.id) || seen.has(item.id)) continue
          seen.add(item.id)
          relatedList.push({ name: item.name, kind: item.kind, reason: `和${entity.name}在同一段对话里出现过` })
        }
      }
      relatedList = relatedList.slice(0, 3)
    }
    return { profiles, viaFocus, related: relatedList }
  }

  /**
   * 应用结构化抽取结果（v2.3.0 睡眠期巩固）。
   *
   * 只接受已知对象（名单由调用方给），同文本去重；`kind` 不在白名单里的一律落「备注」。
   * @returns {number} 新增字段条数
   */
  function applyExtraction(name, items) {
    const entity = findByName(name)
    if (!entity) return 0
    const existing = new Set(facts(entity.id, 500).map((row) => row.text))
    let created = 0
    for (const fact of Array.isArray(items) ? items : []) {
      if (!fact || typeof fact !== 'object') continue
      const factText = flatten(fact.text ?? '', 120)
      if (factText.length === 0 || existing.has(factText)) continue
      const kind = ENTITY_FACT_KINDS.includes(String(fact.kind ?? '').trim())
        ? String(fact.kind).trim()
        : '备注'
      const id = addFact(entity.id, { kind, text: factText })
      if (id) {
        created += 1
        existing.add(factText)
      }
    }
    if (created > 0) log?.('entity-facts-added', { name: entity.name, created })
    return created
  }

  return {
    list,
    get,
    findByName,
    upsert,
    linkTurn,
    addFact,
    facts,
    recentTurns,
    profile,
    ingestTurns,
    resolveMentions,
    related,
    rememberFocus,
    focusEntities,
    resolveForTurn,
    applyExtraction,
  }
}

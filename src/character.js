/**
 * 深月桌面脑：**角色层**（v2.2.0，"我是谁"）。
 *
 * ## 和「域规范」的区别（这是两件不同的事）
 *
 *   【规范】静态：这个领域专业上必须守什么（rules / redlines / 转人工）。
 *                 人工写、不随对话变 —— 安全底线不能靠模型自己发挥。
 *   【角色】动态：我是谁 —— 说话方式、和用户的关系、自己的边界与偏好。
 *                 **由对话塑造**：创建时模型根据初始对话写第一版，
 *                 之后在"睡眠期"（后台消化）按新证据修订，每一版都留历史。
 *
 * 所以这里没有"人设模板"可填：`definition` 只有模型（或用户手改）能写，
 * 我们没有权利替用户预先规定"这个人温柔还是直接"。
 *
 * ## 生命周期
 *
 *   1. **bootstrap**：角色还是 v0、且攒够第一批证据（几轮对话）→ 调模型写第一版；
 *   2. **revise**：之后每攒够 `characterReviseEveryTurns` 轮，带上"当前定义 + 新证据"
 *      让模型改写；沿用量少改的原则，避免每轮来回翻烧饼；
 *   3. **history**：`character_versions` 只增不改，`/brain who` 能看版本与原因；
 *   4. **降级**：模型不可用时不编造 —— 用规则兜底（只写"我们还不太熟"这种事实），
 *      标 `source: 'fallback'`，等下次修订覆盖。
 */

import { completeText, resolveRoute } from './llm.js'

/** 默认角色 id（DSH 一个 profile 只有一个"我"）。 */
export const DEFAULT_CHARACTER_ID = 'self'

/** 第一版定义的 system prompt：只写能站得住的东西，不编造。 */
export const CHARACTER_BOOTSTRAP_PROMPT = [
  '你在为用户维护一个 AI 助手角色的「自我定义」——它要回答"我是谁"，而不是"我该怎么答"。',
  '根据下面这批对话，写一版这个角色的自我定义。要求：',
  '- 第三人称不要用；用「我」的口吻写，像是在说"我是谁、我和你是什么关系"。',
  '- 只写从对话里能看出来的东西：和用户的相处方式、说话风格、我在意什么、我的边界。',
  '- 不要编造身份、专长、经历；看不出来就不写。',
  '- 不要写行业规范/合规要求（那是另一层的事）。',
  '- 120–260 字，纯文本，不要 Markdown，不要标题。',
].join('\n')

/** 修订用的 system prompt：带着旧版改，越改越准，不要翻烧饼。 */
export const CHARACTER_REVISE_PROMPT = [
  '你在更新一个 AI 助手角色的「自我定义」。给你「当前定义」和「新对话证据」。',
  '规则：',
  '- 沿用当前定义里仍然成立的部分，只改被新证据推翻或补充的地方；',
  '- 不要因为一次偶发的对话就改写性格；重复出现的模式才算证据；',
  '- 仍然是「我」的口吻，120–260 字，纯文本，不要 Markdown；',
  '- 不编造，不写行业规范/合规要求。',
].join('\n')

/** 去掉 Markdown 围栏、标题、多余空行，压到一行一段。 */
export function normalizeDefinition(text, maxChars = 900) {
  let value = String(text ?? '')
    .replace(/```[a-zA-Z]*\n?/g, '')
    // 整行标题直接丢掉：模型爱写「## 我是谁」，留着只会占预算。
    .replace(/^#{1,6}[^\n]*$/gm, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (value.length > maxChars) {
    const cut = value.lastIndexOf('\n', maxChars)
    value = value.slice(0, cut > maxChars * 0.6 ? cut : maxChars).trim()
  }
  return value
}

/** 无模型时的兜底定义：只说看得见的事实，不编性格。 */
export function fallbackDefinition({ name = '', evidenceTexts = [], turns = 0 } = {}) {
  const label = String(name ?? '').trim()
  const lines = []
  lines.push(`我是${label || '用户的长期助手'}，和用户长期合作。`)
  if (turns > 0) lines.push(`到目前为止我们一起聊过 ${turns} 轮。`)
  const topics = evidenceTexts
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (topics.length > 0) {
    lines.push('我记得我们聊过这些：')
    for (const text of evidenceTexts.slice(0, 3)) {
      const flat = text.replace(/\s+/g, ' ').trim()
      if (flat.length === 0) continue
      lines.push(`- ${flat.length > 60 ? `${flat.slice(0, 59)}…` : flat}`)
    }
  }
  lines.push('（这一段是规则兜底写的：当时模型不可用，下次整理时会用对话重写。）')
  return lines.join('\n')
}

/** 组装 bootstrap 的 messages（纯函数，便于单测）。 */
export function buildBootstrapMessages({ name = '', turns = 0, evidenceTexts = [] } = {}) {
  const body = [
    `角色名（可能只是个称呼）：${name || '（未命名）'}`,
    `已有的对话轮数：${turns}`,
    '',
    '对话证据（用户 / 助手）：',
    ...evidenceTexts.slice(0, 12).map((text, index) => `${index + 1}. ${text}`),
  ].join('\n')
  return {
    system: CHARACTER_BOOTSTRAP_PROMPT,
    messages: [{ role: 'user', content: body }],
  }
}

/** 组装修订的 messages（纯函数）。 */
export function buildReviseMessages({ name = '', current = '', turns = 0, newEvidence = [] } = {}) {
  const body = [
    `角色名：${name || '（未命名）'}`,
    `已经吸收的轮数：${turns}`,
    '',
    '当前定义：',
    current.trim().length > 0 ? current.trim() : '（还没有定义）',
    '',
    '新对话证据：',
    ...newEvidence.slice(0, 10).map((text, index) => `${index + 1}. ${text}`),
  ].join('\n')
  return {
    system: CHARACTER_REVISE_PROMPT,
    messages: [{ role: 'user', content: body }],
  }
}

/** 渲染注入段（纯函数）。 */
export function renderCharacterSection(character, { maxChars = 600 } = {}) {
  const definition = normalizeDefinition(character?.definition ?? '', maxChars)
  if (definition.length === 0) return ''
  const lines = ['【我是谁】', definition]
  return lines.join('\n').trim()
}

/** 行 → 对象。 */
export function rowToCharacter(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name ?? '',
    emoji: row.emoji ?? '',
    definition: row.definition ?? '',
    evidenceTurns: Number(row.evidence_turns) || 0,
    lastEvidenceSeq: Number(row.last_evidence_seq) || 0,
    version: Number(row.version) || 0,
    source: row.source ?? 'bootstrap',
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

/**
 * 角色存取（只碰数据库，不调模型）。
 *
 * @param {{db: import('node:sqlite').DatabaseSync, log?: Function, now?: () => string}} input
 */
export function createCharacterStore({ db, log, now = () => new Date().toISOString() }) {
  const selectOne = db.prepare('SELECT * FROM characters WHERE id = ?')
  const insert = db.prepare(
    `INSERT INTO characters(id, name, emoji, definition, evidence_turns, last_evidence_seq, version, source, updated_at, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const update = db.prepare(
    `UPDATE characters SET name = ?, emoji = ?, definition = ?, evidence_turns = ?, last_evidence_seq = ?,
       version = ?, source = ?, updated_at = ? WHERE id = ?`,
  )
  const insertVersion = db.prepare(
    `INSERT OR REPLACE INTO character_versions(character_id, version, definition, reason, evidence_turns, created_at)
     VALUES(?, ?, ?, ?, ?, ?)`,
  )
  const selectVersions = db.prepare(
    'SELECT * FROM character_versions WHERE character_id = ? ORDER BY version DESC LIMIT ?',
  )

  /** 确保默认角色存在（幂等；definition 为空表示还没 bootstrap）。 */
  function ensure({ name = '' } = {}) {
    const existing = rowToCharacter(selectOne.get(DEFAULT_CHARACTER_ID))
    if (existing) return existing
    const at = now()
    const cleanName = String(name ?? '').trim()
    insert.run(DEFAULT_CHARACTER_ID, cleanName, '', '', 0, 0, 0, 'pending', at, at)
    log?.('character-created', { id: DEFAULT_CHARACTER_ID, name: cleanName })
    return rowToCharacter(selectOne.get(DEFAULT_CHARACTER_ID))
  }

  function get() {
    return rowToCharacter(selectOne.get(DEFAULT_CHARACTER_ID))
  }

  /**
   * 保存一版定义（version+1 并写历史）。
   * @param {{definition: string, reason?: string, evidenceTurns?: number, lastEvidenceSeq?: number, name?: string, emoji?: string, source?: string}} input
   */
  function save(input = {}) {
    const current = get() ?? ensure()
    const definition = normalizeDefinition(input.definition ?? '')
    if (definition.length === 0) return { ok: false, reason: 'empty-definition', character: current }
    const version = current.version + 1
    const at = now()
    const name = typeof input.name === 'string' && input.name.trim().length > 0 ? input.name.trim() : current.name
    const emoji = typeof input.emoji === 'string' ? input.emoji : current.emoji
    const evidenceTurns = Number.isFinite(input.evidenceTurns) ? Number(input.evidenceTurns) : current.evidenceTurns
    const lastEvidenceSeq = Number.isFinite(input.lastEvidenceSeq) ? Number(input.lastEvidenceSeq) : current.lastEvidenceSeq
    db.exec('BEGIN IMMEDIATE')
    try {
      update.run(name, emoji, definition, evidenceTurns, lastEvidenceSeq, version, input.source ?? 'bootstrap', at, DEFAULT_CHARACTER_ID)
      insertVersion.run(DEFAULT_CHARACTER_ID, version, definition, input.reason ?? 'revise', evidenceTurns, at)
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* 回滚失败保留原错误 */
      }
      throw error
    }
    log?.('character-saved', { version, reason: input.reason ?? 'revise', chars: definition.length, evidenceTurns })
    return { ok: true, character: get(), version }
  }

  /** 改名字/头像（不产生新版本）。 */
  function setMeta({ name, emoji } = {}) {
    const current = get() ?? ensure()
    const at = now()
    update.run(
      typeof name === 'string' && name.trim().length > 0 ? name.trim() : current.name,
      typeof emoji === 'string' ? emoji : current.emoji,
      current.definition,
      current.evidenceTurns,
      current.lastEvidenceSeq,
      current.version,
      current.source,
      at,
      DEFAULT_CHARACTER_ID,
    )
    return get()
  }

  function versions(limit = 10) {
    return selectVersions.all(DEFAULT_CHARACTER_ID, Math.max(1, Number(limit) || 10)).map((row) => ({
      version: Number(row.version),
      definition: row.definition,
      reason: row.reason,
      evidenceTurns: Number(row.evidence_turns) || 0,
      createdAt: row.created_at,
    }))
  }

  /** 是否该修订：攒够新证据才动，避免每轮翻烧饼。 */
  function needsRevision({ evidenceTurns, everyTurns = 6 }) {
    const current = get()
    if (!current) return { needed: true, bootstrap: true }
    if (current.version === 0 || current.definition.trim().length === 0) {
      return { needed: true, bootstrap: true }
    }
    const fresh = Number(evidenceTurns) - current.evidenceTurns
    return { needed: fresh >= Math.max(1, everyTurns), bootstrap: false, fresh }
  }

  return { ensure, get, save, setMeta, versions, needsRevision }
}

/**
 * 用模型 bootstrap / 修订角色定义（失败静默降级）。
 *
 * @param {object} input
 * @param {import('@deepseek-ai/cordis').Context} input.ctx DSH 上下文（取 llm）。
 * @param {object} input.config dsh-memory 配置。
 * @param {object} input.memory `brainMemory` 服务。
 * @param {Function} [input.log]
 * @param {'bootstrap'|'revise'} input.mode
 * @param {{name?: string, evidenceTurns: number, evidenceTexts: string[]}} input.payload
 * @returns {Promise<{ok: boolean, reason?: string, character?: object}>}
 */
export async function runCharacterStep({ ctx, config = {}, memory, log, mode, payload, sessionId }) {
  const store = memory?.characters?.()
  if (!store) return { ok: false, reason: 'no-store' }
  const name = String(payload?.name ?? '').trim() || store.get()?.name || ''
  const turns = Number(payload?.evidenceTurns) || 0
  const evidenceTexts = Array.isArray(payload?.evidenceTexts) ? payload.evidenceTexts : []
  const character = store.ensure({ name })

  const request = mode === 'revise'
    ? buildReviseMessages({ name, current: character.definition, turns, newEvidence: evidenceTexts })
    : buildBootstrapMessages({ name, turns, evidenceTexts })

  let definition = ''
  let source = 'bootstrap'
  try {
    const route = resolveRoute(ctx, config)
    const text = await completeText(ctx, {
      route,
      system: request.system,
      messages: request.messages,
      temperature: 0.4,
      maxTokens: 600,
      ...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}),
    })
    definition = normalizeDefinition(text)
    if (definition.length === 0) throw new Error('模型返回空定义')
    source = 'llm'
  } catch (error) {
    log?.('character-llm-failed', {
      mode,
      message: error?.message ?? String(error),
      code: error?.code ?? '',
      status: error?.status ?? null,
      provider: error?.provider ?? '',
      model: error?.model ?? '',
    })
    definition = fallbackDefinition({ name, evidenceTexts, turns })
    source = 'fallback'
  }

  const saved = store.save({
    definition,
    reason: mode,
    evidenceTurns: turns,
    lastEvidenceSeq: Number(payload?.lastEvidenceSeq) || 0,
    source,
  })
  if (!saved.ok) return { ok: false, reason: saved.reason }
  log?.('character-step', { mode, source, version: saved.version })
  return { ok: true, character: saved.character, source }
}

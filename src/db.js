/**
 * 深月桌面脑：SQLite 持久化层（零依赖，使用 Node 内置 `node:sqlite`）。
 *
 * 四层（memory / mood / persona）共享同一个数据库文件，默认
 * `%USERPROFILE%\.dsh\dsh-brain\brain.db`（每层可用 `dbFile` 配置覆盖）：
 *   - 模块级单例：同一进程内按 `dbFile` 路径共享一个 `DatabaseSync` 连接（引用计数，
 *     最后一个使用者释放时才 close，避免四层各开一个连接互相抢锁）；
 *   - 打开时统一设置 WAL / synchronous=NORMAL / busy_timeout / foreign_keys；
 *   - `meta` 表记录 schema 版本，`CREATE TABLE IF NOT EXISTS` 幂等；
 *   - 预处理语句缓存 + 写操作事务包装（BEGIN IMMEDIATE / COMMIT / ROLLBACK）；
 *   - 首次打开时把同目录 v1.0.0 的 JSON 数据幂等导入（按唯一键去重），成功后把旧文件
 *     改名成 `*.imported-<ts>`，日志 `db-migrated`。
 *
 * 为什么不用 DSH 的 `storageDomain`：它要求 Zod/schemastery schema，而本包是零依赖的
 * link 安装，解析不到这两个包；`node:sqlite` 是 Node 内置模块，零依赖且 DSH 自己的
 * `dsh-session-query-sqlite` 也走这条路（见报告「选型说明」）。
 */

import fs from 'node:fs'
import path from 'node:path'

import { DatabaseSync } from 'node:sqlite'

import { classifyTextOrigin } from './roles.js'
import { readJsonFile, stampNow } from './store.js'

/** 当前 schema 版本（`meta.schema_version`，同时写 `PRAGMA user_version`）。 */
export const SCHEMA_VERSION = 6

/** 召回学习：全局特征权重的初始行（v2.1.0）。 */
export const RECALL_FEATURES = Object.freeze(['relevance', 'salience', 'recency', 'topic', 'affection'])

/** dbFile → 连接句柄（进程内单例）。 */
const handles = new Map()

/** 建表 DDL（幂等）。 */
const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS memory_turns (
     id TEXT PRIMARY KEY,
     session_id TEXT,
     seq INTEGER,
     at TEXT NOT NULL,
     user_text TEXT NOT NULL,
     assistant_text TEXT NOT NULL,
     mood TEXT,
     provider TEXT,
     model TEXT,
     origin TEXT,
     UNIQUE(session_id, seq)
   )`,
  // v2.1.0：系统/工具事件隔离（永不进 user 侧、不参与「你以前说过」召回）。
  `CREATE TABLE IF NOT EXISTS memory_events (
     id TEXT PRIMARY KEY,
     session_id TEXT,
     seq INTEGER,
     at TEXT NOT NULL,
     kind TEXT NOT NULL,
     text TEXT NOT NULL,
     meta TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS memory_facts (
     id TEXT PRIMARY KEY,
     side TEXT NOT NULL CHECK(side IN ('user','self')),
     text TEXT NOT NULL,
     norm TEXT NOT NULL,
     kind TEXT NOT NULL,
     weight REAL NOT NULL DEFAULT 0.5,
     hits INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL,
     UNIQUE(side, norm)
   )`,
  `CREATE TABLE IF NOT EXISTS memory_summaries (
     side TEXT PRIMARY KEY CHECK(side IN ('user','self')),
     summary TEXT NOT NULL DEFAULT '',
     chars INTEGER NOT NULL DEFAULT 0,
     updated_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS mood_state (
     side TEXT PRIMARY KEY CHECK(side IN ('user','self')),
     name TEXT,
     status TEXT,
     valence REAL NOT NULL,
     affection REAL,
     energy REAL NOT NULL,
     updated_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS mood_history (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     side TEXT NOT NULL CHECK(side IN ('user','self')),
     at TEXT NOT NULL,
     name TEXT,
     valence REAL NOT NULL,
     affection REAL,
     energy REAL NOT NULL,
     reason TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS persona_traits (
     side TEXT NOT NULL CHECK(side IN ('user','self')),
     trait TEXT NOT NULL,
     value REAL NOT NULL,
     updated_at TEXT,
     PRIMARY KEY(side, trait)
   )`,
  `CREATE TABLE IF NOT EXISTS persona_baseline (
     side TEXT NOT NULL CHECK(side IN ('user','self')),
     trait TEXT NOT NULL,
     value REAL NOT NULL,
     PRIMARY KEY(side, trait)
   )`,
  `CREATE TABLE IF NOT EXISTS collector_state (
     session_id TEXT NOT NULL,
     layer TEXT NOT NULL,
     last_seq INTEGER NOT NULL,
     updated_at TEXT,
     PRIMARY KEY(session_id, layer)
   )`,
  `CREATE TABLE IF NOT EXISTS collector_pending (
     session_id TEXT NOT NULL,
     layer TEXT NOT NULL,
     user_text TEXT NOT NULL,
     seq INTEGER NOT NULL,
     at TEXT,
     PRIMARY KEY(session_id, layer)
   )`,
  // 情节记忆：后台消化把一段对话压成「第三人称小摘要 + 原文指针 + 当时情绪 + 重要度」，
  // 用于工作记忆检索。原文仍完整保留在 memory_turns（本表只存指针，不删任何原文）。
  `CREATE TABLE IF NOT EXISTS memory_episodes (
     id TEXT PRIMARY KEY,
     session_id TEXT,
     at TEXT NOT NULL,
     summary TEXT NOT NULL,
     turn_ids TEXT NOT NULL DEFAULT '[]',
     mood TEXT,
     salience REAL NOT NULL DEFAULT 0.5,
     terms TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL
   )`,
  // 归档记录：把哪些轮次从当前会话 surface 换成了标记（原文仍在 memory_turns）。
  `CREATE TABLE IF NOT EXISTS memory_archives (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     at TEXT NOT NULL,
     start_seq INTEGER NOT NULL,
     end_seq INTEGER NOT NULL,
     turn_count INTEGER NOT NULL DEFAULT 0,
     tokens_before INTEGER,
     tokens_after INTEGER,
     marker_seq INTEGER,
     marker_message_id TEXT,
     turn_ids TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL DEFAULT 'done',
     created_at TEXT NOT NULL
   )`,
  // v2.1.0：召回自学习。
  // 每条被注入过的记忆的注入/命中/忽略计数与 usefulness（EMA）。
  `CREATE TABLE IF NOT EXISTS recall_item_stats (
     memory_id TEXT PRIMARY KEY,
     injected INTEGER NOT NULL DEFAULT 0,
     used INTEGER NOT NULL DEFAULT 0,
     ignored INTEGER NOT NULL DEFAULT 0,
     usefulness REAL NOT NULL DEFAULT 0.5,
     updated_at TEXT
   )`,
  // 检索词权重：used 的词慢慢变强，ignored 的词慢慢变弱，按天向 1 回落。
  `CREATE TABLE IF NOT EXISTS recall_term_weights (
     term TEXT PRIMARY KEY,
     weight REAL NOT NULL DEFAULT 1,
     hits INTEGER NOT NULL DEFAULT 0,
     misses INTEGER NOT NULL DEFAULT 0,
     updated_at TEXT
   )`,
  // 遗忘信号（用户说「你忘了 / 不记得 / 上次…」）：记录缺失主题，下一轮优先召回。
  `CREATE TABLE IF NOT EXISTS recall_misses (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT,
     turn INTEGER,
     at TEXT NOT NULL,
     terms TEXT NOT NULL DEFAULT '',
     source_text TEXT
   )`,
  // 全局特征权重（relevance / salience / recency / topic / affection）。
  `CREATE TABLE IF NOT EXISTS recall_feature_weights (
     feature TEXT PRIMARY KEY,
     weight REAL NOT NULL DEFAULT 1,
     updated_at TEXT
   )`,
  // v2.2.0：角色（"我是谁"）。
  //
  // 这是**模型从对话里长出来的自我定义**，不是配置里写死的人设：
  // 创建时由模型根据初始对话写第一版（bootstrap），之后在"睡眠期"（后台消化）按新证据
  // 修订，每次修订都留一版历史，可回看"这个角色是怎么变成现在这样的"。
  // 静态的只有领域规范（rules/redlines），那是"这个职业要守什么"，不是"这个人是谁"。
  `CREATE TABLE IF NOT EXISTS characters (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     emoji TEXT,
     definition TEXT NOT NULL DEFAULT '',
     evidence_turns INTEGER NOT NULL DEFAULT 0,
     last_evidence_seq INTEGER NOT NULL DEFAULT 0,
     version INTEGER NOT NULL DEFAULT 0,
     source TEXT NOT NULL DEFAULT 'bootstrap',
     updated_at TEXT,
     created_at TEXT NOT NULL
   )`,
  // 角色定义的版本历史（只增不改）。
  `CREATE TABLE IF NOT EXISTS character_versions (
     character_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     definition TEXT NOT NULL,
     reason TEXT NOT NULL DEFAULT 'revise',
     evidence_turns INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     PRIMARY KEY(character_id, version)
   )`,
  // 实体（患者 / 客户 / 项目 / 宠物…）：跨会话的对象档案。
  `CREATE TABLE IF NOT EXISTS entities (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL DEFAULT 'person',
     name TEXT NOT NULL,
     aliases TEXT NOT NULL DEFAULT '',
     attrs TEXT NOT NULL DEFAULT '{}',
     source TEXT NOT NULL DEFAULT 'rule',
     created_at TEXT NOT NULL,
     updated_at TEXT
   )`,
  // 实体事实：挂到具体对象上的、带时间的要点（主诉 / 处方 / 约定…）。
  `CREATE TABLE IF NOT EXISTS entity_facts (
     id TEXT PRIMARY KEY,
     entity_id TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'note',
     text TEXT NOT NULL,
     at TEXT,
     turn_id TEXT,
     session_id TEXT,
     created_at TEXT NOT NULL
   )`,
  // 实体 ↔ 轮次：用于"这个对象最近聊过什么"和原文溯源。
  `CREATE TABLE IF NOT EXISTS entity_turns (
     entity_id TEXT NOT NULL,
     turn_id TEXT NOT NULL,
     at TEXT,
     session_id TEXT,
     PRIMARY KEY(entity_id, turn_id)
   )`,
  // v2.3.0：表意识槽位（"眼下在说谁"）。
  //
  // 会话是线性的，用户下一句常说「他今天怎么样」「那个患者呢」——没有名字。
  // 这里给每个会话存一小份"当前焦点"（实体 id + 时间），下一轮解析不到名字时用它兜底。
  // 有 TTL：隔太久再提"他"，不该还接回上一个患者。
  `CREATE TABLE IF NOT EXISTS wm_state (
     session_id TEXT PRIMARY KEY,
     kind TEXT NOT NULL DEFAULT 'entity',
     data TEXT NOT NULL DEFAULT '{}',
     updated_at TEXT NOT NULL
   )`,
]

/** 索引 DDL（幂等）。 */
const INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_memory_turns_at ON memory_turns(at)',
  'CREATE INDEX IF NOT EXISTS idx_memory_turns_session ON memory_turns(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_memory_facts_side_kind_weight ON memory_facts(side, kind, weight)',
  'CREATE INDEX IF NOT EXISTS idx_mood_history_side_at ON mood_history(side, at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_collector_state_updated ON collector_state(updated_at)',
  'CREATE INDEX IF NOT EXISTS idx_collector_pending_layer ON collector_pending(layer)',
  'CREATE INDEX IF NOT EXISTS idx_memory_episodes_at ON memory_episodes(at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_memory_episodes_session ON memory_episodes(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_memory_episodes_salience ON memory_episodes(salience DESC)',
  'CREATE INDEX IF NOT EXISTS idx_memory_archives_session ON memory_archives(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_memory_archives_at ON memory_archives(at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_memory_events_session ON memory_events(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_memory_events_at ON memory_events(at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_memory_events_kind ON memory_events(kind)',
  'CREATE INDEX IF NOT EXISTS idx_recall_misses_at ON recall_misses(at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_recall_misses_session ON recall_misses(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_recall_term_weights_weight ON recall_term_weights(weight DESC)',
  // v2.2.0：角色 / 实体
  'CREATE INDEX IF NOT EXISTS idx_character_versions_created ON character_versions(created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_entities_kind_name ON entities(kind, name)',
  'CREATE INDEX IF NOT EXISTS idx_entity_facts_entity ON entity_facts(entity_id, at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_entity_turns_entity ON entity_turns(entity_id, at DESC)',
]

/** 旧版本（v1.0.0）在同一目录写的 JSON 文件。 */
const LEGACY_FILES = ['memory.json', 'mood.json', 'persona.json', 'state.json']

/** 执行一组 DDL。 */
function applySql(db, statements) {
  for (const sql of statements) db.exec(sql)
}

/** 读 meta 值。 */
function getMeta(db, key) {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
    return row?.value
  } catch {
    return undefined
  }
}

/** 写 meta 值（UPSERT，直接对 db）。 */
function writeMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value),
  )
}

/** 写 meta 值（对外，用连接缓存）。 */
export function setMeta(handle, key, value) {
  handle.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value),
  )
}

/** 读 meta 值（对外的便捷函数）。 */
export function getMetaValue(handle, key) {
  return getMeta(handle.db, key)
}

/** 建立 schema（幂等；首次写入版本号）。 */
function ensureSchema(db, meta) {
  applySql(db, SCHEMA_SQL)
  applySql(db, INDEX_SQL)
  // 旧库补列（幂等）：memory_turns 增加 consolidated / turn / archived / archive_id / origin。
  ensureColumn(db, 'memory_turns', 'consolidated', 'consolidated INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'memory_turns', 'turn', 'turn INTEGER')
  ensureColumn(db, 'memory_turns', 'archived', 'archived INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'memory_turns', 'archive_id', 'archive_id TEXT')
  ensureColumn(db, 'memory_turns', 'origin', 'origin TEXT')
  // v2.1.0：召回特征权重初始化（幂等；只补缺的行）。
  seedRecallFeatures(db)
  // v2.1.0：历史轮次 origin 判定 + 系统行迁移到 memory_events（幂等，只处理 origin 为空的行）。
  migrateTurnOrigins(db, meta.log)
  const existing = Number(getMeta(db, 'schema_version'))
  if (!Number.isFinite(existing) || existing <= 0) {
    writeMeta(db, 'schema_version', SCHEMA_VERSION)
    writeMeta(db, 'created_at', new Date().toISOString())
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    meta.log?.('db-schema-created', { schemaVersion: SCHEMA_VERSION })
  } else if (existing < SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    writeMeta(db, 'schema_version', SCHEMA_VERSION)
    meta.log?.('db-schema-upgraded', { from: existing, to: SCHEMA_VERSION })
  }
}

/** 初始化召回特征权重行（v2.1.0）。 */
function seedRecallFeatures(db) {
  try {
    const statement = db.prepare(
      'INSERT OR IGNORE INTO recall_feature_weights(feature, weight, updated_at) VALUES(?, 1, ?)',
    )
    const at = new Date().toISOString()
    for (const feature of RECALL_FEATURES) statement.run(feature, at)
  } catch {
    // 建表失败时读取侧会按默认 1 兜底。
  }
}

/**
 * v2.1.0 历史清洗：给 `memory_turns.origin` 为空的行按内容判定 user/system。
 * system 行的 user_text 另存一份到 `memory_events`（原文不丢），轮次本身标 origin='system'
 * 并停止参与 user 侧召回。只处理 origin 为空的行，幂等。
 */
function migrateTurnOrigins(db, log) {
  let scanned = 0
  let system = 0
  let user = 0
  try {
    const rows = db
      .prepare("SELECT id, session_id, seq, at, user_text FROM memory_turns WHERE origin IS NULL OR origin = ''")
      .all()
    if (rows.length === 0) return { scanned: 0, system: 0, user: 0 }
    const update = db.prepare('UPDATE memory_turns SET origin = ? WHERE id = ?')
    const insertEvent = db.prepare(
      `INSERT OR IGNORE INTO memory_events(id, session_id, seq, at, kind, text, meta) VALUES(?, ?, ?, ?, 'system', ?, ?)`,
    )
    db.exec('BEGIN IMMEDIATE')
    try {
      const at = new Date().toISOString()
      for (const row of rows) {
        scanned += 1
        const origin = classifyTextOrigin(row.user_text)
        update.run(origin, row.id)
        if (origin === 'system') {
          system += 1
          insertEvent.run(
            `evt-${row.id}`,
            row.session_id ?? null,
            Number.isFinite(Number(row.seq)) ? Number(row.seq) : null,
            typeof row.at === 'string' ? row.at : at,
            String(row.user_text ?? ''),
            JSON.stringify({ migratedFromTurn: row.id, reason: 'system-text', salience: 0.05 }),
          )
        } else {
          user += 1
        }
      }
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* 回滚失败保留原错误 */
      }
      throw error
    }
    log?.('turns-origin-migrated', { scanned, user, system, events: system })
    return { scanned, system, user }
  } catch {
    // 清洗失败不阻塞打开：读取侧仍会用 origin 兜底（NULL 按 user 处理）。
    return { scanned, system, user }
  }
}

/** 表缺列时补列（幂等；SQLite 的 ALTER TABLE ADD COLUMN 支持带默认值）。 */
function ensureColumn(db, table, column, ddl) {
  try {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all()
    if (Array.isArray(columns) && columns.some((row) => row.name === column)) return false
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
    return true
  } catch {
    // 补列失败不阻塞打开：读取侧对缺列做了兜底（rowToTurn 默认 0）。
    return false
  }
}

/** 设置连接级 PRAGMA。 */
function applyPragmas(db) {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
}

/** 把旧 JSON 的一个轮次数组导入 DB（按 id / session+seq 去重）。 */
function importTurns(db, turns) {
  let imported = 0
  const statement = db.prepare(
    `INSERT OR IGNORE INTO memory_turns(id, session_id, seq, at, user_text, assistant_text, mood, provider, model)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const turn of Array.isArray(turns) ? turns : []) {
    if (turn === null || typeof turn !== 'object' || typeof turn.user !== 'string' || typeof turn.assistant !== 'string') {
      continue
    }
    const result = statement.run(
      typeof turn.id === 'string' ? turn.id : `turn-import-${imported}-${Date.now()}`,
      typeof turn.sessionId === 'string' ? turn.sessionId : null,
      Number.isFinite(turn.seq) ? turn.seq : null,
      typeof turn.at === 'string' ? turn.at : new Date().toISOString(),
      turn.user,
      turn.assistant,
      typeof turn.mood === 'string' ? turn.mood : null,
      typeof turn.provider === 'string' ? turn.provider : null,
      typeof turn.model === 'string' ? turn.model : null,
    )
    imported += Number(result.changes) || 0
  }
  return imported
}

/** 把旧 JSON 的一侧事实导入 DB（norm 唯一去重）。 */
function importFacts(db, facts) {
  let imported = 0
  const statement = db.prepare(
    `INSERT OR IGNORE INTO memory_facts(id, side, text, norm, kind, weight, hits, created_at, last_seen_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const side of ['user', 'self']) {
    for (const fact of Array.isArray(facts?.[side]) ? facts[side] : []) {
      if (fact === null || typeof fact !== 'object' || typeof fact.text !== 'string' || fact.text.trim().length === 0) {
        continue
      }
      const norm = normalizeForDb(fact.text)
      const result = statement.run(
        typeof fact.id === 'string' ? fact.id : `fact-import-${side}-${imported}-${Date.now()}`,
        side,
        fact.text.trim(),
        norm,
        typeof fact.kind === 'string' ? fact.kind : 'other',
        Number.isFinite(fact.weight) ? fact.weight : 0.5,
        Number.isFinite(fact.hits) ? Math.round(fact.hits) : 1,
        typeof fact.createdAt === 'string' ? fact.createdAt : new Date().toISOString(),
        typeof fact.lastSeenAt === 'string' ? fact.lastSeenAt : new Date().toISOString(),
      )
      imported += Number(result.changes) || 0
    }
  }
  return imported
}

/** 与 memory 层一致的归一化（用于 norm 唯一键）。 */
export function normalizeForDb(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .trim()
}

/**
 * 把同目录 v1.0.0 的 JSON 数据导入 DB（幂等），成功后把文件改名。
 * @returns {{files: string[], imported: Record<string, number>}}
 */
export function migrateLegacyJson(handle, dataDir, log) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) return { files: [], imported: {} }
  const present = LEGACY_FILES.filter((name) => fs.existsSync(path.join(dataDir, name)))
  if (present.length === 0) return { files: [], imported: {} }

  const imported = { turns: 0, facts: 0, summaries: 0, mood: 0, moodHistory: 0, persona: 0, collector: 0 }
  const db = handle.db
  const stamp = stampNow()

  runTransaction(handle, () => {
    for (const name of present) {
      const file = path.join(dataDir, name)
      const data = readJsonFile(file)
      if (data === null || typeof data !== 'object' || Array.isArray(data)) continue

      if (name === 'memory.json') {
        imported.turns += importTurns(db, data.turns)
        imported.facts += importFacts(db, data.facts ?? {})
        for (const side of ['user', 'self']) {
          const text = data.summaries?.[side]
          if (typeof text === 'string' && text.trim().length > 0) {
            const result = db
              .prepare(
                `INSERT OR IGNORE INTO memory_summaries(side, summary, chars, updated_at) VALUES(?, ?, ?, ?)`,
              )
              .run(side, text.trim(), text.trim().length, data.summaryUpdatedAt?.[side] ?? null)
            imported.summaries += Number(result.changes) || 0
          }
        }
        if (typeof data.profile?.userName === 'string' && data.profile.userName.length > 0) {
          setMeta(handle, 'profile.user_name', data.profile.userName)
        }
        for (const [sessionId, seq] of Object.entries(data.lastSeq ?? {})) {
          if (Number.isFinite(seq)) {
            db.prepare(
              `INSERT INTO collector_state(session_id, layer, last_seq, updated_at) VALUES(?, 'memory', ?, ?)
               ON CONFLICT(session_id, layer) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq), updated_at = excluded.updated_at`,
            ).run(sessionId, seq, new Date().toISOString())
            imported.collector += 1
          }
        }
        if (data.collect?.turnsSinceExtract) setMeta(handle, 'memory.turns_since_extract', data.collect.turnsSinceExtract)
        if (data.collect?.turnsSinceSummary) setMeta(handle, 'memory.turns_since_summary', data.collect.turnsSinceSummary)
      }

      if (name === 'mood.json') {
        const seed = (side) => {
          const value = data[side]
          if (value === null || typeof value !== 'object') return
          const result = db
            .prepare(
              `INSERT OR IGNORE INTO mood_state(side, name, status, valence, affection, energy, updated_at)
               VALUES(?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              side,
              typeof value.name === 'string' ? value.name : null,
              typeof value.status === 'string' ? value.status : null,
              Number.isFinite(value.valence) ? value.valence : 0.55,
              Number.isFinite(value.affection) ? value.affection : null,
              Number.isFinite(value.energy) ? value.energy : 0.6,
              typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
            )
          imported.mood += Number(result.changes) || 0
          // 历史只在目标侧为空时导入，保证幂等且不覆盖新数据。
          const history = Array.isArray(data.history?.[side]) ? data.history[side] : []
          const exists = db.prepare('SELECT COUNT(*) AS count FROM mood_history WHERE side = ?').get(side)
          if (Number(exists?.count) === 0) {
            for (const entry of history) {
              if (entry === null || typeof entry !== 'object') continue
              db.prepare(
                `INSERT INTO mood_history(side, at, name, valence, affection, energy, reason) VALUES(?, ?, ?, ?, ?, ?, ?)`,
              ).run(
                side,
                typeof entry.at === 'string' ? entry.at : new Date().toISOString(),
                typeof entry.name === 'string' ? entry.name : null,
                Number.isFinite(entry.valence) ? entry.valence : 0.5,
                Number.isFinite(entry.affection) ? entry.affection : null,
                Number.isFinite(entry.energy) ? entry.energy : 0.5,
                typeof entry.reason === 'string' ? entry.reason : null,
              )
              imported.moodHistory += 1
            }
          }
        }
        seed('user')
        seed('self')
        for (const [sessionId, seq] of Object.entries(data.lastSeq ?? {})) {
          if (Number.isFinite(seq)) {
            db.prepare(
              `INSERT INTO collector_state(session_id, layer, last_seq, updated_at) VALUES(?, 'mood', ?, ?)
               ON CONFLICT(session_id, layer) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq), updated_at = excluded.updated_at`,
            ).run(sessionId, seq, new Date().toISOString())
          }
        }
      }

      if (name === 'persona.json') {
        for (const side of ['user', 'self']) {
          for (const [trait, value] of Object.entries(data.traits?.[side] ?? {})) {
            if (!Number.isFinite(value)) continue
            const result = db
              .prepare(
                `INSERT OR IGNORE INTO persona_traits(side, trait, value, updated_at) VALUES(?, ?, ?, ?)`,
              )
              .run(side, trait, value, data.updatedAt?.[side] ?? null)
            imported.persona += Number(result.changes) || 0
          }
          for (const [trait, value] of Object.entries(data.baseline?.[side] ?? {})) {
            if (!Number.isFinite(value)) continue
            db.prepare('INSERT OR IGNORE INTO persona_baseline(side, trait, value) VALUES(?, ?, ?)').run(
              side,
              trait,
              value,
            )
          }
          if (typeof data.updatedAt?.[side] === 'string') {
            setMeta(handle, `persona.updated_at.${side}`, data.updatedAt[side])
          }
        }
        for (const [sessionId, seq] of Object.entries(data.lastSeq ?? {})) {
          if (Number.isFinite(seq)) {
            db.prepare(
              `INSERT INTO collector_state(session_id, layer, last_seq, updated_at) VALUES(?, 'persona', ?, ?)
               ON CONFLICT(session_id, layer) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq), updated_at = excluded.updated_at`,
            ).run(sessionId, seq, new Date().toISOString())
          }
        }
      }

      if (name === 'state.json') {
        if (Number.isFinite(data.exchanges)) setMeta(handle, 'legacy.exchanges', data.exchanges)
        if (typeof data.lastTurnAt === 'string') setMeta(handle, 'legacy.last_turn_at', data.lastTurnAt)
        for (const [sessionId, seq] of Object.entries(data.lastSeq ?? {})) {
          if (Number.isFinite(seq)) {
            db.prepare(
              `INSERT INTO collector_state(session_id, layer, last_seq, updated_at) VALUES(?, 'memory', ?, ?)
               ON CONFLICT(session_id, layer) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq), updated_at = excluded.updated_at`,
            ).run(sessionId, seq, new Date().toISOString())
          }
        }
      }
    }
  })

  // 导入成功后改名（即使部分行为 0，也说明该文件处理过；改名避免重复导入）。
  const renamed = []
  for (const name of present) {
    const file = path.join(dataDir, name)
    const target = `${file}.imported-${stamp}`
    try {
      fs.renameSync(file, target)
      renamed.push(target)
    } catch {
      /* 改名失败不影响 DB 数据 */
    }
  }
  log?.('db-migrated', { files: present, renamed: renamed.length, imported, schemaVersion: SCHEMA_VERSION })
  return { files: present, imported }
}

/**
 * 获取（或创建）数据库连接。
 * @param {object} options 依赖。
 * @param {string} options.dbFile 数据库文件绝对路径。
 * @param {string} [options.dataDir] 同目录旧 JSON 所在目录（用于迁移）。
 * @param {(event: string, data?: Record<string, unknown>) => void} [options.log] 日志。
 * @returns {object} 连接句柄（须调用 release()）。
 */
export function acquireDatabase({ dbFile, dataDir, log }) {
  const key = path.resolve(dbFile)
  let handle = handles.get(key)
  if (handle !== undefined) {
    handle.refs += 1
    return handle
  }

  fs.mkdirSync(path.dirname(key), { recursive: true })
  const db = new DatabaseSync(key)
  applyPragmas(db)

  handle = {
    db,
    dbFile: key,
    dataDir: dataDir ?? path.dirname(key),
    refs: 1,
    closed: false,
    statements: new Map(),
    inTransaction: false,
    log,
    /** 预处理语句缓存。 */
    prepare(sql) {
      let statement = handle.statements.get(sql)
      if (statement === undefined) {
        statement = db.prepare(sql)
        handle.statements.set(sql, statement)
      }
      return statement
    },
    /** 事务包装；嵌套调用直接加入外层事务。 */
    transaction(fn) {
      return runTransaction(handle, fn)
    },
    /** 释放引用；最后一个使用者释放时关闭连接。 */
    release() {
      if (handle.closed) return
      handle.refs -= 1
      if (handle.refs > 0) return
      handle.closed = true
      try {
        db.close()
      } catch {
        /* 关闭失败忽略 */
      }
      handles.delete(key)
    },
  }
  handles.set(key, handle)

  try {
    ensureSchema(db, { log })
    migrateLegacyJson(handle, handle.dataDir, log)
  } catch (error) {
    handle.release()
    throw error
  }
  log?.('db-open', { dbFile: key, schemaVersion: SCHEMA_VERSION })
  return handle
}

/**
 * 在事务里执行回调；嵌套调用加入外层事务。
 * @param {object} handle 连接句柄。
 * @param {() => any} fn 回调。
 */
export function runTransaction(handle, fn) {
  if (handle.inTransaction) return fn()
  handle.db.exec('BEGIN IMMEDIATE')
  handle.inTransaction = true
  try {
    const result = fn()
    handle.db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      handle.db.exec('ROLLBACK')
    } catch {
      /* 回滚失败保留原错误 */
    }
    throw error
  } finally {
    handle.inTransaction = false
  }
}

/** 当前进程里打开的连接数（测试/工具用）。 */
export function openDatabaseCount() {
  return handles.size
}

/** 关闭所有连接（测试/工具用；插件卸载走 release()）。 */
export function closeAllDatabases() {
  for (const handle of [...handles.values()]) {
    handle.refs = 0
    handle.release()
  }
}


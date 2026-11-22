#!/usr/bin/env node
/**
 * brain-db：DSH 助手大脑的 SQLite 只读核查工具（零依赖，用 DSH 自带 node 跑）。
 *
 * 用法：
 *   node tools/brain-db.mjs stats
 *   node tools/brain-db.mjs turns [n]          # 最近 n 轮（默认 5）
 *   node tools/brain-db.mjs facts [user|self]  # 事实（默认两侧）
 *   node tools/brain-db.mjs mood [user|self]   # 情绪状态 + 最近轨迹
 *   node tools/brain-db.mjs persona            # 倾向 + 基线
 *   node tools/brain-db.mjs learn              # 召回自学习（特征权重 / term / miss / 隔离事件）
 *   node tools/brain-db.mjs sql "SELECT ..."   # 只读查询（SELECT/PRAGMA/EXPLAIN/WITH）
 *
 * 可选：--db <路径> 覆盖默认数据库位置
 *   （默认 %USERPROFILE%\.dsh\dsh-brain\brain.db）
 *
 * 只读打开（readOnly），不会创建/修改数据库；数据库不存在时提示并以 1 退出。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 解析命令行。 */
function parseArgs(argv) {
  const options = { dbFile: '', command: '', args: [], sql: '' }
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--db') {
      options.dbFile = argv[index + 1] ?? ''
      index += 1
      continue
    }
    rest.push(token)
  }
  options.command = rest[0] ?? 'stats'
  options.args = rest.slice(1)
  if (options.command === 'sql') options.sql = options.args.join(' ')
  return options
}

/** 人类可读大小。 */
function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/** 单行截断。 */
function oneLine(text, max = 100) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** 打开只读数据库。 */
function openDb(dbFile) {
  const resolved = path.resolve(dbFile)
  if (!fs.existsSync(resolved)) {
    console.error(`数据库不存在：${resolved}`)
    console.error('提示：先用 DSH 加载 @shenyue/dsh-brain 插件（会在该路径创建 brain.db），或用 --db 指定。')
    process.exit(1)
  }
  let db
  try {
    db = new DatabaseSync(resolved, { readOnly: true })
  } catch {
    db = new DatabaseSync(resolved)
  }
  return { db, resolved }
}

/** 取表行数（表不存在时返回 0）。 */
function countOf(db, table) {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()
    return Number(row?.c) || 0
  } catch {
    return 0
  }
}

/** stats：schema 版本 / 各表行数 / 文件大小。 */
function stats(db, dbFile) {
  const schemaVersion =
    (() => {
      try {
        return db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? '(none)'
      } catch {
        return '(none)'
      }
    })()
  const createdAt =
    (() => {
      try {
        return db.prepare("SELECT value FROM meta WHERE key = 'created_at'").get()?.value ?? '(none)'
      } catch {
        return '(none)'
      }
    })()
  const tables = [
    'memory_turns',
    'memory_facts',
    'memory_summaries',
    'memory_episodes',
    'memory_archives',
    'memory_events',
    'recall_item_stats',
    'recall_term_weights',
    'recall_misses',
    'recall_feature_weights',
    'mood_state',
    'mood_history',
    'persona_traits',
    'persona_baseline',
    'collector_state',
  ]
  const lines = [
    `数据库：${dbFile}`,
    `schema 版本：${schemaVersion}    创建于：${createdAt}`,
    `文件大小：${humanSize(fs.statSync(dbFile).size)}` +
      (fs.existsSync(`${dbFile}-wal`) ? `（WAL ${humanSize(fs.statSync(`${dbFile}-wal`).size)}）` : ''),
    '',
    '表行数：',
  ]
  for (const table of tables) lines.push(`  ${table.padEnd(18)} ${countOf(db, table)}`)
  try {
    const userFacts = db.prepare("SELECT COUNT(*) AS c FROM memory_facts WHERE side = 'user'").get()?.c ?? 0
    const selfFacts = db.prepare("SELECT COUNT(*) AS c FROM memory_facts WHERE side = 'self'").get()?.c ?? 0
    const sessions = db.prepare('SELECT COUNT(DISTINCT session_id) AS c FROM memory_turns').get()?.c ?? 0
    lines.push('', `分布：user 事实 ${userFacts} / self 事实 ${selfFacts} / 会话 ${sessions}`)
  } catch {
    /* 旧库或缺表时跳过 */
  }
  console.log(lines.join('\n'))
}

/** turns [n]。 */
function turns(db, limit) {
  const rows = db
    .prepare('SELECT * FROM memory_turns ORDER BY rowid DESC LIMIT ?')
    .all(limit)
    .reverse()
  console.log(`最近 ${rows.length} 轮（共 ${countOf(db, 'memory_turns')}）：`)
  for (const row of rows) {
    console.log(`\n[${row.at}] session=${row.session_id ?? '-'} seq=${row.seq ?? '-'}`)
    console.log(`  用户：${oneLine(row.user_text, 160)}`)
    console.log(`  助手：${oneLine(row.assistant_text, 160)}`)
  }
}

/** facts [side]。 */
function facts(db, side) {
  const sides = side === 'user' || side === 'self' ? [side] : ['user', 'self']
  for (const current of sides) {
    const rows = db
      .prepare('SELECT * FROM memory_facts WHERE side = ? ORDER BY weight DESC, last_seen_at DESC')
      .all(current)
    console.log(`\n${current} 侧事实（${rows.length} 条）：`)
    for (const row of rows) {
      console.log(`  [${row.kind}] ${oneLine(row.text, 120)}  w=${Number(row.weight).toFixed(2)} hits=${row.hits}`)
    }
  }
}

/** mood [side]。 */
function mood(db, side) {
  const sides = side === 'user' || side === 'self' ? [side] : ['user', 'self']
  for (const current of sides) {
    const state = db.prepare('SELECT * FROM mood_state WHERE side = ?').get(current)
    console.log(`\n${current} 侧状态：${state === undefined ? '(无)' : JSON.stringify(state)}`)
    const history = db
      .prepare('SELECT * FROM mood_history WHERE side = ? ORDER BY id DESC LIMIT 5')
      .all(current)
    for (const row of history) {
      console.log(`  [${row.at}] ${row.name ?? '-'} v=${Number(row.valence).toFixed(2)} e=${Number(row.energy).toFixed(2)} ${row.reason ?? ''}`)
    }
  }
}

/** persona。 */
function persona(db) {
  for (const side of ['user', 'self']) {
    const traits = db.prepare('SELECT trait, value FROM persona_traits WHERE side = ? ORDER BY trait').all(side)
    const baseline = db.prepare('SELECT trait, value FROM persona_baseline WHERE side = ? ORDER BY trait').all(side)
    console.log(`\n${side} 侧倾向：`)
    for (const row of traits) console.log(`  ${row.trait.padEnd(12)} ${Number(row.value).toFixed(3)}`)
    console.log(`${side} 侧基线：`)
    for (const row of baseline) console.log(`  ${row.trait.padEnd(12)} ${Number(row.value).toFixed(3)}`)
  }
}

/** learn：召回自学习观测（v2.1.0）。 */
function learn(db) {
  const feature = db.prepare('SELECT feature, weight FROM recall_feature_weights ORDER BY feature').all()
  console.log('\n特征权重：')
  for (const row of feature) console.log(`  ${row.feature.padEnd(12)} ${Number(row.weight).toFixed(3)}`)
  const items = db
    .prepare('SELECT COUNT(*) AS tracked, COALESCE(SUM(injected),0) AS injected, COALESCE(SUM(used),0) AS used, COALESCE(SUM(ignored),0) AS ignored FROM recall_item_stats')
    .get()
  const judgments = Number(items.used) + Number(items.ignored)
  console.log(
    `\n记忆条目：跟踪 ${items.tracked} · 注入 ${items.injected} · used ${items.used} · ignored ${items.ignored} · 命中率 ${(judgments > 0 ? Number(items.used) / judgments : 0).toFixed(3)}`,
  )
  const terms = db.prepare('SELECT term, weight, hits, misses FROM recall_term_weights ORDER BY ABS(weight - 1) DESC LIMIT 12').all()
  console.log('\n学到的词（偏离 1 最多）：')
  for (const row of terms) {
    console.log(`  ${row.term.padEnd(16)} ×${Number(row.weight).toFixed(3)}  hits=${row.hits} misses=${row.misses}`)
  }
  const misses = db.prepare('SELECT at, terms, source_text FROM recall_misses ORDER BY id DESC LIMIT 5').all()
  console.log('\n最近 miss：')
  for (const row of misses) console.log(`  [${row.at}] ${row.terms} ← ${oneLine(row.source_text, 60)}`)
  const events = db.prepare("SELECT kind, COUNT(*) AS c FROM memory_events GROUP BY kind").all()
  console.log('\n系统/工具事件（隔离区）：')
  for (const row of events) console.log(`  ${row.kind}: ${row.c}`)
}

/** 只读 SQL。 */
function runSql(db, sql) {
  const trimmed = String(sql ?? '').trim()
  if (!/^(?:select|pragma|explain|with)\b/iu.test(trimmed)) {
    console.error('只读工具：只允许 SELECT / PRAGMA / EXPLAIN / WITH 开头的查询。')
    process.exit(1)
  }
  const statement = db.prepare(trimmed)
  const rows = statement.all()
  console.log(JSON.stringify(rows, null, 2))
}

// --------------------------------------------------------------------
const options = parseArgs(process.argv.slice(2))
const defaultDb = path.join(os.homedir(), '.dsh', 'dsh-brain', 'brain.db')
const { db, resolved } = openDb(options.dbFile.length > 0 ? options.dbFile : defaultDb)

try {
  switch (options.command) {
    case 'stats':
      stats(db, resolved)
      break
    case 'turns':
      turns(db, Math.max(1, Number(options.args[0]) || 5))
      break
    case 'facts':
      facts(db, options.args[0])
      break
    case 'mood':
      mood(db, options.args[0])
      break
    case 'persona':
      persona(db)
      break
    case 'learn':
      learn(db)
      break
    case 'sql':
      runSql(db, options.sql)
      break
    default:
      console.error(`未知命令：${options.command}`)
      console.error('用法：stats | turns [n] | facts [user|self] | mood [user|self] | persona | learn | sql "<query>"')
      process.exitCode = 1
  }
} finally {
  try {
    db.close()
  } catch {
    /* 关闭失败忽略 */
  }
}

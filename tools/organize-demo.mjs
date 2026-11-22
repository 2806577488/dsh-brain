#!/usr/bin/env node
/**
 * organize-demo：后台消化 / 工作记忆召回的**真实数据**核查工具（零依赖，用 DSH 自带 node 跑）。
 *
 * 与 `tools/brain-db.mjs` 的区别：本工具会直接调用包内真实模块（记忆/情绪/人格服务 +
 * consolidator + context），因此可以：
 *   - 对真实 `brain.db` 跑一次后台消化（只写长期记忆表，不写任何 DSH 会话）；
 *   - 用真实长期记忆构建一次工作记忆注入文本（同一个 buildContextText）。
 *
 * 用法：
 *   node tools/organize-demo.mjs stats
 *   node tools/organize-demo.mjs consolidate [--session <id>] [--limit 12]
 *   node tools/organize-demo.mjs recall --query "我们最早聊的那个旁路插件叫什么"
 *   node tools/organize-demo.mjs evidence --session <id> --query "…" [--out <file.json>]
 *
 * 注意：这不是 DSH 进程内的常驻路径（常驻路径是 dsh-context 插件自己订阅 turn/end）；
 * 本工具用于线上数据的安全验证与取证，明确标注为 offline。
 */

import fs from 'node:fs'
import path from 'node:path'

import { normalizeContextConfig, normalizeMemoryConfig, normalizeMoodConfig, normalizePersonaConfig } from '../src/config.js'
import { createConsolidator } from '../src/consolidator.js'
import { buildContextText } from '../src/context.js'
import { closeAllDatabases } from '../src/db.js'
import { createMemoryService } from '../src/memory.js'
import { createMoodService } from '../src/mood.js'
import { createPersonaService } from '../src/persona.js'
import { createLayerLog, oneLine, resolveDataDir } from '../src/store.js'

/** 解析命令行。 */
function parseArgs(argv) {
  const options = { command: 'stats', session: '', query: '', out: '', limit: 12 }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--session') options.session = argv[++index] ?? ''
    else if (token === '--query') options.query = argv[++index] ?? ''
    else if (token === '--out') options.out = argv[++index] ?? ''
    else if (token === '--limit') options.limit = Number(argv[++index]) || 12
    else if (!token.startsWith('--')) options.command = token
  }
  return options
}

/** 启动三层真实服务（只读写本地 brain.db，不碰 DSH）。 */
function boot() {
  const dir = resolveDataDir('')
  const log = createLayerLog(dir, 'organize-demo')
  const memory = createMemoryService({ config: normalizeMemoryConfig({ dataDir: dir }).config, log, dir })
  const mood = createMoodService({ config: normalizeMoodConfig({ dataDir: dir }).config, log, dir })
  const persona = createPersonaService({ config: normalizePersonaConfig({ dataDir: dir }).config, log, dir })
  memory.init()
  mood.init()
  persona.init()
  const contextConfig = normalizeContextConfig({ dataDir: dir }).config
  const ctx = {
    get(name) {
      if (name === 'brainMemory') return memory
      if (name === 'brainMood') return mood
      if (name === 'brainPersona') return persona
      return undefined
    },
  }
  const consolidator = createConsolidator({ ctx, config: contextConfig, log })
  return { dir, memory, mood, persona, contextConfig, consolidator }
}

/** 所有会话的未整理轮次统计（按会话聚合）。 */
function unconsolidatedBySession(memory) {
  const rows = memory
    .handle()
    .prepare('SELECT session_id, COUNT(*) AS n, MIN(at) AS first_at, MAX(at) AS last_at FROM memory_turns WHERE consolidated = 0 GROUP BY session_id ORDER BY n DESC')
    .all()
  return rows.map((row) => ({ sessionId: row.session_id, turns: Number(row.n), firstAt: row.first_at, lastAt: row.last_at }))
}

/** 打印快照。 */
function printStats(memory) {
  const counts = memory.counts()
  const summaries = memory.summaries()
  const episodes = memory.episodes(5)
  const facts = { user: memory.facts('user'), self: memory.facts('self') }
  console.log(
    JSON.stringify(
      {
        schema: memory.handle().prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value,
        counts: {
          turns: counts.turns,
          facts: { user: facts.user.length, self: facts.self.length },
          episodes: counts.episodes,
          consolidated: counts.consolidated,
          unconsolidated: counts.unconsolidated,
          summaryChars: { user: summaries.user.text.length, self: summaries.self.text.length },
          lastConsolidateAt: counts.lastConsolidateAt,
        },
        sessionsWithUnconsolidated: unconsolidatedBySession(memory),
        recentEpisodes: episodes.map((episode) => ({
          id: episode.id,
          at: episode.at,
          salience: episode.salience,
          summary: oneLine(episode.summary, 120),
          turnIds: episode.turnIds,
        })),
      },
      null,
      2,
    ),
  )
}

/** 构造一次工作记忆注入（真实长期记忆 + 真实情绪/人格）。 */
function buildRecall({ memory, mood, persona, contextConfig }, query) {
  const result = buildContextText({
    config: contextConfig,
    memory,
    mood,
    persona,
    userText: query,
    recentUserTexts: [],
    recallState: { round: 0, seen: new Map() },
  })
  return result
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const services = boot()
  const runId = `organize-${Date.now().toString(36)}`
  try {
    if (options.command === 'stats') {
      printStats(services.memory)
      return
    }

    let sessionId = options.session
    if (options.command === 'consolidate' || options.command === 'evidence') {
      if (sessionId.length === 0) {
        const groups = unconsolidatedBySession(services.memory)
        sessionId = groups[0]?.sessionId ?? ''
      }
      if (sessionId.length === 0) {
        console.log(JSON.stringify({ ok: false, reason: 'no-unconsolidated-turns' }, null, 2))
        return
      }
      const before = printSnapshot(services.memory)
      const result = await services.consolidator.consolidateNow(sessionId, { reason: 'manual' })
      const after = printSnapshot(services.memory)
      const payload = {
        runId,
        mode: 'offline-real-db',
        sessionId,
        result,
        before,
        after,
        episodes: services.memory.episodes(10).map((episode) => ({
          id: episode.id,
          at: episode.at,
          salience: episode.salience,
          summary: oneLine(episode.summary, 160),
          turnIds: episode.turnIds,
        })),
        summaries: {
          userChars: services.memory.summaries().user.text.length,
          selfChars: services.memory.summaries().self.text.length,
        },
      }
      if (options.command === 'evidence') {
        payload.recall = buildEvidenceRecall(services, options.query)
        if (options.out.length > 0) {
          fs.mkdirSync(path.dirname(options.out), { recursive: true })
          fs.writeFileSync(options.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
          console.log(`evidence-written ${options.out}`)
        }
      }
      console.log(JSON.stringify(payload, null, 2))
      return
    }

    if (options.command === 'recall') {
      const recall = buildEvidenceRecall(services, options.query)
      console.log(JSON.stringify({ runId, mode: 'offline-real-db', recall }, null, 2))
      return
    }

    console.log(`未知命令：${options.command}`)
    process.exitCode = 2
  } finally {
    try {
      services.memory.close()
      services.mood.close()
      services.persona.close()
      closeAllDatabases()
    } catch {
      /* 关闭失败不影响结果 */
    }
  }
}

/** 快照（轻量，用于 before/after 对比）。 */
function printSnapshot(memory) {
  const counts = memory.counts()
  return {
    turns: counts.turns,
    facts: { user: memory.facts('user').length, self: memory.facts('self').length },
    episodes: counts.episodes,
    consolidated: counts.consolidated,
    unconsolidated: counts.unconsolidated,
    summaryChars: {
      user: memory.summaries().user.text.length,
      self: memory.summaries().self.text.length,
    },
  }
}

/** 构建召回证据（注入文本 + 来源元数据；文本按行截断，避免整段原文外泄）。 */
function buildEvidenceRecall(services, query) {
  const result = buildRecall(services, query)
  const lines = result.text.split('\n')
  return {
    query,
    injectedChars: result.text.length,
    injectedSections: result.sections.length,
    workingMemory: result.stats.workingMemory,
    facts: result.stats.facts,
    injectedTextTruncated: lines.map((line) => oneLine(line, 100)),
  }
}

main().catch((error) => {
  console.error(`organize-demo 失败：${error?.stack ?? String(error)}`)
  process.exitCode = 1
})

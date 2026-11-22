#!/usr/bin/env node
/**
 * 一键复现 v2.1.0 召回自学习（临时库 + 合成 user-source 事件）。
 *
 *   node tools/verify-learning.mjs
 *
 * 不依赖 DSH、不联网、不碰线上 brain.db：在系统临时目录建一个独立 brain.db，
 * 用真实的四个插件入口（memory + context）和真实 `session/event` 形状驱动：
 *
 *   1. 预置 3 条 user 侧原文（旁路插件 / 8720 / 召回）；
 *   2. 4 轮 user/assistant（`source.kind='user'`）：
 *      A 注入 → B 归因（used）→ C 触发「你忘了」miss → D 归因并观察分数上升；
 *   3. 断言：item used/ignored 有值、相关 term 权重上浮、无关词不动、
 *      recall_misses 有记录、同一记忆第 4 轮分数 > 基线；
 *   4. 防自我强化探针：助手复述但用户下轮没接话 → term 权重回落（echo 按 ignored）。
 *
 * 失败时打印 FAIL 并以 1 退出；成功打印 `[verify-learning] OK`。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as memoryPlugin from '../src/plugins/memory.js'
import * as contextPlugin from '../src/plugins/context.js'
import { attributeUse } from '../src/learning.js'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-brain-verify-'))
const SESSION = 'sess-verify-learning'
const results = []

function check(name, ok, detail) {
  results.push({ name, ok })
  const suffix = detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${suffix}`)
}

/** 极简假 Cordis ctx（只实现本脚本用到的能力）。 */
function createFakeCtx() {
  const services = new Map()
  const disposers = []
  const handlers = new Map()
  const sectionDefs = []
  const commandDefs = []
  services.set('systemPrompt', {
    section(definition) {
      sectionDefs.push(definition)
      return () => {
        const index = sectionDefs.indexOf(definition)
        if (index >= 0) sectionDefs.splice(index, 1)
      }
    },
  })
  services.set('commands', {
    register(definition) {
      commandDefs.push(definition)
      return () => {
        const index = commandDefs.indexOf(definition)
        if (index >= 0) commandDefs.splice(index, 1)
      }
    },
  })
  services.set('agentDefaultModel', {
    currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }),
  })
  const ctx = {
    get(name) {
      return services.get(name)
    },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    emit(event, ...args) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(...args)
    },
    inject(deps, callback) {
      const names = Array.isArray(deps) ? deps : Object.keys(deps)
      if (names.every((name) => services.get(name) !== undefined)) callback(ctx)
    },
    services,
    sectionDefs,
    commandDefs,
    disposeAll() {
      while (disposers.length > 0) {
        const dispose = disposers.pop()
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          /* 清理失败忽略 */
        }
      }
      handlers.clear()
      services.clear()
    },
  }
  return ctx
}

function send(ctx, type, seq, data) {
  ctx.emit('session/event', { id: SESSION, header: { id: SESSION } }, {
    type,
    seq,
    time: Date.now(),
    data,
  })
}

function sendUser(ctx, seq, text) {
  send(ctx, 'user/message', seq, {
    id: `u-${seq}`,
    role: 'user',
    content: [{ type: 'text', text }],
    // 真实人类消息的形状（user-source）
    source: { kind: 'user' },
  })
}

function sendAssistant(ctx, seq, text) {
  send(ctx, 'assistant/message', seq, {
    turn: Math.ceil(seq / 10),
    message: {
      id: `a-${seq}`,
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' },
    },
    stream: [],
  })
}

const ctx = createFakeCtx()
memoryPlugin.apply(ctx, { dataDir: ROOT })
contextPlugin.apply(ctx, { dataDir: ROOT })

const memory = ctx.get('brainMemory')
const context = ctx.get('brainContext')
const handle = memory.handle()
const nowIso = new Date().toISOString()

// ---------------------------------------------------------------------
// 1. 预置 3 条 user 侧原文（真实入库形状；origin='user'）
// ---------------------------------------------------------------------
const fixture = [
  ['turn-fix-1', '我们上次聊到旁路插件：它监听 8720 端口，也负责记忆层召回。'],
  ['turn-fix-2', '对，旁路插件就是那个记忆层，8720 端口一直开着。'],
  ['turn-fix-3', '旁路插件会把相关记忆召回，再交给上下文整理层注入。'],
]
const insertTurn = handle.prepare(
  'INSERT INTO memory_turns(id, session_id, seq, at, user_text, assistant_text, origin) VALUES(?, ?, ?, ?, ?, ?, ?)',
)
let seq = 1
for (const [id, user] of fixture) {
  insertTurn.run(id, SESSION, seq, nowIso, user, '（预设原文）', 'user')
  seq += 1
}

// 基线：学习前同一查询下 turn-fix-1 的分数
const query = '旁路插件 8720 召回'
const baseline = memory
  .recallOriginals(query, { limit: 10, topicShiftEnabled: false })
  .find((turn) => turn.id === 'turn-fix-1')?.score

// ---------------------------------------------------------------------
// 2. 4 轮真实事件形状：user-source + assistant
// ---------------------------------------------------------------------
const turns = [
  {
    user: '我们继续聊旁路插件：它监听 8720 端口，也负责记忆层召回。',
    assistant: '旁路插件监听 8720 端口，会把相关记忆召回后交给上下文层。',
  },
  {
    user: '对，旁路插件就是那个记忆层，继续讲 8720 端口和召回。',
    assistant: '8720 端口对应旁路插件，召回结果再注入 system prompt。',
  },
  {
    user: '你还记得我上次说的旁路插件吗？不记得的话再从记忆里捞一遍。',
    assistant: '我记得旁路插件监听 8720 端口；我再从记忆里捞一次。',
  },
  {
    user: '对，就是那个监听 8720 的旁路插件，再讲讲召回。',
    assistant: '旁路插件的召回会按相关度、salience 和 term 权重排序。',
  },
]
seq = 10
for (const turn of turns) {
  sendUser(ctx, seq, turn.user)
  // 真实 DSH 在每轮 user 之后、assistant 之前组装 system prompt
  context.sectionText()
  seq += 1
  sendAssistant(ctx, seq, turn.assistant)
  seq += 1
}

// 手动 ignored 探针：保证 ignored 计数也有值（不依赖召回是否选中无关记忆）
const ignoredItem = {
  id: 'turn-probe-ignored',
  kind: 'turn',
  snippet: '完全无关的探针记忆',
  terms: ['无关探针词'],
  score: 0.7,
  features: { relevance: 0.7, salience: 0.5, recency: 0.5, topic: 0.1, affection: 0 },
}
memory.recordRecallInjection([ignoredItem])
memory.applyRecallAttribution({
  items: [ignoredItem],
  attribution: attributeUse({
    injectedItems: [ignoredItem],
    assistantText: '好的。',
    nextUserText: '今天天气不错',
  }),
})

// ---------------------------------------------------------------------
// 3. 断言
// ---------------------------------------------------------------------
const stats = memory.learningStats()
const itemTotals = handle
  .prepare('SELECT COALESCE(SUM(used),0) used, COALESCE(SUM(ignored),0) ignored, COUNT(*) tracked FROM recall_item_stats')
  .get()
check(
  'item-stats-used-and-ignored',
  Number(itemTotals.used) > 0 && Number(itemTotals.ignored) > 0,
  itemTotals,
)

const weightOf = (term) =>
  handle.prepare('SELECT weight, hits, misses FROM recall_term_weights WHERE term = ?').get(term)
const relevant = ['旁路', '插件', '8720', '召回']
const relevantRows = Object.fromEntries(relevant.map((term) => [term, weightOf(term)]))
check(
  'term-weights-up',
  relevant.every((term) => relevantRows[term] !== undefined && Number(relevantRows[term].weight) > 1),
  Object.fromEntries(relevant.map((term) => [term, Number(relevantRows[term]?.weight ?? 0).toFixed(3)])),
)
const unrelated = weightOf('咖啡')
check(
  'unrelated-term-untouched',
  unrelated === undefined || Math.abs(Number(unrelated.weight) - 1) < 1e-9,
  unrelated ?? '(no row)',
)

const misses = memory.learningStats().recentMisses
check(
  'forget-miss-recorded',
  misses.length >= 1 && misses[0].terms.some((term) => ['旁路', '插件', '召回'].includes(term)),
  misses[0],
)

const after = memory
  .recallOriginals(query, { limit: 10, topicShiftEnabled: false })
  .find((turn) => turn.id === 'turn-fix-1')
check(
  'learned-score-increases',
  Number(baseline) > 0 && Number(after?.score) > Number(baseline),
  { before: baseline, after: after?.score, learnedTerm: after?.learnedTerm },
)

// 防自我强化探针：先人为把「回声探针」设为 1.2（模拟之前被用户确认过），
// 再构造「助手复述但用户下轮没接话」的归因；echo 应按 ignored 处理，权重回落。
handle
  .prepare(
    `INSERT INTO recall_term_weights(term, weight, hits, misses, updated_at) VALUES('回声探针', 1.2, 1, 0, ?)
     ON CONFLICT(term) DO UPDATE SET weight = 1.2, hits = 1, misses = 0, updated_at = excluded.updated_at`,
  )
  .run(nowIso)
const echoItem = {
  id: 'turn-probe-echo',
  kind: 'turn',
  snippet: '回声探针只出现在助手复述里',
  terms: ['回声探针'],
  score: 0.8,
  features: { relevance: 0.8, salience: 0.5, recency: 0.8, topic: 0.2, affection: 0 },
}
memory.recordRecallInjection([echoItem])
const echoAttribution = attributeUse({
  injectedItems: [echoItem],
  assistantText: '回声探针只出现在助手复述里。',
  nextUserText: '嗯，先不说这个。',
})
memory.applyRecallAttribution({ items: [echoItem], attribution: echoAttribution })
const echoAfter = Number(weightOf('回声探针')?.weight)
check(
  'echo-does-not-reinforce',
  echoAttribution.echoIds.includes('turn-probe-echo') && echoAfter < 1.2,
  { before: 1.2, after: echoAfter, score: echoAttribution.scores['turn-probe-echo'] },
)

// ---------------------------------------------------------------------
// 4. 输出汇总（报告直接引用）
// ---------------------------------------------------------------------
const brainCommand = ctx.commandDefs.find((definition) => definition.name === 'brain')
if (brainCommand !== undefined) {
  const learnView = await brainCommand.handler({ rawInput: 'learn', agent: { id: SESSION } })
  console.log('\n[verify-learning] /brain learn 输出：')
  console.log(learnView.text)
}
console.log('\n[verify-learning] 汇总：')
console.log(
  JSON.stringify(
    {
      schema: handle.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value,
      items: itemTotals,
      hitRate: Number(stats.items?.hitRate ?? 0).toFixed(3),
      termWeights: Object.fromEntries(
        relevant.map((term) => [term, Number(relevantRows[term]?.weight ?? 0).toFixed(3)]),
      ),
      misses: misses.map((miss) => ({ terms: miss.terms, source: String(miss.sourceText ?? '').slice(0, 60) })),
      score: { before: baseline, after: after?.score, learnedTerm: after?.learnedTerm, recallTerms: after?.terms },
      echo: { before: 1.2, after: echoAfter },
    },
    null,
    2,
  ),
)

// ---------------------------------------------------------------------
// 5. 清理
// ---------------------------------------------------------------------
ctx.disposeAll()
await new Promise((resolve) => setTimeout(resolve, 50))
fs.rmSync(ROOT, { recursive: true, force: true })
const failures = results.filter((result) => !result.ok)
if (failures.length > 0) {
  console.log(`\n[verify-learning] FAILED: ${failures.map((result) => result.name).join(', ')}`)
  process.exit(1)
}
console.log('\n[verify-learning] OK')
process.exit(0)

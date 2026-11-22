/**
 * DSH 助手大脑：离线自测（SQLite 持久化 + 四层单测 + 采集/注入集成）。
 *
 *   node test/smoke.mjs
 *
 * 不依赖 DSH、不联网：用临时目录（`fs.mkdtemp`）+ 极简假 Cordis ctx、假 systemPrompt、
 * 假 commands、假 llm 装载四个插件行，模拟 `session/event` 投递。覆盖：
 *   - SQLite：建表幂等、schema 版本、单连接共享、写入/查询、唯一约束去重、
 *     事务回滚不脏数据、maxTurns 裁剪、重开连接持久化、JSON→DB 迁移幂等
 *   - 采集：配对、幂等（collector + DB 双保险）、subagent/正则过滤、截断、合成消息跳过
 *   - 记忆：双向事实抽取/去重/上限/召回/摘要/手动增删/快照、/brain 读 DB
 *   - 情绪：双侧更新、时间衰减、状态名、轨迹上限
 *   - 人格：双侧倾向、有界、渲染
 *   - 上下文：注入文本、异常返回 ''、section 注册、enabled:false
 *   - 命令：/brain 总览与分项、reset 确认、未知参数
 *   - 降级：单层停用不影响其它层
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as memoryPlugin from '../src/plugins/memory.js'
import * as moodPlugin from '../src/plugins/mood.js'
import * as personaPlugin from '../src/plugins/persona.js'
import * as contextPlugin from '../src/plugins/context.js'
import { openDatabaseCount } from '../src/db.js'
import {
  extractSelfFacts,
  extractUserFacts,
  factSimilarity,
  mergeFacts,
} from '../src/memory.js'
import { applyMoodDecay, emptyMoodState, MOOD_BASELINE } from '../src/mood.js'
import {
  applyTraitRegression,
  collectTraits,
  describeTraits,
  DEFAULT_SELF_BASELINE,
  DEFAULT_USER_BASELINE,
  SELF_FLOOR,
} from '../src/persona.js'
import { buildCommandDefinition, buildContextText, describeLevel } from '../src/context.js'
import { createCollector, isUserAuthored, sessionIncluded } from '../src/collect.js'
import { buildEpisode, extractTerms, parseConsolidation, scoreSalience } from '../src/consolidator.js'
import { archiveMarkerText, computeSurfaceBalance, createArchiver, selectArchiveRange, sessionIdMatches as archiveSessionIdMatches } from '../src/archiver.js'
import {
  attributeUse,
  decayWeight,
  detectForgetSignal,
  forgetTopicTerms,
  nextUsefulness,
  parseJudgeOutput,
  termsOf,
} from '../src/learning.js'
import { classifyMessage, classifyTextOrigin, looksSystemText } from '../src/roles.js'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-brain-test-'))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  const text = detail === undefined ? '' : ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${text}`)
}

// =====================================================================
// 假 DSH 服务
// =====================================================================
let llmMode = 'ok'
let llmDelayMs = 0
let judgeCalls = 0
const fakeLlm = {
  async prepareCall(config) {
    if (llmMode === 'prepare-fail') throw Object.assign(new Error('no route'), { code: 'NO_ROUTE', status: 404 })
    return {
      config: { ...config },
      stream(options) {
        const system = String(options.system ?? '')
        return (async function* generate() {
          if (llmDelayMs > 0) await wait(llmDelayMs)
          if (llmMode === 'fail') {
            yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream', code: 'UPSTREAM', status: 500 } } }
            return
          }
          let text
          if (system.includes('长期记忆摘要')) {
            text = '{"user":"用户叫小林，正在准备季度报告。","self":"我答应提醒用户复盘。"}'
          } else if (system.includes('抽取值得长期记住的事实')) {
            text = '{"user":[{"text":"用户喜欢咖啡","kind":"preference","weight":0.7}],"self":[{"text":"我答应帮用户看代码","kind":"promise","weight":0.75}]}'
          } else if (system.includes('后台整理')) {
            text = '{"facts":{"user":[],"self":[]},"episode":{"summary":"用户和助手聊到旁路插件与记忆层。","salience":0.72,"terms":["旁路","插件","记忆"]}}'
          } else if (system.includes('召回质量判定器')) {
            judgeCalls += 1
            text = '{"used":["turn-e2e"],"ignored":[],"missedTopicTerms":[]}'
          } else {
            text = '好的，我记下了。'
          }
          for (const ch of text) yield { type: 'text-delta', index: 0, text: ch }
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
  },
}

/** 极简假 Cordis ctx。 */
function createFakeCtx() {
  const services = new Map()
  const disposers = []
  const handlers = new Map()
  const sections = []
  const commands = []

  const systemPrompt = {
    section(definition) {
      sections.push(definition)
      return () => {
        const index = sections.indexOf(definition)
        if (index >= 0) sections.splice(index, 1)
      }
    },
  }
  const commandRuntime = {
    register(definition) {
      commands.push(definition)
      return () => {
        const index = commands.indexOf(definition)
        if (index >= 0) commands.splice(index, 1)
      }
    },
  }
  services.set('systemPrompt', systemPrompt)
  services.set('commands', commandRuntime)
  services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) })

  const ctx = {
    get(name) {
      if (name === 'llm') return fakeLlm
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
      for (const handler of [...(handlers.get(event) ?? [])]) {
        try {
          handler(...args)
        } catch {
          /* 与真实事件总线一致：监听器抛错被包含 */
        }
      }
    },
    inject(deps, callback) {
      const names = Array.isArray(deps) ? deps : Object.keys(deps)
      if (names.every((name) => ctx.get(name) !== undefined)) {
        const dispose = callback(ctx)
        if (typeof dispose === 'function') disposers.push(dispose)
      }
    },
    services,
    sections,
    commands: commandRuntime,
    commandDefinitions: commands,
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
      sections.length = 0
      commands.length = 0
    },
  }
  return ctx
}

/** 起一套四层插件。 */
function boot(options = {}) {
  const disabled = new Set(options.disable ?? [])
  const ctx = createFakeCtx()
  const common = { dataDir: options.dir }
  if (!disabled.has('memory')) memoryPlugin.apply(ctx, { ...common, ...(options.memory ?? {}) })
  if (!disabled.has('mood')) moodPlugin.apply(ctx, { ...common, ...(options.mood ?? {}) })
  if (!disabled.has('persona')) personaPlugin.apply(ctx, { ...common, ...(options.persona ?? {}) })
  if (!disabled.has('context')) contextPlugin.apply(ctx, { ...common, ...(options.context ?? {}) })
  return ctx
}

/** 模拟一轮 DSH 会话事件。 */
function emitTurn(ctx, options) {
  const sessionId = options.sessionId ?? 'sess-main'
  const session = { id: sessionId, header: { id: sessionId, ...(options.header ?? {}) } }
  const seq = options.seq ?? Math.floor(Date.now() / 1000) * 10
  ctx.emit('session/event', session, {
    type: 'user/message',
    seq,
    time: Date.now(),
    data: {
      id: `u-${seq}`,
      role: 'user',
      content: [{ type: 'text', text: options.user }],
      source: options.userSource ?? { kind: 'user' },
    },
  })
  ctx.emit('session/event', session, {
    type: 'assistant/message',
    seq: seq + 1,
    time: Date.now(),
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `a-${seq}`,
        role: 'assistant',
        content: [{ type: 'text', text: options.assistant }],
        source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' },
      },
      stream: [],
    },
  })
  return seq + 2
}

/** 模拟一轮结束（后台消化的触发信号；只投递事件，不做任何会话写操作）。 */
function emitTurnEnd(ctx, options = {}) {
  const sessionId = options.sessionId ?? 'sess-main'
  const session = { id: sessionId, header: { id: sessionId } }
  const seq = options.seq ?? Math.floor(Date.now() / 1000) * 10 + 5
  ctx.emit('session/event', session, {
    type: 'turn/end',
    seq,
    time: Date.now(),
    data: { turn: options.turn ?? 1, reason: { kind: 'completed' } },
  })
  return seq + 1
}

// =====================================================================
// A. 纯函数单测（不落库）
// =====================================================================
const userFacts = extractUserFacts('我叫小林，我在准备季度报告，有点紧张。')
check(
  'facts.user-extract-profile-project',
  userFacts.some((fact) => fact.kind === 'profile' && fact.text.includes('小林')) &&
    userFacts.some((fact) => fact.kind === 'project' && fact.text.includes('季度报告')),
  userFacts,
)
check(
  'facts.user-ignore-question',
  extractUserFacts('你还记得我在忙什么吗？').length === 0 && extractUserFacts('我们几点睡？').length === 0,
)
check(
  'facts.self-promise',
  extractSelfFacts('好，我答应你明天提醒你复盘。').some((fact) => fact.kind === 'promise'),
)
check('facts.similarity-threshold', factSimilarity('用户叫小林', '用户叫小林') === 1 && factSimilarity('用户叫小林', '用户喜欢咖啡') < 0.8)

const manyFacts = Array.from({ length: 120 }, (_, index) => ({
  text: `用户提过「${String.fromCharCode(0x4e00 + index)}」这件事`,
  kind: 'preference',
}))
const capped = mergeFacts([], manyFacts, { side: 'user', maxFacts: 10, maxFactChars: 60 })
check('facts.pure-max-cap', capped.facts.length === 10 && capped.evicted.length === 110)

const localNight = new Date(2026, 10, 21, 2, 0, 0).getTime()
const stale = emptyMoodState()
stale.user.updatedAt = new Date(localNight - 6 * 3600 * 1000).toISOString()
stale.user.valence = 0.95
stale.user.energy = 0.1
const decayed = applyMoodDecay(stale, localNight, { decayMinutes: 120 })
check(
  'mood.decay-toward-baseline',
  decayed.changed === true &&
    decayed.state.user.valence < 0.95 &&
    decayed.state.user.energy > 0.1 &&
    decayed.reasons.user.includes('deep-night'),
  decayed.state.user,
)
check('mood.decay-skip-fresh', applyMoodDecay(emptyMoodState(), Date.now(), { decayMinutes: 120 }).changed === false)

const praisedTraits = collectTraits(
  { user: { ...DEFAULT_USER_BASELINE }, self: { ...DEFAULT_SELF_BASELINE } },
  { userText: '谢谢你，太厉害了', assistantText: '不客气' },
  { now: Date.now() },
).traits
check('persona.self-warmth-on-praise', praisedTraits.self.warmth > DEFAULT_SELF_BASELINE.warmth, praisedTraits.self)
let frustratedTraits = { user: { ...DEFAULT_USER_BASELINE }, self: { ...DEFAULT_SELF_BASELINE } }
for (let index = 0; index < 40; index += 1) {
  frustratedTraits = collectTraits(
    frustratedTraits,
    { userText: '烦死了，太难用了，受不了', assistantText: '我看看' },
    { now: Date.now() },
  ).traits
}
check(
  'persona.bounded-negativity',
  frustratedTraits.self.warmth >= SELF_FLOOR.warmth - 1e-9 && frustratedTraits.self.warmth <= 1,
  frustratedTraits.self,
)
const userDetail = collectTraits(
  { user: { ...DEFAULT_USER_BASELINE }, self: { ...DEFAULT_SELF_BASELINE } },
  { userText: '详细说说，为什么会这样？我想知道每一步的实现细节和取舍；还有边界条件怎么处理。', assistantText: '好' },
  { now: Date.now() },
).traits
check('persona.user-detail', userDetail.user.detail > DEFAULT_USER_BASELINE.detail, userDetail.user)
check(
  'persona.daily-regression',
  applyTraitRegression(
    { warmth: 0.95, directness: 0.9, playfulness: 0.9, proactivity: 0.9 },
    Date.now(),
    { baseline: DEFAULT_SELF_BASELINE, regressionPerDay: 0.5, updatedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString() },
  ).traits.warmth < 0.95,
)
const rendered = describeTraits({
  user: { directness: 0.8, pace: 0.8, humor: 0.7, detail: 0.8 },
  self: { warmth: 0.8, directness: 0.7, playfulness: 0.8, proactivity: 0.8 },
})
check(
  'persona.render-natural-language',
  rendered.text.includes('【用户的沟通偏好】') && rendered.text.includes('【我自己的表达倾向】'),
  rendered.sections,
)
check('context.level-description', describeLevel(0.8, { high: '高', mid: '中', low: '低' }) === '高')
const isolated = buildContextText({
  config: { maxChars: 1500, factLimit: 2, includeUser: true, includeSelf: true },
  memory: {
    factsForPrompt: (side) =>
      side === 'user' ? [{ text: '用户叫小林', kind: 'profile', weight: 0.9 }] : [{ text: '我答应提醒用户复盘', kind: 'promise', weight: 0.8 }],
    summaries: () => ({ user: { text: '' }, self: { text: '' } }),
    profile: () => ({ userName: '小林' }),
  },
  mood: {
    current: () => ({
      user: { valence: 0.4, energy: 0.3 },
      self: { valence: 0.6, energy: 0.6, affection: 0.7, status: '专注' },
    }),
  },
  persona: { render: () => ({ lines: { user: ['用户喜欢直接的回答'], self: ['你倾向先解释再给结论'] } }) },
  userText: '报告',
})
check(
  'context.build-text',
  isolated.text.includes('【关于你（用户）】') &&
    isolated.text.includes('【关于我（这个助手）】') &&
    !/valence|affection|energy|系统提示/u.test(isolated.text),
  isolated.text.slice(0, 120),
)

// =====================================================================
// B. 四层集成（SQLite 临时库）
// =====================================================================
const mainDir = path.join(ROOT, 'main')
const mainCtx = boot({ dir: mainDir })
const brainMemory = () => mainCtx.get('brainMemory')
const brainMood = () => mainCtx.get('brainMood')
const brainPersona = () => mainCtx.get('brainPersona')
const brainContext = () => mainCtx.get('brainContext')
check(
  'services.provided',
  ['brainMemory', 'brainMood', 'brainPersona', 'brainContext'].every((key) => mainCtx.get(key) !== undefined),
)
const sharedHandle = brainMemory().handle()
check(
  'db.single-shared-connection',
  sharedHandle !== undefined &&
    brainMood().handle() === sharedHandle &&
    brainPersona().handle() === sharedHandle &&
    openDatabaseCount() === 1,
  { connections: openDatabaseCount() },
)
check('db.file-created', fs.existsSync(path.join(mainDir, 'brain.db')), path.join(mainDir, 'brain.db'))
check(
  'db.schema-version',
  sharedHandle.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value === '5' &&
    sharedHandle.prepare('PRAGMA user_version').get()?.user_version === 5,
)
const tableNames = sharedHandle
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all()
  .map((row) => row.name)
check(
  'db.tables-created',
  ['memory_turns', 'memory_facts', 'memory_summaries', 'memory_episodes', 'memory_archives', 'mood_state', 'mood_history', 'persona_traits', 'persona_baseline', 'collector_state', 'collector_pending', 'meta'].every(
    (name) => tableNames.includes(name),
  ),
  tableNames,
)
check(
  'db.turns-consolidated-column',
  sharedHandle
    .prepare('PRAGMA table_info(memory_turns)')
    .all()
    .some((row) => row.name === 'consolidated') &&
    sharedHandle
      .prepare('PRAGMA table_info(memory_turns)')
      .all()
      .some((row) => row.name === 'turn') &&
    sharedHandle
      .prepare('PRAGMA table_info(memory_turns)')
      .all()
      .some((row) => row.name === 'archived'),
)

// 写入 + 查询
let seq = 1000
seq = emitTurn(mainCtx, {
  seq,
  user: '我叫小林，我在准备季度报告，最近有点累。',
  assistant: '小林，报告的事先拆成大纲，别硬撑。',
})
await wait(50)
check(
  'db.turn-write-query',
  brainMemory().turns().length === 1 && brainMemory().recentTurns(1)[0].user.includes('季度报告'),
  brainMemory().turns()[0],
)

// collector + DB 双重幂等
emitTurn(mainCtx, {
  seq: 1000,
  user: '我叫小林，我在准备季度报告，最近有点累。',
  assistant: '小林，报告的事先拆成大纲，别硬撑。',
})
const directInsert = brainMemory().rememberTurn({
  user: '重复写入',
  assistant: '重复回复',
  sessionId: 'sess-main',
  seq: 1001,
  at: new Date().toISOString(),
})
check(
  'db.unique-session-seq',
  brainMemory().turns().length === 1 && directInsert.inserted === 0,
  { turns: brainMemory().turns().length, inserted: directInsert.inserted },
)

// 事务回滚不脏数据
const beforeRollback = brainMemory().turns().length
try {
  sharedHandle.transaction(() => {
    sharedHandle
      .prepare(
        `INSERT INTO memory_turns(id, session_id, seq, at, user_text, assistant_text)
         VALUES('rollback-test', 'sess-rollback', 99999, ?, '不该留下', '不该留下')`,
      )
      .run(new Date().toISOString())
    throw new Error('boom')
  })
} catch {
  /* 预期异常 */
}
check('db.transaction-rollback', brainMemory().turns().length === beforeRollback)

// 过滤器：subagent / pet 会话 / 合成消息 / 过短
emitTurn(mainCtx, {
  seq: 2000,
  sessionId: 'sub-1',
  header: { origin: 'subagent', parentSession: 'sess-main' },
  user: '子代理说的话不该进记忆',
  assistant: '子代理回复',
})
emitTurn(mainCtx, { seq: 3000, sessionId: 'pet-bridge-session', user: '桌宠会话不该进记忆', assistant: '回复' })
emitTurn(mainCtx, { seq: 4000, user: '嗯', assistant: '回复' })
emitTurn(mainCtx, { seq: 5000, user: 'runtime 注入', userSource: { kind: 'runtime-context' }, assistant: '回复' })
await wait(30)
check(
  'collect.filters',
  brainMemory().turns().length === 1 && brainMood().history('user', 10).length === 1,
  { turns: brainMemory().turns().length },
)
check(
  'collect.session-included-rules',
  sessionIncluded({ id: 'sess-a', header: {} }, { collectSubagents: false, excludeSessionIdPattern: 'pet', includeSessions: [] }).include === true &&
    sessionIncluded({ id: 'sub', header: { origin: 'subagent' } }, { collectSubagents: false, excludeSessionIdPattern: 'pet', includeSessions: [] }).include === false &&
    sessionIncluded({ id: 'pet-x', header: {} }, { collectSubagents: false, excludeSessionIdPattern: 'pet', includeSessions: [] }).include === false &&
    sessionIncluded({ id: 'other', header: {} }, { collectSubagents: false, excludeSessionIdPattern: 'pet', includeSessions: ['^sess-'] }).include === false,
)

// 截断 + 触发事实抽取（默认每 3 轮）
emitTurn(mainCtx, { seq: 6000, user: '长'.repeat(5000), assistant: '短回复' })
emitTurn(mainCtx, { seq: 6500, user: '我平时喜欢喝咖啡', assistant: '记住了' })
await wait(200)
check('collect.full-storage-no-truncate', brainMemory().recentTurns(2)[0].user.length === 5000)
check(
  'facts.extracted-after-interval',
  brainMemory()
    .facts('user')
    .some((fact) => fact.kind === 'profile' && fact.text.includes('小林')),
  brainMemory().facts('user').map((fact) => fact.text),
)
check(
  'facts.self-relation',
  brainMemory().facts('self').some((fact) => fact.kind === 'relation'),
  brainMemory().facts('self').map((fact) => `${fact.kind}:${fact.text}`),
)
check('memory.profile-name', brainMemory().profile().userName === '小林')

// 唯一约束（side, norm）去重
const addedFact = brainMemory().upsertFact({ side: 'user', text: '用户养了一只猫叫团子', kind: 'other', weight: 0.6 })
const addedAgain = brainMemory().upsertFact({ side: 'user', text: '用户养了一只猫叫团子', kind: 'other', weight: 0.6 })
check(
  'db.fact-norm-unique-merge',
  addedFact.added === 1 &&
    addedAgain.added === 0 &&
    addedAgain.merged === 1 &&
    brainMemory().facts('user').filter((fact) => fact.text.includes('团子')).length === 1,
  { added: addedFact.added, again: addedAgain },
)

// 手动删 / 存
check('memory.remove-fact', brainMemory().removeFact(addedFact.fact.id) === true && !brainMemory().facts('user').some((fact) => fact.text.includes('团子')))

// 情绪：累 → user 精力降；谢 → self 好感升
const beforeMood = brainMood().current()
emitTurn(mainCtx, { seq: 7000, user: '今天加班到很晚，好累', assistant: '早点睡' })
await wait(30)
check('mood.user-energy-drop', brainMood().current().user.energy < beforeMood.user.energy, brainMood().current().user)
const affectionBefore = brainMood().current().self.affection
emitTurn(mainCtx, { seq: 8000, user: '谢谢你，真的很厉害', assistant: '不客气' })
await wait(30)
check('mood.self-affection-up', brainMood().current().self.affection > affectionBefore)
check(
  'mood.history-db',
  brainMood().history('user', 10).length >= 3 && typeof brainMood().current().self.status === 'string',
  { history: brainMood().history('user', 10).length },
)
check(
  'persona.both-sides-db',
  Object.keys(brainPersona().traits('user')).length === 4 && Object.keys(brainPersona().traits('self')).length === 4,
  { user: brainPersona().traits('user'), self: brainPersona().traits('self') },
)

// 注入 section
const registered = mainCtx.sections.find((section) => section.name === 'dsh-brain:context')
const sectionText = typeof registered?.text === 'function' ? registered.text() : ''
check('context.section-registered', registered !== undefined && registered.order === 100)
check(
  'context.section-text-content',
  sectionText.includes('【关于你（用户）】') && sectionText.includes('【关于我（这个助手）】') && sectionText.length <= 1800,
  sectionText.slice(0, 100),
)

// 异常 → 空字符串
const brokenCtx = boot({ dir: path.join(ROOT, 'broken') })
brokenCtx.services.set('brainMemory', {
  recentTurns() {
    return []
  },
  factsForPrompt() {
    throw new Error('boom')
  },
  summaries() {
    throw new Error('boom')
  },
  profile() {
    throw new Error('boom')
  },
})
check('context.error-returns-empty', brokenCtx.get('brainContext').sectionText() === '')
brokenCtx.disposeAll()

// 命令（读 DB）
const command = mainCtx.commandDefinitions.find((definition) => definition.name === 'brain')
const run = async (rawInput, sessionId = 'sess-main') =>
  command.handler({ rawInput, agent: { id: sessionId }, attachments: [], signal: new AbortController().signal })
const overviewResult = await run('')
check('command.overview', overviewResult.kind === 'success' && overviewResult.text.includes('记忆'))
const memoryResult = await run('memory')
check(
  'command.memory-reads-db',
  memoryResult.text.includes('用户侧事实') && memoryResult.text.includes('小林'),
  memoryResult.text.split('\n').slice(0, 4),
)
check('command.mood', (await run('mood')).text.includes('情绪层'))
check('command.persona', (await run('persona')).text.includes('人格层'))
check('command.reset-needs-confirm', (await run('reset')).kind === 'error')
const unknown = await run('nope')
check('command.unknown', unknown.kind === 'error' && unknown.text.includes('用法'))
check(
  'command.definition-shape',
  command.name === 'brain' && definitionShapeOk(command),
)
function definitionShapeOk(definition) {
  return typeof definition.description === 'string' && definition.input?.hint.includes('memory')
}

// 不写 JSON（除迁移外）
check(
  'db.no-json-files',
  !['memory.json', 'mood.json', 'persona.json', 'state.json'].some((name) => fs.existsSync(path.join(mainDir, name))),
  fs.readdirSync(mainDir),
)

// =====================================================================
// B2. 待配对用户消息（跨重载恢复）
// =====================================================================
const pendingDir = path.join(ROOT, 'pending')
const pendingCtx = boot({ dir: pendingDir, memory: { factExtractMode: 'off' } })
const pendingSession = { id: 'sess-pending', header: { id: 'sess-pending' } }
pendingCtx.emit('session/event', pendingSession, {
  type: 'user/message',
  seq: 71000,
  time: Date.now(),
  data: { id: 'u-pending', role: 'user', content: [{ type: 'text', text: '这条人类消息还没等到助手回复' }], source: { kind: 'user' } },
})
await wait(20)
check(
  'db.pending-user-persisted',
  pendingCtx.get('brainMemory').getPending('sess-pending')?.text.includes('人类消息') === true &&
    pendingCtx.get('brainMemory').turns().length === 0,
  pendingCtx.get('brainMemory').getPending('sess-pending'),
)
pendingCtx.disposeAll()
await wait(30)
// 插件重载后，下一轮助手回复应把待配对用户消息接上
const pendingCtx2 = boot({ dir: pendingDir, memory: { factExtractMode: 'off' } })
const pendingSession2 = { id: 'sess-pending', header: { id: 'sess-pending' } }
pendingCtx2.emit('session/event', pendingSession2, {
  type: 'assistant/message',
  seq: 71001,
  time: Date.now(),
  data: {
    message: { id: 'a-pending', role: 'assistant', content: [{ type: 'text', text: '现在回复你' }], source: { kind: 'model', provider: 'x', model: 'y' } },
    stream: [],
  },
})
await wait(30)
check(
  'db.pending-survives-reload',
  pendingCtx2.get('brainMemory').turns().length === 1 &&
    pendingCtx2.get('brainMemory').turns()[0].user.includes('人类消息') &&
    pendingCtx2.get('brainMemory').getPending('sess-pending') === undefined,
  pendingCtx2.get('brainMemory').turns().map((turn) => turn.user),
)
const pendingRowCount = pendingCtx2.get('brainMemory').handle().prepare('SELECT COUNT(*) AS c FROM collector_pending').get().c
check('db.pending-cleared-after-pair', Number(pendingRowCount) === 0, pendingRowCount)
pendingCtx2.disposeAll()
await wait(30)

// 跳过原因统计：只有 assistant、没有配对用户时应记录 no-pending-user
const skipCollector = {
  collected: 0,
}
const skipCtx = boot({ dir: path.join(ROOT, 'skip'), disable: ['memory', 'mood', 'persona', 'context'] })
const skipProbe = createCollector({
  ctx: skipCtx,
  config: { collectSubagents: false, excludeSessionIdPattern: 'pet', includeSessions: [], maxTextChars: 100, minTextChars: 2 },
  log: () => {},
  onTurn: () => {
    skipCollector.collected += 1
  },
})
skipProbe.subscribe()
const skipSession = { id: 'sess-skip', header: { id: 'sess-skip' } }
skipCtx.emit('session/event', skipSession, {
  type: 'assistant/message',
  seq: 72000,
  time: Date.now(),
  data: { message: { id: 'a-skip', content: [{ type: 'text', text: '孤立回复' }], source: { kind: 'model', provider: 'x', model: 'y' } }, stream: [] },
})
check(
  'collector.skip-no-pending',
  skipProbe.stats().skippedByReason['no-pending-user'] === 1 && skipCollector.collected === 0,
  skipProbe.stats(),
)
skipProbe.dispose()
skipCtx.disposeAll()
await wait(20)
// =====================================================================
// C. 重开连接持久化
// =====================================================================
const turnsBefore = brainMemory().turns().length
const factsBefore = brainMemory().facts('user').length
const moodBefore = brainMood().current()
const personaBefore = brainPersona().traits('self')
mainCtx.disposeAll()
await wait(30)
check('db.connection-released', openDatabaseCount() === 0, openDatabaseCount())
const reloadCtx = boot({ dir: mainDir })
check(
  'db.reopen-persists',
  reloadCtx.get('brainMemory').turns().length === turnsBefore &&
    reloadCtx.get('brainMemory').facts('user').length === factsBefore &&
    Math.abs(reloadCtx.get('brainMood').current().user.energy - moodBefore.user.energy) < 1e-9 &&
    Math.abs(reloadCtx.get('brainPersona').traits('self').warmth - personaBefore.warmth) < 1e-9,
  { turns: reloadCtx.get('brainMemory').turns().length },
)
reloadCtx.disposeAll()
await wait(30)

// =====================================================================
// D. maxTurns 裁剪
// =====================================================================
const pruneCtx = boot({ dir: path.join(ROOT, 'prune'), memory: { maxTurns: 3, factExtractMode: 'off' } })
let pruneSeq = 20000
pruneSeq = emitTurn(pruneCtx, { seq: pruneSeq, user: '第一轮旧消息', assistant: '回复一' })
pruneSeq = emitTurn(pruneCtx, { seq: pruneSeq, user: '第二轮旧消息', assistant: '回复二' })
pruneSeq = emitTurn(pruneCtx, { seq: pruneSeq, user: '第三轮消息', assistant: '回复三' })
await wait(30)
pruneSeq = emitTurn(pruneCtx, { seq: pruneSeq, user: '第四轮消息', assistant: '回复四' })
pruneSeq = emitTurn(pruneCtx, { seq: pruneSeq, user: '第五轮消息', assistant: '回复五' })
await wait(30)
check(
  'db.max-turns-prune',
  pruneCtx.get('brainMemory').turns().length === 3 &&
    !pruneCtx.get('brainMemory').turns().some((turn) => turn.user.includes('第一轮旧消息')),
  pruneCtx.get('brainMemory').turns().map((turn) => turn.user),
)
pruneCtx.disposeAll()
await wait(30)

// =====================================================================
// E. JSON→DB 迁移（幂等）
// =====================================================================
const migrateDir = path.join(ROOT, 'migrate')
fs.mkdirSync(migrateDir, { recursive: true })
function writeLegacyJson() {
  fs.writeFileSync(
    path.join(migrateDir, 'memory.json'),
    JSON.stringify({
      version: 1,
      summaries: { user: '旧摘要：用户小林在准备季度报告。', self: '旧摘要：我答应提醒用户复盘。' },
      summaryUpdatedAt: { user: '2026-11-20T10:00:00.000Z', self: '2026-11-20T10:00:00.000Z' },
      turns: [
        { id: 'turn-old-1', at: '2026-11-20T10:00:00.000Z', sessionId: 'sess-old', user: '旧问题一', assistant: '旧回复一' },
        { id: 'turn-old-2', at: '2026-11-20T10:01:00.000Z', sessionId: 'sess-old', user: '旧问题二', assistant: '旧回复二' },
      ],
      facts: {
        user: [{ id: 'fact-old-1', side: 'user', text: '用户叫小林', kind: 'profile', weight: 0.9, createdAt: '2026-11-20T10:00:00.000Z', lastSeenAt: '2026-11-20T10:00:00.000Z', hits: 1 }],
        self: [{ id: 'fact-old-2', side: 'self', text: '我答应提醒用户复盘', kind: 'promise', weight: 0.8, createdAt: '2026-11-20T10:00:00.000Z', lastSeenAt: '2026-11-20T10:00:00.000Z', hits: 1 }],
      },
      profile: { userName: '小林' },
      collect: { turnsSinceExtract: 1, turnsSinceSummary: 2 },
      lastSeq: { 'sess-old': 42 },
    }),
    'utf8',
  )
  fs.writeFileSync(
    path.join(migrateDir, 'mood.json'),
    JSON.stringify({
      version: 1,
      user: { valence: 0.7, energy: 0.4, updatedAt: '2026-11-20T10:00:00.000Z' },
      self: { valence: 0.65, energy: 0.5, affection: 0.6, status: '专注', updatedAt: '2026-11-20T10:00:00.000Z' },
      history: {
        user: [{ at: '2026-11-20T10:00:00.000Z', valence: 0.7, energy: 0.4, reason: '旧轨迹' }],
        self: [{ at: '2026-11-20T10:00:00.000Z', valence: 0.65, extent: 0.5, energy: 0.5, affection: 0.6, status: '专注', reason: '旧轨迹' }],
      },
      lastSeq: { 'sess-old': 42 },
    }),
    'utf8',
  )
  fs.writeFileSync(
    path.join(migrateDir, 'persona.json'),
    JSON.stringify({
      version: 1,
      traits: {
        user: { directness: 0.8, pace: 0.7, humor: 0.6, detail: 0.9 },
        self: { warmth: 0.85, directness: 0.7, playfulness: 0.6, proactivity: 0.8 },
      },
      baseline: {
        user: { directness: 0.5, pace: 0.5, humor: 0.4, detail: 0.5 },
        self: { warmth: 0.6, directness: 0.55, playfulness: 0.4, proactivity: 0.5 },
      },
      updatedAt: { user: '2026-11-20T10:00:00.000Z', self: '2026-11-20T10:00:00.000Z' },
      lastSeq: { 'sess-old': 42 },
    }),
    'utf8',
  )
  fs.writeFileSync(path.join(migrateDir, 'state.json'), JSON.stringify({ version: 1, exchanges: 7 }), 'utf8')
}
writeLegacyJson()
const migrateCtx = boot({ dir: migrateDir })
const migrated = migrateCtx.get('brainMemory')
const migratedFacts = migrated.facts('user')
check(
  'migrate.json-to-db',
  migrated.turns().length === 2 &&
    migratedFacts.some((fact) => fact.text === '用户叫小林') &&
    migrated.summaries().user.text.includes('旧摘要') &&
    migrateCtx.get('brainMood').current().self.status === '专注' &&
    Math.abs(migrateCtx.get('brainPersona').traits('user').detail - 0.9) < 1e-9 &&
    migrated.profile().userName === '小林',
  {
    turns: migrated.turns().length,
    facts: migratedFacts.length,
    userDetail: migrateCtx.get('brainPersona').traits('user').detail,
  },
)
const renamed = fs.readdirSync(migrateDir).filter((name) => name.includes('.imported-'))
check('migrate.files-renamed', renamed.length === 4, renamed)
const countsAfterFirst = {
  turns: migrated.turns().length,
  facts: migrated.facts('user').length,
}
migrateCtx.disposeAll()
await wait(30)
// 再放一份同样的 JSON，重新打开：幂等导入（不重复）
writeLegacyJson()
const migrateCtx2 = boot({ dir: migrateDir })
const migrated2 = migrateCtx2.get('brainMemory')
check(
  'migrate.idempotent',
  migrated2.turns().length === countsAfterFirst.turns &&
    migrated2.facts('user').length === countsAfterFirst.facts &&
    migrateCtx2.get('brainMood').current().self.status === '专注',
  { turns: migrated2.turns().length, facts: migrated2.facts('user').length },
)
check('migrate.collector-seq', migrated2.getLastSeq('sess-old') === 42, migrated2.getLastSeq('sess-old'))
migrateCtx2.disposeAll()
await wait(30)

// =====================================================================
// F. 双层隔离 + 降级 + 单层停用
// =====================================================================
const isolateCtx = boot({ dir: path.join(ROOT, 'isolate') })
isolateCtx.get('brainMemory').upsertFact({ side: 'user', text: '用户喜欢喝茶', kind: 'preference' })
isolateCtx.get('brainMemory').upsertFact({ side: 'self', text: '我答应提醒用户喝水', kind: 'promise' })
check(
  'db.side-isolation',
  isolateCtx.get('brainMemory').facts('user').every((fact) => fact.side === 'user') &&
    isolateCtx.get('brainMemory').facts('self').every((fact) => fact.side === 'self'),
)
isolateCtx.disposeAll()
await wait(30)

const partial = boot({ dir: path.join(ROOT, 'partial'), disable: ['mood'] })
let partialSeq = 30000
partialSeq = emitTurn(partial, { seq: partialSeq, user: '只开记忆层也要采集', assistant: '收到' })
await wait(30)
check(
  'degrade.mood-disabled-memory-collects',
  partial.get('brainMemory').turns().length === 1 && partial.get('brainMood') === undefined,
)
check(
  'degrade.context-still-injects',
  partial.get('brainContext').sectionText().includes('【关于你（用户）】'),
)
partial.disposeAll()
await wait(30)

const offCtx = boot({ dir: path.join(ROOT, 'off'), context: { enabled: false } })
check('context.disabled-no-section', offCtx.sections.length === 0 && offCtx.get('brainContext') !== undefined)
offCtx.disposeAll()
await wait(30)

// =====================================================================
// G. LLM 补充 + 摘要 + reset（DB 备份）
// =====================================================================
llmMode = 'ok'
const llmCtx = boot({ dir: path.join(ROOT, 'llm'), memory: { factExtractMode: 'llm', factExtractInterval: 1 } })
emitTurn(llmCtx, { seq: 40000, user: '我最近在学做饭，做得还行。', assistant: '听起来不错' })
await wait(200)
check(
  'facts.llm-supplement',
  llmCtx.get('brainMemory').facts('user').some((fact) => fact.text.includes('咖啡')),
)
llmCtx.disposeAll()
await wait(30)

const summaryCtx = boot({ dir: path.join(ROOT, 'summary'), memory: { summaryThreshold: 2, factExtractMode: 'off' } })
emitTurn(summaryCtx, { seq: 41000, user: '第一轮用户消息', assistant: '第一轮回复' })
emitTurn(summaryCtx, { seq: 41100, user: '第二轮用户消息', assistant: '第二轮回复' })
await wait(250)
const summaries = summaryCtx.get('brainMemory').summaries()
check(
  'memory.dual-summary-db',
  summaries.user.text.includes('季度报告') && summaries.self.text.includes('复盘'),
  summaries,
)
check(
  'memory.summary-row-count',
  summaryCtx.get('brainMemory').handle().prepare('SELECT COUNT(*) AS c FROM memory_summaries').get().c === 2,
)
summaryCtx.disposeAll()
await wait(30)

const resetDir = path.join(ROOT, 'reset')
const resetCtx = boot({ dir: resetDir })
emitTurn(resetCtx, { seq: 42000, user: '我叫小林', assistant: '记住了' })
await wait(30)
const resetCommand = resetCtx.commandDefinitions.find((definition) => definition.name === 'brain')
const resetResult = await resetCommand.handler({
  rawInput: 'reset confirm',
  agent: { id: 'agent-1' },
  attachments: [],
  signal: new AbortController().signal,
})
check(
  'command.reset-confirm-db',
  resetResult.kind === 'success' && resetCtx.get('brainMemory').turns().length === 0,
  resetResult.text.split('\n').slice(0, 2),
)
check(
  'db.reset-backup-file',
  fs.readdirSync(resetDir).some((name) => name.startsWith('brain.db.bak-')),
  fs.readdirSync(resetDir),
)
resetCtx.disposeAll()
await wait(30)

// =====================================================================
// H. 采集器直测
// =====================================================================
const collectorCtx = boot({ dir: path.join(ROOT, 'collector'), disable: ['memory', 'mood', 'persona', 'context'] })
const collected = []
const collector = createCollector({
  ctx: collectorCtx,
  config: { collectSubagents: false, excludeSessionIdPattern: 'pet', includeSessions: [], maxTextChars: 100, minTextChars: 2 },
  log: () => {},
  onTurn: (turn) => collected.push(turn),
})
collector.subscribe()
const session = { id: 'sess-collector', header: { id: 'sess-collector' } }
collectorCtx.emit('session/event', session, {
  type: 'user/message',
  seq: 1,
  time: Date.now(),
  data: { id: 'u1', content: [{ type: 'text', text: '你好，帮我看看这个问题' }], source: { kind: 'user' } },
})
collectorCtx.emit('session/event', session, {
  type: 'assistant/message',
  seq: 2,
  time: Date.now(),
  data: { message: { id: 'a1', content: [{ type: 'text', text: '我先看看' }], source: { kind: 'model', provider: 'x', model: 'y' } }, stream: [] },
})
collectorCtx.emit('session/event', session, {
  type: 'assistant/message',
  seq: 3,
  time: Date.now(),
  data: { message: { id: 'a2', content: [{ type: 'text', text: '没有配对用户的回复' }], source: { kind: 'model', provider: 'x', model: 'y' } }, stream: [] },
})
check(
  'collect.subagent-agent-message-accepted',
  isUserAuthored({ source: { kind: 'agent-message' } }, { collectSubagents: false }) === false &&
    isUserAuthored({ source: { kind: 'agent-message' } }, { collectSubagents: true }) === true &&
    isUserAuthored({ source: { kind: 'user' } }, {}) === true,
)
check('collector.direct-events', collected.length === 1 && collected[0].user.includes('看看这个问题'))
collector.dispose()
collectorCtx.disposeAll()
await wait(30)

// =====================================================================
// I. 后台消化（无损）+ 工作记忆召回（原文可精确取回）
// =====================================================================

// I1. 纯函数：情节摘要 / 重要度 / 检索项 / LLM JSON 解析
const sampleTurns = [
  { id: 't-a', user: '我叫小林，我最近在准备季度报告，有点紧张', assistant: '我帮你把报告拆成大纲', at: '2026-11-20T10:00:00.000Z' },
  { id: 't-b', user: '报告明天要交，我有点焦虑', assistant: '今晚先把结论写出来', at: '2026-11-20T10:05:00.000Z' },
]
const builtEpisode = buildEpisode(sampleTurns)
check(
  'episode.rule-summary',
  builtEpisode.summary.includes('用户和助手聊到') &&
    builtEpisode.summary.includes('报告') &&
    builtEpisode.summary.length <= 160,
  builtEpisode.summary,
)
check('episode.salience-high', builtEpisode.salience >= 0.7, builtEpisode.salience)
check(
  'episode.terms-keywords',
  builtEpisode.terms.split(' ').some((term) => '季度报告'.includes(term) || '报告'.includes(term)),
  builtEpisode.terms.split(' ').slice(0, 8),
)
check(
  'episode.salience-neutral-low',
  scoreSalience([{ user: '嗯嗯好的', assistant: '好' }], extractTerms('嗯嗯好的')) < 0.5,
)
check(
  'episode.parse-llm-json',
  parseConsolidation('{"episode":{"summary":"用户和助手聊到插件","salience":0.6,"terms":["插件"]}}')?.episode.summary ===
    '用户和助手聊到插件' && parseConsolidation('not json') === undefined,
)

// I2. 攒够 N 轮自动消化：事实 + 情节 + 摘要 + consolidated 标记
const consDir = path.join(ROOT, 'consolidate')
const consCtx = boot({
  dir: consDir,
  context: { consolidateEveryTurns: 2, idleConsolidateMs: 0 },
  memory: { factExtractMode: 'off', summaryEnabled: false },
})
let consSeq = 50000
consSeq = emitTurn(consCtx, {
  seq: consSeq,
  sessionId: 'sess-cons',
  user: '我叫小林，我在做旁路插件，最近有点累',
  assistant: '我记下了，先歇会儿',
})
consSeq = emitTurn(consCtx, {
  seq: consSeq,
  sessionId: 'sess-cons',
  user: '旁路插件就是那个记忆层，我们最早聊过的',
  assistant: '对，就是那个记忆层',
})
emitTurnEnd(consCtx, { seq: consSeq + 10, sessionId: 'sess-cons' })
emitTurnEnd(consCtx, { seq: consSeq + 12, sessionId: 'sess-cons' })
await wait(180)
const consMemory = consCtx.get('brainMemory')
const consCounts = consMemory.counts()
check(
  'consolidate.turn-threshold',
  consMemory.episodes().length === 1 && consCounts.consolidated === 2 && consCounts.unconsolidated === 0,
  { episodes: consMemory.episodes().length, ...consCounts },
)
check(
  'consolidate.facts-produced',
  consMemory.facts('user').some((fact) => fact.kind === 'profile' && fact.text.includes('小林')),
  consMemory.facts('user').map((fact) => fact.text),
)
check(
  'consolidate.summary-appended',
  consMemory.summaries().user.text.includes('旁路') || consMemory.summaries().user.text.includes('小林'),
  consMemory.summaries().user.text,
)
check(
  'consolidate.episode-index',
  consMemory.episodes()[0].turnIds.length === 2 && consMemory.episodes()[0].salience >= 0.5,
  consMemory.episodes()[0],
)
check(
  'consolidate.no-compaction-table',
  consMemory.handle().prepare("SELECT name FROM sqlite_master WHERE name LIKE '%compaction%'").all().length === 0,
)

// I3. 原文无损：按 id / 区间 / 关键词取回
const consTurns = consMemory.turns()
const firstTurn = consTurns[0]
const fetchBack = consMemory.fetchTurn(firstTurn.id)
const seqs = consTurns.map((turn) => turn.seq).filter((value) => Number.isFinite(value))
const rangeTurns = consMemory.fetchRange('sess-cons', Math.min(...seqs), Math.max(...seqs))
const searchHits = consMemory.searchTurns('旁路插件', { limit: 5 })
check('memory.fetch-turn', fetchBack?.user === firstTurn.user && fetchBack?.assistant === firstTurn.assistant)
check('memory.fetch-range', rangeTurns.length === consTurns.length && rangeTurns[0].seq <= rangeTurns[rangeTurns.length - 1].seq)
check(
  'memory.search-turns',
  searchHits.length >= 1 && searchHits[0].score > 0 && searchHits[0].user.includes('旁路'),
  searchHits.map((turn) => turn.user),
)

// I4. 注入：工作记忆段落 + 原文片段 + 来源元数据
const consRecall = consCtx.get('brainContext').assemble({ sessionId: 'sess-cons', userText: '我们最早聊的旁路插件是什么' })
check(
  'recall.episode-injected',
  consRecall.text.includes('【工作记忆 · 相关回忆】') &&
    (consRecall.text.includes('旁路') || consRecall.text.includes('记忆层')),
  consRecall.text.split('\n').slice(0, 6),
)
check(
  'recall.sources-metadata',
  consRecall.stats.workingMemory.sources.length >= 1 &&
    consRecall.stats.workingMemory.sources.every((source) => typeof source.id === 'string'),
  consRecall.stats.workingMemory.sources,
)

// I5. 空闲触发 + 新 turn 取消重排
const idleCtx = boot({
  dir: path.join(ROOT, 'idle'),
  context: { consolidateEveryTurns: 99, idleConsolidateMs: 50 },
  memory: { factExtractMode: 'off', summaryEnabled: false },
})
let idleSeq = 60000
idleSeq = emitTurn(idleCtx, { seq: idleSeq, sessionId: 'sess-idle', user: '空闲时也要整理一下这段对话', assistant: '好的' })
emitTurnEnd(idleCtx, { seq: idleSeq + 10, sessionId: 'sess-idle' })
await wait(220)
check('consolidate.idle-trigger', idleCtx.get('brainMemory').episodes().length === 1)

const cancelCtx = boot({
  dir: path.join(ROOT, 'cancel'),
  context: { consolidateEveryTurns: 99, idleConsolidateMs: 80 },
  memory: { factExtractMode: 'off', summaryEnabled: false },
})
let cancelSeq = 61000
cancelSeq = emitTurn(cancelCtx, { seq: cancelSeq, sessionId: 'sess-cancel', user: '第一轮', assistant: '收到' })
emitTurnEnd(cancelCtx, { seq: cancelSeq + 10, sessionId: 'sess-cancel' })
await wait(20)
cancelSeq = emitTurn(cancelCtx, { seq: cancelSeq, sessionId: 'sess-cancel', user: '第二轮又开始了，取消空闲整理', assistant: '好的' })
await wait(160)
const cancelledBefore = cancelCtx.get('brainMemory').episodes().length
emitTurnEnd(cancelCtx, { seq: cancelSeq + 10, sessionId: 'sess-cancel' })
await wait(240)
check(
  'consolidate.idle-cancelled-by-new-turn',
  cancelledBefore === 0 && cancelCtx.get('brainMemory').episodes().length === 1,
  { before: cancelledBefore, after: cancelCtx.get('brainMemory').episodes().length },
)

// I6. 同会话互斥 + LLM 模式
llmMode = 'ok'
llmDelayMs = 80
const busyCtx = boot({
  dir: path.join(ROOT, 'busy'),
  context: { consolidateMode: 'llm', consolidateEveryTurns: 99, idleConsolidateMs: 0 },
  memory: { factExtractMode: 'off', summaryEnabled: false },
})
let busySeq = 62000
busySeq = emitTurn(busyCtx, { seq: busySeq, sessionId: 'sess-busy', user: '旁路插件和记忆层是一回事吗', assistant: '是的' })
await wait(20)
const busyFirst = busyCtx.get('brainContext').consolidateNow('sess-busy')
const busySecond = busyCtx.get('brainContext').consolidateNow('sess-busy')
const busySecondResult = await busySecond
const busyFirstResult = await busyFirst
llmDelayMs = 0
check(
  'consolidate.mutex',
  busyFirstResult.ok === true && busySecondResult.ok === false && busySecondResult.reason === 'busy',
  { first: busyFirstResult, second: busySecondResult },
)
check(
  'consolidate.llm-episode',
  busyCtx.get('brainMemory').episodes()[0]?.summary.includes('旁路插件与记忆层'),
  busyCtx.get('brainMemory').episodes()[0]?.summary,
)

// I7. LLM 失败回退规则；硬失败静默且不标记
llmMode = 'fail'
const fallbackCtx = boot({
  dir: path.join(ROOT, 'fallback'),
  context: { consolidateMode: 'llm', consolidateEveryTurns: 99, idleConsolidateMs: 0 },
  memory: { factExtractMode: 'off', summaryEnabled: false },
})
let fallbackSeq = 63000
emitTurn(fallbackCtx, { seq: fallbackSeq, sessionId: 'sess-fallback', user: '我叫小林，在整理插件', assistant: '好的' })
await wait(20)
const fallbackResult = await fallbackCtx.get('brainContext').consolidateNow('sess-fallback')
check(
  'consolidate.llm-fail-fallback',
  fallbackResult.ok === true && fallbackCtx.get('brainMemory').episodes().length === 1,
  fallbackResult,
)
llmMode = 'ok'

const hardCtx = boot({
  dir: path.join(ROOT, 'hard-fail'),
  context: { consolidateEveryTurns: 99, idleConsolidateMs: 0 },
  memory: { factExtractMode: 'off', summaryEnabled: false },
})
let hardSeq = 64000
emitTurn(hardCtx, { seq: hardSeq, sessionId: 'sess-hard', user: '这条消化会失败', assistant: '知道了' })
await wait(20)
const hardMemory = hardCtx.get('brainMemory')
const originalApplyFacts = hardMemory.applyFacts
hardMemory.applyFacts = () => {
  throw new Error('boom')
}
const hardResult = await hardCtx.get('brainContext').consolidateNow('sess-hard')
hardMemory.applyFacts = originalApplyFacts
check(
  'consolidate.failure-silent',
  hardResult.ok === false && hardResult.reason === 'error' && hardCtx.get('brainMemory').counts().unconsolidated === 1,
  hardResult,
)

// I8. 不写任何会话事件（只在后台读） + /brain 观测
consSeq = emitTurn(consCtx, { seq: consSeq, sessionId: 'sess-cons', user: '再补一句：插件叫深月', assistant: '收到' })
let pluginEmits = 0
const originalConsEmit = consCtx.emit.bind(consCtx)
consCtx.emit = (...args) => {
  pluginEmits += 1
  return originalConsEmit(...args)
}
const manualResult = await consCtx.get('brainContext').consolidateNow('sess-cons')
check(
  'consolidate.no-session-writes',
  manualResult.ok === true && pluginEmits === 0,
  { ok: manualResult.ok, emitted: pluginEmits },
)
const consCommand = consCtx.commandDefinitions.find((definition) => definition.name === 'brain')
const runCons = async (rawInput, sessionId = 'sess-cons') =>
  consCommand.handler({ rawInput, agent: { id: sessionId }, attachments: [], signal: new AbortController().signal })
const consOverview = await runCons('')
check(
  'command.overview-long-memory',
  consOverview.text.includes('长期记忆：') && consOverview.text.includes('工作记忆注入'),
  consOverview.text.split('\n').slice(0, 5),
)
const consMemoryView = await runCons('memory')
check(
  'command.memory-episodes',
  consMemoryView.text.includes('长期记忆：') && consMemoryView.text.includes('情节记忆'),
  consMemoryView.text.split('\n').slice(0, 8),
)
const consSearchView = await runCons('memory 旁路插件')
check(
  'command.memory-search-original',
  consSearchView.text.includes('原文检索') && consSearchView.text.includes('旁路'),
  consSearchView.text.split('\n').slice(0, 3),
)
consSeq = emitTurn(consCtx, { seq: consSeq, sessionId: 'sess-cons-2', user: '这个会话还没有整理过', assistant: '好的' })
const consManual = await runCons('consolidate', 'sess-cons-2')
check(
  'command.consolidate',
  consManual.kind === 'success' && consManual.text.includes('后台整理完成'),
  consManual.text,
)
const consSnapshot = consCtx.get('brainContext').snapshot()
check(
  'context.snapshot-organization',
  typeof consSnapshot.consolidated === 'number' &&
    typeof consSnapshot.episodes === 'number' &&
    Array.isArray(consSnapshot.workingMemory?.ids) &&
    typeof consSnapshot.organization?.runs === 'number',
  { consolidated: consSnapshot.consolidated, episodes: consSnapshot.episodes, workingMemory: consSnapshot.workingMemory },
)

// I9. 冷启动持久化
const episodeCountBeforeReload = consCtx.get('brainMemory').episodes().length
consCtx.disposeAll()
await wait(40)
const consReloadCtx = boot({
  dir: consDir,
  context: { consolidateEveryTurns: 99, idleConsolidateMs: 0 },
  memory: { factExtractMode: 'off', summaryEnabled: false },
})
check(
  'consolidate.persist-reload',
  consReloadCtx.get('brainMemory').episodes().length === episodeCountBeforeReload &&
    consReloadCtx.get('brainMemory').counts().consolidated > 0,
  {
    episodes: consReloadCtx.get('brainMemory').episodes().length,
    consolidated: consReloadCtx.get('brainMemory').counts().consolidated,
  },
)
consReloadCtx.disposeAll()
await wait(30)

// I10. 召回冷却 / 预算裁剪 / 好感度加权 / 原文片段标注（纯函数 + 假记忆层）
const makeMemoryStub = (overrides = {}) => ({
  factsForPrompt: () => [],
  summaries: () => ({ user: { text: '' }, self: { text: '' } }),
  profile: () => ({ userName: null }),
  recallEpisodes: () => [],
  recall: () => [],
  ...overrides,
})
const recallConfig = { maxChars: 1800, workingMemoryMaxChars: 1200, recallLimit: 3, turnRecallLimit: 2, recallCooldownTurns: 3, factLimit: 6 }
const oldTurn = {
  id: 'turn-old-1',
  user: '我们之前聊过旁路插件，它其实是记忆层',
  assistant: '对',
  at: '2026-11-19T10:00:00.000Z',
  sessionId: 'sess-old',
  seq: 10,
}
const turnStub = makeMemoryStub({ recall: () => [oldTurn] })
const cooldownState = { round: 0, seen: new Map() }
const recall1 = buildContextText({ config: recallConfig, memory: turnStub, userText: '旁路插件', recallState: cooldownState })
const recall2 = buildContextText({ config: recallConfig, memory: turnStub, userText: '旁路插件', recallState: cooldownState })
const recall3 = buildContextText({ config: recallConfig, memory: turnStub, userText: '旁路插件', recallState: cooldownState })
const recall4 = buildContextText({ config: recallConfig, memory: turnStub, userText: '旁路插件', recallState: cooldownState })
check(
  'recall.cooldown-window',
  recall1.stats.workingMemory.count === 1 &&
    recall2.stats.workingMemory.count === 0 &&
    recall3.stats.workingMemory.count === 0 &&
    recall4.stats.workingMemory.count === 1,
  [recall1, recall2, recall3, recall4].map((item) => item.stats.workingMemory.count),
)
check(
  'recall.original-fragment-labelled',
  /你以前说过（11-19 \d{2}:\d{2}，seq 10）："我们之前聊过旁路插件/u.test(recall1.text) &&
    recall1.stats.workingMemory.sources[0]?.id === 'turn-old-1' &&
    recall1.stats.workingMemory.sources[0]?.seq === 10,
  recall1.stats.workingMemory.sources,
)

const longEpisodes = Array.from({ length: 6 }, (_, index) => ({
  id: `ep-${index}`,
  summary: '你们聊到旁路插件与记忆层的具体细节'.repeat(6),
  terms: extractTerms('旁路插件 记忆层').join(' '),
  salience: 0.9,
  score: 1 - index * 0.01,
  at: new Date().toISOString(),
  turnIds: [],
}))
const budgetResult = buildContextText({
  config: { ...recallConfig, workingMemoryMaxChars: 300 },
  memory: makeMemoryStub({ recallEpisodes: () => longEpisodes }),
  userText: '旁路插件',
  recallState: { round: 0, seen: new Map() },
})
check(
  'recall.budget-capped',
  budgetResult.text.length <= 1800 &&
    budgetResult.stats.workingMemory.chars <= 360 &&
    budgetResult.stats.workingMemory.count >= 1,
  { chars: budgetResult.text.length, workChars: budgetResult.stats.workingMemory.chars },
)

const priorityResult = buildContextText({
  config: { ...recallConfig, maxChars: 260 },
  memory: makeMemoryStub({
    factsForPrompt: () => [{ text: '用户叫小林', kind: 'profile', weight: 0.9 }],
    recallEpisodes: () => longEpisodes,
  }),
  userText: '旁路插件',
  recallState: { round: 0, seen: new Map() },
})
check(
  'recall.priority-facts-first',
  priorityResult.text.includes('小林') && priorityResult.text.length <= 260,
  { text: priorityResult.text, stats: priorityResult.stats.workingMemory },
)

const relationEpisode = {
  id: 'ep-relation',
  summary: '你答应过陪主人一起整理记忆',
  terms: extractTerms('答应 陪 整理记忆').join(' '),
  salience: 0.8,
  score: 0.8,
  at: new Date().toISOString(),
  turnIds: [],
}
const neutralEpisode = {
  id: 'ep-neutral',
  summary: '你们聊到天气和咖啡',
  terms: extractTerms('天气 咖啡').join(' '),
  salience: 0.8,
  score: 0.8,
  at: new Date().toISOString(),
  turnIds: [],
}
const moodHighAffection = {
  current: () => ({ user: { valence: 0.6, energy: 0.6 }, self: { valence: 0.7, energy: 0.6, affection: 0.9, status: '专注' } }),
}
const affectionResult = buildContextText({
  config: recallConfig,
  memory: makeMemoryStub({ recallEpisodes: () => [neutralEpisode, relationEpisode] }),
  mood: moodHighAffection,
  persona: { traits: () => ({ directness: 0.5, detail: 0.5 }), render: () => ({ lines: { user: [], self: [] } }) },
  userText: '答应 陪 整理记忆 天气 咖啡',
  recallState: { round: 0, seen: new Map() },
})
check(
  'recall.affection-boost-relation',
  affectionResult.stats.workingMemory.sources[0]?.id === 'ep-relation',
  affectionResult.stats.workingMemory.sources.map((source) => source.id),
)

// I11. 单层停用不崩：没有记忆层时注入仍可用、整理给出中文原因
const noMemCtx = boot({ dir: path.join(ROOT, 'no-memory'), disable: ['memory'] })
const noMemText = noMemCtx.get('brainContext').sectionText()
const noMemConsolidate = await noMemCtx.get('brainContext').consolidateNow('sess-x')
check(
  'degrade.no-memory-safe',
  typeof noMemText === 'string' && noMemConsolidate.ok === false && noMemConsolidate.reason === 'memory-unavailable',
  noMemConsolidate,
)
noMemCtx.disposeAll()
await wait(20)

// =====================================================================
// =====================================================================
// K. 归档（surface 替换）与话题召回
// =====================================================================

/** 极简假 Session：只实现归档器用到的 surface / eventAt / append(replace)。 */
function createFakeSession(id, start = 0) {
  const events = []
  const nodes = []
  let counter = start
  let replaceGeneration = 0
  let failAppend = false
  const session = {
    id,
    header: { id },
    failAppend(value) {
      failAppend = value
    },
    get surface() {
      return { nodes: [...nodes], replaceGeneration, contentGeneration: replaceGeneration }
    },
    eventAt(seq) {
      return events.find((event) => event.seq === seq)
    },
    append(type, data, opts) {
      if (failAppend) throw new Error('append disabled')
      counter += 1
      const event = { type, seq: counter, time: Date.now(), data, ...(opts ?? {}) }
      events.push(event)
      if (opts?.surfaceOp !== undefined && typeof opts.surfaceOp === 'object') {
        const { startSeq, endSeq } = opts.surfaceOp
        const startIdx = nodes.indexOf(startSeq)
        const endIdx = nodes.indexOf(endSeq)
        if (startIdx < 0 || endIdx < 0) throw new Error('bad replace range')
        nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
        replaceGeneration += 1
      } else {
        nodes.push(event.seq)
      }
      return event
    },
    events,
    get nodes() {
      return nodes
    },
  }
  return session
}

/** 往假 Session 里塞一轮（可带 tool-call/result）。 */
function pushTurn(session, { user, assistant, turn, tool = false }) {
  session.append('user/message', { role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'user' } })
  const content = [{ type: 'text', text: assistant }]
  if (tool) content.push({ type: 'tool-call', id: `call-${turn}`, name: 'read', arguments: '{}' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: { role: 'assistant', content, source: { kind: 'model', provider: 'x', model: 'y' } },
    stream: [],
  })
  if (tool) {
    session.append('tool/result', {
      turn,
      step: 1,
      message: {
        role: 'tool',
        content: [{ type: 'text', text: 'ok' }],
        source: { kind: 'tool', callId: `call-${turn}` },
        toolCallId: `call-${turn}`,
      },
    })
  }
}

const archiveDir = path.join(ROOT, 'archive')
const archiveCtx = boot({
  dir: archiveDir,
  disable: ['mood', 'persona'],
  context: {
    archiveEnabled: true,
    archiveDryRun: true,
    archiveSessionIds: ['sess-archive'],
    keepRecentTurns: 2,
    archiveMaxTurnsPerBatch: 8,
    archiveAtPercent: 0.5,
    archiveMarker: 'oneline',
  },
  memory: { maxTextChars: 20000, factExtractMode: 'off', summaryEnabled: false },
})
archiveCtx.services.set('tokenMeter', {
  contextPressure: () => ({ pressureTokens: 600000, contextWindow: 1000000 }),
  measure: (session) => ({
    nodes: session.surface.nodes.map((seq) => ({ seq, tokens: 10, heuristicTokens: 10 })),
  }),
  estimateMessage: () => 5,
})
const archiveMemory = archiveCtx.get('brainMemory')
const archiver = createArchiver({ ctx: archiveCtx, config: archiveCtx.get('brainContext').config, log: () => {} })
const archiveSession = createFakeSession('sess-archive')
archiveSession.append('system/message', {
  turn: 0,
  step: 0,
  message: { role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'system-prompt' } },
})
for (let turn = 1; turn <= 5; turn += 1) {
  pushTurn(archiveSession, { user: `第 ${turn} 轮用户原文`, assistant: `第 ${turn} 轮助手原文`, turn, tool: turn === 2 })
}

const rangePlan = selectArchiveRange(archiveSession, { keepRecentTurns: 2, maxTurns: 8 })
check(
  'archive.range-keeps-recent',
  rangePlan !== null && rangePlan.groups.length === 2 && rangePlan.groups[0].user.includes('第 1 轮'),
  rangePlan?.groups.map((group) => group.user),
)
check(
  'archive.pairing-balance',
  computeSurfaceBalance(archiveSession).after.filter(Boolean).length > 0 &&
    archiveSession.eventAt(rangePlan.end)?.type === 'tool/result',
  rangePlan?.end,
)

const dryResult = await archiver.archiveNow(archiveSession)
check(
  'archive.dry-run-no-append',
  dryResult.ok === true &&
    dryResult.dryRun === true &&
    archiveSession.events.filter((event) => event.surfaceOp !== undefined).length === 0 &&
    archiveSession.nodes.length === 12,
  dryResult,
)
check(
  'archive.token-measure',
  dryResult.shadowedTokens > 0 &&
    dryResult.estimatedAfter < dryResult.estimatedBefore &&
    dryResult.estimatedBefore === 120,
  {
    shadowedTokens: dryResult.shadowedTokens,
    estimatedBefore: dryResult.estimatedBefore,
    estimatedAfter: dryResult.estimatedAfter,
  },
)
check(
  'archive.session-id-prefix-match',
  archiveSessionIdMatches(['session-abc'], 'abc') === true &&
    archiveSessionIdMatches(['abc'], 'session-abc') === true &&
    archiveSessionIdMatches(['session-abc'], 'session-other') === false,
)
check(
  'archive.persist-before-move',
  archiveMemory.turns().length === 2 &&
    archiveMemory.turns().every((turn) => turn.user.includes('轮用户原文')) &&
    archiveMemory.counts().archived === 0,
  archiveMemory.turns().map((turn) => turn.user),
)

const realResult = await archiver.archiveNow(archiveSession, { dryRun: false })
const markerEvent = archiveSession.events.find((event) => event.surfaceOp?.op === 'replace')
check(
  'archive.surface-replaced',
  realResult.ok === true &&
    realResult.dryRun === false &&
    archiveSession.nodes.length === 8 &&
    markerEvent?.data?.content?.[0]?.text.includes('已归档到记忆库：2 轮'),
  { nodes: archiveSession.nodes.length, marker: markerEvent?.data?.content?.[0]?.text },
)
check(
  'archive.marker-source',
  markerEvent?.data?.source?.kind === 'brain-archive' && markerEvent?.data?.source?.turnCount === 2,
  markerEvent?.data?.source,
)
check(
  'archive.marked-and-recorded',
  archiveMemory.counts().archived === 2 &&
    archiveMemory.counts().archives === 1 &&
    archiveMemory.archives(1)[0].turnCount === 2,
  { counts: archiveMemory.counts(), archives: archiveMemory.archives(1) },
)
check(
  'archive.still-usable',
  (() => {
    pushTurn(archiveSession, { user: '归档后继续聊', assistant: '可以继续', turn: 6 })
    return archiveSession.nodes.length === 10
  })(),
)
check(
  'archive.marker-compact',
  archiveMarkerText({ turnCount: 3, firstAt: '2026-11-21T10:00:00Z', lastAt: '2026-11-21T11:00:00Z', style: 'compact' }) ===
    '[已归档 3 轮 · 可检索]',
)

// 失败静默：append 抛错只返回失败，不影响会话
const failSession = createFakeSession('sess-archive', 1000)
failSession.append('system/message', {
  turn: 0,
  step: 0,
  message: { role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'system-prompt' } },
})
for (let turn = 1; turn <= 4; turn += 1) pushTurn(failSession, { user: `失败会话第 ${turn} 轮`, assistant: `回复 ${turn}`, turn })
failSession.failAppend(true)
const failResult = await archiver.archiveNow(failSession, { dryRun: false })
check(
  'archive.append-failure-silent',
  failResult.ok === false && failResult.reason === 'append-failed' && failSession.nodes.length === 9,
  failResult,
)

// 话题召回：归档段与当前话题无关时不注入；用户点名该话题时召回
archiveMemory.rememberTurn({
  user: 'APK 打包又失败了，继续调编译参数',
  assistant: '好，先看 ABI',
  sessionId: 'sess-topic',
  seq: 9001,
  at: new Date().toISOString(),
  turn: 1,
})
archiveMemory.rememberTurn({
  user: '记忆插件继续做召回',
  assistant: '收到',
  sessionId: 'sess-topic',
  seq: 9002,
  at: new Date().toISOString(),
  turn: 2,
})
const archivedApk = archiveMemory.findTurnBySeq('sess-topic', 9001)
const archivedMemoryTurn = archiveMemory.findTurnBySeq('sess-topic', 9002)
archiveMemory.markArchived([archivedApk.id], 'arc-topic-test')
const stayingRecall = archiveMemory.recallOriginals('继续', { limit: 5, recentTexts: '记忆插件 召回' })
const switchingRecall = archiveMemory.recallOriginals('APK 打包', { limit: 5, recentTexts: '记忆插件 召回' })
check(
  'recall.topic-gate-skips-unrelated-archive',
  stayingRecall.every((turn) => turn.id !== archivedApk.id) && stayingRecall.some((turn) => turn.id === archivedMemoryTurn.id),
  stayingRecall.map((turn) => turn.user),
)
check(
  'recall.topic-switch-recalls-archive',
  switchingRecall.some((turn) => turn.id === archivedApk.id && turn.archived === 1 && turn.score > 0),
  switchingRecall.map((turn) => ({ user: turn.user, score: turn.score })),
)

// /brain recall 调试视图
const archiveCommand = archiveCtx.commandDefinitions.find((definition) => definition.name === 'brain')
const recallView = await archiveCommand.handler({
  rawInput: 'recall 打包',
  agent: { id: 'sess-topic' },
  attachments: [],
  signal: new AbortController().signal,
})
check(
  'command.recall-scores',
  recallView.kind === 'success' && recallView.text.includes('召回调试') && recallView.text.includes('score'),
  recallView.text.split('\n').slice(0, 3),
)

archiveCtx.disposeAll()
await wait(40)

// =====================================================================
// K. v2.1.0：角色隔离 + 系统事件隔离 + 召回自学习
// =====================================================================

// K1. 角色 / 文本判定（纯函数）
check(
  'roles.classify-message-source',
  classifyMessage({ role: 'system', source: { kind: 'system' } }) === 'system' &&
    classifyMessage({ role: 'developer' }) === 'system' &&
    classifyMessage({ role: 'user', source: { kind: 'runtime-context' } }) === 'system' &&
    classifyMessage({ role: 'user', source: { kind: 'user' } }) === 'user' &&
    classifyMessage({ role: 'assistant', source: { kind: 'model' } }) === 'assistant' &&
    classifyMessage({ role: 'user', source: { kind: 'agent-message' } }, { collectSubagents: false }) === 'system' &&
    classifyMessage({ role: 'user', source: { kind: 'agent-message' } }, { collectSubagents: true }) === 'user',
)
check(
  'roles.system-text-patterns',
  looksSystemText('Time sampled while preparing turn 1, step 1') &&
    looksSystemText('Browser time zone for this request: unavailable') &&
    looksSystemText('Elapsed since the preceding model-visible message: unavailable') &&
    looksSystemText('Agent lead sent a message: hi') &&
    looksSystemText('Background subagent x finished and will do no further work') &&
    looksSystemText('[已归档到记忆库：2 轮 · 11-21 20:00]') &&
    looksSystemText('<system-reminder>...') &&
    !looksSystemText('我今天想喝咖啡') &&
    !looksSystemText('你忘了上次说的插件吗'),
)
check(
  'roles.classify-text-origin',
  classifyTextOrigin('Time sampled while preparing turn 1') === 'system' &&
    classifyTextOrigin('我们聊到旁路插件和记忆层') === 'user',
)

// K2. schema 5：新表 + 特征权重初始行
const learnDir = path.join(ROOT, 'learning')
const learnCtx = boot({ dir: learnDir })
const learnMemory = learnCtx.get('brainMemory')
const learnHandle = learnMemory.handle()
const v21Tables = learnHandle
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
  .all()
  .map((row) => row.name)
const seedFeatures = learnHandle.prepare('SELECT feature, weight FROM recall_feature_weights').all()
check(
  'db.schema5-recall-tables',
  ['memory_events', 'recall_item_stats', 'recall_term_weights', 'recall_misses', 'recall_feature_weights'].every((name) =>
    v21Tables.includes(name),
  ),
  v21Tables.filter((name) => name.startsWith('recall')),
)
check(
  'db.recall-feature-seeded',
  seedFeatures.length === 5 && seedFeatures.every((row) => Number(row.weight) === 1),
  seedFeatures,
)

// K3. 历史 origin 清洗（幂等；system 行迁到 memory_events 且不再参与召回）
const originMigrateDir = path.join(ROOT, 'origin-migrate')
const originCtx1 = boot({ dir: originMigrateDir, disable: ['mood', 'persona', 'context'] })
const originSeed = originCtx1.get('brainMemory').handle()
originSeed
  .prepare(
    'INSERT INTO memory_turns(id, session_id, seq, at, user_text, assistant_text, origin) VALUES(?, ?, ?, ?, ?, ?, NULL)',
  )
  .run(
    'turn-sys-1',
    'sess-mig',
    1,
    '2026-11-20T10:00:00.000Z',
    'Time sampled while preparing turn 1, step 1: 2026-11-20T10:00:00+08:00',
    'OK',
  )
originSeed
  .prepare(
    'INSERT INTO memory_turns(id, session_id, seq, at, user_text, assistant_text, origin) VALUES(?, ?, ?, ?, ?, ?, NULL)',
  )
  .run('turn-human-1', 'sess-mig', 2, '2026-11-20T10:01:00.000Z', '我们上次聊到旁路插件监听 8720 端口', '对')
originSeed.prepare("UPDATE meta SET value = '4' WHERE key = 'schema_version'").run()
check(
  'db.origin-column-exists',
  originSeed.prepare('PRAGMA table_info(memory_turns)').all().some((row) => row.name === 'origin'),
)
originCtx1.disposeAll()
await wait(30)
const originCtx2 = boot({ dir: originMigrateDir, disable: ['mood', 'persona', 'context'] })
const originMemory = originCtx2.get('brainMemory')
const originTurns = originMemory.turns()
const originEvents = originMemory.events(10)
check(
  'migrate.origin-classified',
  originTurns.find((turn) => turn.id === 'turn-sys-1')?.origin === 'system' &&
    originTurns.find((turn) => turn.id === 'turn-human-1')?.origin === 'user',
  originTurns.map((turn) => [turn.id, turn.origin]),
)
check(
  'migrate.system-moved-to-events',
  originEvents.length === 1 &&
    originEvents[0].kind === 'system' &&
    originEvents[0].text.includes('Time sampled') &&
    originEvents[0].meta?.salience === 0.05,
  originEvents.map((event) => event.kind),
)
check(
  'migrate.system-never-recalled',
  originMemory
    .recallOriginals('Time sampled while preparing', { limit: 5, topicShiftEnabled: false })
    .every((turn) => turn.id !== 'turn-sys-1'),
)
originCtx2.disposeAll()
await wait(30)
const originCtx3 = boot({ dir: originMigrateDir, disable: ['mood', 'persona', 'context'] })
check(
  'migrate.origin-idempotent',
  originCtx3.get('brainMemory').counts().events === 1 && originCtx3.get('brainMemory').counts().systemTurns === 1,
)
originCtx3.disposeAll()
await wait(30)

// K4. 采集角色隔离：默认 system 不进 user 侧；includeSystemEvents 时才落 memory_events
const systemDir = path.join(ROOT, 'system-events')
const systemCtx = boot({ dir: systemDir, disable: ['mood', 'persona', 'context'] })
const systemMemory = systemCtx.get('brainMemory')
const systemSession = { id: 'sess-sys', header: { id: 'sess-sys' } }
systemCtx.emit('session/event', systemSession, {
  type: 'user/message',
  seq: 1,
  time: Date.now(),
  data: {
    role: 'system',
    content: [{ type: 'text', text: '<system-reminder>injected runtime context' }],
    source: { kind: 'runtime-context' },
  },
})
systemCtx.emit('session/event', systemSession, {
  type: 'assistant/message',
  seq: 2,
  time: Date.now(),
  data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的' }], source: { kind: 'model' } } },
})
check('collect.system-not-user-side', systemMemory.turns().length === 0 && systemMemory.events(5).length === 0)
systemCtx.disposeAll()
await wait(20)
const systemCtx2 = boot({
  dir: systemDir,
  disable: ['mood', 'persona', 'context'],
  memory: { includeSystemEvents: true },
})
const systemMemory2 = systemCtx2.get('brainMemory')
const systemSession2 = { id: 'sess-sys-2', header: { id: 'sess-sys-2' } }
systemCtx2.emit('session/event', systemSession2, {
  type: 'user/message',
  seq: 10,
  time: Date.now(),
  data: {
    role: 'system',
    content: [{ type: 'text', text: 'Browser time zone for this request: unavailable' }],
    source: { kind: 'runtime-context' },
  },
})
check(
  'collect.system-events-isolated',
  systemMemory2.turns().length === 0 &&
    systemMemory2.events(5).length === 1 &&
    systemMemory2.events(5)[0].kind === 'system' &&
    systemMemory2.events(5)[0].meta?.salience === 0.05,
)

// K5. 学习纯函数
const attrItemA = {
  id: 'turn-learn-a',
  kind: 'turn',
  snippet: '旁路插件监听 8720 端口',
  terms: termsOf('旁路插件监听 8720 端口'),
  score: 0.4,
  features: { relevance: 0.8, salience: 0.5, recency: 0.9, topic: 0.5, affection: 0 },
}
const attrUsed = attributeUse({
  injectedItems: [attrItemA],
  assistantText: '旁路插件监听 8720 端口。',
  nextUserText: '对，继续讲旁路插件和 8720 端口',
})
check('learning.attribute-rule', attrUsed.usedIds.includes('turn-learn-a') && attrUsed.scores[attrItemA.id] === 1)
const attrEcho = attributeUse({
  injectedItems: [{ id: 'turn-echo', snippet: '季度报告要交', terms: ['季度', '报告'] }],
  assistantText: '季度报告要交，我来拆大纲。',
  nextUserText: '嗯',
})
check(
  'learning.echo-not-used',
  attrEcho.echoIds.includes('turn-echo') &&
    !attrEcho.usedIds.includes('turn-echo') &&
    attrEcho.scores['turn-echo'] === 0.5,
)
check(
  'learning.usefulness-ema',
  Math.abs(nextUsefulness(0.5, 1) - 0.65) < 1e-9 && Math.abs(nextUsefulness(0.65, 0) - 0.455) < 1e-9,
)
check(
  'learning.term-daily-decay',
  Math.abs(decayWeight(2, new Date(Date.now() - 10 * 86400000).toISOString()) - (1 + Math.pow(0.95, 10))) < 1e-6,
)
check(
  'learning.forget-signal',
  detectForgetSignal('你忘了上次说的插件吗') !== null &&
    detectForgetSignal('今天天气不错') === null &&
    forgetTopicTerms('你忘了上次说的插件吗', '旁路插件').includes('插件'),
)
check(
  'learning.parse-judge',
  parseJudgeOutput('{"used":["a"],"ignored":["b"],"missedTopicTerms":["c"]}')?.usedIds[0] === 'a' &&
    parseJudgeOutput('not json') === undefined,
)

// K6. 学习仓库：注入/归因/EMA/term/feature/miss/关闭
const nowIso = new Date().toISOString()
const learnItemA = attrItemA
const injectedCount = learnMemory.recordRecallInjection([learnItemA])
const appliedA = learnMemory.applyRecallAttribution({ items: [learnItemA], attribution: attrUsed })
const termRowA = learnHandle.prepare("SELECT * FROM recall_term_weights WHERE term = '插件'").get()
const itemRowA = learnHandle.prepare("SELECT * FROM recall_item_stats WHERE memory_id = 'turn-learn-a'").get()
check(
  'learning.record-injection',
  injectedCount === 1 && appliedA.ok === true && Number(itemRowA?.injected) === 1,
  itemRowA,
)
check(
  'learning.term-weight-up',
  Math.abs(Number(termRowA?.weight) - 1.05) < 1e-9 && Number(termRowA?.hits) === 1,
  termRowA,
)
check(
  'learning.item-usefulness-ema',
  Math.abs(Number(itemRowA?.usefulness) - 0.65) < 1e-9 && Number(itemRowA?.used) === 1,
  itemRowA,
)
check(
  'learning.feature-weight-updated',
  learnMemory.recallFeatureWeights().relevance > 1 && learnMemory.recallFeatureWeights().relevance <= 3,
  learnMemory.recallFeatureWeights(),
)
const learnItemB = {
  id: 'turn-learn-b',
  kind: 'turn',
  snippet: '我最近在准备季度报告',
  terms: ['季度报告'],
  score: 0.9,
  features: { relevance: 0.9, salience: 0.5, recency: 0.5, topic: 0.2, affection: 0 },
}
learnMemory.recordRecallInjection([learnItemB])
const attrB = attributeUse({
  injectedItems: [learnItemB],
  assistantText: '好的。',
  nextUserText: '今天天气不错',
})
learnMemory.applyRecallAttribution({ items: [learnItemB], attribution: attrB })
const termRowB = learnHandle.prepare("SELECT * FROM recall_term_weights WHERE term = '季度报告'").get()
check(
  'learning.term-weight-down',
  Math.abs(Number(termRowB?.weight) - 0.95) < 1e-9 && Number(termRowB?.misses) === 1,
  termRowB,
)
// 助手复述但用户下轮没接话 → 按 ignored 处理，权重回落（防自我强化）。
const echoItem = {
  id: 'turn-echo-weight',
  kind: 'turn',
  snippet: '回声词只在助手回复里出现',
  terms: ['回声'],
  score: 0.8,
  features: { relevance: 0.8, salience: 0.5, recency: 0.8, topic: 0.2, affection: 0 },
}
learnMemory.recordRecallInjection([echoItem])
const echoAttribution = attributeUse({
  injectedItems: [echoItem],
  assistantText: '回声',
  nextUserText: '嗯',
})
learnMemory.applyRecallAttribution({ items: [echoItem], attribution: echoAttribution })
const echoTerm = learnHandle.prepare("SELECT * FROM recall_term_weights WHERE term = '回声'").get()
check(
  'learning.echo-weight-down',
  echoAttribution.echoIds.includes('turn-echo-weight') &&
    echoAttribution.scores['turn-echo-weight'] === 0.5 &&
    Math.abs(Number(echoTerm?.weight) - 0.95) < 1e-9,
  echoTerm,
)
const beforeMiss = Number(learnHandle.prepare("SELECT weight FROM recall_term_weights WHERE term = '插件'").get().weight)
const missed = learnMemory.recordRecallMiss({
  sessionId: 'sess-learning',
  turn: 1,
  at: nowIso,
  terms: ['插件'],
  sourceText: '你忘了上次的插件',
})
const afterMiss = Number(learnHandle.prepare("SELECT weight FROM recall_term_weights WHERE term = '插件'").get().weight)
check(
  'learning.miss-boost',
  missed.ok === true && afterMiss > beforeMiss * 1.4 && learnMemory.learningStats().misses >= 1,
  { beforeMiss, afterMiss },
)
learnHandle
  .prepare(
    'INSERT INTO memory_turns(id, session_id, seq, at, user_text, assistant_text, origin) VALUES(?, ?, ?, ?, ?, ?, ?)',
  )
  .run('turn-learn-score', 'sess-learning', 1, nowIso, '我们继续讲插件和 8720 端口', '好', 'user')
const learnedRecall = learnMemory.recallOriginals('继续讲插件', { limit: 5, topicShiftEnabled: false })
check(
  'learning.recall-term-factor',
  learnedRecall.length > 0 &&
    Number(learnedRecall[0].learnedTerm) > 1 &&
    Number(learnedRecall[0].components?.learnedTerm) > 1,
  learnedRecall.slice(0, 2).map((turn) => ({ id: turn.id, learnedTerm: turn.learnedTerm, score: turn.score })),
)
const learnOffDir = path.join(ROOT, 'learning-off')
const learnOffCtx = boot({ dir: learnOffDir, memory: { recallLearningEnabled: false } })
const learnOffMemory = learnOffCtx.get('brainMemory')
const learnOffWrites = learnOffMemory.recordRecallInjection([learnItemA])
const learnOffApply = learnOffMemory.applyRecallAttribution({ items: [learnItemA], attribution: attrUsed })
check(
  'learning.disabled-no-writes',
  learnOffWrites === 0 &&
    learnOffApply.ok === false &&
    learnOffMemory.learningStats().enabled === false &&
    Number(learnOffMemory.handle().prepare('SELECT COUNT(*) AS c FROM recall_item_stats').get().c) === 0,
)
learnOffCtx.disposeAll()
await wait(20)

// K7. context 接入：注入 → assistant → 下一轮 user 归因；/brain learn、/brain recall、snapshot.learning
async function feedEvent(ctx, sessionId, type, seq, data) {
  ctx.emit('session/event', { id: sessionId, header: { id: sessionId } }, { type, seq, time: Date.now(), data })
}
const e2eDir = path.join(ROOT, 'learning-e2e')
const e2eCtx = boot({ dir: e2eDir })
const e2eMemory = e2eCtx.get('brainMemory')
e2eMemory
  .handle()
  .prepare(
    'INSERT INTO memory_turns(id, session_id, seq, at, user_text, assistant_text, origin) VALUES(?, ?, ?, ?, ?, ?, ?)',
  )
  .run('turn-e2e', 'sess-e2e', 1, nowIso, '扎特插件监听 8720 端口，用来做记忆层', '好', 'user')
const e2eContext = e2eCtx.get('brainContext')
await feedEvent(e2eCtx, 'sess-e2e', 'user/message', 10, {
  role: 'user',
  content: [{ type: 'text', text: '继续聊扎特插件和 8720 端口' }],
  source: { kind: 'user' },
})
const injectedText = e2eContext.sectionText()
await feedEvent(e2eCtx, 'sess-e2e', 'assistant/message', 11, {
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: '扎特插件监听 8720 端口这件事我记得。' }],
    source: { kind: 'model' },
  },
})
await feedEvent(e2eCtx, 'sess-e2e', 'user/message', 12, {
  role: 'user',
  content: [{ type: 'text', text: '对，就是扎特插件监听 8720 端口，继续' }],
  source: { kind: 'user' },
})
await wait(30)
const e2eTerm = e2eMemory.handle().prepare("SELECT * FROM recall_term_weights WHERE term = '扎特'").get()
check(
  'learning.e2e-context-attribution',
  injectedText.includes('扎特') && e2eTerm !== undefined && Number(e2eTerm.weight) > 1,
  { injected: injectedText.includes('扎特'), term: e2eTerm },
)
const e2eSnapshot = e2eContext.snapshot()
check(
  'context.snapshot-learning',
  e2eSnapshot.learning?.enabled === true && typeof e2eSnapshot.learning?.features?.relevance === 'number',
)
const e2eCommand = e2eCtx.commandDefinitions.find((definition) => definition.name === 'brain')
const learnView = await e2eCommand.handler({ rawInput: 'learn', agent: { id: 'sess-e2e' } })
check(
  'command.learn',
  learnView.kind === 'success' && learnView.text.includes('命中率') && learnView.text.includes('特征权重'),
  learnView.text.split('\n').slice(0, 3),
)
const recallDetail = await e2eCommand.handler({ rawInput: 'recall 扎特插件', agent: { id: 'sess-e2e' } })
check(
  'command.recall-detail',
  recallDetail.kind === 'success' && recallDetail.text.includes('学习词') && recallDetail.text.includes('新近'),
  recallDetail.text.split('\n').slice(0, 2),
)

// K8. llm 归因模式：单轮最多 1 次 judge（fake llm 返回 judge JSON）
const judgeDir = path.join(ROOT, 'learning-judge')
const judgeCtx = boot({ dir: judgeDir, memory: { recallLearningMode: 'llm' } })
const judgeMemory = judgeCtx.get('brainMemory')
judgeMemory
  .handle()
  .prepare(
    'INSERT INTO memory_turns(id, session_id, seq, at, user_text, assistant_text, origin) VALUES(?, ?, ?, ?, ?, ?, ?)',
  )
  .run('turn-e2e', 'sess-judge', 1, nowIso, '扎特插件监听 8720 端口', '好', 'user')
const judgeContext = judgeCtx.get('brainContext')
await feedEvent(judgeCtx, 'sess-judge', 'user/message', 20, {
  role: 'user',
  content: [{ type: 'text', text: '继续聊扎特插件' }],
  source: { kind: 'user' },
})
judgeContext.sectionText()
await feedEvent(judgeCtx, 'sess-judge', 'assistant/message', 21, {
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: '扎特插件监听 8720。' }],
    source: { kind: 'model' },
  },
})
judgeCalls = 0
await feedEvent(judgeCtx, 'sess-judge', 'user/message', 22, {
  role: 'user',
  content: [{ type: 'text', text: '对，扎特插件继续' }],
  source: { kind: 'user' },
})
await wait(100)
check('learning.llm-judge-single-call', judgeCalls === 1, judgeCalls)
judgeCtx.disposeAll()
await wait(30)

learnCtx.disposeAll()
e2eCtx.disposeAll()
systemCtx2.disposeAll()
await wait(40)

// =====================================================================
// J. 收尾：确保所有连接都释放，才能删除临时目录（Windows 文件锁）
for (const ctx of [idleCtx, cancelCtx, busyCtx, fallbackCtx, hardCtx]) {
  try {
    ctx.disposeAll()
  } catch {
    /* 已释放 */
  }
}
await wait(60)
fs.rmSync(ROOT, { recursive: true, force: true })
const failures = results.filter((result) => !result.ok)
console.log(`\n=== ${results.length - failures.length}/${results.length} passed ===`)
if (failures.length > 0) {
  console.log('FAILED:', failures.map((result) => result.name))
  process.exit(1)
}
process.exit(0)



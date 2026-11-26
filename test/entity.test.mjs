/**
 * v2.3.0 实体层自测：规则抽取（宁缺毋滥）/ 存储 / 关联轮次 / 档案渲染。
 *
 * 跑法：node test/entity.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { acquireDatabase } from '../src/db.js'
import {
  createEntityStore,
  extractEntityCandidates,
  kindLabelOf,
  normalizeEntityName,
  renderEntitySection,
} from '../src/entities.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

// ---- 1. 规则抽取 -----------------------------------------------------------
check('身份前缀：患者张三', () => {
  const found = extractEntityCandidates('患者张三今天来复诊，主诉还是咳嗽。')
  assert.deepEqual(found, [{ kind: 'patient', name: '张三' }])
})

check('身份前缀带冒号：病人：李姐', () => {
  const found = extractEntityCandidates('病人：李姐，开了三剂。')
  assert.deepEqual(found, [{ kind: 'patient', name: '李姐' }])
})

check('敬称算代号的一部分：客户王先生 → 王先生', () => {
  const found = extractEntityCandidates('客户王先生来了。')
  assert.deepEqual(found, [{ kind: 'client', name: '王先生' }])
  assert.equal(found.some((item) => item.name === '户王'), false, '不能把「户王」当名字')
  assert.equal(found.some((item) => item.name === '王'), false, '不能把敬称吃掉当名字')
})

check('敬称后缀：张三先生', () => {
  const found = extractEntityCandidates('张三先生上次说胃不舒服。')
  assert.deepEqual(found, [{ kind: 'person', name: '张三' }])
})

check('不编造：普通句子不产生对象', () => {
  assert.deepEqual(extractEntityCandidates('今天天气不错，我下午要去趟医院。'), [])
  assert.deepEqual(extractEntityCandidates('这个情况怎么办？'), [])
  assert.deepEqual(extractEntityCandidates(''), [])
})

check('项目/宠物类型', () => {
  assert.deepEqual(extractEntityCandidates('项目留声下个月上线。'), [{ kind: 'project', name: '留声' }])
  assert.deepEqual(extractEntityCandidates('宠物豆豆要打疫苗。'), [{ kind: 'pet', name: '豆豆' }])
})

check('名字归一化', () => {
  assert.equal(normalizeEntityName('「张三」'), '张三')
  assert.equal(normalizeEntityName(' 张 三 '), '张三')
  assert.equal(kindLabelOf('patient'), '患者')
})

// ---- 2. 存储 / 关联 / 档案 --------------------------------------------------
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-brain-entity-'))
const log = () => {}
const handle = acquireDatabase({ dbFile: path.join(tempDir, 'brain.db'), dataDir: tempDir, log })
const store = createEntityStore({ db: handle.db, log })

// 造两轮原文（entity_turns 会 JOIN memory_turns 取文本）
const insertTurn = handle.db.prepare(
  'INSERT INTO memory_turns(id, session_id, seq, at, user_text, assistant_text) VALUES(?, ?, ?, ?, ?, ?)',
)
insertTurn.run('turn-1', 'sess-1', 1, '2026-11-20T02:00:00.000Z', '患者张三主诉咳嗽三天', '建议先辨寒热')
insertTurn.run('turn-2', 'sess-1', 2, '2026-11-26T02:00:00.000Z', '张三复诊，咳嗽好转', '原方加减')

check('upsert 幂等（按归一化名字）', () => {
  const first = store.upsert({ kind: 'patient', name: '张三' })
  const second = store.upsert({ kind: 'patient', name: '张三' })
  assert.equal(first.id, second.id)
  assert.equal(store.list(10).length, 1)
})

check('按名字/别名查找', () => {
  const entity = store.upsert({ kind: 'patient', name: '李四', aliases: ['李姐'] })
  assert.equal(store.findByName('李四')?.id, entity.id)
  assert.equal(store.findByName('李姐')?.id, entity.id)
})

check('ingestTurns：抽实体 + 关联轮次 + 记要点', () => {
  const result = store.ingestTurns([
    { id: 'turn-1', at: '2026-11-20T02:00:00.000Z', user: '患者张三主诉咳嗽三天', assistant: '建议先辨寒热' },
    { id: 'turn-2', at: '2026-11-26T02:00:00.000Z', user: '张三复诊，咳嗽好转', assistant: '原方加减' },
  ])
  assert.equal(result.entities, 0, '张三已存在，不重复建')
  const profile = store.profile(store.findByName('张三').id)
  assert.equal(profile.turnCount, 2)
  assert.equal(profile.turns.length, 2)
  assert.equal(profile.turns[0].turnId, 'turn-2', '最近一轮在前')
  assert.ok(profile.facts.length >= 1)
})

check('resolveMentions：本轮提到谁', () => {
  const hits = store.resolveMentions('张三这次咳嗽又反复了', 2)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].name, '张三')
  assert.deepEqual(store.resolveMentions('今天天气不错', 2), [])
})

check('重名/别名不重复建号', () => {
  const before = store.list(20).length
  store.ingestTurns([{ id: 'turn-2', at: '2026-11-26T02:00:00.000Z', user: '患者张三', assistant: '' }])
  assert.equal(store.list(20).length, before)
})

check('渲染「当前对象」段', () => {
  const profile = store.profile(store.findByName('张三').id, { factLimit: 3, turnLimit: 2 })
  const text = renderEntitySection([profile], { maxChars: 400, turnLimit: 2 })
  assert.ok(text.startsWith('【当前对象 · 张三（患者）】'))
  assert.ok(text.includes('聊到：'))
  assert.equal(renderEntitySection([]), '')
})

check('renderEntitySection 超预算截断', () => {
  const profile = store.profile(store.findByName('张三').id)
  const text = renderEntitySection([profile], { maxChars: 60 })
  assert.ok(text.length <= 61)
})

// ---- 3. 激活扩散 + 表意识槽位（v2.3.0） ------------------------------------
insertTurn.run('turn-3', 'sess-1', 3, '2026-11-27T02:00:00.000Z', '患者李四，和上次那个张三一样咳嗽', '同法加减')
store.ingestTurns([
  {
    id: 'turn-3',
    at: '2026-11-27T02:00:00.000Z',
    user: '患者李四，和上次那个张三一样咳嗽',
    assistant: '同法加减',
  },
])

check('激活扩散：同段出现过的对象互相关联', () => {
  const zhangsan = store.findByName('张三')
  const related = store.related(zhangsan.id, 3)
  assert.ok(related.some((item) => item.name === '李四'), '张三应该牵扯出李四')
  const lisi = store.findByName('李四')
  assert.equal(lisi.kind, 'patient')
})

check('表意识槽位：记住「眼下在说谁」', () => {
  const zhangsan = store.findByName('张三')
  store.rememberFocus('sess-focus', [zhangsan.id])
  const focused = store.focusEntities('sess-focus')
  assert.equal(focused.length, 1)
  assert.equal(focused[0].name, '张三')
})

check('槽位有 TTL：隔太久不接旧对象', () => {
  const oldStore = createEntityStore({
    db: handle.db,
    log,
    now: () => '2026-11-26T00:00:00.000Z',
  })
  const zhangsan = store.findByName('张三')
  oldStore.rememberFocus('sess-expired', [zhangsan.id])
  assert.deepEqual(store.focusEntities('sess-expired'), [], '超过 TTL 应该失效')
})

check('resolveForTurn：点名优先，没点名用焦点', () => {
  const named = store.resolveForTurn({ sessionId: 'sess-r1', text: '张三今天复诊' })
  assert.equal(named.profiles[0].name, '张三')
  assert.equal(named.viaFocus, false)
  assert.ok(named.related.some((item) => item.name === '李四'), '顺带给出相关对象')

  // 下一句只说「他」：靠槽位接上
  const pronoun = store.resolveForTurn({ sessionId: 'sess-r1', text: '他今天怎么样？' })
  assert.equal(pronoun.profiles[0].name, '张三')
  assert.equal(pronoun.viaFocus, true)

  const orphan = store.resolveForTurn({ sessionId: 'sess-never', text: '他今天怎么样？' })
  assert.deepEqual(orphan.profiles, [], '没有焦点的会话不猜')
})

check('相关对象只在开的时侯出现（spread=false 关闭扩散）', () => {
  const plain = store.resolveForTurn({ sessionId: 'sess-r2', text: '张三今天复诊', spread: false })
  assert.deepEqual(plain.related, [])
})

handle.release?.()
fs.rmSync(tempDir, { recursive: true, force: true })

console.log(`\n全部通过：${passed} 项`)

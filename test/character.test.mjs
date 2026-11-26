/**
 * v2.2.0 角色层自测：定义规范化 / prompt 组装 / 渲染 / 版本化存储 / 无模型时降级。
 *
 * 跑法：node test/character.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  buildBootstrapMessages,
  buildReviseMessages,
  createCharacterStore,
  DEFAULT_CHARACTER_ID,
  fallbackDefinition,
  normalizeDefinition,
  renderCharacterSection,
  runCharacterStep,
} from '../src/character.js'
import { acquireDatabase } from '../src/db.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

async function checkAsync(name, fn) {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

// ---- 1. 纯函数 -------------------------------------------------------------
check('定义去围栏/去标题/限长', () => {
  const raw = '```text\n# 我是谁\n我是用户的长期助手。\n\n\n\n我喜欢先给结论。\n```'
  const text = normalizeDefinition(raw)
  assert.equal(text.includes('```'), false)
  assert.equal(text.includes('#'), false)
  assert.ok(text.startsWith('我是用户的长期助手。'))
  assert.ok(normalizeDefinition('x'.repeat(2000), 100).length <= 101)
})

check('无模型兜底只写看得见的事实', () => {
  const text = fallbackDefinition({ name: '', evidenceTexts: ['用户在问中药剂量'], turns: 3 })
  assert.ok(text.includes('我是用户的长期助手'))
  assert.ok(text.includes('3 轮'))
  assert.ok(text.includes('中药剂量'))
  assert.ok(text.includes('规则兜底'))
  assert.equal(fallbackDefinition({}).includes('温柔'), false, '不编造性格')
})

check('bootstrap / revise 的 messages 形状', () => {
  const boot = buildBootstrapMessages({ name: '小月', turns: 2, evidenceTexts: ['用户：你好', '助手：你好呀'] })
  assert.ok(boot.system.includes('自我定义'))
  assert.equal(boot.messages.length, 1)
  assert.ok(boot.messages[0].content.includes('小月'))
  assert.ok(boot.messages[0].content.includes('用户：你好'))

  const revise = buildReviseMessages({ name: '小月', current: '我是小月。', turns: 8, newEvidence: ['用户：今天很累'] })
  assert.ok(revise.system.includes('当前定义'))
  assert.ok(revise.messages[0].content.includes('我是小月。'))
  assert.ok(revise.messages[0].content.includes('今天很累'))
})

check('渲染：没定义不注入，有定义带标题', () => {
  assert.equal(renderCharacterSection({ definition: '' }), '')
  assert.equal(renderCharacterSection(null), '')
  const text = renderCharacterSection({ definition: '我是用户的长期助手。' })
  assert.ok(text.startsWith('【我是谁】'))
  assert.ok(text.includes('我是用户的长期助手。'))
})

// ---- 2. 存储与版本 ---------------------------------------------------------
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-brain-char-'))
const log = () => {}
const handle = acquireDatabase({ dbFile: path.join(tempDir, 'brain.db'), dataDir: tempDir, log })
const store = createCharacterStore({ db: handle.db, log })

check('ensure 幂等创建 pending 角色（v0）', () => {
  const first = store.ensure()
  const second = store.ensure()
  assert.equal(first.id, DEFAULT_CHARACTER_ID)
  assert.equal(first.version, 0)
  assert.equal(second.version, 0)
  assert.equal(store.needsRevision({ evidenceTurns: 3, everyTurns: 6 }).bootstrap, true)
})

check('save 产生新版本并留历史', () => {
  const saved = store.save({ definition: '我是用户的长期助手，说话直接。', reason: 'bootstrap', evidenceTurns: 3, source: 'llm' })
  assert.equal(saved.ok, true)
  assert.equal(saved.version, 1)
  assert.equal(store.get().definition.includes('说话直接'), true)
  const versions = store.versions(5)
  assert.equal(versions.length, 1)
  assert.equal(versions[0].reason, 'bootstrap')
  assert.equal(versions[0].evidenceTurns, 3)
})

check('攒不够证据不修订，攒够了才修订', () => {
  assert.equal(store.needsRevision({ evidenceTurns: 5, everyTurns: 6 }).needed, false)
  assert.equal(store.needsRevision({ evidenceTurns: 9, everyTurns: 6 }).needed, true)
  const saved = store.save({ definition: '我是用户的长期助手，说话直接，会主动提醒休息。', reason: 'revise', evidenceTurns: 9 })
  assert.equal(saved.version, 2)
  assert.equal(store.versions(5).length, 2)
})

check('改名不动版本、不改定义', () => {
  const before = store.get()
  const after = store.setMeta({ name: '小月' })
  assert.equal(after.name, '小月')
  assert.equal(after.version, before.version)
  assert.equal(after.definition, before.definition)
})

check('空定义拒绝保存（不让角色被写成空）', () => {
  const result = store.save({ definition: '   ' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'empty-definition')
})

// ---- 3. 无模型时降级（completeText 会抛，走 fallback） ----------------------
await checkAsync('模型不可用 → 写规则兜底定义并标记 fallback', async () => {
  const fakeCtx = { get: () => undefined }
  const result = await runCharacterStep({
    ctx: fakeCtx,
    config: {},
    memory: {
      characters: () => store,
      characterRow: () => store.get(),
    },
    log,
    mode: 'revise',
    payload: { evidenceTurns: 12, evidenceTexts: ['用户：今天开了 12 味药'] },
  })
  assert.equal(result.ok, true)
  assert.equal(result.source, 'fallback')
  assert.ok(result.character.definition.includes('规则兜底'))
  assert.equal(result.character.version, 3)
})

handle.release?.()
fs.rmSync(tempDir, { recursive: true, force: true })

console.log(`\n全部通过：${passed} 项`)

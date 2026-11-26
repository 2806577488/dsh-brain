/**
 * v2.2.0 域角色层自测：配置归一化 + 注入文本（红线的优先级必须最高）。
 *
 * 跑法：node test/role.test.mjs
 */
import assert from 'node:assert/strict'

import { DEFAULT_CONTEXT_CONFIG, normalizeContextConfig } from '../src/config.js'
import {
  buildRoleText,
  normalizeRoleConfig,
  roleHasContent,
  roleSummary,
  ROLE_SECTION_NAME,
} from '../src/role.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

// ---- 1. 配置归一化 ---------------------------------------------------------
check('空配置 → 空角色，不注入', () => {
  const role = normalizeRoleConfig(undefined)
  assert.equal(roleHasContent(role), false)
  assert.equal(buildRoleText(role), '')
})

check('垃圾输入被收敛，不抛异常', () => {
  const role = normalizeRoleConfig({
    domain: '  中医  ',
    title: 123,
    identity: 'a'.repeat(500),
    expertise: ['经方', '经方', '', null, '  时方 ', 42],
    redlines: 'not-an-array',
    habits: Array.from({ length: 20 }, (_, i) => `习惯${i}`),
  })
  assert.equal(role.domain, '中医')
  assert.equal(role.title, '')
  assert.ok(role.identity.length <= 400)
  assert.deepEqual([...role.expertise], ['经方', '时方'], '去重 + 去空 + 丢掉非字符串')
  assert.deepEqual([...role.redlines], [])
  assert.equal(role.habits.length, 6, '每个列表有条目上限')
})

// ---- 2. 注入文本 -----------------------------------------------------------
const TCM = normalizeRoleConfig({
  domain: '中医',
  title: '中医临床协作助手',
  identity: '你是用户的长期中医临床协作助手。',
  preferences: ['回答能直接抄进病历'],
  rules: ['先辨证再议方'],
  redlines: ['毒性药必须给用量上限', '十八反十九畏不要开'],
  referrals: ['剧烈胸痛、大出血'],
  uncertainty: ['缺四诊信息先问'],
})

check('注入文本包含该有的段', () => {
  const text = buildRoleText(TCM)
  assert.ok(text.startsWith('【角色 · 中医临床协作助手】'))
  assert.ok(text.includes('【用户画像 · 偏好】'))
  assert.ok(text.includes('【专业规范 · 必须遵守】'))
  assert.ok(text.includes('【红线 · 违反就不要给答案】'))
  // 标题必须是通用措辞：字段叫 referrals，但不能印成「红旗症状」这种行业词
  assert.ok(text.includes('【必须转人工 / 线下确认】'))
  assert.ok(!text.includes('红旗症状'), '不能出现医疗专用词')
  assert.ok(text.includes('【不确定时】'))
  assert.ok(text.includes('所有会话共享同一份记忆'), '多线程/多对象场景的共享记忆说明')
})

check('预算再紧也不丢红线与规范', () => {
  const text = buildRoleText(TCM, { maxChars: 200 })
  assert.ok(text.includes('十八反十九畏不要开'), '红线必须保留')
  assert.ok(text.includes('先辨证再议方'), '专业规范必须保留')
})

check('可以从实体上关掉共享记忆说明', () => {
  const text = buildRoleText(normalizeRoleConfig({ title: 'X', sharedMemoryNote: false }))
  assert.ok(!text.includes('所有会话共享同一份记忆'))
})

check('身份说明自己讲了共享记忆就不重复补一句', () => {
  const text = buildRoleText(
    normalizeRoleConfig({ title: 'X', identity: '所有会话共享同一套患者档案，算同一次合作。' }),
  )
  assert.equal(text.split('所有会话共享').length - 1, 1, '同义句只出现一次')
})

check('缺 uncertainty 时给默认兜底策略', () => {
  const text = buildRoleText(normalizeRoleConfig({ title: 'X' }))
  assert.ok(text.includes('【不确定时】'))
  assert.ok(text.includes('先问'))
})

// ---- 3. 接进 dsh-context 配置 ----------------------------------------------
check('dsh-context 接受 role 三项且不报未知配置', () => {
  const { config, warnings } = normalizeContextConfig({
    roleEnabled: true,
    roleSectionOrder: 90,
    role: { domain: '中医', title: '中医助手', redlines: ['不要开毒药'] },
  })
  assert.deepEqual(warnings, [])
  assert.equal(config.roleEnabled, true)
  assert.equal(config.roleSectionOrder, 90)
  assert.equal(config.role.title, '中医助手')
  assert.ok(buildRoleText(config.role).includes('不要开毒药'))
})

check('默认关闭域角色（不写配置不会突然多一段注入）', () => {
  assert.equal(DEFAULT_CONTEXT_CONFIG.roleEnabled, false)
  assert.equal(buildRoleText(DEFAULT_CONTEXT_CONFIG.role), '')
})

check('/brain profile 用到的摘要能给出条目数', () => {
  const summary = roleSummary(TCM, { enabled: true, order: 90 })
  assert.ok(summary.includes('中医临床协作助手'))
  assert.ok(summary.includes('红线 2'))
})

check('注入段名字固定（卸载/排查靠它）', () => {
  assert.equal(ROLE_SECTION_NAME, 'dsh-brain:role')
})

console.log(`\n全部通过：${passed} 项`)

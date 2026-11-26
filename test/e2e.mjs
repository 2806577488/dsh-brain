/**
 * dsh-brain 端到端自测（v2.3.0）：假 Host + 假模型，把整条链跑一遍。
 *
 *   node test/e2e.mjs
 *
 * 覆盖「整理 → 角色 bootstrap → 实体抽取 → 注入」的全链路，不依赖 DSH、不联网：
 *   1. 两轮医患对话 → turn/end 触发后台整理；
 *   2. 整理里顺带 bootstrap 角色（模型写「我是谁」）与结构化抽取患者字段；
 *   3. 再算一次注入文本，检查 【我是谁】【当前对象】【相关对象】 都在；
 *   4. 检查表意识槽位：「他今天怎么样」能接回上一个患者。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as memoryPlugin from '../src/plugins/memory.js'
import * as moodPlugin from '../src/plugins/mood.js'
import * as personaPlugin from '../src/plugins/persona.js'
import * as contextPlugin from '../src/plugins/context.js'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  const text = detail === undefined ? '' : ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${text}`)
}

// ---------------------------------------------------------------------------
// 假模型：按 system prompt 判断这次是谁在调
// ---------------------------------------------------------------------------
const CHARACTER_TEXT = '我是用户的长期助手，说话直接，会留意患者的具体细节。'
const calls = []
const fakeLlm = {
  async prepareCall(config) {
    return {
      config: { ...config },
      stream(options) {
        const system = String(options.system ?? '')
        return (async function* generate() {
          let text = '好的。'
          if (system.includes('自我定义')) {
            calls.push('character')
            text = CHARACTER_TEXT
          } else if (system.includes('对象要点')) {
            calls.push('entity-extract')
            text = JSON.stringify({
              entities: [
                {
                  name: '张三',
                  facts: [
                    { kind: '主诉', text: '咳嗽三天，夜间加重' },
                    { kind: '处方', text: '止嗽散加减' },
                  ],
                },
              ],
            })
          } else if (system.includes('长期记忆摘要')) {
            calls.push('summary')
            text = '{"user":"用户在看一位咳嗽的患者。","self":"我在帮他辨证。"}'
          } else if (system.includes('后台整理')) {
            calls.push('episode')
            text = JSON.stringify({
              facts: { user: [], self: [] },
              episode: { summary: '用户与助手讨论患者张三的咳嗽。', salience: 0.7, terms: ['患者', '咳嗽', '张三'] },
            })
          }
          for (const char of text) yield { type: 'text-delta', index: 0, text: char }
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
  },
}

function createFakeCtx() {
  const services = new Map()
  const disposers = []
  const handlers = new Map()
  const sections = []
  const systemPrompt = {
    section(definition) {
      sections.push(definition)
      return () => {
        const index = sections.indexOf(definition)
        if (index >= 0) sections.splice(index, 1)
      }
    },
  }
  const commandRuntime = { register: () => () => {} }
  services.set('systemPrompt', systemPrompt)
  services.set('commands', commandRuntime)
  services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) })
  const ctx = {
    get: (name) => (name === 'llm' ? fakeLlm : services.get(name)),
    provide: (name, value) => {
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
          /* 与真实事件总线一致 */
        }
      }
    },
    inject(deps, callback) {
      const names = Array.isArray(deps) ? deps : Object.keys(deps)
      if (names.every((name) => ctx.get(name) !== undefined)) callback(ctx)
    },
    services,
    sections,
  }
  return ctx
}

function emitTurn(ctx, { sessionId = 'sess-tcm', seq, user, assistant }) {
  const session = { id: sessionId, header: { id: sessionId } }
  ctx.emit('session/event', session, {
    type: 'user/message', seq, time: Date.now(),
    data: { id: `u-${seq}`, role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'user' } },
  })
  ctx.emit('session/event', session, {
    type: 'assistant/message', seq: seq + 1, time: Date.now(),
    data: {
      turn: 1, step: 1,
      message: {
        id: `a-${seq}`, role: 'assistant', content: [{ type: 'text', text: assistant }],
        source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' },
      },
      stream: [],
    },
  })
}

function emitTurnEnd(ctx, { sessionId = 'sess-tcm', seq, turn = 1 }) {
  const session = { id: sessionId, header: { id: sessionId } }
  ctx.emit('session/event', session, {
    type: 'turn/end', seq, time: Date.now(),
    data: { turn, reason: { kind: 'completed' } },
  })
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-brain-e2e-'))
const ctx = createFakeCtx()
const common = { dataDir: dir }
memoryPlugin.apply(ctx, { ...common })
moodPlugin.apply(ctx, { ...common })
personaPlugin.apply(ctx, { ...common })
contextPlugin.apply(ctx, {
  ...common,
  // 打开这次新做的三块，并让整理触发得快一点（2 轮一整理）。
  consolidateEnabled: true,
  consolidateEveryTurns: 2,
  consolidateMinTurns: 1,
  consolidateMode: 'rule',
  consolidateEpisodeMaxChars: 160,
  characterEnabled: true,
  characterReviseEveryTurns: 2,
  entityEnabled: true,
  entityExtractMode: 'llm',
  entityLimit: 2,
})

const memory = ctx.get('brainMemory')
const context = ctx.get('brainContext')

emitTurn(ctx, { seq: 1000, user: '患者张三，咳嗽三天，夜间加重', assistant: '先辨寒热，别急着止咳' })
emitTurn(ctx, { seq: 1002, user: '张三复诊，咳嗽好转，痰少了', assistant: '原方去桔梗，加陈皮' })
emitTurnEnd(ctx, { seq: 1004, turn: 2 })
await wait(500)

emitTurn(ctx, { seq: 1010, user: '患者李四，和上次那个张三一样咳嗽', assistant: '同法加减' })
emitTurnEnd(ctx, { seq: 1012, turn: 3 })
await wait(500)

// ---- 1. 角色 bootstrap ------------------------------------------------------
const character = memory.character()
check('角色被模型写出第一版', Boolean(character && character.version >= 1), character?.definition)
check('角色定义来自模型（不是配置模板）', String(character?.definition ?? '').includes('说话直接'), character?.source)
check('角色有版本历史', memory.characterVersions(5).length >= 1)

// ---- 2. 实体 + 结构化字段 ---------------------------------------------------
const zhang = memory.entityProfile('张三', { factLimit: 8, turnLimit: 3 })
check('识别出患者张三', Boolean(zhang), zhang?.name)
check('张三关联了 2 轮对话', zhang?.turnCount >= 2, zhang?.turnCount)
const kinds = (zhang?.facts ?? []).map((item) => item.kind)
check('结构化抽取写入主诉/处方', kinds.includes('主诉') && kinds.includes('处方'), kinds)
check('识别出患者李四', Boolean(memory.entityProfile('李四')))

// ---- 3. 激活扩散 -----------------------------------------------------------
const related = memory.entityResolveForTurn({ sessionId: 'sess-tcm', text: '张三今天怎么样' })
check('提到张三时给出相关对象李四', related.related.some((item) => item.name === '李四'), related.related)

// ---- 4. 表意识槽位 ---------------------------------------------------------
const pronoun = memory.entityResolveForTurn({ sessionId: 'sess-tcm', text: '他今天怎么样？' })
check('「他今天怎么样」接回张三', pronoun.profiles[0]?.name === '张三' && pronoun.viaFocus === true, pronoun.profiles[0]?.name)

// ---- 5. 注入文本 -----------------------------------------------------------
const joined = ctx.sections.map((section) => {
  try {
    return typeof section.text === 'function' ? String(section.text() ?? '') : String(section.text ?? '')
  } catch {
    return ''
  }
}).join('\n\n')
check('注入里有【我是谁】', joined.includes('【我是谁】'), joined.slice(0, 120))
check('注入里有【当前对象 · 张三】', joined.includes('【当前对象 · 张三'), '')
check('注入里有结构化字段（主诉）', joined.includes('主诉') || joined.includes('咳嗽三天'), '')
check('注入段排序：角色在上下文之前', (() => {
  const roleSection = ctx.sections.find((section) => section.name === 'dsh-brain:self')
  const contextSection = ctx.sections.find((section) => section.name === 'dsh-brain:context')
  return Boolean(roleSection && contextSection && roleSection.order < contextSection.order)
})())
check('模型确实被调过角色与实体抽取', calls.includes('character') && calls.includes('entity-extract'), calls)

// ---- 收尾 -------------------------------------------------------------------
const failed = results.filter((item) => !item.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`)
fs.rmSync(dir, { recursive: true, force: true })
if (failed.length > 0) {
  console.log('FAILED: ' + JSON.stringify(failed.map((item) => item.name)))
  process.exit(1)
}

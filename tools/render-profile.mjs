/**
 * 从一份 `cordis.patch.yml`（或 `examples/profiles/*.yml`）里解析 `role:` 块，
 * 渲一次**真实注入文本**（人工审阅用）。
 *
 * 为什么手写解析：本仓库策略是零依赖，不为了一个开发工具引入 YAML 库。
 * 只认这个仓库里的形状（8/10/12 空格缩进 + `- ` 列表 + `>-` 折叠标量 +
 * `#` 注释行），解析不到就抛错，不会静默给出错的内容。
 *
 * 跑法：
 *   node tools/render-profile.mjs                                  # 读 bundle 里的 cordis.patch.yml
 *   node tools/render-profile.mjs examples/profiles/tcm.yml        # 读某个示例
 */
import fs from 'node:fs'

import { normalizeContextConfig } from '../src/config.js'
import { buildRoleText } from '../src/role.js'

/** 缩进宽度（与 cordis.patch.yml 的层级一致）。 */
const INDENT = { role: 8, key: 10, item: 12 }

const isComment = (line) => /^\s*#/.test(line)

export function parseRoleBlock(text) {
  const lines = text.split(/\r?\n/)
  const roleAt = lines.findIndex((line) => new RegExp(`^\\s{${INDENT.role}}role:\\s*$`).test(line))
  if (roleAt < 0) throw new Error('没找到 role: 块')

  const role = {}
  let listKey = null
  let pendingKey = null
  let buffer = []

  const commitFold = () => {
    if (!pendingKey) return
    role[pendingKey] = buffer.map((line) => line.trim()).join(' ')
    pendingKey = null
    buffer = []
  }

  for (let i = roleAt + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (isComment(line)) continue
    if (line.trim().length === 0) continue
    const indent = line.match(/^\s*/)[0].length
    if (indent <= INDENT.role) break

    const listMatch = line.match(new RegExp(`^\\s{${INDENT.item}}-\\s+(.*)$`))
    if (listMatch) {
      commitFold()
      const key = listKey ?? pendingKey
      if (!key) continue
      role[key] = role[key] ?? []
      if (!Array.isArray(role[key])) role[key] = []
      role[key].push(listMatch[1].trim())
      continue
    }

    const keyMatch = line.match(new RegExp(`^\\s{${INDENT.key}}([A-Za-z][\\w]*):\\s*(.*)$`))
    if (keyMatch) {
      commitFold()
      const [, key, rest] = keyMatch
      listKey = null
      if (rest.length === 0) {
        // 后面跟列表
        listKey = key
        role[key] = []
      } else if (rest === '>-' || rest === '>') {
        pendingKey = key
        buffer = []
      } else {
        role[key] = rest.replace(/^['"]|['"]$/g, '').trim()
      }
      continue
    }

    if (pendingKey) buffer.push(line)
  }
  commitFold()
  for (const [key, value] of Object.entries(role)) {
    if (Array.isArray(value) && value.length === 0) delete role[key]
  }
  return role
}

const target = process.argv[2]
const path = target
  ? new URL(target, `file:///${process.cwd().replace(/\\/g, '/')}/`)
  : new URL('../cordis.patch.yml', import.meta.url)
const yamlText = fs.readFileSync(path, 'utf8')
const role = parseRoleBlock(yamlText)
const { config, warnings } = normalizeContextConfig({ roleEnabled: true, role })
if (warnings.length > 0) console.log('配置告警:', warnings)

const text = buildRoleText(config.role)
console.log(`# 来源：${String(path).replace(/^file:\/\//, '')}`)
console.log(text.length > 0 ? text : '（这一段为空：roleEnabled 关着，或 role 没内容 → 不会注入）')
console.log(`\n—— ${text.length} 字，${text.split('\n').length} 行 ——`)
const parts = Object.entries(role).map(([key, value]) =>
  `${key}: ${Array.isArray(value) ? `${value.length} 条` : `${String(value).length} 字`}`,
)
console.log(parts.join(' · '))

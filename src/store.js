/**
 * 深月桌面脑：共享持久化与通用工具。
 *
 * 四层（memory / mood / persona / context）各自只拥有自己的数据文件，默认目录为
 * `%USERPROFILE%\.dsh\dsh-brain\`（可用各层 `dataDir` 配置覆盖）：
 *   - memory.json   双向长期记忆：user 侧 / self 侧的事实 + 摘要 + 原文轮次
 *   - mood.json     双向情绪：user（用户）/ self（助手）两套状态与轨迹
 *   - persona.json  双向人格倾向：user（沟通偏好）/ self（助手倾向）
 *   - state.json    上下文层/采集层的运行状态（各层共用一份轻量计数）
 *   - brain.md      人和 DSH agent 可直接读的 Markdown 镜像
 *   - brain.log     四层共用的 JSONL 事件日志
 *
 * 这里只有"零依赖 + 容错"的底层实现：读坏文件自动改名备份、写文件先写 .tmp
 * 再原子 rename、日志滚动、重置前备份。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 默认数据目录。 */
export function defaultDataDir() {
  return path.join(os.homedir(), '.dsh', 'dsh-brain')
}

/** 解析某一层实际使用的数据目录。 */
export function resolveDataDir(configured) {
  return typeof configured === 'string' && configured.trim().length > 0 ? configured.trim() : defaultDataDir()
}

/**
 * 解析某一层实际使用的 SQLite 文件。
 * `dbFile` 显式配置优先；否则用 `<dataDir>/brain.db`。
 * @param {{dbFile?: string, dataDir?: string}} config 本层配置。
 */
export function resolveDbFile(config) {
  const explicit = typeof config?.dbFile === 'string' ? config.dbFile.trim() : ''
  if (explicit.length > 0) return explicit
  return path.join(resolveDataDir(config?.dataDir ?? ''), 'brain.db')
}

/** 读一个 JSON 文件；损坏时改名备份并返回 undefined。 */
export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      /* 备份失败不阻塞启动 */
    }
    return undefined
  }
}

/** 原子写一个 JSON 文件（同目录先写 .tmp 再 rename）。 */
export function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/** 生成一个短 id。 */
export function shortId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 时间戳字符串，用于备份后缀。 */
export function stampNow() {
  const date = new Date()
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** 重置前备份若干数据文件到同目录的 `<file>.bak-<stamp>`。 */
export function backupDataFiles(dir, names, stamp) {
  const created = []
  for (const name of names) {
    const source = path.join(dir, name)
    if (!fs.existsSync(source)) continue
    const target = `${source}.bak-${stamp}`
    try {
      fs.copyFileSync(source, target)
      created.push(target)
    } catch {
      /* 单个文件备份失败不影响其它文件 */
    }
  }
  return created
}

/** 收敛到 [0,1]；非数字给默认值。 */
export function clamp01(value, fallback = 0.5) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(1, Math.max(0, number))
}

/** 夹在闭区间里。 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** 压成一行，供 Markdown / 提示词展示。 */
export function oneLine(text, max = 200) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * 生成一层共用的日志函数：同时打印到 DSH 控制台并追加到 `<dataDir>/brain.log`。
 * 日志失败永远不影响主流程。
 */
export function createLayerLog(dir, layer) {
  const file = path.join(dir, 'brain.log')
  const rotateBytes = 2 * 1024 * 1024
  return (event, data = {}) => {
    const entry = { ts: new Date().toISOString(), layer, event, ...data }
    console.log(`[${layer}] ${JSON.stringify(entry)}`)
    try {
      const stat = fs.statSync(file, { throwIfNoEntry: false })
      if (stat && stat.size > rotateBytes) fs.renameSync(file, `${file}.1`)
    } catch {
      /* 滚动失败就继续追加 */
    }
    try {
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      /* 日志失败不影响主流程 */
    }
  }
}

/** 把任意输入收敛成有限数字。 */
export function numberOr(value, fallback) {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback
}

/** 收一个整数并夹紧。 */
export function integerOr(value, fallback, min, max) {
  return clamp(Math.round(numberOr(value, fallback)), min, max)
}

/** 收一个布尔。 */
export function booleanOr(value, fallback) {
  if (value === undefined || value === null) return fallback
  return Boolean(value)
}

/** 收一个非空字符串。 */
export function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

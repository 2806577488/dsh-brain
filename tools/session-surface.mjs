#!/usr/bin/env node
/**
 * session-surface：只读统计某个 DSH 会话日志的 surface 节点数 / 事件数 / 归档替换次数。
 * 用法：node tools/session-surface.mjs <session.v4.jsonl.zstd 路径>
 *
 * 会话日志是多帧 zstd 拼接；这里按 magic 切帧逐帧解压（Node 自带的流式解码器不认多帧）。
 */
import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
if (typeof file !== 'string' || file.length === 0) {
  console.error('用法：node tools/session-surface.mjs <session.v4.jsonl.zstd>')
  process.exit(2)
}

/** 按 zstd magic 切帧并解压。 */
function readFrames(buffer) {
  const magic = [0x28, 0xb5, 0x2f, 0xfd]
  const offsets = []
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer[index] === magic[0] && buffer[index + 1] === magic[1] && buffer[index + 2] === magic[2] && buffer[index + 3] === magic[3]) {
      offsets.push(index)
    }
  }
  const parts = []
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(start, end)))
    } catch {
      /* 跳过误判的 magic */
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

const lines = readFrames(fs.readFileSync(file)).split('\n').filter((line) => line.trim().length > 0)
const surfaceTypes = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
const nodes = []
const types = new Map()
let replaces = 0
let lastTurnEnd = null
let markerTexts = []
for (const line of lines) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }
  types.set(event.type, (types.get(event.type) ?? 0) + 1)
  if (event.type === 'turn/end') lastTurnEnd = { seq: event.seq, time: event.time, turn: event.data?.turn }
  if (!surfaceTypes.has(event.type)) continue
  if (event.surfaceOp === 'append') {
    nodes.push(event.seq)
  } else if (event.surfaceOp !== undefined && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace') {
    const startIdx = nodes.indexOf(event.surfaceOp.startSeq)
    const endIdx = nodes.indexOf(event.surfaceOp.endSeq)
    if (startIdx >= 0 && endIdx >= startIdx) {
      nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
      replaces += 1
    }
    const text = event.data?.content?.[0]?.text
    if (typeof text === 'string' && text.includes('已归档')) markerTexts.push(text)
  } else if (event.surfaceOp === undefined) {
    nodes.push(event.seq)
  }
}
const messages = lines
  .map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  })
  .filter((event) => event !== null)

console.log(
  JSON.stringify(
    {
      file: file.replaceAll('\\', '/').split('/').slice(-2).join('/'),
      events: lines.length,
      surfaceNodes: nodes.length,
      surfaceReplacements: replaces,
      markerTexts,
      lastTurnEnd,
      compactionEvents: [...types.keys()].filter((type) => type.startsWith('compaction')),
      lastUserMessage: messages.filter((event) => event.type === 'user/message').slice(-2).map((event) => ({
        seq: event.seq,
        source: event.data?.source?.kind ?? null,
        text: String(event.data?.content?.[0]?.text ?? '').slice(0, 60),
      })),
    },
    null,
    2,
  ),
)

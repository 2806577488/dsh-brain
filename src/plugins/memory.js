/**
 * dsh-memory：记忆层 Host 插件入口。
 *
 * 归一化 config → 创建双向记忆服务 → 挂成 `brainMemory` → 订阅 `session/event`
 * 自动采集（用户消息 + 助手回复配对成轮）→ 记忆层自行低频做事实抽取 / 滚动摘要
 * （异步、失败静默，绝不阻塞 DSH）。
 */

import { createCollector } from '../collect.js'
import { normalizeMemoryConfig } from '../config.js'
import { createMemoryService } from '../memory.js'
import { createLayerLog, resolveDataDir } from '../store.js'

/** Loader 行 id 里的插件名。 */
export const name = 'dsh-memory'

/** 记忆层不硬依赖任何 DSH 服务：LLM 只在低频旁路任务里用 `ctx.get('llm')`，缺失就跳过。 */
export const inject = []

/**
 * 挂载记忆层。
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文。
 * @param {unknown} rawConfig 行配置。
 */
export function apply(ctx, rawConfig) {
  const { config, warnings } = normalizeMemoryConfig(rawConfig)
  const dir = resolveDataDir(config.dataDir)
  const log = createLayerLog(dir, 'memory')
  for (const warning of warnings) log('config-warning', { warning })

  const service = createMemoryService({ ctx, config, log, dir })
  try {
    service.init()
  } catch (error) {
    log('init-failed', { message: error?.message ?? String(error) })
  }

  ctx.provide('brainMemory', service)

  if (config.enabled) {
    const collector = createCollector({
      ctx,
      config,
      log,
      getLastSeq: (sessionId) => service.getLastSeq(sessionId),
      setLastSeq: (sessionId, seq) => service.setLastSeq(sessionId, seq),
      getPending: (sessionId) => service.getPending(sessionId),
      setPending: (sessionId, pending) => service.setPending(sessionId, pending),
      clearPending: (sessionId) => service.clearPending(sessionId),
      onSystemEvent: (event) => service.rememberEvent(event),
      onTurn: (turn) => {
        service.rememberTurn(turn)
        if (service.dueForFacts()) {
          service.runFactExtraction().catch((error) => {
            try {
              log('fact-extract-failed', { message: error?.message ?? String(error) })
            } catch {
              /* 静默 */
            }
          })
        }
        if (service.dueForSummary()) {
          service.runSummary().catch((error) => {
            try {
              log('summary-failed', { message: error?.message ?? String(error) })
            } catch {
              /* 静默 */
            }
          })
        }
      },
    })
    service.setCollectorStats(() => collector.stats())
    collector.subscribe()
    ctx.effect(() => () => collector.dispose())
  }

  ctx.effect(() => () => service.close())

  log('plugin-apply', {
    dir,
    enabled: config.enabled,
    maxTurns: config.maxTurns,
    summaryEnabled: config.summaryEnabled,
    summaryThreshold: config.summaryThreshold,
    factExtractInterval: config.factExtractInterval,
    factExtractMode: config.factExtractMode,
    maxFactsPerSide: config.maxFactsPerSide,
    recallLearning: {
      enabled: config.recallLearningEnabled,
      mode: config.recallLearningMode,
    },
    collect: {
      collectSubagents: config.collectSubagents,
      excludeSessionIdPattern: config.excludeSessionIdPattern,
      includeSessions: [...config.includeSessions],
      maxTextChars: config.maxTextChars,
    },
  })
}


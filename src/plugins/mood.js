/**
 * dsh-mood：情绪层 Host 插件入口。
 *
 * 双向情绪（用户状态 / 助手状态）随采集到的对话更新，先时间衰减再按规则小幅增减；
 * 本层零模型调用，也不保存任何个人原文（只保留数值与原因）。
 */

import { createCollector } from '../collect.js'
import { normalizeMoodConfig } from '../config.js'
import { createMoodService } from '../mood.js'
import { createLayerLog, resolveDataDir } from '../store.js'

/** Loader 行 id 里的插件名。 */
export const name = 'dsh-mood'

/** 情绪层不依赖任何 DSH 服务。 */
export const inject = []

/**
 * 挂载情绪层。
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文。
 * @param {unknown} rawConfig 行配置。
 */
export function apply(ctx, rawConfig) {
  const { config, warnings } = normalizeMoodConfig(rawConfig)
  const dir = resolveDataDir(config.dataDir)
  const log = createLayerLog(dir, 'mood')
  for (const warning of warnings) log('config-warning', { warning })

  const service = createMoodService({ config, log, dir })
  try {
    service.init()
  } catch (error) {
    log('init-failed', { message: error?.message ?? String(error) })
  }

  ctx.provide('brainMood', service)

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
      onTurn: (turn) => {
        service.update({ userText: turn.user, assistantText: turn.assistant })
      },
    })
    collector.subscribe()
    ctx.effect(() => () => collector.dispose())
  }

  ctx.effect(() => () => service.close())

  log('plugin-apply', {
    dir,
    enabled: config.enabled,
    moodDecayMinutes: config.moodDecayMinutes,
    historyLimit: config.historyLimit,
    collectSubagents: config.collectSubagents,
  })
}


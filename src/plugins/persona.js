/**
 * dsh-persona：人格收集层 Host 插件入口。
 *
 * 双向人格倾向（用户沟通风格 / 助手自己的倾向）随对话缓慢变化、有界并每天回归基线；
 * 本层零模型调用。
 */

import { createCollector } from '../collect.js'
import { normalizePersonaConfig } from '../config.js'
import { createPersonaService } from '../persona.js'
import { createLayerLog, resolveDataDir } from '../store.js'

/** Loader 行 id 里的插件名。 */
export const name = 'dsh-persona'

/** 人格层不依赖任何 DSH 服务。 */
export const inject = []

/**
 * 挂载人格层。
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文。
 * @param {unknown} rawConfig 行配置。
 */
export function apply(ctx, rawConfig) {
  const { config, warnings } = normalizePersonaConfig(rawConfig)
  const dir = resolveDataDir(config.dataDir)
  const log = createLayerLog(dir, 'persona')
  for (const warning of warnings) log('config-warning', { warning })

  const service = createPersonaService({ config, log, dir })
  try {
    service.init()
  } catch (error) {
    log('init-failed', { message: error?.message ?? String(error) })
  }

  ctx.provide('brainPersona', service)

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
        service.collect({ userText: turn.user, assistantText: turn.assistant })
      },
    })
    collector.subscribe()
    ctx.effect(() => () => collector.dispose())
  }

  ctx.effect(() => () => service.close())

  log('plugin-apply', {
    dir,
    enabled: config.enabled,
    dynamicsEnabled: config.dynamicsEnabled,
    baselineUser: config.baselineUser,
    baselineSelf: config.baselineSelf,
    collectSubagents: config.collectSubagents,
  })
}


/**
 * dsh-context：上下文整理层 Host 插件入口。
 *
 * 「整理」= 记忆的双向搬运，不做压缩、不改会话历史：
 *   1. 后台消化（consolidator）：会话攒够几轮 / 空闲后，把原文静默压入长期记忆
 *      （事实 + 情节记忆 + 滚动摘要），只读会话事件、不写任何会话内容；
 *   2. 工作记忆召回（context）：每次组装 system prompt 时，根据本轮输入 + 最近两轮
 *      + 用户画像/情绪/人格，从长期记忆里捞出相关情节/旧对话，限长注入；
 *   3. 注册 `/brain` 命令（含 `/brain consolidate` 立即整理一次）。
 *
 * 硬依赖 `systemPrompt`（这是本层的输出目标）；`commands` 是可选依赖，用 `ctx.inject`
 * 等它可用再注册。三层数据用 `ctx.get()` 动态取，单独停某一层不会拖垮本层。
 */

import { createArchiver } from '../archiver.js'
import { buildCommandDefinition, createContextService } from '../context.js'
import { createConsolidator } from '../consolidator.js'
import { normalizeContextConfig } from '../config.js'
import { createLayerLog, resolveDataDir } from '../store.js'

/** Loader 行 id 里的插件名。 */
export const name = 'dsh-context'

/** systemPrompt 是本层的输出目标；commands 可选（用 ctx.inject 等待）。 */
export const inject = ['systemPrompt']

/**
 * 挂载上下文整理层。
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文。
 * @param {unknown} rawConfig 行配置。
 */
export function apply(ctx, rawConfig) {
  const { config, warnings } = normalizeContextConfig(rawConfig)
  const dir = resolveDataDir(config.dataDir)
  const log = createLayerLog(dir, 'context')
  for (const warning of warnings) log('config-warning', { warning })

  const service = createContextService({ ctx, config, log })
  const consolidator = createConsolidator({ ctx, config, log })
  const archiver = createArchiver({ ctx, config, log })
  service.attachConsolidator(consolidator)
  service.attachArchiver(archiver)
  ctx.provide('brainContext', service)

  if (config.enabled) {
    try {
      const dispose = service.registerPromptSection()
      if (typeof dispose === 'function') {
        ctx.effect(() => () => {
          try {
            dispose()
          } catch {
            /* 注销失败不影响卸载 */
          }
        })
      }
    } catch (error) {
      log('section-failed', { message: error?.message ?? String(error) })
    }
  }

  // 只读订阅：跟踪用户消息（给召回当检索词）+ 后台消化触发；两者都不写会话。
  try {
    ctx.effect(() => {
      const disposers = []
      try {
        disposers.push(service.trackUserMessages())
      } catch (error) {
        log('user-track-failed', { message: error?.message ?? String(error) })
      }
      try {
        if (config.consolidateEnabled) disposers.push(consolidator.subscribe())
      } catch (error) {
        log('consolidator-subscribe-failed', { message: error?.message ?? String(error) })
      }
      try {
        if (config.archiveEnabled) {
          disposers.push(ctx.on('session/event', (session, event) => archiver.handleEvent(session, event)))
          log('archiver-subscribed', {
            atPercent: config.archiveAtPercent,
            keepRecentTurns: config.keepRecentTurns,
            maxTurns: config.archiveMaxTurnsPerBatch,
            marker: config.archiveMarker,
            dryRun: config.archiveDryRun,
            whitelist: [...(config.archiveSessionIds ?? [])],
          })
        }
      } catch (error) {
        log('archiver-subscribe-failed', { message: error?.message ?? String(error) })
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose?.()
          } catch {
            /* 单个注销失败不影响其它 */
          }
        }
        try {
          consolidator.dispose()
        } catch {
          /* 静默 */
        }
        try {
          archiver.dispose()
        } catch {
          /* 静默 */
        }
      }
    })
  } catch (error) {
    log('effect-failed', { message: error?.message ?? String(error) })
  }

  if (config.commandEnabled) {
    // commands 服务可能在别处被停用；用 ctx.inject 等它就绪，不拖垮本层。
    ctx.inject(['commands'], (commandCtx) => {
      try {
        // 真 Cordis 里注入的服务是 ctx.commands；测试/极简上下文里退回 ctx.get()。
        const commandRuntime = commandCtx.commands ?? commandCtx.get('commands')
        if (!commandRuntime || typeof commandRuntime.register !== 'function') {
          log('command-skip', { reason: 'commands 服务不可用' })
          return
        }
        commandRuntime.register(buildCommandDefinition({ ctx, config, log }))
        log('command-registered', { name: 'brain' })
      } catch (error) {
        log('command-failed', { message: error?.message ?? String(error) })
      }
    })
  }

  log('plugin-apply', {
    dir,
    enabled: config.enabled,
    sectionOrder: config.sectionOrder,
    maxChars: config.maxChars,
    workingMemoryMaxChars: config.workingMemoryMaxChars,
    factLimit: config.factLimit,
    commandEnabled: config.commandEnabled,
    consolidate: {
      enabled: config.consolidateEnabled,
      everyTurns: config.consolidateEveryTurns,
      idleMs: config.idleConsolidateMs,
      mode: config.consolidateMode,
    },
  })
}

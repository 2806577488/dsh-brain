/**
 * 深月桌面脑：模型调用（供记忆层的滚动摘要 / LLM 事实抽取使用）。
 *
 * 不保存任何 API key、不直连 api.deepseek.com：一律通过 DSH 的 `ctx.llm`
 * 服务（`prepareCall` + `stream`），复用当前账号登录态与 provider 路由。
 * 所有调用都是低频、异步、失败静默的旁路任务，绝不进入 DSH 的主对话链路。
 */

/** 构造一个带原因的调用错误。 */
export class BridgeLlmError extends Error {
  /**
   * @param {string} message 人类可读原因。
   * @param {{code?: string, status?: number, kind?: string}} [details] 细节。
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'BridgeLlmError'
    this.code = details.code ?? 'LLM_UNAVAILABLE'
    this.status = details.status ?? 502
    this.kind = details.kind ?? 'llm'
  }
}

/**
 * 解析本轮要用的 provider / model。
 * provider 未显式配置时读取 DSH 当前的默认模型选择。
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文。
 * @param {import('./config.js').DEFAULT_CONFIG} config 归一化配置。
 * @returns {{provider: string, model: string}}
 */
export function resolveRoute(ctx, config = {}) {
  let selection = undefined
  const service = ctx.get('agentDefaultModel')
  if (service && typeof service.currentSelection === 'function') {
    try {
      selection = service.currentSelection()
    } catch {
      selection = undefined
    }
  }
  const configuredProvider = typeof config.provider === 'string' ? config.provider.trim() : ''
  const configuredModel = typeof config.defaultModel === 'string' ? config.defaultModel.trim() : ''
  const provider = configuredProvider.length > 0 ? configuredProvider : selection?.provider ?? 'deepseek-account'
  const model = configuredModel.length > 0 ? configuredModel : selection?.model ?? 'deepseek-flash'
  return { provider, model }
}

/** 取 llm 服务；缺失时给出明确错误。 */
function requireLlm(ctx) {
  const llm = ctx.get('llm')
  if (!llm || typeof llm.prepareCall !== 'function') {
    throw new BridgeLlmError('DSH 的 llm 服务不可用，无法调用模型', { code: 'LLM_SERVICE_MISSING' })
  }
  return llm
}

/** 把终止原因转成结果；error/aborted 抛错。 */
function finishOutcome(reason) {
  switch (reason?.kind) {
    case 'stop':
    case 'max-tokens':
    case 'tool-calls':
      return { kind: reason.kind }
    case 'aborted':
      return {
        error: new BridgeLlmError('模型调用被取消或超时', { code: 'LLM_ABORTED', status: 504, kind: reason.kind }),
      }
    case 'error':
      return {
        error: new BridgeLlmError(reason.failure?.message ?? '模型调用失败', {
          code: typeof reason.failure?.code === 'string' ? reason.failure.code : 'LLM_ERROR',
          status: typeof reason.failure?.status === 'number' ? reason.failure.status : 502,
          kind: 'error',
        }),
      }
    default:
      return { kind: 'stop' }
  }
}

/** 把 `content: '文本'` 归一化成 blocks 形态（DSH 的消息契约是 blocks 数组）。 */
function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return []
  return messages.map((message) => {
    if (!message || typeof message !== 'object') return message
    if (typeof message.content !== 'string') return message
    return { ...message, content: [{ type: 'text', text: message.content }] }
  })
}

/**
 * 流式调用一次模型。
 *
 * 产出 `{kind:'text'}`、`{kind:'usage'}`、`{kind:'finish'}` 三种事件；终止错误
 * 通过最后一个 `{kind:'finish', error}` 事件报出（而不是中途抛出），这样 HTTP
 * 层在已经写出 SSE 头之后仍能干净收尾。
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文。
 * @param {object} request 调用参数。
 * @param {{provider: string, model: string}} request.route 模型路由。
 * @param {string} request.system system prompt。
 * @param {readonly object[]} request.messages 请求消息。
 * @param {number} request.temperature 温度。
 * @param {number} request.maxTokens 输出上限。
 * @param {AbortSignal} request.signal 取消信号。
 * @param {string} [request.sessionId] 可选：绑定到某个会话（账号型传输可能需要它）。
 */
export async function* streamCompletion(ctx, request) {
  let call
  try {
    const llm = requireLlm(ctx)
    call = await llm.prepareCall(
      {
        provider: request.route.provider,
        model: request.route.model,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
      },
      request.signal,
    )
  } catch (error) {
    if (error instanceof BridgeLlmError) {
      yield { kind: 'finish', error }
      return
    }
    yield {
      kind: 'finish',
      error: new BridgeLlmError(`模型路由准备失败：${error?.message ?? String(error)}`, {
        code: typeof error?.code === 'string' ? error.code : 'LLM_PREPARE_FAILED',
        status: typeof error?.status === 'number' ? error.status : 502,
      }),
    }
    return
  }

  const options = {
    ...call.config,
    messages: normalizeMessages(request.messages),
    system: request.system,
    signal: request.signal,
    // 账号型传输（deepseek-account）按会话路由；不传 sessionId 时后台调用会在
    // 传输层直接失败（"DeepSeek Messages transport failed"）。
    ...(typeof request.sessionId === 'string' && request.sessionId.length > 0
      ? { sessionId: request.sessionId }
      : {}),
  }

  let usage
  let finish
  try {
    for await (const chunk of call.stream(options)) {
      switch (chunk.type) {
        case 'text-delta':
          if (chunk.text.length > 0) yield { kind: 'text', text: chunk.text }
          break
        case 'usage':
          usage = chunk.usage
          break
        case 'finish':
          finish = chunk.reason
          break
        default:
          break
      }
    }
  } catch (error) {
    yield {
      kind: 'finish',
      error: new BridgeLlmError(`模型流读取出错：${error?.message ?? String(error)}`, {
        code: typeof error?.code === 'string' ? error.code : 'LLM_STREAM_FAILED',
        status: typeof error?.status === 'number' ? error.status : 502,
      }),
    }
    return
  }

  const outcome = finishOutcome(finish)
  if (outcome.error) {
    // 把路由信息带到错误上：失败日志里能直接看到是哪个 provider/model 出的问题。
    outcome.error.provider = request.route?.provider ?? ''
    outcome.error.model = request.route?.model ?? ''
    yield { kind: 'finish', error: outcome.error }
    return
  }
  yield { kind: 'finish', finish: outcome.kind, usage }
}

/**
 * 后台调用的**路由候选链**：先按配置/当前选择，再把其它已注册 provider 作为备选。
 *
 * 为什么需要：`deepseek-account` 是账号登录态传输，后台宿主调用它会 502 TRANSPORT
 * （"DeepSeek Messages transport failed"）；`deepseek-official` 这类 API Key 路由
 * 才是插件能用的通道。这里不猜模型名，用 `llm.listModels()` 拿每个 provider 的首个模型。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文。
 * @param {object} config 归一化配置。
 * @returns {Promise<Array<{provider: string, model: string}>>}
 */
export async function resolveRouteChain(ctx, config = {}) {
  const primary = resolveRoute(ctx, config)
  const chain = [primary]
  try {
    const llm = ctx.get('llm')
    const providers = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
    for (const item of Array.isArray(providers) ? providers : []) {
      const id = typeof item === 'string' ? item : item?.id
      if (!id || id === primary.provider) continue
      let model = ''
      try {
        const models = await llm.listModels(id)
        model = models?.[0]?.id ?? ''
      } catch {
        model = ''
      }
      if (typeof model === 'string' && model.length > 0) chain.push({ provider: id, model })
    }
  } catch {
    // 发现失败就只用首选路由
  }
  return chain
}

/** 这个错误值不值得换下一个路由重试（传输/5xx/流失败）。 */
function isRouteRetryable(error) {
  const code = String(error?.code ?? '')
  if (code === 'TRANSPORT' || code === 'LLM_STREAM_FAILED' || code === 'LLM_PREPARE_FAILED') return true
  const status = Number(error?.status)
  return Number.isFinite(status) && status >= 500
}

/**
 * 非流式的便捷封装：把流式事件收成完整文本。
 *
 * 会在候选路由链上**逐个尝试**：首选路由（用户当前选择）失败且属于传输类错误时，
 * 自动换下一个 provider 再试一次。全部失败才抛最后一个错误。
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文。
 * @param {Parameters<typeof streamCompletion>[1]} request 调用参数。
 * @returns {Promise<string>}
 */
export async function completeText(ctx, request) {
  const chain = Array.isArray(request.routes) && request.routes.length > 0
    ? request.routes
    : await resolveRouteChain(ctx, request.config ?? {})
  let lastError
  for (const route of chain) {
    try {
      const parts = []
      for await (const event of streamCompletion(ctx, { ...request, route })) {
        if (event.kind === 'text') parts.push(event.text)
        else if (event.kind === 'finish' && event.error) throw event.error
      }
      return parts.join('')
    } catch (error) {
      lastError = error
      lastError.triedRoutes = chain.length
      if (!isRouteRetryable(error)) throw error
    }
  }
  throw lastError ?? new BridgeLlmError('没有可用的模型路由', { code: 'NO_ROUTE', status: 502 })
}

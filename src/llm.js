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
    messages: request.messages,
    system: request.system,
    signal: request.signal,
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
    yield { kind: 'finish', error: outcome.error }
    return
  }
  yield { kind: 'finish', finish: outcome.kind, usage }
}

/**
 * 非流式的便捷封装：把流式事件收成完整文本。
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文。
 * @param {Parameters<typeof streamCompletion>[1]} request 调用参数。
 * @returns {Promise<string>}
 */
export async function completeText(ctx, request) {
  const parts = []
  for await (const event of streamCompletion(ctx, request)) {
    if (event.kind === 'text') parts.push(event.text)
    else if (event.kind === 'finish' && event.error) throw event.error
  }
  return parts.join('')
}

// 用脚本化的假模型回放 OpenAI 兼容流式响应，驱动 Pi Agent 循环。
export type ScriptedStep =
  | { tool: string; args: unknown; reasoning?: string }
  | { text: string }

export type CapturedRequest = {
  url: string
  body: {
    model: string
    messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> | null; tool_calls?: Array<{ function: { name: string; arguments: string } }> }>
    tools?: Array<{ function: { name: string } }>
    tool_choice?: unknown
    thinking?: { type: string; clear_thinking?: boolean }
    reasoning_effort?: string
    max_tokens?: number
  }
  headers: Headers
}

const sse = (chunks: unknown[], id: string, model: string) =>
  new Response(
    chunks.map((chunk) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, ...(chunk as object) })}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  )

export const messageText = (message: { content: string | Array<{ type: string; text?: string }> | null } | undefined) =>
  typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? []).map((item) => item.text ?? '').join('')

export const installScriptedProvider = (script: ScriptedStep[]) => {
  const originalFetch = globalThis.fetch
  const requests: CapturedRequest[] = []
  const remaining = [...script]
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as CapturedRequest['body']
    requests.push({ url: String(url), body, headers: new Headers(init?.headers) })
    const step = remaining.shift()
    if (!step) throw new Error(`脚本已用尽，收到第 ${requests.length} 次请求。`)
    const id = `chatcmpl-${requests.length}`
    if ('text' in step) {
      return sse([
        { choices: [{ index: 0, delta: { role: 'assistant', content: step.text } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } },
      ], id, body.model)
    }
    const raw = JSON.stringify(step.args)
    const midpoint = Math.floor(raw.length / 2)
    return sse([
      ...(step.reasoning ? [{ choices: [{ index: 0, delta: { reasoning_content: step.reasoning } }] }] : []),
      { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: step.tool, arguments: raw.slice(0, midpoint) } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: raw.slice(midpoint) } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 } },
    ], id, body.model)
  }
  return {
    requests,
    toolNames: () => requests.map((request) => request.body.tools?.map((tool) => tool.function.name) ?? []),
    remaining: () => remaining.length,
    restore: () => { globalThis.fetch = originalFetch },
  }
}

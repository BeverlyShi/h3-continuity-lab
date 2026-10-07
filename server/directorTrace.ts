import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { TraceUsage } from '../src/types/director.ts'

type AssistantAgentMessage = Extract<AgentMessage, { role: 'assistant' }>

export const toDurableValue = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T

export const toDurableMessage = (message: AgentMessage): AgentMessage =>
  toDurableValue(message)

export const inspectRawToolArguments = (rawArguments: string) => {
  try {
    JSON.parse(rawArguments)
    return { rawArguments, jsonParseError: null }
  } catch (error) {
    return { rawArguments, jsonParseError: error instanceof Error ? error.message : String(error) }
  }
}

export const summarizeAssistantUsage = (messages: AgentMessage[]): TraceUsage | undefined => {
  const assistants = messages.filter((message): message is AssistantAgentMessage =>
    message.role === 'assistant' && 'usage' in message && message.usage.totalTokens > 0,
  )
  if (!assistants.length) return undefined

  const hasReasoningUsage = assistants.some((message) => message.usage.reasoning !== undefined)
  return {
    input: assistants.reduce((total, message) => total + message.usage.input, 0),
    output: assistants.reduce((total, message) => total + message.usage.output, 0),
    reasoning: hasReasoningUsage
      ? assistants.reduce((total, message) => total + (message.usage.reasoning ?? 0), 0)
      : undefined,
    cacheRead: assistants.reduce((total, message) => total + message.usage.cacheRead, 0),
    totalTokens: assistants.reduce((total, message) => total + message.usage.totalTokens, 0),
    cost: assistants.reduce((total, message) => total + message.usage.cost.total, 0),
  }
}

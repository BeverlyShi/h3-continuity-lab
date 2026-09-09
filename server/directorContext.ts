import type { Entry } from '@earendil-works/pi-agent-core/node'

type MessageEntry = Extract<Entry, { type: 'message' }>
type AssistantMessage = Extract<MessageEntry['message'], { role: 'assistant' }>
type ToolResultMessage = Extract<MessageEntry['message'], { role: 'toolResult' }>
type ToolCallContent = Extract<AssistantMessage['content'][number], { type: 'toolCall' }>

const DIRECTOR_TRACE_CUSTOM_TYPE = 'director_trace'

const textFromContent = (content: ToolResultMessage['content']) =>
  content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n')

const summarizeCastScene = (text: string): string => {
  const parts = text.split('\n').flatMap((line) => {
    const match = /^- (.+?)：(?:新演员 )?([^，]+)，/.exec(line)
    return match ? [`${match[1]}→${match[2]}`] : []
  })
  return parts.length ? `选角：${parts.join('，')}` : '选角已确定'
}

type ToolCallIndex = {
  sequenceByToolCallId: Map<string, number>
  isLastBySequence: Map<number, boolean>
}

const buildToolCallIndex = (messageEntries: MessageEntry[]): ToolCallIndex => {
  const sequenceByToolCallId = new Map<string, number>()
  const isLastBySequence = new Map<number, boolean>()
  for (const entry of messageEntries) {
    if (entry.message.role !== 'assistant') continue
    for (const content of entry.message.content) {
      if (content.type !== 'toolCall') continue
      if (content.name !== 'write_segment' && content.name !== 'generate_segment') continue
      const args = content.arguments as { sequence?: unknown; isLast?: unknown }
      if (typeof args.sequence === 'number') sequenceByToolCallId.set(content.id, args.sequence)
      if (content.name === 'write_segment' && typeof args.sequence === 'number' && typeof args.isLast === 'boolean') {
        isLastBySequence.set(args.sequence, args.isLast)
      }
    }
  }
  return { sequenceByToolCallId, isLastBySequence }
}

const findFinalSegmentSequence = (isLastBySequence: Map<number, boolean>): number | undefined => {
  let result: number | undefined
  for (const [sequence, isLast] of isLastBySequence) if (isLast) result = sequence
  return result
}

const findKeepFullResultEntryId = (
  messageEntries: MessageEntry[],
  index: ToolCallIndex,
  finalSegmentSequence: number | undefined,
): string | undefined => {
  if (finalSegmentSequence === undefined) return undefined
  let result: string | undefined
  for (const entry of messageEntries) {
    if (entry.message.role !== 'toolResult') continue
    if (entry.message.toolName !== 'generate_segment') continue
    if (entry.message.isError) continue
    if (index.sequenceByToolCallId.get(entry.message.toolCallId) !== finalSegmentSequence) continue
    result = entry.id
  }
  return result
}

const summarizeToolResult = (
  entry: MessageEntry,
  message: ToolResultMessage,
  index: ToolCallIndex,
  keepFullResultEntryId: string | undefined,
): string => {
  if (message.isError) return '（校验未通过，已修正）'
  if (message.toolName === 'publish_scene') return '场景已发布'
  if (message.toolName === 'cast_scene') return summarizeCastScene(textFromContent(message.content))
  if (message.toolName === 'write_segment') {
    const sequence = index.sequenceByToolCallId.get(message.toolCallId)
    const details = message.details as { segment?: { startTime: number; endTime: number } } | undefined
    const seconds = details?.segment ? details.segment.endTime - details.segment.startTime : undefined
    return `第 ${sequence ?? '?'} 段已写${seconds !== undefined ? `，${seconds} 秒` : ''}`
  }
  if (message.toolName === 'generate_segment') {
    const sequence = index.sequenceByToolCallId.get(message.toolCallId)
    if (entry.id === keepFullResultEntryId) {
      const details = message.details as { visualState?: unknown } | undefined
      if (details?.visualState !== undefined) return JSON.stringify(details.visualState)
    }
    const details = message.details as { durationSeconds?: number } | undefined
    return `第 ${sequence ?? '?'} 段已生成${details?.durationSeconds !== undefined ? `，实测 ${details.durationSeconds} 秒` : ''}`
  }
  if (message.toolName === 'finish_turn') return '回合已结束'
  return textFromContent(message.content).split('\n')[0] ?? ''
}

const compressToolCallArguments = (content: ToolCallContent, index: ToolCallIndex): ToolCallContent => {
  if (content.name === 'publish_scene' || content.name === 'cast_scene') return content
  if (content.name === 'finish_turn') return { ...content, arguments: {} }
  const sequence = index.sequenceByToolCallId.get(content.id)
  return { ...content, arguments: sequence === undefined ? {} : { sequence } }
}

const projectTurn = (turnEntries: Entry[]): Entry[] => {
  const messageEntries = turnEntries.filter((entry): entry is MessageEntry => entry.type === 'message')
  const index = buildToolCallIndex(messageEntries)
  const finalSegmentSequence = findFinalSegmentSequence(index.isLastBySequence)
  const keepFullResultEntryId = findKeepFullResultEntryId(messageEntries, index, finalSegmentSequence)

  return turnEntries.map((entry): Entry => {
    if (entry.type !== 'message') return entry
    const { message } = entry
    if (message.role === 'assistant') {
      const content: AssistantMessage['content'] = message.content.flatMap((item): AssistantMessage['content'] => {
        if (item.type === 'thinking') return []
        if (item.type !== 'toolCall') return [item]
        return [compressToolCallArguments(item, index)]
      })
      return { ...entry, message: { ...message, content } }
    }
    if (message.role !== 'toolResult') return entry
    const rest = { ...message }
    delete rest.details
    const text = summarizeToolResult(entry, message, index, keepFullResultEntryId)
    return { ...entry, message: { ...rest, content: [{ type: 'text', text }] } }
  })
}

// 以 director_trace 边界切出当前回合（完整保留）和之前的历史回合（每个工具往返压成一行）。
export const projectHistory = (entries: Entry[]): Entry[] => {
  const boundaryIndices = entries.reduce<number[]>((acc, entry, index) => {
    if (entry.type === 'custom' && entry.customType === DIRECTOR_TRACE_CUSTOM_TYPE) acc.push(index)
    return acc
  }, [])
  if (!boundaryIndices.length) return entries

  const lastBoundary = boundaryIndices[boundaryIndices.length - 1]
  const historyEntries = entries.slice(0, lastBoundary)
  const currentEntries = entries.slice(lastBoundary)
  const historyBoundaries = boundaryIndices.filter((index) => index < lastBoundary)

  const ranges: Array<readonly [number, number]> = []
  if (historyBoundaries.length && historyBoundaries[0] > 0) ranges.push([0, historyBoundaries[0]])
  historyBoundaries.forEach((start, index) => {
    ranges.push([start, historyBoundaries[index + 1] ?? lastBoundary])
  })

  const projectedHistory = ranges.flatMap(([start, end]) => projectTurn(historyEntries.slice(start, end)))
  return [...projectedHistory, ...currentEntries]
}

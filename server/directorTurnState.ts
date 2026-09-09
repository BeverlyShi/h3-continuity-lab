import type { Entry, JsonlSessionMetadata, Session } from '@earendil-works/pi-agent-core/node'
import type { DirectorModelId } from '../src/config/directorModels.ts'
import type { CastableActor, CharacterCasting } from '../src/types/actor.ts'
import type { DirectorTurnContext } from '../src/types/game.ts'
import type { ScenePublish, TailFrameVisualState } from '../src/types/story.ts'
import type { CastingBookSnapshot } from './castSceneTool.ts'
import type { DirectorVideoMode } from './directorPrompt.ts'
import { toDurableValue } from './directorTrace.ts'

export const TURN_STATE_CUSTOM_TYPE = 'director_turn_state'

export type SegmentState = {
  sequence: number
  characters: string[]
  seconds: number
  isLast: boolean
  prompt: string
  lineIds: string[]
  style?: string
  generated?: { durationSeconds: number; visualState: TailFrameVisualState }
  generateAttempts: number
}

export type TurnVideoState = {
  style?: string
  segments: SegmentState[]
}

export type PendingGeneration = {
  sequence: number
  toolCallId: string
}

export type DirectorTurnStatus = 'running' | 'awaiting_upload' | 'resumed' | 'finished' | 'abandoned'

// 单个回合的完整内存态，暂停/恢复时整份写入 director_trace 同一个 Pi session。
export type DirectorTurnState = {
  status: DirectorTurnStatus
  traceId: string
  modelId: DirectorModelId
  thinkingEnabled: boolean
  videoMode: DirectorVideoMode
  context: DirectorTurnContext
  actors: CastableActor[]
  castings: CharacterCasting[]
  startSeq: number
  startedAt: number
  scenePublish?: ScenePublish
  castingBook?: CastingBookSnapshot
  video: TurnVideoState
  pending?: PendingGeneration
  skipVideoReason?: string
  finished: boolean
}

// 回合结束或被放弃时只需要留下一个轻量标记。
export type DirectorTurnStateFinishedSnapshot = {
  status: 'finished' | 'abandoned'
  traceId: string
}

export type PersistedTurnState = DirectorTurnState | DirectorTurnStateFinishedSnapshot

export const isFullTurnState = (value: PersistedTurnState): value is DirectorTurnState => 'context' in value

export const persistTurnState = async (
  session: Session<JsonlSessionMetadata>,
  state: PersistedTurnState,
): Promise<void> => {
  await session.appendCustomEntry(TURN_STATE_CUSTOM_TYPE, toDurableValue(state))
}

export const readLatestTurnState = (entries: readonly Entry[]): PersistedTurnState | undefined => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry.type === 'custom' && entry.customType === TURN_STATE_CUSTOM_TYPE) {
      return entry.data as PersistedTurnState
    }
  }
  return undefined
}

export type UnresolvedToolCall = { toolCallId: string; toolName: string; arguments: unknown }

type MessageEntry = Extract<Entry, { type: 'message' }>

// JSONL 尾部若是一条带工具调用、还没有对应 toolResult 的 assistant 消息，说明上一次 generate_segment 暂停后玩家还没上传。
export const findUnresolvedToolCall = (entries: readonly Entry[]): UnresolvedToolCall | undefined => {
  const messageEntries = entries.filter((entry): entry is MessageEntry => entry.type === 'message')
  const last = messageEntries.at(-1)
  if (!last || last.message.role !== 'assistant') return undefined
  const toolCalls = last.message.content.filter(
    (content): content is Extract<typeof content, { type: 'toolCall' }> => content.type === 'toolCall',
  )
  if (!toolCalls.length) return undefined
  const resolvedIds = new Set(
    messageEntries.flatMap((entry) => (entry.message.role === 'toolResult' ? [entry.message.toolCallId] : [])),
  )
  const unresolved = toolCalls.find((call) => !resolvedIds.has(call.id))
  return unresolved ? { toolCallId: unresolved.id, toolName: unresolved.name, arguments: unresolved.arguments } : undefined
}

export type AwaitingUpload = {
  state: DirectorTurnState
  pending: PendingGeneration
}

// “正在等待上传”必须同时满足：最新状态是 awaiting_upload，且它记录的 toolCallId 与 JSONL 尾部未决工具调用一致。
export const findAwaitingUpload = (entries: readonly Entry[]): AwaitingUpload | undefined => {
  const latest = readLatestTurnState(entries)
  if (!latest || latest.status !== 'awaiting_upload' || !isFullTurnState(latest) || !latest.pending) return undefined
  const unresolved = findUnresolvedToolCall(entries)
  if (!unresolved || unresolved.toolCallId !== latest.pending.toolCallId) return undefined
  return { state: latest, pending: latest.pending }
}

import type { Entry, JsonlSessionMetadata, Session } from '@earendil-works/pi-agent-core'
import type { DirectorModelId } from '../config/directorModels.ts'
import type { CastableActor, CharacterCasting } from '../types/actor.ts'
import type { DirectorTurnContext } from '../types/game.ts'
import type { SceneCharacter, ScenePublish, TailFrameVisualState } from '../types/story.ts'
import type { CastingBookSnapshot } from './castSceneTool.ts'
import { toDurableValue } from './directorTrace.ts'
import type { SceneVideoDraft } from './writeSceneVideoTool.ts'

export const TURN_STATE_CUSTOM_TYPE = 'director_turn_state'

// 一次导演运行（写一个场次，或重写其中一段）的内存态。运行结束时整份写入 Pi session，
// 玩家要求“让导演重写某段”时从这里取回本场次的剧情、选角和原始分镜。
export type DirectorTurnState = {
  status: 'running' | 'finished'
  traceId: string
  modelId: DirectorModelId
  thinkingEnabled: boolean
  context: DirectorTurnContext
  actors: CastableActor[]
  castings: CharacterCasting[]
  // 本局此前登场过的全部人物：名册和人物 id 冲突检查用；旧版状态没有这个字段。
  knownCharacters?: SceneCharacter[]
  startSeq: number
  startedAt: number
  scenePublish?: ScenePublish
  castingBook?: CastingBookSnapshot
  video?: SceneVideoDraft
  // 本场次 inspect_last_frame 的结果：有它才允许 opening: continue。
  inspected?: TailFrameVisualState
  skipVideoReason?: string
}

// 上一场次尾帧是整张 data URL，持久化前剥掉，只留“有没有”这件事由 inspected 体现。
const withoutFrameImage = (state: DirectorTurnState): DirectorTurnState => ({
  ...state,
  context: { ...state.context, previousScene: undefined },
})

export const persistTurnState = async (
  session: Session<JsonlSessionMetadata>,
  state: DirectorTurnState,
): Promise<void> => {
  await session.appendCustomEntry(TURN_STATE_CUSTOM_TYPE, toDurableValue(withoutFrameImage(state)))
}

export const readLatestTurnState = (entries: readonly Entry[]): unknown => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry.type === 'custom' && entry.customType === TURN_STATE_CUSTOM_TYPE) return entry.data
  }
  return undefined
}

// 只认新格式、已经写完分镜的场次；旧版逐段循环留下的状态没有 video.opening，不能用来重写。
export const findRewritableScene = (entries: readonly Entry[]): DirectorTurnState | undefined => {
  const latest = readLatestTurnState(entries) as Partial<DirectorTurnState> | undefined
  if (!latest || latest.status !== 'finished' || !latest.scenePublish || !latest.video?.opening || !latest.video.segments?.length) {
    return undefined
  }
  // 旧版状态带 videoMode 字段，已不再使用，去掉以免随重写再次写回。
  const state = { ...latest } as DirectorTurnState & { videoMode?: unknown }
  delete state.videoMode
  return state
}

export type UnresolvedToolCall = { toolCallId: string; toolName: string; arguments: unknown }

type MessageEntry = Extract<Entry, { type: 'message' }>

// JSONL 尾部若是一条带工具调用、还没有对应 toolResult 的 assistant 消息（旧版暂停回合或进程中断留下的），
// 新回合开始前要补一条失败结果，否则模型 API 会拒绝这段历史。
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

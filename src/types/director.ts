import type { SceneCharacter, StoryScene, VideoGenerationRequest } from './story'
import type { SceneCastingResult } from './actor'

export type DirectorStatus = 'idle' | 'thinking' | 'publishing' | 'error'

export type DirectorChatMessage = {
  id: string
  role: 'player' | 'agent' | 'status' | 'error'
  text: string
  createdAt: number
}

export type TraceEntryKind =
  | 'input'
  | 'thinking'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'error'

export type AgentTraceEntry = {
  id: string
  kind: TraceEntryKind
  title: string
  timestamp: number
  text?: string
  data?: unknown
  isError?: boolean
}

export type TraceUsage = {
  input: number
  output: number
  reasoning?: number
  cacheRead: number
  totalTokens: number
  cost: number
}

export type HarnessTraceSnapshot = {
  traceId: string
  harnessSessionId: string
  startedAt: number
  endedAt: number
  durationMs: number
  outcome: 'completed' | 'degraded' | 'aborted' | 'failed' | 'suspended'
  stopReason?: string
  usage?: TraceUsage
  entries: AgentTraceEntry[]
}

export type AgentTraceRun = {
  id: string
  gameSessionId: string
  turn: number
  action: string
  startedAt: number
  endedAt?: number
  status: 'running' | 'completed' | 'degraded' | 'error'
  harnessSessionId?: string
  outcome?: HarnessTraceSnapshot['outcome']
  stopReason?: string
  usage?: TraceUsage
  entries: AgentTraceEntry[]
}

export type AgentTraceUpdate =
  | { type: 'start'; run: AgentTraceRun }
  | { type: 'harness'; traceId: string; snapshot: HarnessTraceSnapshot }
  | { type: 'append'; traceId: string; entry: AgentTraceEntry }
  | { type: 'complete'; traceId: string; endedAt: number }
  | { type: 'error'; traceId: string; endedAt: number; message: string }

export type DirectorStreamEvent =
  | { type: 'status'; text: string }
  | { type: 'trace_started'; traceId: string; harnessSessionId: string; startedAt: number }
  | { type: 'harness_trace'; trace: HarnessTraceSnapshot }
  | { type: 'scene'; scene: StoryScene; characters: SceneCharacter[] }
  | { type: 'cast'; casting: SceneCastingResult }
  | { type: 'cast_error'; message: string }
  | { type: 'video_plan'; video: VideoGenerationRequest }
  | { type: 'video_plan_error'; message: string }
  | { type: 'done' }
  | { type: 'error'; error: string }

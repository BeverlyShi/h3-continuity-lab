import type { CharacterCasting } from './actor'
import type { VideoInputReferenceImage } from './video'
import type {
  SceneCharacter,
  StoryInput,
  StoryScene,
  TailFrameVisualState,
  VideoGenerationRequest,
  VideoPromptSegment,
  VideoReferenceDescriptor,
} from './story'

export type SceneVideoClip = VideoPromptSegment & {
  status: 'written' | 'awaiting_upload' | 'generating' | 'analyzing' | 'ready' | 'failed'
  // written：prompt 已到，导演尚未要求生成；awaiting_upload：等玩家上传/等 fal 或 Comfy；generating：fal（auto）或 Comfy（comfy）生成中
  // analyzing：尾帧已交给服务端 resume，等 VLM 与导演续跑；ready：segment_generated 已到；failed：上传/生成/resume 出错，可重试
  toolCallId?: string
  referenceDescriptors?: VideoReferenceDescriptor[]
  referenceImages?: VideoInputReferenceImage[]
  startImageUrl?: string
  uploadId?: string
  videoUrl?: string
  tailFrameUrl?: string
  actualDuration?: number
  visualState?: TailFrameVisualState
  // Comfy 任务 ID：刷新后凭它接着查原任务，避免重复提交扣费；导演重拍（新的 toolCallId）时清空。
  comfyJobId?: string
  error?: string
}

export type GameScene = StoryScene & {
  id: string
  turn: number
  characterIds?: string[]
  castingStatus?: 'selecting' | 'ready' | 'partial' | 'failed'
  castings?: CharacterCasting[]
  unmatchedCharacterIds?: string[]
  castingError?: string
  videoRequest?: VideoGenerationRequest
  videoClips?: SceneVideoClip[]
  videoMode?: 'auto' | 'comfy' | 'manual' | 'off'
  videoSkippedReason?: string
  tailFrameUrl?: string
  tailVisualState?: TailFrameVisualState
  visualAnalysisError?: string
}

export type GameSessionStatus = 'awaiting_agent' | 'awaiting_upload' | 'awaiting_action'
// awaiting_agent：导演回合（含 resume 后的续跑）进行中
// awaiting_upload：回合暂停，等玩家上传（manual）、fal 生成（auto）或 Comfy 生成（comfy）第 pendingUpload.sequence 段
// awaiting_action：finish_turn 已通过，选项开放

export type GameSession = {
  schemaVersion: 9
  id: string
  storyId: 'palace-validation'
  status: GameSessionStatus
  turn: number
  createdAt: number
  updatedAt: number
  currentScene?: GameScene
  sceneHistory: GameScene[]
  characters: SceneCharacter[]
  castings: CharacterCasting[]
  pendingInput?: StoryInput
  pendingUpload?: { sceneId: string; sequence: number; toolCallId: string; traceId: string }
}

export type DirectorTurnContext = {
  ok: true
  sessionId: string
  turn: number
  input: StoryInput
  previousVisualState?: TailFrameVisualState
  hasPreviousTailFrame?: boolean
}

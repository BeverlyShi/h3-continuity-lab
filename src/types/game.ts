import type { CharacterCasting } from './actor'
import type { VideoInputReferenceImage } from './video'
import type {
  SceneCharacter,
  StoryInput,
  StoryScene,
  VideoGenerationRequest,
  VideoPromptSegment,
  VideoReferenceDescriptor,
} from './story'

export type SceneVideoClip = VideoPromptSegment & {
  status: 'waiting' | 'pending' | 'generating' | 'ready' | 'failed'
  // waiting：等上一段完成（画面参考帧来自上一段尾帧）；pending：可以生成；generating：fal（auto）或 Comfy（comfy）生成中
  // ready：视频与尾帧已就绪；failed：生成出错，可重试或让导演重写
  referenceDescriptors?: VideoReferenceDescriptor[]
  referenceImages?: VideoInputReferenceImage[]
  startImageUrl?: string
  uploadId?: string
  videoUrl?: string
  tailFrameUrl?: string
  actualDuration?: number
  // 生成任务 ID（带后端前缀）：刷新后凭它接着查原任务，避免重复提交扣费；该段被导演重写或作废时清空。
  jobId?: string
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
  videoMode?: 'auto' | 'comfy'
  videoSkippedReason?: string
  // 本场次最后一段的尾帧：下一场次导演选择接着拍时，用它作画面参考帧并交给 inspect_last_frame。
  tailFrameUrl?: string
}

export type GameSessionStatus = 'awaiting_agent' | 'awaiting_video' | 'awaiting_action'
// awaiting_agent：导演正在写本场次（剧情、选角、分镜）
// awaiting_video：导演已交出分镜，页面按段生成视频；全部完成或玩家跳过视频后开放选择
// awaiting_action：选项开放

export type GameSession = {
  schemaVersion: 10
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
}

export type DirectorTurnContext = {
  ok: true
  sessionId: string
  turn: number
  input: StoryInput
  // 上一场次有视频时附上最后一帧（data:image/）和出场人物，供导演按需调用 inspect_last_frame。
  previousScene?: { tailFrameDataUrl: string; characters: SceneCharacter[] }
}

import type { CharacterCasting } from './actor'
import type { VideoInputReferenceImage } from './video'
import type {
  SceneCharacter,
  StoryInput,
  StoryScene,
  TailFrameVisualState,
  VideoGenerationRequest,
  VideoPromptSegment,
} from './story'

export type SceneVideoClip = VideoPromptSegment & {
  status: 'waiting' | 'generating' | 'extracting' | 'analyzing' | 'ready' | 'failed' | 'skipped'
  videoUrl?: string
  startImageUrl?: string
  referenceImages?: VideoInputReferenceImage[]
  tailFrameUrl?: string
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
  tailFrameUrl?: string
  tailVisualState?: TailFrameVisualState
  visualAnalysisError?: string
}

export type GameSessionStatus = 'awaiting_agent' | 'awaiting_media' | 'awaiting_action'

export type GameSession = {
  schemaVersion: 8
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
  previousVisualState?: TailFrameVisualState
}

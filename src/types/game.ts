import type { CharacterCasting } from './actor'
import type { SceneCharacter, StoryInput, StoryScene, VideoGenerationRequest, VideoPromptSegment } from './story'

export type SceneVideoClip = VideoPromptSegment & {
  status: 'waiting' | 'generating' | 'extracting' | 'ready' | 'failed' | 'skipped'
  videoUrl?: string
  startImageUrl?: string
  tailFrameUrl?: string
  error?: string
}

export type GameScene = StoryScene & {
  id: string
  turn: number
  videoRequest?: VideoGenerationRequest
  videoClips?: SceneVideoClip[]
}

export type GameSessionStatus = 'awaiting_agent' | 'awaiting_action'

export type GameSession = {
  schemaVersion: 7
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
}

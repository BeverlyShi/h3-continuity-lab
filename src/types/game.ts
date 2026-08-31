import type { StoryInput, StoryScene, VideoGenerationRequest } from './story'

export type GameScene = StoryScene & {
  id: string
  turn: number
  videoStatus?: 'generating' | 'ready' | 'failed' | 'skipped'
  videoUrl?: string
  videoError?: string
  videoRequest?: VideoGenerationRequest
}

export type GameSessionStatus = 'awaiting_agent' | 'awaiting_action'

export type GameSession = {
  schemaVersion: 4
  id: string
  storyId: 'palace-validation'
  status: GameSessionStatus
  turn: number
  createdAt: number
  updatedAt: number
  currentScene?: GameScene
  sceneHistory: GameScene[]
  pendingInput?: StoryInput
}

export type DirectorTurnContext = {
  ok: true
  sessionId: string
  turn: number
  input: StoryInput
}

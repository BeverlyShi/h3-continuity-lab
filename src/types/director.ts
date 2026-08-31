import type { DirectorResolutionInput } from './game'

export type DirectorStatus = 'idle' | 'thinking' | 'generating' | 'error'

export type DirectorChatMessage = {
  id: string
  role: 'player' | 'agent' | 'status' | 'error'
  text: string
  createdAt: number
}

export type DirectorStreamEvent =
  | { type: 'status'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; text: string }
  | { type: 'resolution'; resolution: DirectorResolutionInput }
  | { type: 'done' }
  | { type: 'error'; error: string }

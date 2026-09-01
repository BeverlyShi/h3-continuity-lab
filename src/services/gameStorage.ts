import type { GameSession } from '../types/game'

const GAME_SESSION_STORAGE_KEY = 'h3-continuity-lab:game-session'

export const loadGameSession = (): GameSession | null => {
  try {
    const raw = localStorage.getItem(GAME_SESSION_STORAGE_KEY)
    if (!raw) return null
    const session = JSON.parse(raw) as GameSession
    if (session.schemaVersion !== 7 || !session.id || session.storyId !== 'palace-validation' || !session.status) return null
    return session
  } catch {
    return null
  }
}

export const saveGameSession = (session: GameSession) => {
  localStorage.setItem(GAME_SESSION_STORAGE_KEY, JSON.stringify(session))
}

export const clearGameSession = () => {
  localStorage.removeItem(GAME_SESSION_STORAGE_KEY)
}

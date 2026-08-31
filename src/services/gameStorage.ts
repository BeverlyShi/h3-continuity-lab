import type { GameSession } from '../types/game'

const GAME_SESSION_STORAGE_KEY = 'h3-continuity-lab:game-session'

const INTERRUPTED_STATUSES = ['generating_opening', 'generating_video']

export const loadGameSession = (): GameSession | null => {
  try {
    const raw = localStorage.getItem(GAME_SESSION_STORAGE_KEY)
    if (!raw) return null
    const session = JSON.parse(raw) as GameSession
    if (session.schemaVersion !== 2 || !session.id || !session.storyId || !session.status) return null
    if (INTERRUPTED_STATUSES.includes(session.status)) {
      return {
        ...session,
        status: 'failed',
        failureStep: session.status === 'generating_opening' ? 'opening' : 'next_scene',
        error: '页面刷新中断了视频生成，请重新生成。',
      }
    }
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

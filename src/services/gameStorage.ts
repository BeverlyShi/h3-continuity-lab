import type { GameSession } from '../types/game'

const GAME_SESSION_STORAGE_KEY = 'h3-continuity-lab:game-session'
const IMAGE_URL_KEYS = new Set(['imageUrl', 'startImageUrl', 'tailFrameUrl'])

export const loadGameSession = (): GameSession | null => {
  try {
    const raw = localStorage.getItem(GAME_SESSION_STORAGE_KEY)
    if (!raw) return null
    const { inlineImages, ...stored } = JSON.parse(raw) as GameSession & { inlineImages?: string[] }
    const session = (inlineImages ? JSON.parse(JSON.stringify(stored), (key, value) => {
      if (IMAGE_URL_KEYS.has(key) && typeof value === 'string' && value.startsWith('session-image:')) {
        return inlineImages[Number(value.slice('session-image:'.length))] ?? value
      }
      return value
    }) : stored) as GameSession
    if (session.schemaVersion !== 8 || !session.id || session.storyId !== 'palace-validation' || !session.status) return null
    for (const scene of [...session.sceneHistory, ...(session.currentScene ? [session.currentScene] : [])]) {
      if (scene.videoMode !== 'manual') continue
      for (const clip of scene.videoClips ?? []) {
        if (!clip.uploadId && ['extracting', 'analyzing'].includes(clip.status)) {
          clip.status = 'failed'
          clip.error = '上次上传处理已中断，请重新上传这一片段。'
        }
      }
    }
    return session
  } catch {
    return null
  }
}

export const saveGameSession = (session: GameSession) => {
  const tails = new Map(session.sceneHistory.flatMap((scene) => (scene.videoClips ?? []).flatMap((clip) =>
    clip.uploadId && clip.tailFrameUrl ? [[clip.tailFrameUrl, `upload-tail:${clip.uploadId}`] as const] : [])))
  const inlineImages: string[] = []
  const imageIds = new Map<string, string>()
  try {
    const compact = JSON.stringify(session, function (key, value) {
      if (key === 'videoUrl' && this.uploadId) return undefined
      if (typeof value !== 'string') return value
      const tail = tails.get(value)
      if (tail) return tail
      if (IMAGE_URL_KEYS.has(key) && value.startsWith('data:image/')) {
        let id = imageIds.get(value)
        if (!id) {
          id = `session-image:${inlineImages.length}`
          imageIds.set(value, id)
          inlineImages.push(value)
        }
        return id
      }
      return value
    })
    localStorage.setItem(GAME_SESSION_STORAGE_KEY, inlineImages.length
      ? JSON.stringify({ ...JSON.parse(compact), inlineImages }) : compact)
  } catch (error) {
    if (error instanceof Error && error.name === 'QuotaExceededError') {
      throw new Error('无法保存场景：浏览器本地存储空间不足。请释放空间后重试。', { cause: error })
    }
    throw error
  }
}

export const clearGameSession = () => {
  localStorage.removeItem(GAME_SESSION_STORAGE_KEY)
}

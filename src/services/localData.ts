import { clearDirectorSessions } from '../director/sessionDatabase.ts'
import { clearSessionImages } from './sessionImageStorage.ts'

// 只清理游戏存档、导演会话历史与视频数据；API Key、模型偏好和演员库保持不变。
const CLEARED_STORAGE_KEYS = [
  'h3-continuity-lab:game-session',
  'h3-continuity-lab:projects',
  'h3-continuity-lab:active-project',
]

const UPLOADED_VIDEO_DATABASE = 'palace-uploaded-videos'

const deleteDatabase = (name: string) => new Promise<void>((resolve) => {
  const request = indexedDB.deleteDatabase(name)
  request.onsuccess = () => resolve()
  request.onerror = () => resolve()
  request.onblocked = () => resolve()
})

export const clearLocalMedia = async () => {
  CLEARED_STORAGE_KEYS.forEach((key) => {
    try {
      localStorage.removeItem(key)
    } catch {
      // 个别键删不掉不影响其余清理
    }
  })
  await deleteDatabase(UPLOADED_VIDEO_DATABASE)
  await clearSessionImages().catch(() => {})
  await clearDirectorSessions()
}

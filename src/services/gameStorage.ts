import type { GameScene, GameSession } from '../types/game.ts'
import { deleteSessionImages, loadSessionImages, saveSessionImage } from './sessionImageStorage.ts'

const GAME_SESSION_STORAGE_KEY = 'h3-continuity-lab:game-session'
const IMAGE_URL_KEYS = new Set(['imageUrl', 'startImageUrl', 'tailFrameUrl'])
const SESSION_IMAGE_PREFIX = 'session-image:'
// 令牌指向的图片已经丢失，替换阶段先打标记，再按字段决定降级方式。
const MISSING_IMAGE = 'missing:session-image'
const IMAGE_KEEP_SCENES = 3

// 同一张图片在多幕之间复用同一个 IndexedDB 记录。
const imageIds = new Map<string, string>()
const imageUrls = new Map<string, string>()

export type SaveGameSessionResult = { degraded: boolean; droppedScenes: number }

const isQuotaError = (error: unknown) => error instanceof Error && error.name === 'QuotaExceededError'

const uploadTailTokens = (session: GameSession) => new Map(session.sceneHistory.flatMap((scene) =>
  (scene.videoClips ?? []).flatMap((clip) =>
    clip.uploadId && clip.tailFrameUrl ? [[clip.tailFrameUrl, `upload-tail:${clip.uploadId}`] as const] : [])))

const serialize = (session: GameSession, pending: Map<string, string>) => {
  const tails = uploadTailTokens(session)
  const created = new Map<string, string>()
  return JSON.stringify(session, function (key, value) {
    if (key === 'videoUrl' && this.uploadId) return undefined
    // 演员三视图只按 actorId 引用，加载时用当前演员库解析。
    if (key === 'imageUrl' && this.type === 'character' && this.actorId) return undefined
    if (typeof value !== 'string') return value
    const tail = tails.get(value)
    if (tail) return tail
    if (IMAGE_URL_KEYS.has(key) && value.startsWith('data:image/')) {
      let id = imageIds.get(value) ?? created.get(value)
      if (!id) {
        id = crypto.randomUUID()
        created.set(value, id)
        pending.set(id, value)
      }
      return `${SESSION_IMAGE_PREFIX}${id}`
    }
    return value
  })
}

const persist = async (session: GameSession) => {
  const pending = new Map<string, string>()
  const compact = serialize(session, pending)
  for (const [id, dataUrl] of pending) {
    await saveSessionImage(id, dataUrl)
    imageIds.set(dataUrl, id)
    imageUrls.set(id, dataUrl)
  }
  localStorage.setItem(GAME_SESSION_STORAGE_KEY, compact)
}

const hasSceneImages = (scene: GameScene) => Boolean(scene.tailFrameUrl) || Boolean(scene.videoClips?.some(
  (clip) => clip.startImageUrl || clip.tailFrameUrl || clip.referenceImages?.length))

const stripSceneImages = (scene: GameScene): GameScene => ({
  ...scene,
  tailFrameUrl: undefined,
  videoClips: scene.videoClips?.map((clip) => ({
    ...clip,
    startImageUrl: undefined,
    referenceImages: undefined,
    tailFrameUrl: undefined,
  })),
})

const dropOldSceneImages = (session: GameSession) => {
  const cutoff = Math.max(0, session.sceneHistory.length - IMAGE_KEEP_SCENES)
  let droppedScenes = 0
  const sceneHistory = session.sceneHistory.map((scene, index) => {
    if (index >= cutoff || !hasSceneImages(scene)) return scene
    droppedScenes += 1
    return stripSceneImages(scene)
  })
  return { session: { ...session, sceneHistory }, droppedScenes }
}

const collectImageIds = (raw: string) => {
  const ids = new Set<string>()
  JSON.parse(raw, (key, value) => {
    if (IMAGE_URL_KEYS.has(key) && typeof value === 'string' && value.startsWith(SESSION_IMAGE_PREFIX)) {
      const id = value.slice(SESSION_IMAGE_PREFIX.length)
      // 旧格式的下标令牌不是 IndexedDB 记录。
      if (!/^\d+$/.test(id)) ids.add(id)
    }
    return value
  })
  return [...ids]
}

const restoreScene = (scene: GameScene) => {
  if (scene.tailFrameUrl === MISSING_IMAGE) scene.tailFrameUrl = undefined
  for (const clip of scene.videoClips ?? []) {
    const lostTailFrame = clip.tailFrameUrl === MISSING_IMAGE
    if (lostTailFrame) clip.tailFrameUrl = undefined
    if (clip.startImageUrl === MISSING_IMAGE) clip.startImageUrl = undefined
    if (clip.referenceImages?.some((reference) => reference.imageUrl === MISSING_IMAGE)) {
      clip.referenceImages = clip.referenceImages.map((reference) =>
        reference.imageUrl === MISSING_IMAGE ? { ...reference, imageUrl: undefined } : reference)
    }
    if (!['extracting', 'analyzing'].includes(clip.status)) continue
    if (scene.videoMode === 'manual' && !clip.uploadId) {
      clip.status = 'failed'
      clip.error = '上次上传处理已中断，请重新上传这一片段。'
    } else if (lostTailFrame) {
      clip.status = 'failed'
      clip.error = '上次尾帧处理已中断，请重试这一片段。'
    }
  }
}

const readRawSession = () => {
  try {
    return localStorage.getItem(GAME_SESSION_STORAGE_KEY)
  } catch {
    return null
  }
}

export const loadGameSession = async (): Promise<GameSession | null> => {
  const raw = readRawSession()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as GameSession & { inlineImages?: string[] }
    const inlineImages = parsed.inlineImages
    const tokens = collectImageIds(raw)
    const missing = tokens.filter((id) => !imageUrls.has(id))
    const stored = await loadSessionImages(missing).catch(() => new Map<string, string>())
    const revived = (tokens.length || inlineImages
      ? JSON.parse(raw, (key, value) => {
          if (!IMAGE_URL_KEYS.has(key) || typeof value !== 'string' || !value.startsWith(SESSION_IMAGE_PREFIX)) return value
          const id = value.slice(SESSION_IMAGE_PREFIX.length)
          // 旧版本把图片内联在 inlineImages 数组里，令牌是下标。
          if (inlineImages && /^\d+$/.test(id)) return inlineImages[Number(id)] ?? MISSING_IMAGE
          return imageUrls.get(id) ?? stored.get(id) ?? MISSING_IMAGE
        })
      : parsed) as GameSession & { inlineImages?: string[] }
    delete revived.inlineImages
    const session = revived as GameSession
    if (session.schemaVersion !== 8 || !session.id || session.storyId !== 'palace-validation' || !session.status) return null
    for (const scene of [...session.sceneHistory, ...(session.currentScene ? [session.currentScene] : [])]) {
      restoreScene(scene)
    }
    return session
  } catch {
    return null
  }
}

export const saveGameSession = async (session: GameSession): Promise<SaveGameSessionResult> => {
  try {
    await persist(session)
    return { degraded: false, droppedScenes: 0 }
  } catch (error) {
    if (!isQuotaError(error)) throw error
    const trimmed = dropOldSceneImages(session)
    if (trimmed.droppedScenes) {
      try {
        await persist(trimmed.session)
        return { degraded: true, droppedScenes: trimmed.droppedScenes }
      } catch (retryError) {
        if (!isQuotaError(retryError)) throw retryError
      }
    }
    throw new Error('无法保存场景：浏览器本地存储空间不足。请释放空间后重试。', { cause: error })
  }
}

export const clearGameSession = async () => {
  const raw = readRawSession()
  try {
    localStorage.removeItem(GAME_SESSION_STORAGE_KEY)
  } catch {
    // 删不掉旧存档时至少清理内存缓存与图片。
  }
  const ids = new Set([...(raw ? collectImageIds(raw) : []), ...imageUrls.keys()])
  imageIds.clear()
  imageUrls.clear()
  await deleteSessionImages([...ids]).catch(() => {})
}

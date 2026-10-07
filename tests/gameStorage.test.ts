import assert from 'node:assert/strict'
import test from 'node:test'
import { clearGameSession, loadGameSession, saveGameSession } from '../src/services/gameStorage.ts'
import { clearLocalMedia } from '../src/services/localData.ts'
import { installMemorySessionImages } from './helpers/memorySessionImages.ts'
import type { GameScene, GameSession } from '../src/types/game.ts'

const tailFrame = `data:image/jpeg;base64,${'a'.repeat(200_000)}`

const makeScene = (id: string, overrides: Partial<GameScene> = {}): GameScene => ({
  id, turn: 1, title: `第 ${id} 场次`, narrative: '宫门打开。', choices: [],
  tailFrameUrl: tailFrame,
  videoClips: [{
    sequence: 1, startTime: 0, endTime: 5, characterIds: ['heroine'], prompt: '人物回望。',
    status: 'ready', startImageUrl: tailFrame, tailFrameUrl: tailFrame,
    referenceImages: [{ type: 'character', imageUrl: 'three-view.jpg', label: '人物参考 · 沈清禾', actorId: 'actor-1' }],
  }],
  ...overrides,
})

const makeSession = (scenes: GameScene[]): GameSession => ({
  schemaVersion: 10, id: 'game', storyId: 'palace-validation', status: 'awaiting_video',
  turn: scenes.length, createdAt: 1, updatedAt: 2,
  currentScene: scenes.at(-1), sceneHistory: scenes, characters: [], castings: [],
})

// 每个用例都用独立的 localStorage 与内存图片库，测试之间不共享模块缓存。
const withStorage = async (
  run: (context: {
    images: Map<string, string>
    read: () => string
    limit: (bytes: number) => void
  }) => Promise<void>,
) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const sessionImages = installMemorySessionImages()
  const entries = new Map<string, string>()
  let limit = Number.POSITIVE_INFINITY
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (value.length > limit) throw new DOMException('Quota exceeded', 'QuotaExceededError')
      entries.set(key, value)
    },
    removeItem: (key: string) => { entries.delete(key) },
  } })
  try {
    await run({
      images: sessionImages.images,
      read: () => entries.get('h3-continuity-lab:game-session') ?? '',
      limit: (bytes: number) => { limit = bytes },
    })
  } finally {
    await clearGameSession()
    sessionImages.restore()
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
}

test('keeps every image out of localStorage and stores one record per data URL', async () => {
  await withStorage(async ({ images, read }) => {
    await saveGameSession(makeSession([makeScene('one'), makeScene('two')]))
    assert.doesNotMatch(read(), /data:image\//)
    assert.equal(images.size, 1, '同一张 data URL 只写一次 IndexedDB')
    await saveGameSession(makeSession([makeScene('one'), makeScene('two'), makeScene('three')]))
    assert.equal(images.size, 1, '已存过的图片不再重复写入')
  })
})

test('restores tail frames from IndexedDB and keeps character references as actor ids', async () => {
  await withStorage(async ({ read }) => {
    await saveGameSession(makeSession([makeScene('one')]))
    const stored = JSON.parse(read()) as GameSession
    const storedReference = stored.sceneHistory[0].videoClips?.[0].referenceImages?.[0]
    assert.equal(storedReference?.actorId, 'actor-1')
    assert.equal(storedReference?.imageUrl, undefined)
    const restored = (await loadGameSession())!
    assert.equal(restored.sceneHistory[0].tailFrameUrl, tailFrame)
    assert.equal(restored.sceneHistory[0].videoClips?.[0].startImageUrl, tailFrame)
    assert.equal(restored.currentScene?.videoClips?.[0].tailFrameUrl, tailFrame)
  })
})

test('drops a lost tail frame when the image record is gone', async () => {
  await withStorage(async () => {
    // 图片记录丢失（例如清理过 IndexedDB）时，令牌无法还原。
    const scene = makeScene('one', { videoMode: 'auto' })
    scene.tailFrameUrl = 'session-image:lost'
    scene.videoClips![0] = { ...scene.videoClips![0], startImageUrl: 'session-image:lost', tailFrameUrl: 'session-image:lost' }
    localStorage.setItem('h3-continuity-lab:game-session', JSON.stringify(makeSession([scene])))
    const restored = (await loadGameSession())!
    const clip = restored.sceneHistory[0].videoClips?.[0]
    assert.equal(restored.sceneHistory[0].tailFrameUrl, undefined)
    assert.equal(clip?.tailFrameUrl, undefined)
    assert.equal(clip?.startImageUrl, undefined)
  })
})

test('marks an interrupted generating clip as failed and keeps its Comfy job', async () => {
  await withStorage(async () => {
    const scene = makeScene('one', { videoMode: 'comfy' })
    scene.videoClips![0] = { ...scene.videoClips![0], status: 'generating', comfyJobId: 'job-1', tailFrameUrl: undefined, startImageUrl: undefined }
    localStorage.setItem('h3-continuity-lab:game-session', JSON.stringify(makeSession([scene])))
    const restored = (await loadGameSession())!
    const clip = restored.sceneHistory[0].videoClips?.[0]
    assert.equal(clip?.status, 'failed')
    assert.match(clip?.error ?? '', /中断/)
    assert.equal(clip?.comfyJobId, 'job-1', '刷新后凭任务 ID 接着查原任务，不重复扣费')
  })
})

test('rejects a session saved with an older schemaVersion', async () => {
  await withStorage(async () => {
    localStorage.setItem('h3-continuity-lab:game-session', JSON.stringify({
      ...makeSession([makeScene('one')]), schemaVersion: 9,
    }))
    assert.equal(await loadGameSession(), null)
  })
})

test('reads the legacy inlineImages format once and rewrites it into IndexedDB', async () => {
  await withStorage(async ({ images, read }) => {
    const legacy = {
      schemaVersion: 10, id: 'game', storyId: 'palace-validation', status: 'awaiting_video',
      turn: 1, createdAt: 1, updatedAt: 2, sceneHistory: [{
        id: 'one', turn: 1, title: '旧存档', narrative: '旧存档。', choices: [],
        tailFrameUrl: 'session-image:0',
        videoClips: [{ sequence: 1, startTime: 0, endTime: 5, characterIds: [], prompt: '回望。',
          status: 'ready', tailFrameUrl: 'session-image:0' }],
      }], characters: [], castings: [], inlineImages: [tailFrame],
    }
    localStorage.setItem('h3-continuity-lab:game-session', JSON.stringify(legacy))
    const restored = (await loadGameSession())!
    assert.equal(restored.sceneHistory[0].tailFrameUrl, tailFrame)
    assert.equal((restored as GameSession & { inlineImages?: string[] }).inlineImages, undefined)
    await saveGameSession(restored)
    assert.doesNotMatch(read(), /data:image\/|inlineImages/)
    assert.equal(images.size, 1)
  })
})

test('degrades by dropping images of the oldest scenes when the quota is exceeded', async () => {
  await withStorage(async ({ limit, read }) => {
    const scenes = ['one', 'two', 'three', 'four', 'five'].map((id) => makeScene(id))
    await saveGameSession(makeSession(scenes))
    limit(read().length - 1)
    const result = await saveGameSession(makeSession(scenes))
    assert.deepEqual(result, { degraded: true, droppedScenes: 2 })
    const stored = JSON.parse(read()) as GameSession
    assert.equal(stored.sceneHistory[0].tailFrameUrl, undefined)
    assert.equal(stored.sceneHistory[0].videoClips?.[0].startImageUrl, undefined)
    assert.equal(stored.sceneHistory[0].videoClips?.[0].referenceImages, undefined)
    assert.ok(stored.sceneHistory[4].tailFrameUrl?.startsWith('session-image:'), '最近三个场次保留图片引用')
  })
})

test('reports the storage error when even the degraded session does not fit', async () => {
  await withStorage(async ({ limit }) => {
    limit(10)
    await assert.rejects(saveGameSession(makeSession([makeScene('one')])), /本地存储空间不足/)
  })
})

test('clearLocalMedia only removes session, project and media keys', async () => {
  await withStorage(async ({ images }) => {
    await saveGameSession(makeSession([makeScene('one')]))
    localStorage.setItem('h3-continuity-lab:projects', '[]')
    localStorage.setItem('h3-continuity-lab:active-project', 'project-1')
    localStorage.setItem('h3-continuity-lab:fal-key', 'fal')
    localStorage.setItem('h3-continuity-lab:deepseek-key', 'deepseek')
    localStorage.setItem('palace-director-model', 'deepseek-chat')
    const deleted: string[] = []
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {
      deleteDatabase: (name: string) => {
        deleted.push(name)
        const request: { onsuccess?: () => void; onerror?: () => void; onblocked?: () => void } = {}
        setTimeout(() => request.onsuccess?.(), 0)
        return request
      },
    } })
    try {
      await clearLocalMedia()
    } finally {
      Reflect.deleteProperty(globalThis, 'indexedDB')
    }
    assert.deepEqual(deleted, ['palace-uploaded-videos'])
    assert.equal(images.size, 0)
    assert.equal(localStorage.getItem('h3-continuity-lab:game-session'), null)
    assert.equal(localStorage.getItem('h3-continuity-lab:projects'), null)
    assert.equal(localStorage.getItem('h3-continuity-lab:active-project'), null)
    assert.equal(localStorage.getItem('h3-continuity-lab:fal-key'), 'fal')
    assert.equal(localStorage.getItem('h3-continuity-lab:deepseek-key'), 'deepseek')
    assert.equal(localStorage.getItem('palace-director-model'), 'deepseek-chat')
  })
})

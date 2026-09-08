import assert from 'node:assert/strict'
import test from 'node:test'
import { applyManualClip, buildManualPrompt, invalidateManualClipsFrom, prepareManualScene } from '../src/services/manualSceneVideo.ts'
import { clearGameSession, saveGameSession, loadGameSession } from '../src/services/gameStorage.ts'
import { installMemorySessionImages } from './helpers/memorySessionImages.ts'
import type { GameScene, GameSession } from '../src/types/game.ts'

const scene: GameScene = {
  id: 'manual-scene', turn: 1, title: '宫门初雪', narrative: '宫门打开，少女停在廊下。', choices: [],
  videoClips: [1, 2, 3].map((sequence) => ({
    sequence, startTime: (sequence - 1) * 5, endTime: sequence * 5,
    characterIds: ['heroine'], prompt: '人物停步回望，保持构图稳定。', endFrame: '少女站定。', audio: '脚步声', status: 'skipped',
  })),
}
const references = { heroine: { characterName: '沈清禾', actorId: 'actor-heroine', imageUrl: 'actor.jpg' } }

test('manual mode prepares character images without starting generation and waits for real preceding tails', () => {
  const prepared = prepareManualScene(scene, references)
  assert.equal(prepared.videoMode, 'manual')
  assert.deepEqual(prepared.videoClips?.map((clip) => clip.status), ['awaiting_upload', 'waiting', 'waiting'])
  assert.deepEqual(prepared.videoClips?.[0].referenceImages, [{ type: 'character', imageUrl: 'actor.jpg', label: '人物参考 · 沈清禾', actorId: 'actor-heroine' }])
  assert.deepEqual(prepared.videoClips?.[1].referenceImages, [])
  assert.match(buildManualPrompt(prepared.videoClips![0]), /沈清禾外观与图1一致/)
})

test('the next scene uses the actual previous scene tail instead of actor portraits', () => {
  const prepared = prepareManualScene(scene, references, 'previous-tail.jpg')
  assert.equal(prepared.videoClips?.[0].startImageUrl, 'previous-tail.jpg')
  assert.deepEqual(prepared.videoClips?.[0].referenceImages?.map((image) => image.type), ['start_frame'])
  assert.match(buildManualPrompt(prepared.videoClips![0]), /以图1为起始画面/)
})

test('uploading one segment unlocks only its successor and preserves the planned timing', () => {
  const prepared = prepareManualScene(scene, references)
  const applied = applyManualClip(prepared, 1, { status: 'ready', uploadId: 'v1', videoUrl: 'blob:v1', tailFrameUrl: 'tail1.jpg', actualDuration: 6.7 })
  assert.deepEqual(applied.videoClips?.map((clip) => clip.status), ['ready', 'awaiting_upload', 'waiting'])
  assert.equal(applied.videoClips?.[0].actualDuration, 6.7)
  assert.equal(applied.videoClips?.[0].endTime, 5)
  assert.equal(applied.videoClips?.[1].startImageUrl, 'tail1.jpg')
  assert.deepEqual(applied.videoClips?.[1].referenceImages, [{ type: 'start_frame', imageUrl: 'tail1.jpg', label: '起始尾帧' }])
})

test('replacing a middle segment clears dependent videos and scene visual state, keeping the previous segment', () => {
  let completed = prepareManualScene(scene, references)
  for (let sequence = 1; sequence <= 3; sequence++) {
    completed = applyManualClip(completed, sequence, { status: 'ready', uploadId: `v${sequence}`, videoUrl: `blob:v${sequence}`, tailFrameUrl: `tail${sequence}.jpg`, actualDuration: 7 })
  }
  completed.tailFrameUrl = 'tail3.jpg'
  completed.visualAnalysisError = 'old error'
  const reset = invalidateManualClipsFrom(completed, 2)
  assert.deepEqual(reset.videoClips?.[0], completed.videoClips?.[0])
  assert.equal(reset.videoClips?.[1].startImageUrl, 'tail1.jpg')
  assert.equal(reset.videoClips?.[1].videoUrl, undefined)
  assert.equal(reset.videoClips?.[2].uploadId, undefined)
  assert.equal(reset.videoClips?.[2].tailFrameUrl, undefined)
  assert.equal(reset.videoClips?.[2].startImageUrl, undefined)
  assert.equal(reset.videoClips?.[2].actualDuration, undefined)
  assert.equal(reset.tailFrameUrl, undefined)
  assert.equal(reset.tailVisualState, undefined)
  assert.equal(reset.visualAnalysisError, undefined)
})

test('switching into manual mode retains existing completed videos', () => {
  const completed = applyManualClip(scene, 1, { status: 'ready', videoUrl: 'video1.mp4', tailFrameUrl: 'tail1.jpg' })
  const prepared = prepareManualScene(completed, references)
  assert.deepEqual(prepared.videoClips?.[0], completed.videoClips?.[0])
  assert.equal(prepared.videoClips?.[1].startImageUrl, 'tail1.jpg')
})

test('localStorage keeps durable upload ids rather than blob URLs and repeated inline tail images', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const sessionImages = installMemorySessionImages()
  let stored = ''
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    setItem: (_key: string, value: string) => { stored = value },
    getItem: () => stored,
    removeItem: () => { stored = '' },
  } })
  try {
    const prepared = applyManualClip(prepareManualScene(scene, references), 1, {
      status: 'ready', uploadId: 'uploaded-1', videoUrl: 'blob:temporary', tailFrameUrl: 'data:image/jpeg;base64,tail', actualDuration: 7,
    })
    const session = { schemaVersion: 8, id: 'game', storyId: 'palace-validation', status: 'awaiting_media', currentScene: prepared, sceneHistory: [prepared] } as GameSession
    await saveGameSession(session)
    assert.doesNotMatch(stored, /blob:temporary|data:image/)
    const restored = (await loadGameSession())!
    assert.equal(restored.currentScene?.videoClips?.[0].uploadId, 'uploaded-1')
    assert.equal(restored.currentScene?.videoClips?.[1].startImageUrl, 'upload-tail:uploaded-1')
    assert.equal(prepared.videoClips?.[0].videoUrl, 'blob:temporary')
  } finally {
    await clearGameSession()
    sessionImages.restore()
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('reload recovers a stranded manual extraction without changing automatic generation', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const manual = invalidateManualClipsFrom(prepareManualScene(scene, references), 1)
  const automatic = { ...manual, id: 'automatic', videoMode: 'auto' }
  const stored = JSON.stringify({ schemaVersion: 8, id: 'game', storyId: 'palace-validation',
    status: 'awaiting_media', currentScene: manual, sceneHistory: [automatic, manual] })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => stored } })
  try {
    const restored = (await loadGameSession())!
    assert.equal(restored.currentScene?.videoClips?.[0].status, 'failed')
    assert.match(restored.currentScene?.videoClips?.[0].error ?? '', /重新上传/)
    assert.equal(restored.sceneHistory[1].videoClips?.[0].status, 'failed')
    assert.equal(restored.sceneHistory[0].videoClips?.[0].status, 'extracting')
    assert.equal(restored.currentScene?.videoClips?.[1].status, 'waiting')
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('large images stay out of localStorage and are shared by current and historical scenes', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const sessionImages = installMemorySessionImages()
  const imageUrl = `data:image/jpeg;base64,${'a'.repeat(3_000_000)}`
  const prepared = applyManualClip(prepareManualScene(scene, references), 1, { status: 'ready', tailFrameUrl: imageUrl })
  const nextScene = { ...prepared, id: 'next-scene', turn: 2 }
  const session = { schemaVersion: 8, id: 'game', storyId: 'palace-validation', status: 'awaiting_media',
    currentScene: nextScene, sceneHistory: [prepared, nextScene] } as GameSession
  let stored = ''
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => stored,
    removeItem: () => { stored = '' },
    setItem: (_key: string, value: string) => {
      if (value.length > 5_000_000) throw new DOMException('Quota exceeded', 'QuotaExceededError')
      stored = value
    },
  } })
  try {
    await saveGameSession(session)
    assert.doesNotMatch(stored, /data:image/)
    assert.equal(sessionImages.images.size, 1, 'history and current scene must share one stored image')
    const restored = (await loadGameSession())!
    assert.equal(restored.currentScene?.videoClips?.[0].tailFrameUrl, imageUrl)
    assert.equal(restored.sceneHistory[0].videoClips?.[1].startImageUrl, imageUrl)
    assert.equal(prepared.videoClips?.[0].referenceImages?.[0].imageUrl, 'actor.jpg')
  } finally {
    await clearGameSession()
    sessionImages.restore()
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

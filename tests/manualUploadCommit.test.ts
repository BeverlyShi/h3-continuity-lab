import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { createServer } from 'vite'
import type { GameSession } from '../src/types/game.ts'
import type { useGameSession } from '../src/hooks/useGameSession.ts'

test('manual upload commits the video and successor together and survives storage failure', async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' })
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  try {
    const module = await server.ssrLoadModule('/src/hooks/useGameSession.ts')
    const scene = {
      id: 'scene', turn: 1, title: '测试', narrative: '测试', choices: [], videoMode: 'manual' as const,
      videoClips: [1, 2, 3].map((sequence) => ({
        sequence, startTime: (sequence - 1) * 5, endTime: sequence * 5,
        characterIds: [], prompt: '回头', endFrame: '站定', audio: '',
        status: 'ready' as const, uploadId: `old-${sequence}`,
        tailFrameUrl: `old-tail-${sequence}`, videoUrl: `blob:old-${sequence}`,
      })),
    }
    let stored = JSON.stringify({
      schemaVersion: 8, id: 'session', storyId: 'palace-validation', status: 'awaiting_media',
      currentScene: scene, sceneHistory: [scene],
    })
    const writes: GameSession[] = []
    let quotaExceeded = true
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        if (quotaExceeded) throw new DOMException('Quota exceeded', 'QuotaExceededError')
        writes.push(JSON.parse(value))
        stored = value
      },
    } })
    let game: ReturnType<typeof useGameSession>
    function Harness() { game = module.useGameSession(); return null }
    renderToString(createElement(Harness))
    const uploaded = { uploadId: 'new-2', videoUrl: 'blob:new-2', tailFrameUrl: 'new-tail-2', actualDuration: 7 }
    assert.throws(() => game.completeManualUpload('scene', 2, uploaded), /存储空间不足/)
    assert.equal(writes.length, 0)

    // A later no-op update reads the live session ref: failed persistence must not have cleared old clips.
    quotaExceeded = false
    game!.updateSceneVideoClip('scene', 99, {})
    assert.deepEqual(writes[0].currentScene?.videoClips?.map((clip) => [clip.status, clip.uploadId]), [
      ['ready', 'old-1'], ['ready', 'old-2'], ['ready', 'old-3'],
    ])

    assert.equal(game!.completeManualUpload('scene', 2, uploaded), true)
    assert.equal(writes.length, 2, 'a successful upload must perform only one session write')
    const committed = writes[1].currentScene!
    assert.deepEqual(committed.videoClips?.map((clip) => clip.status), ['ready', 'ready', 'awaiting_upload'])
    assert.equal(committed.videoClips?.[1].uploadId, 'new-2')
    assert.equal(committed.videoClips?.[1].actualDuration, 7)
    assert.equal(committed.videoClips?.[2].uploadId, undefined)
    assert.equal(committed.videoClips?.[2].startImageUrl, 'upload-tail:new-2')
    assert.deepEqual(writes[1].sceneHistory[0], committed)
    assert.equal(game!.completeManualUpload('another-scene', 2, uploaded), false)
    assert.equal(writes.length, 2)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
    await server.close()
  }
})

test('Prompt preparation keeps its output available for retry when browser storage is full', async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' })
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  try {
    const module = await server.ssrLoadModule('/src/hooks/useGameSession.ts')
    const scene = { id: 'scene', videoClips: [{ sequence: 1, status: 'awaiting_upload',
      characterIds: ['heroine'], prompt: '刚生成的 Prompt' }] }
    let stored = JSON.stringify({ schemaVersion: 8, id: 'session', storyId: 'palace-validation',
      status: 'awaiting_media', currentScene: scene, sceneHistory: [scene] })
    let quotaExceeded = true
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        if (quotaExceeded) throw new DOMException('Quota exceeded', 'QuotaExceededError')
        stored = value
      },
    } })
    let game: ReturnType<typeof useGameSession>
    function Harness() { game = module.useGameSession(); return null }
    renderToString(createElement(Harness))
    assert.doesNotThrow(() => game.prepareManualVideo('scene', {
      heroine: { characterName: '女主', imageUrl: 'actor.jpg' },
    }), 'an effect preparing references must not throw and unmount the page')
    assert.doesNotThrow(() => game!.retrySaveSession())
    quotaExceeded = false
    game!.retrySaveSession()
    const saved = JSON.parse(stored) as GameSession
    assert.equal(saved.currentScene?.videoMode, 'manual')
    assert.equal(saved.currentScene?.videoClips?.[0].prompt, '刚生成的 Prompt')
    assert.equal(saved.currentScene?.videoClips?.[0].referenceImages?.[0].imageUrl, 'actor.jpg')
    assert.deepEqual(saved.currentScene, saved.sceneHistory[0])
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
    await server.close()
  }
})

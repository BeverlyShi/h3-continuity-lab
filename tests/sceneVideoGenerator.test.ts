import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSceneVideoSegments } from '../src/services/sceneVideoGenerator.ts'
import type { VideoGenerator } from '../src/types/video.ts'
import type { VideoGenerationRequest } from '../src/types/story.ts'

const request: VideoGenerationRequest = {
  totalDuration: 20,
  videoPrompts: [
    { sequence: 1, startTime: 0, endTime: 5, characterIds: ['heroine'], prompt: '0秒-4秒：第一段宫廷场景，人物向前行走，镜头保持稳定。' },
    { sequence: 2, startTime: 5, endTime: 12, transitionFromPrevious: 'continuous', characterIds: ['heroine'], prompt: '5秒-11秒：开场延续上一画面，人物继续行走并开口说话。' },
    { sequence: 3, startTime: 12, endTime: 20, transitionFromPrevious: 'cut', characterIds: ['girl'], prompt: '12秒-19秒：切到圆脸少女近景，她停下脚步回头看向身后。' },
  ],
}

test('routes continuous segments through the previous tail and cut segments through references', async () => {
  const calls: Array<{ sequence: number; duration: number; startImageUrl?: string; references: string[] }> = []
  const generator: VideoGenerator = {
    generate: async (_prompt, duration, sequence, conditioning) => {
      calls.push({
        sequence,
        duration,
        startImageUrl: conditioning?.startImageUrl,
        references: conditioning?.characterReferences?.map((reference) => reference.characterName) ?? [],
      })
      return { videoUrl: `video-${sequence}.mp4` }
    },
    createTailFrameUrl: async (videoUrl) => `${videoUrl}.jpg`,
  }
  const results: Array<{ sequence: number; status: string }> = []

  await generateSceneVideoSegments(generator, request, ({ sequence, status }) => {
    results.push({ sequence, status })
  }, {
    characterReferences: {
      heroine: { characterName: '沈映棠', imageUrl: 'heroine.jpg' },
      girl: { characterName: '圆脸少女', imageUrl: 'girl.jpg' },
    },
  })

  assert.deepEqual(calls, [
    { sequence: 1, duration: 5, startImageUrl: undefined, references: ['沈映棠'] },
    { sequence: 2, duration: 7, startImageUrl: 'video-1.mp4.jpg', references: [] },
    { sequence: 3, duration: 8, startImageUrl: undefined, references: ['圆脸少女'] },
  ])
  assert.deepEqual(results, [
    { sequence: 1, status: 'generating' },
    { sequence: 1, status: 'extracting' },
    { sequence: 1, status: 'ready' },
    { sequence: 2, status: 'generating' },
    { sequence: 2, status: 'ready' },
    { sequence: 3, status: 'generating' },
    { sequence: 3, status: 'ready' },
  ])
})

test('skips blocked continuous dependencies but continues at the next cut', async () => {
  const started: number[] = []
  const generator: VideoGenerator = {
    generate: async (_prompt, _duration, sequence) => {
      started.push(sequence)
      if (sequence === 2) throw new Error('generation failed')
      return { videoUrl: `video-${sequence}.mp4` }
    },
    createTailFrameUrl: async (videoUrl) => `${videoUrl}.jpg`,
  }
  const failed: number[] = []

  await generateSceneVideoSegments(generator, request, (result) => {
    if (result.status === 'failed') failed.push(result.sequence)
  })

  assert.deepEqual(started, [1, 2, 3])
  assert.deepEqual(failed, [2])
})

test('can resume from a failed segment using the previous tail frame', async () => {
  const calls: Array<{ sequence: number; startImageUrl?: string }> = []
  const generator: VideoGenerator = {
    generate: async (_prompt, _duration, sequence, conditioning) => {
      calls.push({ sequence, startImageUrl: conditioning?.startImageUrl })
      return { videoUrl: `retry-${sequence}.mp4` }
    },
    createTailFrameUrl: async (videoUrl) => `${videoUrl}.jpg`,
  }

  await generateSceneVideoSegments(generator, request, () => {}, {
    startSequence: 2,
    endSequence: 2,
    initialTailFrameUrl: 'video-1-tail.jpg',
  })

  assert.deepEqual(calls, [
    { sequence: 2, startImageUrl: 'video-1-tail.jpg' },
  ])
})

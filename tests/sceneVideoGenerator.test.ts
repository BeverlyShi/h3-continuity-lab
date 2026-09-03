import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSceneVideoSegments } from '../src/services/sceneVideoGenerator.ts'
import type { VideoGenerator } from '../src/types/video.ts'
import type { VideoGenerationRequest } from '../src/types/story.ts'

const request: VideoGenerationRequest = {
  totalDuration: 20,
  videoPrompts: [
    { sequence: 1, startTime: 0, endTime: 5, characterIds: ['heroine'], prompt: '0秒-4秒：第一段宫廷场景，人物向前行走，镜头保持稳定。' },
    { sequence: 2, startTime: 5, endTime: 12, characterIds: ['heroine'], prompt: '5秒-11秒：开场延续上一画面，人物继续行走并开口说话。' },
    { sequence: 3, startTime: 12, endTime: 20, characterIds: ['girl'], prompt: '12秒-19秒：切到圆脸少女近景，她停下脚步回头看向身后。' },
  ],
}

test('pads every later segment with the previous tail frame', async () => {
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
  const referenceImages: Array<{ sequence: number; labels: string[] }> = []

  await generateSceneVideoSegments(generator, request, ({ sequence, status, referenceImages: images }) => {
    results.push({ sequence, status })
    if (status === 'generating') {
      referenceImages.push({ sequence, labels: images?.map((image) => image.label) ?? [] })
    }
  }, {
    characterReferences: {
      heroine: { characterName: '沈映棠', imageUrl: 'heroine.jpg' },
      girl: { characterName: '圆脸少女', imageUrl: 'girl.jpg' },
    },
  })

  assert.deepEqual(calls, [
    { sequence: 1, duration: 5, startImageUrl: undefined, references: ['沈映棠'] },
    { sequence: 2, duration: 7, startImageUrl: 'video-1.mp4.jpg', references: [] },
    { sequence: 3, duration: 8, startImageUrl: 'video-2.mp4.jpg', references: [] },
  ])
  assert.deepEqual(referenceImages, [
    { sequence: 1, labels: ['人物参考 · 沈映棠'] },
    { sequence: 2, labels: ['起始尾帧'] },
    { sequence: 3, labels: ['起始尾帧'] },
  ])
  assert.deepEqual(results, [
    { sequence: 1, status: 'generating' },
    { sequence: 1, status: 'extracting' },
    { sequence: 1, status: 'ready' },
    { sequence: 2, status: 'generating' },
    { sequence: 2, status: 'extracting' },
    { sequence: 2, status: 'ready' },
    { sequence: 3, status: 'generating' },
    { sequence: 3, status: 'extracting' },
    { sequence: 3, status: 'ready' },
  ])
})

test('keeps later segments blocked when the previous tail cannot be produced', async () => {
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

  assert.deepEqual(started, [1, 2])
  assert.deepEqual(failed, [2])
})

test('can resume from a failed segment using the previous tail frame', async () => {
  const calls: Array<{ sequence: number; startImageUrl?: string; references: string[] }> = []
  const displayedReferences: string[][] = []
  const generator: VideoGenerator = {
    generate: async (_prompt, _duration, sequence, conditioning) => {
      calls.push({
        sequence,
        startImageUrl: conditioning?.startImageUrl,
        references: conditioning?.characterReferences?.map((reference) => reference.imageUrl) ?? [],
      })
      return { videoUrl: `retry-${sequence}.mp4` }
    },
    createTailFrameUrl: async (videoUrl) => `${videoUrl}.jpg`,
  }

  await generateSceneVideoSegments(generator, request, (result) => {
    if (result.status === 'generating') {
      displayedReferences.push(result.referenceImages?.map((reference) => reference.imageUrl) ?? [])
    }
  }, {
    startSequence: 2,
    endSequence: 2,
    initialTailFrameUrl: 'video-1-tail.jpg',
    characterReferences: {
      heroine: { characterName: '沈映棠', imageUrl: 'heroine.jpg' },
    },
  })

  assert.deepEqual(calls, [
    { sequence: 2, startImageUrl: 'video-1-tail.jpg', references: [] },
  ])
  assert.deepEqual(displayedReferences, [['video-1-tail.jpg']])
})

test('reports an empty reference list when fal receives no image input', async () => {
  const sentImages: string[][] = []
  const displayedImages: string[][] = []
  const generator: VideoGenerator = {
    generate: async (_prompt, _duration, _sequence, conditioning) => {
      sentImages.push([
        ...(conditioning?.startImageUrl ? [conditioning.startImageUrl] : []),
        ...(conditioning?.characterReferences?.map((reference) => reference.imageUrl) ?? []),
      ])
      return { videoUrl: 'video-1.mp4' }
    },
    createTailFrameUrl: async () => 'video-1-tail.jpg',
  }

  await generateSceneVideoSegments(generator, {
    totalDuration: 5,
    videoPrompts: [request.videoPrompts[0]],
  }, (result) => {
    if (result.status === 'generating') {
      displayedImages.push(result.referenceImages?.map((reference) => reference.imageUrl) ?? [])
    }
  })

  assert.deepEqual(sentImages, [[]])
  assert.deepEqual(displayedImages, [[]])
})

test('analyzes only the final scene tail frame before reporting it ready', async () => {
  const analyzed: string[] = []
  const statuses: string[] = []
  const generator: VideoGenerator = {
    generate: async (_prompt, _duration, sequence) => ({ videoUrl: `video-${sequence}.mp4` }),
    createTailFrameUrl: async (videoUrl) => `${videoUrl}.jpg`,
  }

  await generateSceneVideoSegments(generator, request, (result) => {
    statuses.push(`${result.sequence}:${result.status}`)
  }, {
    analyzeTailFrame: async (imageUrl) => {
      analyzed.push(imageUrl)
      return {
        shot_size: '中景',
        shot_position: '人物正前方',
        shot_content: {
          characters: [],
          scene: {
            location: '宫墙甬道', visible_elements: '宫墙',
            lighting: '清晨柔光', time_of_day: '清晨',
          },
          key_props: [],
        },
        frame_quality: '清晰稳定',
      }
    },
  })

  assert.deepEqual(analyzed, ['video-3.mp4.jpg'])
  assert.deepEqual(statuses.slice(-3), ['3:extracting', '3:analyzing', '3:ready'])
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { Check } from 'typebox/value'
import {
  scenePublishSchema,
  storySceneSchema,
  videoGenerationRequestSchema,
  videoPlanSchema,
} from '../src/types/story.ts'

const makeScene = (choiceCount: number) => ({
  title: '宫门初雪',
  narrative: '宫门在身后缓缓合拢，沈清禾第一次听见深宫里的晨钟，队伍已经向前移动。',
  choices: Array.from({ length: choiceCount }, (_, index) => ({
    id: String.fromCharCode(65 + index),
    text: `第 ${index + 1} 个选择`,
  })),
})

test('accepts exactly two or three story choices', () => {
  assert.equal(Check(storySceneSchema, makeScene(2)), true)
  assert.equal(Check(storySceneSchema, makeScene(3)), true)
  assert.equal(Check(storySceneSchema, makeScene(1)), false)
  assert.equal(Check(storySceneSchema, makeScene(4)), false)
})

test('rejects extra scene fields', () => {
  assert.equal(Check(storySceneSchema, { ...makeScene(2), directorBoardPatch: {} }), false)
  assert.equal(Check(storySceneSchema, {
    ...makeScene(2),
    scene: { title: '宫门初雪', location: '储秀宫外', time: '入宫第一日', atmosphere: '细雪无声' },
  }), false)
  assert.equal(Check(storySceneSchema, { ...makeScene(2), objects: [] }), false)
  assert.equal(Check(storySceneSchema, { ...makeScene(2), characters: [] }), false)
  assert.equal(Check(storySceneSchema, {
    ...makeScene(2),
    choices: [{ id: 'A', text: '捡起绣帕', action: '拾取绣帕' }, { id: 'B', text: '跟上队伍' }],
  }), false)
})

test('rejects narrative longer than 600 characters', () => {
  assert.equal(Check(storySceneSchema, { ...makeScene(2), narrative: 'a'.repeat(601) }), false)
})

const makeVideoRequest = () => ({
  totalDuration: 15,
  videoPrompts: [
    {
      sequence: 1,
      startTime: 0,
      endTime: 5,
      characterIds: ['heroine'],
      prompt: '宫墙暮色场景，镜头缓慢推进朱红宫墙，宫灯在少女身后次第亮起。',
    },
    {
      sequence: 2,
      startTime: 5,
      endTime: 15,
      transitionFromPrevious: 'cut' as const,
      characterIds: ['heroine'],
      prompt: '偏院室内场景，少女坐在木椅上攥紧袖口，烛光在她脸上摇曳。',
    },
  ],
})

test('rejects scenes carrying the removed videoPrompt field', () => {
  assert.equal(Check(storySceneSchema, { ...makeScene(2), videoPrompt: makeVideoRequest() }), false)
})

test('accepts a well formed video generation request', () => {
  assert.equal(Check(videoGenerationRequestSchema, makeVideoRequest()), true)
})

test('accepts a scene publish with scene and characters only', () => {
  assert.equal(Check(scenePublishSchema, {
    scene: makeScene(2),
    characters: [{ id: 'heroine', name: '沈清禾', gender: 'female', minAge: 16, maxAge: 20 }],
  }), true)
  assert.equal(Check(scenePublishSchema, { scene: makeScene(2) }), false)
  assert.equal(Check(scenePublishSchema, { characters: [] }), false)
})

test('rejects a scene publish carrying a video field', () => {
  assert.equal(Check(scenePublishSchema, {
    scene: makeScene(2),
    characters: [{ id: 'heroine', name: '沈清禾', gender: 'female', minAge: 16, maxAge: 20 }],
    video: makeVideoRequest(),
  }), false)
})

test('accepts a video plan submitted on its own', () => {
  assert.equal(Check(videoPlanSchema, { video: makeVideoRequest() }), true)
  assert.equal(Check(videoPlanSchema, {}), false)
  assert.equal(Check(videoPlanSchema, {
    video: makeVideoRequest(),
    scene: makeScene(2),
  }), false)
})

test('requires character ids and accepts the transition field on later video segments', () => {
  const request = makeVideoRequest()
  assert.equal(Check(videoGenerationRequestSchema, {
    ...request,
    videoPrompts: request.videoPrompts.map((segment) => Object.fromEntries(
      Object.entries(segment).filter(([key]) => key !== 'characterIds'),
    )),
  }), false)
  assert.equal(Check(videoGenerationRequestSchema, {
    ...request,
    videoPrompts: request.videoPrompts.map((segment) => segment.sequence === 2
      ? { ...segment, transitionFromPrevious: undefined }
      : segment),
  }), true)
})

test('rejects video requests with unsupported total durations', () => {
  assert.equal(Check(videoGenerationRequestSchema, { ...makeVideoRequest(), totalDuration: 14 }), false)
  assert.equal(Check(videoGenerationRequestSchema, { ...makeVideoRequest(), totalDuration: 31 }), false)
  assert.equal(Check(videoGenerationRequestSchema, { ...makeVideoRequest(), totalDuration: 15 }), true)
  assert.equal(Check(videoGenerationRequestSchema, {
    totalDuration: 30,
    videoPrompts: [
      { ...makeVideoRequest().videoPrompts[0], endTime: 10 },
      { ...makeVideoRequest().videoPrompts[1], startTime: 10, endTime: 20 },
      { ...makeVideoRequest().videoPrompts[1], sequence: 3, startTime: 20, endTime: 30 },
    ],
  }), true)
})

test('rejects video requests with a too short or too long prompt', () => {
  const request = makeVideoRequest()
  assert.equal(Check(videoGenerationRequestSchema, {
    ...request,
    videoPrompts: [{ ...request.videoPrompts[0], prompt: '镜头推进宫墙' }],
  }), false)
  assert.equal(Check(videoGenerationRequestSchema, {
    ...request,
    videoPrompts: [{ ...request.videoPrompts[0], prompt: 'a'.repeat(601) }],
  }), false)
})

test('rejects video requests with extra fields', () => {
  assert.equal(Check(videoGenerationRequestSchema, { ...makeVideoRequest(), style: 'cinematic' }), false)
})

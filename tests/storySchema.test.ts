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
  narrative: '宫门在身后缓缓合拢，沈清禾第一次听见深宫里的晨钟。细雪落在朱红宫墙下，教引嬷嬷催促秀女们向前，她却发现同行少女悄悄塞来一方绣帕。绣帕角落绣着禁军纹样，远处又有人停步回望。沈清禾把手藏进袖中，前方嬷嬷忽然点到她的名字，身旁少女低声让她千万别交出去。队伍即将转过宫门，再迟一步便会被人看见，她必须立刻决定如何应对。',
  choices: Array.from({ length: choiceCount }, (_, index) => ({
    id: String(index + 1),
    text: `第 ${index + 1} 个选择`,
  })),
})

test('accepts exactly three story choices', () => {
  assert.equal(Check(storySceneSchema, makeScene(2)), false)
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

test('requires a nonblank narrative without imposing a length range', () => {
  for (const narrative of ['', ' \n\t　']) {
    assert.equal(Check(storySceneSchema, { ...makeScene(3), narrative }), false)
  }
  for (const narrative of ['宫门开了。', 'a'.repeat(99), '沈'.repeat(138), '沈'.repeat(500)]) {
    assert.equal(Check(storySceneSchema, { ...makeScene(3), narrative }), true)
  }
})

const makeVideoRequest = () => ({
  totalDuration: 15,
  style: '写实电影质感，暖色柔光，稳定自然的宫廷叙事风格。',
  videoPrompts: [
    {
      sequence: 1,
      startTime: 0,
      endTime: 5,
      characterIds: ['heroine'],
      prompt: '0–5秒：宫墙暮色场景，镜头缓慢推进朱红宫墙，宫灯在少女身后次第亮起。',
    },
    {
      sequence: 2,
      startTime: 5,
      endTime: 15,
      characterIds: ['heroine'],
      prompt: '0–10秒：偏院室内场景，少女坐在木椅上攥紧袖口，烛光在她脸上摇曳。',
    },
  ],
})

const makeVideoPlan = () => ({
  style: makeVideoRequest().style,
  segments: [
    { characters: ['heroine'], seconds: 5, prompt: '0–5秒：固定中景，少女站在朱红宫墙前，抬头听见远处晨钟。轻微风声。' },
    { characters: ['heroine'], seconds: 10, prompt: '0–10秒：镜头推近，少女坐到木椅上，攥紧袖口并望向关闭的木门，{{line_1}}。轻微风声。' },
  ],
})

test('rejects scenes carrying the removed videoPrompt field', () => {
  assert.equal(Check(storySceneSchema, { ...makeScene(3), videoPrompt: makeVideoRequest() }), false)
})

test('accepts a well formed video generation request', () => {
  assert.equal(Check(videoGenerationRequestSchema, makeVideoRequest()), true)
})

test('requires scene, characters and a dialogue catalogue at publication', () => {
  assert.equal(Check(scenePublishSchema, {
    dialogues: [],
    scene: makeScene(3),
    characters: [{ id: 'heroine', name: '沈清禾', gender: 'female', minAge: 16, maxAge: 20 }],
  }), true)
  assert.equal(Check(scenePublishSchema, { scene: makeScene(3) }), false)
  assert.equal(Check(scenePublishSchema, { characters: [] }), false)
  assert.equal(Check(scenePublishSchema, {
    scene: makeScene(3), characters: [{ id: 'heroine', name: '沈清禾', gender: 'female', minAge: 16, maxAge: 20 }],
  }), false)
})

test('rejects a scene publish carrying a video field', () => {
  assert.equal(Check(scenePublishSchema, {
    dialogues: [],
    scene: makeScene(3),
    characters: [{ id: 'heroine', name: '沈清禾', gender: 'female', minAge: 16, maxAge: 20 }],
    video: makeVideoRequest(),
  }), false)
})

test('accepts a video plan submitted on its own and rejects the removed nested structure', () => {
  assert.equal(Check(videoPlanSchema, makeVideoPlan()), true)
  assert.equal(Check(videoPlanSchema, {}), false)
  assert.equal(Check(videoPlanSchema, { ...makeVideoPlan(), scene: makeScene(2) }), false)
  const plan = makeVideoPlan()
  assert.equal(Check(videoPlanSchema, { visualContext: { style: plan.style, scene: '宫墙' }, videoPrompts: [] }), false)
  assert.equal(Check(videoPlanSchema, { ...plan, segments: plan.segments.map((segment) => ({ ...segment, endFrame: '少女站在宫墙前。' })) }), false)
  assert.equal(Check(videoPlanSchema, { ...plan, segments: plan.segments.map((segment) => ({ ...segment, beats: [] })) }), false)
  assert.equal(Check(videoPlanSchema, { ...plan, segments: plan.segments.map((segment) => ({ ...segment, audio: '脚步声。' })) }), false)
})

test('keeps mechanical timing out of the tool input schema but bounds seconds per segment', () => {
  const plan = makeVideoPlan()
  assert.equal(Check(videoPlanSchema, { ...plan, totalDuration: 15 }), false)
  assert.equal(Check(videoPlanSchema, { ...plan, segments: plan.segments.map((segment) => ({ ...segment, startTime: 0 })) }), false)
  assert.equal(Check(videoPlanSchema, { ...plan, segments: plan.segments.map((segment) => ({ ...segment, seconds: 4 })) }), false)
  assert.equal(Check(videoPlanSchema, { ...plan, segments: plan.segments.map((segment) => ({ ...segment, seconds: 15 })) }), true)
  assert.equal(Check(videoPlanSchema, { ...plan, segments: plan.segments.map((segment) => ({ ...segment, seconds: 16 })) }), false)
  assert.equal(Check(videoPlanSchema, { ...plan, segments: [plan.segments[0]] }), false)
  assert.equal(Check(videoPlanSchema, { ...plan, segments: [...plan.segments, ...plan.segments] }), false)
  const request = makeVideoRequest()
  assert.equal(Check(videoGenerationRequestSchema, {
    ...request,
    videoPrompts: request.videoPrompts.map((segment) => Object.fromEntries(
      Object.entries(segment).filter(([key]) => key !== 'characterIds'),
    )),
  }), false)
})

test('rejects video requests with unsupported total durations', () => {
  assert.equal(Check(videoGenerationRequestSchema, { ...makeVideoRequest(), totalDuration: 14 }), false)
  assert.equal(Check(videoGenerationRequestSchema, { ...makeVideoRequest(), totalDuration: 46 }), false)
  assert.equal(Check(videoGenerationRequestSchema, { ...makeVideoRequest(), totalDuration: 15 }), true)
  assert.equal(Check(videoGenerationRequestSchema, { ...makeVideoRequest(), totalDuration: 45 }), true)
  assert.equal(Check(videoGenerationRequestSchema, {
    totalDuration: 45,
    style: makeVideoRequest().style,
    videoPrompts: [
      { ...makeVideoRequest().videoPrompts[0], endTime: 15 },
      { ...makeVideoRequest().videoPrompts[1], startTime: 15, endTime: 30 },
      { ...makeVideoRequest().videoPrompts[1], sequence: 3, startTime: 30, endTime: 45 },
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
    videoPrompts: [{ ...request.videoPrompts[0], prompt: 'a'.repeat(2401) }],
  }), false)
})

test('rejects video requests with extra or removed fields', () => {
  assert.equal(Check(videoGenerationRequestSchema, { ...makeVideoRequest(), visualContext: { style: 'cinematic', scene: '宫墙' } }), false)
  const request = makeVideoRequest()
  assert.equal(Check(videoGenerationRequestSchema, {
    ...request,
    videoPrompts: request.videoPrompts.map((segment) => ({ ...segment, endFrame: '少女站在宫墙前。', audio: '风声' })),
  }), false)
})

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
  visualContext: {
    style: '写实电影质感，暖色柔光，稳定自然的宫廷叙事风格。',
    scene: '清晨的宫墙甬道，朱红高墙夹着青石路，远处宫门关闭。',
  },
  videoPrompts: [
    {
      sequence: 1,
      startTime: 0,
      endTime: 5,
      characterIds: ['heroine'],
      prompt: '宫墙暮色场景，镜头缓慢推进朱红宫墙，宫灯在少女身后次第亮起。',
      endFrame: '中景，少女站在朱红宫墙前，双手收进袖中，保持静止。',
      audio: '远处晨钟和衣料摩擦声',
    },
    {
      sequence: 2,
      startTime: 5,
      endTime: 15,
      characterIds: ['heroine'],
      prompt: '偏院室内场景，少女坐在木椅上攥紧袖口，烛光在她脸上摇曳。',
      endFrame: '中近景，少女坐在木椅上攥紧袖口，望向关闭的木门。',
      audio: '木门轻响和脚步声',
    },
  ],
})

const makeVideoPlanDraft = () => ({
  visualContext: makeVideoRequest().visualContext,
  videoPrompts: [
    {
      characterIds: ['heroine'],
      beats: [{ visual: '固定中景，少女站在朱红宫墙前，抬头听见远处晨钟。', audio: '轻微风声。' }],
      endFrame: '中景，少女站在朱红宫墙前，双手收进袖中，保持静止。',
    },
    {
      characterIds: ['heroine'],
      beats: [{
        visual: '镜头推近，少女坐到木椅上，攥紧袖口并望向关闭的木门。', audio: '轻微风声。',
        dialogueIds: ['line_1'],
      }],
      endFrame: '中近景，少女坐在木椅上攥紧袖口，望向关闭的木门。',
    },
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

test('accepts a video plan submitted on its own', () => {
  assert.equal(Check(videoPlanSchema, makeVideoPlanDraft()), true)
  assert.equal(Check(videoPlanSchema, {}), false)
  assert.equal(Check(videoPlanSchema, {
    ...makeVideoPlanDraft(),
    scene: makeScene(2),
  }), false)
})

test('requires shot-specific sound and rejects separate layout or segment sound', () => {
  const draft = makeVideoPlanDraft()
  assert.equal(Check(videoPlanSchema, {
    ...draft, visualContext: { ...draft.visualContext, layout: '女主在左，嬷嬷在右。' },
  }), false)
  assert.equal(Check(videoPlanSchema, {
    ...draft, videoPrompts: draft.videoPrompts.map((segment) => ({ ...segment, audio: '脚步声。' })),
  }), false)
  assert.equal(Check(videoPlanSchema, {
    ...draft, videoPrompts: draft.videoPrompts.map((segment) => ({
      ...segment, beats: segment.beats.map((beat) => ({ visual: beat.visual })),
    })),
  }), false)
})

test('keeps mechanical timing out of the tool input schema', () => {
  const request = makeVideoRequest()
  assert.equal(Check(videoGenerationRequestSchema, {
    ...request,
    videoPrompts: request.videoPrompts.map((segment) => Object.fromEntries(
      Object.entries(segment).filter(([key]) => key !== 'characterIds'),
    )),
  }), false)
  assert.equal(Check(videoPlanSchema, makeVideoPlanDraft()), true)
  assert.equal(Check(videoPlanSchema, {
    ...makeVideoPlanDraft(),
    totalDuration: 15,
  }), false)
  assert.equal(Check(videoPlanSchema, {
    ...makeVideoPlanDraft(),
    videoPrompts: makeVideoPlanDraft().videoPrompts.map((segment) => ({
      ...segment,
      duration: 8,
    })),
  }), false)
})

test('rejects video requests with unsupported total durations', () => {
  assert.equal(Check(videoGenerationRequestSchema, { ...makeVideoRequest(), totalDuration: 14 }), false)
  assert.equal(Check(videoGenerationRequestSchema, { ...makeVideoRequest(), totalDuration: 31 }), false)
  assert.equal(Check(videoGenerationRequestSchema, { ...makeVideoRequest(), totalDuration: 15 }), true)
  assert.equal(Check(videoGenerationRequestSchema, {
    totalDuration: 30,
    visualContext: makeVideoRequest().visualContext,
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
    videoPrompts: [{ ...request.videoPrompts[0], prompt: 'a'.repeat(2401) }],
  }), false)
})

test('rejects video requests with extra fields', () => {
  assert.equal(Check(videoGenerationRequestSchema, { ...makeVideoRequest(), style: 'cinematic' }), false)
})

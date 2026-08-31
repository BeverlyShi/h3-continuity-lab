import assert from 'node:assert/strict'
import test from 'node:test'
import { Check } from 'typebox/value'
import { storySceneSchema, videoGenerationRequestSchema } from '../src/types/story.ts'

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
  duration: 6,
  prompt: '0-2秒，宫墙暮色场景，镜头缓慢推进朱红宫墙，宫灯次第亮起；2-6秒，偏院室内场景，少女坐在木椅上攥紧袖口，烛光摇曳',
})

test('rejects scenes carrying the removed videoPrompt field', () => {
  assert.equal(Check(storySceneSchema, { ...makeScene(2), videoPrompt: makeVideoRequest() }), false)
})

test('accepts a well formed video generation request', () => {
  assert.equal(Check(videoGenerationRequestSchema, makeVideoRequest()), true)
})

test('rejects video requests with out-of-range or fractional duration', () => {
  assert.equal(Check(videoGenerationRequestSchema, { ...makeVideoRequest(), duration: 3 }), false)
  assert.equal(Check(videoGenerationRequestSchema, { ...makeVideoRequest(), duration: 16 }), false)
  assert.equal(Check(videoGenerationRequestSchema, { ...makeVideoRequest(), duration: 6.5 }), false)
})

test('rejects video requests with a too short or too long prompt', () => {
  assert.equal(Check(videoGenerationRequestSchema, { ...makeVideoRequest(), prompt: '镜头推进宫墙' }), false)
  assert.equal(Check(videoGenerationRequestSchema, { ...makeVideoRequest(), prompt: 'a'.repeat(601) }), false)
})

test('rejects video requests with extra fields', () => {
  assert.equal(Check(videoGenerationRequestSchema, { ...makeVideoRequest(), style: 'cinematic' }), false)
})

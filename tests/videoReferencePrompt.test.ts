import assert from 'node:assert/strict'
import test from 'node:test'
import { buildClipGenerationInput } from '../src/services/videoReferencePrompt.ts'
import type { Actor } from '../src/types/actor.ts'
import type { VideoInputReferenceImage } from '../src/types/video.ts'

const actor = (id: string, patch: Partial<Actor> = {}): Actor => ({
  id, name: id, gender: 'female', minAge: 15, maxAge: 20, createdAt: 1, ...patch,
})

const actors = new Map([
  ['a-shen', actor('a-shen', { referenceImageUrl: 'shen.png', appearance: '十八岁，青色褙子' })],
  ['a-xu', actor('a-xu', { appearance: '五十岁上下，深青圆领太监服。' })],
])
const findActor = (id: string) => actors.get(id)

const prompt = '写实古装画面。\n\n0–3秒：全景，平视，固定。两人对视。\n\n3–5秒：镜头硬切为近景。无音乐，无旁白。'

test('characters with a reference image get an image number, the rest get their appearance, the frame goes last', () => {
  const references: VideoInputReferenceImage[] = [
    { type: 'start_frame', imageUrl: 'tail-1.jpg', label: '上一段最后一帧' },
    { type: 'character', label: '沈令仪', actorId: 'a-shen' },
    { type: 'character', label: '徐全', actorId: 'a-xu' },
  ]
  const input = buildClipGenerationInput(prompt, references, findActor)
  assert.deepEqual(input.images, [
    { imageUrl: 'shen.png', label: '沈令仪' },
    { imageUrl: 'tail-1.jpg', label: '上一段最后一帧' },
  ])
  assert.deepEqual(input.textOnlyCharacters, [{ name: '徐全', actorMissing: false }])
  assert.equal(input.prompt, [
    '写实古装画面。',
    '人物：沈令仪——人物形象参考图1；徐全——五十岁上下，深青圆领太监服。\n画面参考图2：上一段最后一帧，本段从这个画面接着拍。',
    '0–3秒：全景，平视，固定。两人对视。',
    '3–5秒：镜头硬切为近景。无音乐，无旁白。',
  ].join('\n\n'))
  assert.doesNotMatch(input.prompt, /青色褙子/, '有参考图的人物不写外貌')
})

test('an image added to the actor library later is picked up, and a deleted actor is reported', () => {
  const later = new Map([['a-xu', actor('a-xu', { referenceImageUrl: 'xu.png' })]])
  const input = buildClipGenerationInput(prompt, [
    { type: 'character', label: '人物参考 · 徐全', actorId: 'a-xu' },
    { type: 'character', label: '柳碧昭', actorId: 'a-gone' },
  ], (id) => later.get(id))
  assert.deepEqual(input.images, [{ imageUrl: 'xu.png', label: '徐全' }])
  assert.deepEqual(input.textOnlyCharacters, [{ name: '柳碧昭', actorMissing: true }])
  assert.match(input.prompt, /人物：徐全——人物形象参考图1。\n\n0–3秒/)
})

test('without references the prompt is left untouched', () => {
  assert.deepEqual(buildClipGenerationInput(prompt, [], findActor), { prompt, images: [], textOnlyCharacters: [] })
})

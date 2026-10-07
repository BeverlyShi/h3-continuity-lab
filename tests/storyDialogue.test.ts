import assert from 'node:assert/strict'
import test from 'node:test'
import { assertValidScenePublish } from '../src/director/publishSceneTool.ts'
import type { ScenePublish } from '../src/types/story.ts'

const scene: ScenePublish = {
  scene: {
    title: '初入宫门',
    narrative: '李公公冷冷道：“下车吧，进了这道门，规矩就得记牢。”沈知微提着裙摆下车。',
    choices: [{ id: '1', text: '点头示好' }, { id: '2', text: '低头前行' }, { id: '3', text: '打听规矩' }],
  },
  characters: [{ id: 'li_gonggong', name: '李公公', gender: 'male', minAge: 45, maxAge: 55 }],
  dialogues: [{ id: 'line_1', characterId: 'li_gonggong', text: '下车吧，进了这道门，规矩就得记牢。' }],
}

test('rejects the omitted 下车吧 from trace d1087476 at scene publication', () => {
  assert.throws(() => assertValidScenePublish({
    ...scene, dialogues: [{ ...scene.dialogues[0], text: '进了这道门，规矩就得记牢。' }],
  }), /台词.*不一致/)
  assert.doesNotThrow(() => assertValidScenePublish(scene))
})

test('requires every quoted speech occurrence, even when two lines contain identical words', () => {
  const repeated = {
    ...scene,
    scene: { ...scene.scene, narrative: '李公公道：“站住。”他又重复：“站住。”' },
    dialogues: [{ id: 'a', characterId: 'li_gonggong', text: '站住。' }],
  }
  assert.throws(() => assertValidScenePublish(repeated), /台词.*不一致/)
  assert.doesNotThrow(() => assertValidScenePublish({
    ...repeated, dialogues: [...repeated.dialogues, { ...repeated.dialogues[0], id: 'b' }],
  }))
})

test('rejects duplicate dialogue ids and unknown speakers', () => {
  assert.throws(() => assertValidScenePublish({
    ...scene, dialogues: [scene.dialogues[0], scene.dialogues[0]],
  }), /台词 ID.*重复/)
  assert.throws(() => assertValidScenePublish({
    ...scene, dialogues: [{ ...scene.dialogues[0], characterId: 'unknown' }],
  }), /未声明人物/)
})

test('accepts ASCII speech quotes, keeps single-quoted document text separate, and rejects unclosed speech', () => {
  assert.doesNotThrow(() => assertValidScenePublish({
    ...scene, scene: { ...scene.scene, narrative: '李公公道："下车吧，进了这道门，规矩就得记牢。"信上只有‘安好’二字。' },
  }))
  assert.doesNotThrow(() => assertValidScenePublish({
    ...scene, scene: { ...scene.scene, narrative: '信上只有‘安好’二字，他心中默念平安。' }, dialogues: [],
  }))
  assert.throws(() => assertValidScenePublish({
    ...scene, scene: { ...scene.scene, narrative: '李公公道：“下车吧。' },
  }), /引号/)
})

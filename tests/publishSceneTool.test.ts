import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPublishSceneTool,
  DIALOGUE_MAX_LINES,
  DIALOGUE_TOTAL_MAX_HAN,
  prepareScenePublishArguments,
} from '../server/publishSceneTool.ts'
import type { ScenePublish } from '../src/types/story.ts'

const turn: ScenePublish = {
  dialogues: [],
  scene: {
    title: '宫门初雪',
    narrative: '宫门在身后缓缓合拢，沈清禾第一次听见深宫里的晨钟。细雪落在朱红宫墙下，教引嬷嬷催促秀女们向前，她却发现同行少女悄悄塞来一方绣帕。绣帕角落绣着禁军纹样，远处又有人停步回望。沈清禾把手藏进袖中，前方嬷嬷忽然点到她的名字，身旁少女低声让她千万别交出去。队伍即将转过宫门，再迟一步便会被人看见，她必须立刻决定如何应对。',
    choices: [
      { id: '1', text: '把绣帕交给嬷嬷' },
      { id: '2', text: '替少女暂时藏好' },
      { id: '3', text: '假装失手丢在雪中' },
    ],
  },
  characters: [
    { id: 'heroine', name: '沈清禾', gender: 'female', minAge: 16, maxAge: 20 },
  ],
}

test('publishes the scene without terminating the wider media turn', async () => {
  let published: ScenePublish | undefined
  const tool = createPublishSceneTool((value) => { published = value })
  const result = await tool.execute('tool-1', turn)

  assert.equal(tool.name, 'publish_scene')
  assert.equal(result.terminate, false)
  assert.deepEqual(result.details, turn)
  assert.deepEqual(published, turn)
  assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /场景已发布/)
})

test('rejects duplicate character ids', async () => {
  const tool = createPublishSceneTool()
  await assert.rejects(() => tool.execute('tool-duplicate', {
    ...turn,
    characters: [...turn.characters, { ...turn.characters[0] }],
  }), /重复/)
})

test('rejects an invalid character age range', async () => {
  const tool = createPublishSceneTool()
  await assert.rejects(() => tool.execute('tool-age', {
    ...turn,
    characters: [{ ...turn.characters[0], minAge: 30, maxAge: 20 }],
  }), /年龄区间无效/)
})

test('requires choice ids 1, 2 and 3 exactly once', async () => {
  const tool = createPublishSceneTool()
  await assert.rejects(() => tool.execute('tool-choice-ids', {
    ...turn,
    scene: {
      ...turn.scene,
      choices: turn.scene.choices.map((choice) => ({ ...choice, id: '1' })),
    },
  }), /各使用一次 ID 1、2、3/)
})

test('accepts a narrative counted by Han characters even when punctuation pushes the string length past 250 (real trace: 219 Han chars, 253 total chars)', () => {
  const narrative = `${'沈'.repeat(219)}${'，'.repeat(34)}`
  assert.equal(narrative.length, 253)
  const prepared = prepareScenePublishArguments({
    ...turn,
    scene: { ...turn.scene, narrative },
  })
  assert.equal(prepared.scene.narrative, narrative)
})

test('publishes the original 138-Han-character narrative from trace 418ef163 without padding', async () => {
  const narrative = '初秋晨光透过雕花窗棂洒进储秀宫偏殿，江南织造嫡女沈吟霜刚到宫中，父亲因进献云锦有功送她入宫，盼她得圣眷光耀门楣。偏殿虽逼仄，还算清净。她正望着窗外陌生景致发怔，忽闻急促脚步声——昨日同入宫的秀女李婉如惊惶闯入，攥着一封泪湿信笺，颤声道家中父亲被人弹劾下狱。话音未落，院外传来掌事姑姑查房的脚步声，越来越近。'
  assert.equal(narrative.match(/\p{Script=Han}/gu)?.length, 138)
  let published: ScenePublish | undefined
  const tool = createPublishSceneTool((value) => { published = value })
  const prepared = prepareScenePublishArguments({
    ...turn,
    scene: { ...turn.scene, narrative },
  })
  await tool.execute('tool-short-narrative', prepared)
  assert.equal(published?.scene.narrative, narrative)
})

test('accepts narratives outside the former Han and schema length bounds without rewriting', () => {
  for (const narrative of ['宫门外响起脚步声，她握紧信笺。', '沈'.repeat(260), '沈'.repeat(500)]) {
    const prepared = prepareScenePublishArguments({
      ...turn,
      scene: { ...turn.scene, narrative },
    })
    assert.equal(prepared.scene.narrative, narrative)
  }
})

test('rejects empty and whitespace-only narratives', () => {
  for (const narrative of ['', ' \n\t　']) {
    assert.throws(() => prepareScenePublishArguments({
      ...turn,
      scene: { ...turn.scene, narrative },
    }), /publish_scene 参数不符合 schema/)
  }
})

test('reports a schema violation when required fields such as choices are missing', () => {
  const sceneWithoutChoices: Record<string, unknown> = { ...turn.scene }
  delete sceneWithoutChoices.choices
  assert.throws(
    () => prepareScenePublishArguments({ ...turn, scene: sceneWithoutChoices }),
    /publish_scene 参数不符合 schema/,
  )
})

test('explains the wrong nesting and missing choices from trace a942bf88 without fabricating a scene', () => {
  const malformed = { scene: { ...turn.scene, choices: turn.scene.choices.slice(0, 1), characters: turn.characters } }
  assert.throws(() => prepareScenePublishArguments(malformed), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /characters 必须位于顶层，与 scene 同级/)
    assert.match(error.message, /choices 当前为 1 项/)
    assert.match(error.message, /重新提交完整 JSON/)
    return true
  })
  assert.equal(malformed.scene.choices.length, 1)
})

test('asks for complete valid JSON when the SDK hands the tool an empty argument object', () => {
  assert.throws(() => prepareScenePublishArguments({}), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /收到空参数对象/)
    assert.match(error.message, /重新提交完整 JSON/)
    assert.match(error.message, /"scene":.*"characters":/s)
    return true
  })
})

const withDialogues = (texts: string[]): ScenePublish => ({
  ...turn,
  scene: {
    ...turn.scene,
    narrative: `雪落在宫墙下，${texts.map((text) => `她说：“${text}”`).join('')}队伍继续向前。`,
  },
  dialogues: texts.map((text, index) => ({ id: `line_${index + 1}`, characterId: 'heroine', text })),
})

test('rejects a single line longer than the 20 Han character budget', async () => {
  const tool = createPublishSceneTool()
  await assert.rejects(() => tool.execute('tool-long-line', withDialogues(['沈'.repeat(21)])), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /台词 line_1 有 21 个汉字，超过单句 20 字上限/)
    assert.match(error.message, /留到下一回合/)
    assert.match(error.message, /不要把对白改写成叙述/)
    return true
  })
})

test('rejects more lines than a single beat can hold', async () => {
  const tool = createPublishSceneTool()
  await assert.rejects(
    () => tool.execute('tool-too-many-lines', withDialogues(Array.from({ length: DIALOGUE_MAX_LINES + 1 }, () => '知道了。'))),
    /本幕有 7 句台词，超过 6 句上限/,
  )
})

test('rejects a scene whose lines fit individually but blow the whole-scene budget', async () => {
  const tool = createPublishSceneTool()
  const texts = [...Array.from({ length: 4 }, () => `${'沈'.repeat(18)}。`), `${'沈'.repeat(19)}。`]
  await assert.rejects(() => tool.execute('tool-over-budget', withDialogues(texts)), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, new RegExp(`本幕台词合计 ${DIALOGUE_TOTAL_MAX_HAN + 1} 字，超出 ${DIALOGUE_TOTAL_MAX_HAN} 字预算`))
    assert.match(error.message, /一幕对应 15–45 秒画面/)
    return true
  })
})

test('publishes three lines totalling 60 Han characters', async () => {
  let published: ScenePublish | undefined
  const tool = createPublishSceneTool((value) => { published = value })
  const publishable = withDialogues(Array.from({ length: 3 }, () => `${'沈'.repeat(20)}。`))
  await tool.execute('tool-within-budget', publishable)
  assert.equal(published?.dialogues.length, 3)
})

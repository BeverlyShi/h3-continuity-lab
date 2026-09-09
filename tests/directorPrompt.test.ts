import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { buildStoryInputMessage, DIRECTOR_SYSTEM_PROMPT } from '../server/directorPrompt.ts'
import { SCENE_PUBLISH_ARGUMENTS_EXAMPLE } from '../server/publishSceneTool.ts'
import { prepareWriteSegment, WRITE_SEGMENT_ARGUMENTS_EXAMPLE_FIRST, WRITE_SEGMENT_ARGUMENTS_EXAMPLE_NEXT } from '../server/writeSegmentTool.ts'

test('the single system prompt covers story, casting and shot writing in a fixed section order', () => {
  const role = DIRECTOR_SYSTEM_PROMPT.indexOf('## 角色设定')
  const instructions = DIRECTOR_SYSTEM_PROMPT.indexOf('## Instructions')
  const toolGuidance = DIRECTOR_SYSTEM_PROMPT.indexOf('## Tool Guidance')
  const outputDescription = DIRECTOR_SYSTEM_PROMPT.indexOf('## Output Description')
  assert.ok(role >= 0 && role < instructions && instructions < toolGuidance && toolGuidance < outputDescription)

  assert.match(DIRECTOR_SYSTEM_PROMPT, /互动文字游戏《后宫》/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /主动决定故事开场/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /先 publish_scene 发布场景.*cast_scene.*write_segment.*generate_segment.*finish_turn/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /"1"、"2"、"3"/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /更换往回合已绑定的演员必须设置 recast: true/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /create: \{ name, appearance \}/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /appearance 只写身份层外观/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /只有没有台词的背景人物可以设为 null/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /一幕对应 15–45 秒画面/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /合计不超过 90 字/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /空间关系只用画面坐标/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /镜头硬切为/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /建立镜头/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /入画动作/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /相对关系、距离和视线/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /skipVideo\.reason/)
  assert.doesNotMatch(DIRECTOR_SYSTEM_PROMPT, /actionSeconds|visualContext|videoPrompts|宿籍|数值|150|250/)
  assert.doesNotMatch(DIRECTOR_SYSTEM_PROMPT, /search_actors/)
})

test('both structure examples in the prompt validate against each other', () => {
  assert.ok(DIRECTOR_SYSTEM_PROMPT.includes(SCENE_PUBLISH_ARGUMENTS_EXAMPLE))
  assert.ok(DIRECTOR_SYSTEM_PROMPT.includes(WRITE_SEGMENT_ARGUMENTS_EXAMPLE_FIRST))
  assert.ok(DIRECTOR_SYSTEM_PROMPT.includes(WRITE_SEGMENT_ARGUMENTS_EXAMPLE_NEXT))
  const scene = JSON.parse(SCENE_PUBLISH_ARGUMENTS_EXAMPLE)
  const first = prepareWriteSegment(JSON.parse(WRITE_SEGMENT_ARGUMENTS_EXAMPLE_FIRST), {
    characters: scene.characters,
    dialogues: scene.dialogues,
    existingSegments: [],
  })
  assert.match(first.segment.prompt, /你识字吗？/)
  const second = prepareWriteSegment(JSON.parse(WRITE_SEGMENT_ARGUMENTS_EXAMPLE_NEXT), {
    characters: scene.characters,
    dialogues: scene.dialogues,
    existingSegments: [{ sequence: 1, seconds: first.segment.seconds, lineIds: first.segment.lineIds, generated: {} }],
  })
  assert.equal(second.cumulativeSeconds, first.cumulativeSeconds + second.segment.seconds)
  assert.equal(second.remainingLines.length, 0)
})

test('the agent exposes every tool to one Agent instance without forcing tool choice', async () => {
  const source = await readFile(new URL('../server/directorAgent.ts', import.meta.url), 'utf8')
  assert.match(source, /publishSceneTool,\s*castSceneTool,\s*\.\.\.\(videoEnabled \? \[writeSegmentTool, generateSegmentTool\] : \[\]\),\s*finishTurnTool,/)
  assert.equal((source.match(/new Agent\(/g) ?? []).length, 1)
  assert.doesNotMatch(source, /tool_choice|narrativeReview|DIRECTOR_VIDEO_SYSTEM_PROMPT/)
})

test('the turn message carries the player input, video mode, first-segment reference and measured tail state', () => {
  const choice = buildStoryInputMessage({ type: 'choice', choice: { id: '2', text: '询问身后的秀女' } }, undefined, { videoMode: 'auto' })
  assert.match(choice, /ID：2/)
  assert.match(choice, /询问身后的秀女/)
  assert.match(choice, /本局视频模式：API 生成/)
  assert.match(choice, /没有起始尾帧/)

  const state = {
    shot_size: '中景' as const,
    shot_position: '人物正前方',
    shot_content: { characters: [], scene: { location: '宫墙甬道', visible_elements: '朱红宫墙', lighting: '清晨柔光', time_of_day: '清晨' }, key_props: [] },
    frame_quality: '清晰稳定' as const,
  }
  const withTail = buildStoryInputMessage({ type: 'freeform', text: '走向宫门' }, state, { videoMode: 'manual', hasPreviousTailFrame: true })
  assert.match(withTail, /玩家决定自由行动：走向宫门/)
  assert.match(withTail, /本局视频模式：上传视频/)
  assert.match(withTail, /以上一幕尾帧为起始画面，不附人物参考图/)
  assert.match(withTail, /上一幕尾帧的 VLM 实测视觉状态/)
  assert.match(withTail, /宫墙甬道/)

  const textOnly = buildStoryInputMessage({ type: 'start' }, undefined, { videoMode: 'off' })
  assert.match(textOnly, /请开始故事/)
  assert.match(textOnly, /仅文字.*不提供 write_segment 和 generate_segment/)
  assert.doesNotMatch(buildStoryInputMessage({ type: 'start' }), /视频模式/)
})

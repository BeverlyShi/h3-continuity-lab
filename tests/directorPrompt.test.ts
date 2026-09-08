import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { buildStoryInputMessage, DIRECTOR_SYSTEM_PROMPT } from '../server/directorPrompt.ts'
import { SCENE_PUBLISH_ARGUMENTS_EXAMPLE } from '../server/publishSceneTool.ts'
import { prepareVideoPlan, VIDEO_PLAN_ARGUMENTS_EXAMPLE } from '../server/videoPlanTool.ts'

test('the single system prompt covers story, casting and shot writing in a fixed section order', () => {
  const role = DIRECTOR_SYSTEM_PROMPT.indexOf('## 角色设定')
  const instructions = DIRECTOR_SYSTEM_PROMPT.indexOf('## Instructions')
  const toolGuidance = DIRECTOR_SYSTEM_PROMPT.indexOf('## Tool Guidance')
  const outputDescription = DIRECTOR_SYSTEM_PROMPT.indexOf('## Output Description')
  assert.ok(role >= 0 && role < instructions && instructions < toolGuidance && toolGuidance < outputDescription)

  assert.match(DIRECTOR_SYSTEM_PROMPT, /互动文字游戏《后宫》/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /主动决定故事开场/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /先 publish_scene 发布场景.*search_actors.*cast_scene.*write_video_prompt.*finish_turn/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /"1"、"2"、"3"/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /更换已绑定演员必须设置 recast: true/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /每个时间块就是一个镜头/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /skipVideo\.reason/)
  assert.doesNotMatch(DIRECTOR_SYSTEM_PROMPT, /actionSeconds|visualContext|videoPrompts|宿籍|数值|150|250/)
})

test('both structure examples in the prompt validate against each other', () => {
  assert.ok(DIRECTOR_SYSTEM_PROMPT.includes(SCENE_PUBLISH_ARGUMENTS_EXAMPLE))
  assert.ok(DIRECTOR_SYSTEM_PROMPT.includes(VIDEO_PLAN_ARGUMENTS_EXAMPLE))
  const scene = JSON.parse(SCENE_PUBLISH_ARGUMENTS_EXAMPLE)
  const { video } = prepareVideoPlan(JSON.parse(VIDEO_PLAN_ARGUMENTS_EXAMPLE), scene.characters, scene.dialogues)
  assert.equal(video.videoPrompts.length, 2)
  assert.equal(video.totalDuration, 15)
  assert.equal(video.videoPrompts.filter((segment) => segment.prompt.includes('你识字吗？')).length, 1)
})

test('the agent exposes every tool to one Agent instance without forcing tool choice', async () => {
  const source = await readFile(new URL('../server/directorAgent.ts', import.meta.url), 'utf8')
  assert.match(source, /publishSceneTool,\s*searchActorsTool,\s*castSceneTool,\s*\.\.\.\(videoEnabled \? \[videoPlanTool\] : \[\]\),\s*finishTurnTool,/)
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
  assert.match(textOnly, /仅文字.*不提供 write_video_prompt/)
  assert.doesNotMatch(buildStoryInputMessage({ type: 'start' }), /视频模式/)
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { buildRewriteMessage, buildStoryInputMessage, DIRECTOR_SYSTEM_PROMPT } from '../server/directorPrompt.ts'
import { SCENE_PUBLISH_ARGUMENTS_EXAMPLE } from '../server/publishSceneTool.ts'
import { prepareSceneVideo, WRITE_SCENE_VIDEO_ARGUMENTS_EXAMPLE } from '../server/writeSceneVideoTool.ts'

test('the single system prompt covers story, casting and shot writing in a fixed section order', () => {
  const role = DIRECTOR_SYSTEM_PROMPT.indexOf('## 角色设定')
  const instructions = DIRECTOR_SYSTEM_PROMPT.indexOf('## Instructions')
  const toolGuidance = DIRECTOR_SYSTEM_PROMPT.indexOf('## Tool Guidance')
  const outputDescription = DIRECTOR_SYSTEM_PROMPT.indexOf('## Output Description')
  assert.ok(role >= 0 && role < instructions && instructions < toolGuidance && toolGuidance < outputDescription)

  assert.match(DIRECTOR_SYSTEM_PROMPT, /互动文字游戏《后宫》/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /主动决定故事开场/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /publish_scene.*cast_scene.*write_scene_video/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /先调用 inspect_last_frame 看上一场次最后一帧/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /三样都交齐后回合自动结束/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /承接上一段画面/)
  assert.doesNotMatch(DIRECTOR_SYSTEM_PROMPT, /generate_segment|finish_turn|write_segment|下一步：/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /"1"、"2"、"3"/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /更换此前场次已绑定的演员必须设置 recast: true/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /create: \{ name, appearance \}/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /appearance 只写身份层外观/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /只有没有台词的背景人物可以设为 null/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /一个场次对应 15–45 秒画面/)
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
  assert.ok(DIRECTOR_SYSTEM_PROMPT.includes(WRITE_SCENE_VIDEO_ARGUMENTS_EXAMPLE))
  const scene = JSON.parse(SCENE_PUBLISH_ARGUMENTS_EXAMPLE)
  const result = prepareSceneVideo(JSON.parse(WRITE_SCENE_VIDEO_ARGUMENTS_EXAMPLE), {
    characters: scene.characters,
    dialogues: scene.dialogues,
  })
  assert.equal(result.kind, 'plan')
  assert.ok(result.kind === 'plan')
  assert.equal(result.segments.length, 2)
  assert.match(result.segments[0].prompt, /你识字吗？/)
  assert.match(result.segments[1].prompt, /^0–3秒：承接上一段画面/)
})

test('the agent exposes the scene tools to one Agent instance without forcing tool choice', async () => {
  const source = await readFile(new URL('../server/directorAgent.ts', import.meta.url), 'utf8')
  assert.match(source, /\[publishSceneTool, castSceneTool, inspectLastFrameTool, writeSceneVideoTool\]/)
  assert.doesNotMatch(source, /videoEnabled/)
  assert.match(source, /rewrite\s*\?\s*\[writeSceneVideoTool\]/)
  assert.equal((source.match(/new Agent\(/g) ?? []).length, 1)
  assert.doesNotMatch(source, /tool_choice|narrativeReview|DIRECTOR_VIDEO_SYSTEM_PROMPT|generate_segment|finish_turn/)
})

test('the scene message carries the player input, video mode and whether a previous frame exists', () => {
  const choice = buildStoryInputMessage({ type: 'choice', choice: { id: '2', text: '询问身后的秀女' } }, { videoMode: 'auto' })
  assert.match(choice, /ID：2/)
  assert.match(choice, /询问身后的秀女/)
  assert.match(choice, /本局视频模式：API 生成/)
  assert.match(choice, /上一场次没有可接的视频画面.*new_shot/)

  const withFrame = buildStoryInputMessage({ type: 'freeform', text: '走向宫门' }, { videoMode: 'comfy', hasPreviousFrame: true })
  assert.match(withFrame, /玩家决定自由行动：走向宫门/)
  assert.match(withFrame, /本局视频模式：ComfyUI 生成/)
  assert.match(withFrame, /可以调用 inspect_last_frame/)

  const start = buildStoryInputMessage({ type: 'start' }, { videoMode: 'comfy' })
  assert.match(start, /请开始故事/)
  assert.doesNotMatch(start, /仅文字|上传视频|不提供 inspect_last_frame/)
  assert.doesNotMatch(DIRECTOR_SYSTEM_PROMPT, /仅文字/)
  assert.doesNotMatch(buildStoryInputMessage({ type: 'start' }), /视频模式/)
})

test('the rewrite message names the segment, the reason and the current storyboard', () => {
  const draft = { opening: 'new_shot', style: '写实', segments: [{ characters: ['heroine'], seconds: 8, prompt: '0–8秒：女主中景。' }] }
  const message = buildRewriteMessage(2, '人物走位跳了', draft)
  assert.match(message, /要求重写第 2 段。原因：人物走位跳了/)
  assert.match(message, /rewriteSequence: 2/)
  assert.ok(message.includes(JSON.stringify(draft)))
})

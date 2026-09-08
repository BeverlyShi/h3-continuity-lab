import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  buildStoryInputMessage,
  buildVideoInputMessage,
  DIRECTOR_SYSTEM_PROMPT,
  DIRECTOR_VIDEO_SYSTEM_PROMPT,
} from '../server/directorPrompt.ts'
import { SCENE_PUBLISH_ARGUMENTS_EXAMPLE } from '../server/publishSceneTool.ts'
import { prepareVideoPlan } from '../server/videoPlanTool.ts'

test('includes a complete video tool example that passes structure, dialogue and timing validation', () => {
  const marker = '完整参数结构示例（只参考结构，不复制人物或剧情）：\n'
  const example = DIRECTOR_VIDEO_SYSTEM_PROMPT.split(marker)[1]
  assert.ok(example, 'video prompt must include a complete JSON example')
  const scene = JSON.parse(SCENE_PUBLISH_ARGUMENTS_EXAMPLE)
  const { video } = prepareVideoPlan(JSON.parse(example), scene.characters, scene.dialogues)
  assert.equal(video.videoPrompts.length, 2)
  assert.equal(video.totalDuration, 15)
  assert.equal(video.videoPrompts.filter((segment) => segment.prompt.includes('你识字吗？')).length, 1)
})

test('separates scene direction from the video generation contract', () => {
  assert.match(DIRECTOR_SYSTEM_PROMPT, /互动文字游戏《后宫》/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /主动决定故事开场/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /只调用一次 publish_scene/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /scene 和 characters/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /篇幅以本幕内容为准/)
  assert.doesNotMatch(DIRECTOR_SYSTEM_PROMPT, /150|250|只计汉字|不计标点/)
  assert.doesNotMatch(DIRECTOR_SYSTEM_PROMPT, /write_video_prompt|videoPrompts/)

  assert.match(DIRECTOR_VIDEO_SYSTEM_PROMPT, /只负责把该 narrative 转成/)
  assert.match(DIRECTOR_VIDEO_SYSTEM_PROMPT, /2–3 个连续视频片段/)
  assert.match(DIRECTOR_VIDEO_SYSTEM_PROMPT, /dialogueIds 只引用本次输入中的台词 ID/)
  assert.match(DIRECTOR_VIDEO_SYSTEM_PROMPT, /程序会按每秒 3\.5 个汉字/)
  assert.match(DIRECTOR_VIDEO_SYSTEM_PROMPT, /已发布台词不可删改/)
  assert.match(DIRECTOR_VIDEO_SYSTEM_PROMPT, /endFrame 是对该段最后一帧的简洁文字预测/)
  assert.match(DIRECTOR_VIDEO_SYSTEM_PROMPT, /不要手写时间、duration、sequence、startTime、endTime 或 totalDuration/)
  assert.match(DIRECTOR_VIDEO_SYSTEM_PROMPT, /直接提交 visualContext 和 videoPrompts/)
  assert.doesNotMatch(DIRECTOR_VIDEO_SYSTEM_PROMPT, /expectedEndState|shot_content/)
})

test('orders both system prompts consistently', () => {
  for (const prompt of [DIRECTOR_SYSTEM_PROMPT, DIRECTOR_VIDEO_SYSTEM_PROMPT]) {
    const role = prompt.indexOf('## 角色设定')
    const instructions = prompt.indexOf('## Instructions')
    const toolGuidance = prompt.indexOf('## Tool Guidance')
    const outputDescription = prompt.indexOf('## Output Description')

    assert.ok(role >= 0)
    assert.ok(role < instructions)
    assert.ok(instructions < toolGuidance)
    assert.ok(toolGuidance < outputDescription)
  }
})

test('requires numeric choice ids and no removed scene fields', () => {
  assert.match(DIRECTOR_SYSTEM_PROMPT, /"1"、"2"、"3"/)
  assert.doesNotMatch(DIRECTOR_SYSTEM_PROMPT, /scene\.videoPrompt|directorBoardPatch|宿籍|数值/)
})

test('waits for casting before writing video shots with explicit reference context', async () => {
  const source = await readFile(new URL('../server/directorAgent.ts', import.meta.url), 'utf8')
  assert.match(source, /tools: \[publishSceneTool\]/)
  assert.match(source, /streamFn: createDirectorStreamFn\('publish_scene'\)/)
  assert.match(source, /const castingPromise = createCastSceneTool/)
  assert.match(source, /tools: \[videoPlanTool\]/)
  assert.match(source, /streamFn: createDirectorStreamFn\('write_video_prompt'\)/)
  assert.ok(source.indexOf('await Promise.allSettled([castingPromise])') < source.indexOf('const videoAgent = new Agent'))
  assert.match(source, /videoAgent\.prompt\(videoInputMessage\)/)
  assert.match(source, /sendTrace\(castingResult && videoPlan \? 'completed' : 'degraded'\)/)
  assert.doesNotMatch(source, /tools: \[publishSceneTool, castSceneTool, videoPlanTool\]/)
})

test('publishes the scene before starting the video phase', async () => {
  const source = await readFile(new URL('../server/directorAgent.ts', import.meta.url), 'utf8')
  const scenePrompt = source.indexOf('await sceneAgent.prompt')
  const sceneEvent = source.indexOf("send({ type: 'scene'", scenePrompt)
  const videoAgent = source.indexOf('const videoAgent = new Agent', sceneEvent)
  const videoPrompt = source.indexOf('videoAgent.prompt', videoAgent)

  assert.ok(scenePrompt >= 0)
  assert.ok(sceneEvent > scenePrompt)
  assert.ok(videoAgent > sceneEvent)
  assert.ok(videoPrompt > videoAgent)
  assert.equal(source.indexOf("send({ type: 'scene'", sceneEvent + 1), -1)
})

test('passes a player choice to the agent as the next user message', () => {
  const prompt = buildStoryInputMessage({
    type: 'choice',
    choice: { id: '2', text: '询问身后的秀女' },
  })

  assert.match(prompt, /ID：2/)
  assert.match(prompt, /询问身后的秀女/)
})

test('passes the measured tail-frame state into the next story turn', () => {
  const prompt = buildStoryInputMessage({
    type: 'choice',
    choice: { id: '1', text: '走向宫门' },
  }, {
    shot_size: '中景',
    shot_position: '人物正前方',
    shot_content: {
      characters: [],
      scene: {
        location: '宫墙甬道', visible_elements: '朱红宫墙',
        lighting: '清晨柔光', time_of_day: '清晨',
      },
      key_props: [],
    },
    frame_quality: '清晰稳定',
  })

  assert.match(prompt, /上一幕尾帧的 VLM 实测视觉状态/)
  assert.match(prompt, /宫墙甬道/)
})

test('does not claim a portrait exists when an old casting points to a removed actor', () => {
  const message = buildVideoInputMessage(
    [{ id: 'heroine', name: '沈清禾', gender: 'female', minAge: 16, maxAge: 20 }],
    { castings: [{ characterId: 'heroine', actorId: 'removed-actor' }], unmatchedCharacterIds: [] },
    [], [],
  )
  const input = JSON.parse(message.split('\n')[1])
  assert.equal(input.characters[0].hasActorReference, false)
  assert.equal(input.characters[0].hasFirstSegmentPortrait, false)
})

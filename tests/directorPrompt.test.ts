import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  buildStoryInputMessage,
  DIRECTOR_SYSTEM_PROMPT,
  DIRECTOR_VIDEO_SYSTEM_PROMPT,
} from '../server/directorPrompt.ts'

test('separates scene direction from the video generation contract', () => {
  assert.match(DIRECTOR_SYSTEM_PROMPT, /互动文字游戏《后宫》/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /主动决定故事开场/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /只调用一次 publish_scene/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /scene 和 characters/)
  assert.doesNotMatch(DIRECTOR_SYSTEM_PROMPT, /write_video_prompt|videoPrompts/)

  assert.match(DIRECTOR_VIDEO_SYSTEM_PROMPT, /只负责把该 narrative 转成/)
  assert.match(DIRECTOR_VIDEO_SYSTEM_PROMPT, /2–3 个连续视频片段/)
  assert.match(DIRECTOR_VIDEO_SYSTEM_PROMPT, /台词必须放入 dialogue 数组/)
  assert.match(DIRECTOR_VIDEO_SYSTEM_PROMPT, /程序会按每秒 3\.5 个汉字/)
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

test('uses deterministic scene and video phases while casting runs in parallel', async () => {
  const source = await readFile(new URL('../server/directorAgent.ts', import.meta.url), 'utf8')
  assert.match(source, /tools: \[publishSceneTool\]/)
  assert.match(source, /streamFn: createDirectorStreamFn\('publish_scene'\)/)
  assert.match(source, /const castingPromise = createCastSceneTool/)
  assert.match(source, /tools: \[videoPlanTool\]/)
  assert.match(source, /streamFn: createDirectorStreamFn\('write_video_prompt'\)/)
  assert.match(source, /Promise\.allSettled\(\[castingPromise, videoPromise\]\)/)
  assert.match(source, /sendTrace\(castingResult && videoPlan \? 'completed' : 'degraded'\)/)
  assert.doesNotMatch(source, /tools: \[publishSceneTool, castSceneTool, videoPlanTool\]/)
})

test('publishes the scene before starting the video phase', async () => {
  const source = await readFile(new URL('../server/directorAgent.ts', import.meta.url), 'utf8')
  const scenePrompt = source.indexOf('await sceneAgent.prompt')
  const sceneEvent = source.indexOf("send({ type: 'scene'", scenePrompt)
  const videoAgent = source.indexOf('const videoAgent = new Agent', sceneEvent)
  const videoPrompt = source.indexOf('videoAgent.continue', videoAgent)

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

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  buildStoryInputMessage,
  DIRECTOR_SYSTEM_PROMPT,
  DIRECTOR_VIDEO_PLAN_USER_MESSAGE,
  DIRECTOR_VIDEO_TOOL_INSTRUCTIONS,
} from '../server/directorPrompt.ts'

test('keeps the director focused on story and requires one scene tool', () => {
  assert.match(DIRECTOR_SYSTEM_PROMPT, /互动文字游戏《后宫》/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /一名秀女初次进宫/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /主动决定故事开场/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /2–3 个/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /调用一次 publish_scene/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /视频计划会在场景发布后单独生成/)
  assert.doesNotMatch(DIRECTOR_SYSTEM_PROMPT, /videoPrompts|每秒 3–4 个汉字/)
  assert.doesNotMatch(DIRECTOR_SYSTEM_PROMPT, /directorBoardPatch/)
  assert.doesNotMatch(DIRECTOR_SYSTEM_PROMPT, /宿籍|数值|确定性规则/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /程序会根据性别和年龄区间自动匹配演员/)
})

test('requires numeric choice ids and no longer asks for a videoPrompt field', () => {
  assert.match(DIRECTOR_SYSTEM_PROMPT, /"1"\/"2"\/"3"/)
  assert.doesNotMatch(DIRECTOR_SYSTEM_PROMPT, /videoPrompt/)
})

test('points the video planning prompt at submit_video_plan and the already-published scene', () => {
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /已经在上一步通过 publish_scene 发布/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /submit_video_plan 的参数只包含 video/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /scene（title、narrative、choices）/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /video 包含 totalDuration 和 videoPrompts/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /characters（本幕出现的主要剧情人物/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /唯一一次 submit_video_plan 调用提交/)
  assert.doesNotMatch(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /generate_video/)
  assert.doesNotMatch(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /publish_scene 的参数包含 scene、characters 和 video/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /15–30 秒的整数/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /videoPrompts/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /sequence 从 1 连续递增/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /每个 sequence 为 5–10 秒/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /transitionFromPrevious 只能是 continuous 或 cut/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /continuous：当前段是上一段画面和动作的直接延续/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /cut：当前段是主动切镜/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /每秒 3–4 个汉字/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /汉字数 ÷ 4 至汉字数 ÷ 3 秒/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /汉字数 ÷ 3”向上取整/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /在 10 秒内无法自然完成，拆成相邻的多个 sequence/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /视频 prompt 撰写指南/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /关键情节和关键台词需要写进对应的 prompt/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /明确说话者并优先保留 narrative 中的台词原文/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /不得只用氛围、表情或概括性动作代替/)
  assert.doesNotMatch(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /\[主体\/人物设定\]|\[场景\/环境\]|\[动作\/运镜\]|\[音频\/氛围\]/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /每个时间段相当于一个镜头 shot/)
  assert.doesNotMatch(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /不写对白/)

  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /正例（narrative → prompt）/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /宫门在身后沉沉合拢/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /示例视频计划/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /totalDuration：25/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /sequence：1；startTime：0；endTime：5/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /sequence：2；startTime：5；endTime：15/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /sequence：3；startTime：15；endTime：25/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /0秒-2秒：破晓时分/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /22秒-25秒：镜头回到圆脸少女/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /都跟紧喽，咱们先去储秀宫司礼监验身记档/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /圆脸少女被门槛绊倒/)
})

test('asks the model to submit a video plan for the scene it just published', () => {
  assert.match(DIRECTOR_VIDEO_PLAN_USER_MESSAGE, /场景已发布/)
  assert.match(DIRECTOR_VIDEO_PLAN_USER_MESSAGE, /submit_video_plan/)
})

test('runs two separate model phases, retrying tool validation failures instead of stopping immediately', async () => {
  const source = await readFile(new URL('../server/directorAgent.ts', import.meta.url), 'utf8')
  assert.match(source, /thinkingLevel: 'off'/)
  assert.match(source, /tools: \[publishSceneTool\]/)
  assert.match(source, /tools: \[videoPlanTool\]/)
  assert.match(source, /systemPrompt: DIRECTOR_SYSTEM_PROMPT,/)
  assert.match(source, /systemPrompt: DIRECTOR_VIDEO_TOOL_INSTRUCTIONS,/)
  assert.match(source, /createRetryingStopCondition\(MAX_TOOL_ATTEMPTS\)/)
  assert.doesNotMatch(source, /shouldStopAfterTurn: \(\) => true/)
  assert.doesNotMatch(source, /DIRECTOR_AGENT_SYSTEM_PROMPT/)
})

test('passes a player choice to the agent as the next user message', () => {
  const prompt = buildStoryInputMessage({
    type: 'choice',
    choice: { id: 'B', text: '询问身后的秀女' },
  })

  assert.match(prompt, /ID：B/)
  assert.match(prompt, /询问身后的秀女/)
})

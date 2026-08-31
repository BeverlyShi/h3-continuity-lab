import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  buildStoryInputMessage,
  DIRECTOR_SYSTEM_PROMPT,
  DIRECTOR_VIDEO_TOOL_INSTRUCTIONS,
} from '../server/directorPrompt.ts'

test('uses a small palace story prompt and requires the scene publishing tool', () => {
  assert.match(DIRECTOR_SYSTEM_PROMPT, /互动文字游戏《后宫》/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /一名秀女初次进宫/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /主动决定故事开场/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /2–3 个/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /必须调用 publish_scene/)
  assert.doesNotMatch(DIRECTOR_SYSTEM_PROMPT, /directorBoardPatch/)
  assert.doesNotMatch(DIRECTOR_SYSTEM_PROMPT, /宿籍|数值|确定性规则/)
})

test('requires numeric choice ids and no longer asks for a videoPrompt field', () => {
  assert.match(DIRECTOR_SYSTEM_PROMPT, /"1"\/"2"\/"3"/)
  assert.doesNotMatch(DIRECTOR_SYSTEM_PROMPT, /videoPrompt/)
})

test('describes the generate_video tool contract separately', () => {
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /调用 publish_scene 之前，必须先调用一次 generate_video/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /4–15 秒的整数/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /0-X秒/)
  assert.match(DIRECTOR_VIDEO_TOOL_INSTRUCTIONS, /首尾相接不重叠/)
})

test('keeps director model thinking disabled and registers both tools', async () => {
  const source = await readFile(new URL('../server/directorAgent.ts', import.meta.url), 'utf8')
  assert.match(source, /thinkingLevel: 'off'/)
  assert.match(source, /tools: \[generateVideoTool, publishSceneTool\]/)
})

test('passes a player choice to the agent as the next user message', () => {
  const prompt = buildStoryInputMessage({
    type: 'choice',
    choice: { id: 'B', text: '询问身后的秀女' },
  })

  assert.match(prompt, /ID：B/)
  assert.match(prompt, /询问身后的秀女/)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeTailFrame, DEEPSEEK_VISION_MODEL } from '../server/tailFrameVision.ts'
import { createInspectLastFrameTool } from '../server/inspectLastFrameTool.ts'
import type { TailFrameVisualState } from '../src/types/story.ts'

const characters = [
  { id: 'heroine', name: '沈清禾', gender: 'female' as const, minAge: 16, maxAge: 20 },
]

const state = {
  shot_size: '中景',
  shot_position: '人物正前方，与视线齐平',
  shot_content: {
    characters: [{
      id: 'heroine',
      facing: '正面朝向镜头',
      position_in_frame: '画面中央',
      pose: '站定不动',
      expression: '警觉',
      holding: null,
      appearance_notes: null,
    }],
    scene: {
      location: '宫墙甬道',
      visible_elements: '朱红宫墙和青石路',
      lighting: '清晨柔光',
      time_of_day: '清晨',
    },
    key_props: [],
  },
  frame_quality: '清晰稳定',
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((item) => item.text ?? '').join('\n')

test('inspect_last_frame reports a missing frame or vision key as a normal result, not a failure', async () => {
  const analyze = async () => { throw new Error('不应调用识别') }
  const noFrame = createInspectLastFrameTool({ getPreviousScene: () => undefined, visionKey: 'sk', analyze, onInspect: () => {} })
  assert.equal(noFrame.name, 'inspect_last_frame')
  assert.match(textOf(await noFrame.execute('call-1', {})), /没有可接的视频画面.*new_shot/)

  const previous = { tailFrameDataUrl: 'data:image/jpeg;base64,AAAA', characters }
  const noKey = createInspectLastFrameTool({ getPreviousScene: () => previous, analyze, onInspect: () => {} })
  assert.match(textOf(await noKey.execute('call-2', {})), /未配置 DeepSeek Key/)
})

test('inspect_last_frame analyzes the previous scene frame with its characters and records the state', async () => {
  const previous = { tailFrameDataUrl: 'data:image/jpeg;base64,AAAA', characters }
  let seen: { apiKey: string; imageUrl: string; characters: unknown } | undefined
  let recorded: TailFrameVisualState | undefined
  const tool = createInspectLastFrameTool({
    getPreviousScene: () => previous,
    visionKey: 'sk-deepseek-test',
    analyze: async (input) => {
      seen = input
      return state as TailFrameVisualState
    },
    onInspect: (visualState) => { recorded = visualState },
  })
  const result = await tool.execute('call-3', {})
  assert.deepEqual(seen, { apiKey: 'sk-deepseek-test', imageUrl: previous.tailFrameDataUrl, characters, signal: undefined })
  assert.deepEqual(recorded, state)
  assert.match(textOf(result), /宫墙甬道/)
  assert.match(textOf(result), /只用于镜头衔接/)
})

test('uses only the dedicated DeepSeek vision model for tail-frame inspection', async () => {
  const originalFetch = globalThis.fetch
  let requestBody: {
    model?: string
    messages?: Array<{ content?: Array<{ type?: string; image_url?: { url?: string } }> }>
  } = {}
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as typeof requestBody
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(state) } }],
    }), { status: 200 })
  }

  try {
    const result = await analyzeTailFrame({
      apiKey: 'sk-deepseek-test',
      imageUrl: 'https://example.com/tail.jpg',
      characters,
    })

    assert.equal(requestBody.model, DEEPSEEK_VISION_MODEL)
    const imageBlocks = requestBody.messages?.[0]?.content?.filter((block) => block.type === 'image_url') ?? []
    assert.equal(imageBlocks.length, 1)
    assert.equal(imageBlocks[0].image_url?.url, 'https://example.com/tail.jpg')
    assert.deepEqual(result, state)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rejects unregistered character ids returned by the vision model', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            ...state,
            shot_content: {
              ...state.shot_content,
              characters: [{ ...state.shot_content.characters[0], id: 'invented_character' }],
            },
          }),
        },
      }],
    }), { status: 200 })
  }

  try {
    await assert.rejects(() => analyzeTailFrame({
      apiKey: 'sk-deepseek-test',
      imageUrl: 'https://example.com/tail.jpg',
      characters,
    }), /未登记人物/)
    assert.equal(calls, 3)
  } finally {
    globalThis.fetch = originalFetch
  }
})

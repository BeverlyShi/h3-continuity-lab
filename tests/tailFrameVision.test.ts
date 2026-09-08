import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeTailFrame, DEEPSEEK_VISION_MODEL } from '../server/tailFrameVision.ts'
import { createInspectTailFrameTool, inspectTailFrameSchema } from '../server/inspectTailFrameTool.ts'
import { Check } from 'typebox/value'

test('accepts inline tail images from uploaded videos without a hosted image URL', () => {
  assert.equal(Check(inspectTailFrameSchema, {
    imageUrl: `data:image/jpeg;base64,${'a'.repeat(20_000)}`,
    characters: [],
  }), true)
})

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

test('exposes tail-frame recognition as a dedicated agent tool', () => {
  const tool = createInspectTailFrameTool('sk-deepseek-test')
  assert.equal(tool.name, 'inspect_tail_frame')
  assert.match(tool.description, /DeepSeek Vision/)
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

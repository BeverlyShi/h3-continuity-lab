import assert from 'node:assert/strict'
import test from 'node:test'
import { narrativeSources } from '../server/narrativeReview.ts'
import { runSimpleDirector } from '../server/simpleDirector.ts'
import { buildManualPrompt, prepareManualScene } from '../src/services/manualSceneVideo.ts'
import { buildVideoReferencePrompt } from '../src/services/videoReferencePrompt.ts'
import { generateSceneVideoSegments } from '../src/services/sceneVideoGenerator.ts'
import type { CastableActor } from '../src/types/actor.ts'
import type { GameScene } from '../src/types/game.ts'
import type { ScenePublish, VideoPlan } from '../src/types/story.ts'

const scene: ScenePublish = {
  dialogues: [
    { id: 'line_1', characterId: 'xu_momo', text: '你识字吗？' },
    { id: 'line_2', characterId: 'heroine', text: '家父教过。' },
  ],
  scene: {
    title: '宫门问话', narrative: '沈清禾低头站在宫门内，徐嬷嬷拨开她额前的碎发，问：“你识字吗？”沈清禾抬头回答：“家父教过。”',
    choices: [{ id: '1', text: '解释家学' }, { id: '2', text: '询问缘由' }, { id: '3', text: '低头等候' }],
  },
  characters: [
    { id: 'heroine', name: '沈清禾', gender: 'female', minAge: 16, maxAge: 20 },
    { id: 'xu_momo', name: '徐嬷嬷', gender: 'female', minAge: 40, maxAge: 50 },
  ],
}
const actors: CastableActor[] = [
  { id: 'actor-1', name: '演员一', gender: 'female', minAge: 16, maxAge: 20 },
  { id: 'actor-2', name: '演员二', gender: 'female', minAge: 40, maxAge: 50 },
]
const draft: VideoPlan = {
  visualContext: { style: '写实古装宫廷剧，清晨冷色自然光从画面右侧照入。', scene: '神武门内侧石阶下的平台，背景是一面朱红宫墙。' },
  videoPrompts: [
    {
      characterIds: ['heroine', 'xu_momo'],
      beats: [
        { visual: '固定双人中近景，机位与视线齐平，从两人侧面拍摄。沈清禾站在画面左侧，面朝右侧低头；徐嬷嬷站在右侧，抬起右手，将沈清禾额前碎发拨向鬓边，随后放下手。', audio: '抬手时衣袖轻响。' },
        { visual: '硬切至徐嬷嬷近景，从沈清禾肩后拍摄，沈清禾肩部虚化占据画面左下角。镜头固定。徐嬷嬷目光停在沈清禾眼睛上，轻轻眯眼，{{line_1}}，随后闭嘴。', dialogueIds: ['line_1'], audio: '背景有轻微风声。' },
      ],
      endFrame: '沈清禾肩后近景，徐嬷嬷闭嘴，目光停在沈清禾眼睛上。',
    },
    {
      characterIds: ['heroine', 'xu_momo'],
      beats: [{ visual: '固定近景，机位仍在沈清禾肩后，徐嬷嬷位于画面中央，闭嘴注视沈清禾。沈清禾轻轻抬起头，{{line_2}}。', dialogueIds: ['line_2'], audio: '背景只有轻微风声。' }],
      endFrame: '沈清禾肩后近景，徐嬷嬷仍在画面中央，注视已经抬头的沈清禾。',
    },
  ],
}

const reviewResult = (messages: Array<{ content: string }>) => {
  const input = JSON.parse(messages.at(-1)!.content)
  return { issues: [], coverage: input.finalVideo ? narrativeSources(input.scene.narrative).map((item) => ({
    sourceId: item.id, status: 'shown', evidence: input.finalVideo.videoPrompts[0].prompt,
  })) : [] }
}

test('Simple repairs semantic failures against the same narrative and never publishes a rejected video', async () => {
  const originalFetch = globalThis.fetch
  try {
    for (const repairSucceeds of [true, false]) {
      let videoAttempts = 0
      const events: string[] = []
      globalThis.fetch = async (_url, init) => {
        const request = JSON.parse(String(init?.body))
        const name = request.tools[0].function.name
        let result: unknown = scene
        if (name === 'write_video_prompt') {
          videoAttempts += 1
          const input = JSON.parse(request.messages[1].content.split('\n')[1])
          assert.equal(input.narrative, scene.scene.narrative)
          if (videoAttempts === 2) assert.match(request.messages.at(-1).content, /原文没有手帕/)
          const candidate = structuredClone(draft)
          if (videoAttempts === 1 || !repairSucceeds) candidate.videoPrompts[0].beats[0].visual += '沈清禾攥紧手帕。'
          result = candidate
        } else if (name === 'review_narrative') {
          const input = JSON.parse(request.messages.at(-1).content)
          const review = reviewResult(request.messages)
          if (input.finalVideo) {
            assert.ok(input.finalVideo.videoPrompts[0].prompt.startsWith(draft.visualContext.style))
            assert.doesNotMatch(JSON.stringify(input.finalVideo), /xu_momo说|heroine说|\{\{line/)
            result = { ...review, issues: videoAttempts === 1 || !repairSucceeds ? ['原文没有手帕，请删除攥帕动作。'] : [] }
          } else result = review
        }
        return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{
          id: `call-${name}-${videoAttempts}`, type: 'function', function: { name, arguments: JSON.stringify(result) },
        }] } }] }))
      }
      const result = await runSimpleDirector({
        apiKey: 'test-key', modelId: 'deepseek-v4-flash',
        context: { ok: true, sessionId: `semantic-repair-${repairSucceeds}`, turn: 1, input: { type: 'start' } },
        actors: [], castings: [], traceId: 'semantic-repair', send: (event) => { events.push(event.type) },
      })
      assert.equal(videoAttempts, 2)
      assert.equal(events.filter((event) => event === 'scene').length, 1)
      assert.equal(events.filter((event) => event === 'video_plan').length, repairSucceeds ? 1 : 0)
      assert.equal(events.includes('video_plan_error'), !repairSucceeds)
      if (repairSucceeds) assert.doesNotMatch(JSON.stringify(result.video), /攥紧手帕/)
      else assert.equal(result.video, undefined)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

for (const modelId of ['deepseek-v4-flash', 'z-ai/glm-5.3-flash'] as const) {
  test(`Simple ${modelId} retains reasoning through tool repair, video planning and the next story turn`, async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), modelId === 'z-ai/glm-5.3-flash' ? 'https://open.bigmodel.cn/api/paas/v4/chat/completions' : 'https://api.deepseek.com/chat/completions')
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-key')
      const request = JSON.parse(String(init?.body))
      if (request.thinking?.type === 'enabled' && 'tool_choice' in request) {
        return new Response(JSON.stringify({ error: { message: 'Thinking mode does not support this tool_choice', type: 'invalid_request_error' } }), { status: 400 })
      }
      calls += 1
      assert.equal(request.thinking.type, 'enabled')
      assert.equal(request.model, modelId === 'z-ai/glm-5.3-flash' ? 'glm-5.3-flash' : modelId)
      if (modelId === 'z-ai/glm-5.3-flash') assert.equal(request.thinking.clear_thinking, false)
      assert.equal(request.reasoning_effort, 'high')
      const assistants = request.messages.filter((message: { role: string }) => message.role === 'assistant')
      if (request.tools[0].function.name === 'write_video_prompt') {
        assert.equal(assistants.length, 0)
        assert.equal(request.messages.length, 2)
        assert.ok(request.messages[1].content.includes(scene.scene.narrative))
      }
      for (const message of assistants) assert.equal(message.reasoning_content, 'Test reasoning for scene planning.')
      const toolName = request.tools[0].function.name
      const result = calls === 1 ? {} : toolName === 'publish_scene' ? scene : toolName === 'review_narrative' ? reviewResult(request.messages) : draft
      return new Response(JSON.stringify({ choices: [{ message: {
        reasoning_content: 'Test reasoning for scene planning.',
        tool_calls: [{ id: `call-${calls}`, type: 'function', function: { name: toolName, arguments: JSON.stringify(result) } }],
      } }] }), { status: 200 })
    }
    try {
      for (const turn of [1, 2]) {
        const result = await runSimpleDirector({
          apiKey: 'test-key', modelId, thinkingEnabled: true,
          context: { ok: true, sessionId: `simple-thinking-replay-${modelId}`, turn, input: turn === 1 ? { type: 'start' } : { type: 'choice', choice: scene.scene.choices[0] } },
          actors: [], castings: [], traceId: `simple-thinking-${turn}`, send: () => {},
        })
        assert.deepEqual(result.scene, scene.scene)
        assert.equal(result.video?.videoPrompts.length, 2)
      }
      assert.equal(calls, 9)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
}

test('passes actual casting and tail availability to the video model, then formats its shots for both delivery modes', async (t) => {
  for (const mode of ['portraits', 'tail', 'no-portraits'] as const) {
    await t.test(mode, async () => {
      const originalFetch = globalThis.fetch
      const requests: Array<{ messages: Array<{ role: string; content: string }>; tools: Array<{ function: { name: string } }> }> = []
      globalThis.fetch = async (_url, init) => {
        const request = JSON.parse(String(init?.body))
        assert.deepEqual(request.thinking, { type: 'enabled' })
        assert.equal(request.reasoning_effort, 'high')
        assert.equal(request.max_tokens, 16_384)
        requests.push(request)
        const toolName = request.tools[0].function.name
        return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{
          id: `call-${requests.length}`, type: 'function',
          function: { name: toolName, arguments: JSON.stringify(toolName === 'publish_scene' ? scene : toolName === 'review_narrative' ? reviewResult(request.messages) : draft) },
        }] } }] }), { status: 200 })
      }
      try {
        const events: string[] = []
        const result = await runSimpleDirector({
          apiKey: 'test-key', modelId: 'deepseek-v4-flash', thinkingEnabled: true,
          context: { ok: true, sessionId: `prompt-flow-${mode}`, turn: 1, input: { type: 'start' }, hasPreviousTailFrame: mode === 'tail' },
          actors: mode === 'no-portraits' ? [] : actors, castings: [], traceId: `trace-${mode}`,
          send: (event) => { events.push(event.type) },
        })
        assert.equal(requests.length, 4)
        assert.deepEqual(requests.map((request) => request.tools[0].function.name), ['publish_scene', 'review_narrative', 'write_video_prompt', 'review_narrative'])
        const videoMessages = requests[2].messages
        const input = JSON.parse(videoMessages.at(-1)!.content.split('\n')[1])
        assert.equal(input.firstSegmentReference, mode === 'tail' ? 'previous_tail_frame' : 'character_images')
        assert.equal(input.laterSegmentReference, 'previous_segment_tail_frame_only')
        assert.deepEqual(input.dialogues, scene.dialogues)
        assert.deepEqual(input.characters.map((character: { hasFirstSegmentPortrait: boolean }) => character.hasFirstSegmentPortrait), [mode === 'portraits', mode === 'portraits'])
        assert.ok(videoMessages[0].content.includes('固定双人中近景'))
        assert.ok(events.indexOf('cast') < events.indexOf('video_plan'))

        const video = result.video!
        assert.ok(video)
        const rendered = video.videoPrompts.map((segment) => segment.prompt).join('\n')
        for (const line of scene.dialogues) assert.ok(rendered.includes(`${scene.characters.find((character) => character.id === line.characterId)!.name}说：“${line.text}”`))
        const gameScene: GameScene = {
          ...scene.scene, id: 'flow-scene', turn: 1,
          videoClips: video.videoPrompts.map((segment) => ({ ...segment, status: 'skipped' })),
        }
        const references = mode === 'no-portraits' ? {} : {
          heroine: { characterName: '沈清禾', imageUrl: 'heroine.jpg' },
          xu_momo: { characterName: '徐嬷嬷', imageUrl: 'momo.jpg' },
        }
        const initialTailFrameUrl = mode === 'tail' ? 'previous-tail.jpg' : undefined
        const manual = prepareManualScene(gameScene, references, initialTailFrameUrl)
        const manualPrompt = buildManualPrompt(manual.videoClips![0])
        let apiPrompt = ''
        await generateSceneVideoSegments({
          generate: async (prompt, _duration, _sequence, conditioning) => {
            const images = conditioning?.startImageUrl
              ? [{ type: 'start_frame' as const, imageUrl: conditioning.startImageUrl, label: '起始尾帧' }]
              : (conditioning?.characterReferences ?? []).map((reference) => ({ type: 'character' as const, imageUrl: reference.imageUrl, label: reference.characterName }))
            apiPrompt = buildVideoReferencePrompt(prompt, images)
            return { videoUrl: 'video.mp4' }
          },
          createTailFrameUrl: async () => 'new-tail.jpg',
        }, video, () => {}, { characterReferences: references, initialTailFrameUrl, endSequence: 1 })
        assert.equal(apiPrompt, manualPrompt)
        assert.doesNotMatch(manualPrompt, /【|三视图|该演员扮演|实测尾帧|角色ID/)
        if (mode === 'portraits') {
          assert.ok(manualPrompt.indexOf('神武门') < manualPrompt.indexOf('沈清禾外观与图1一致'))
          assert.ok(manualPrompt.indexOf('徐嬷嬷外观与图2一致') < manualPrompt.indexOf('0–'))
        } else if (mode === 'tail') {
          const firstShot = manualPrompt.split('\n\n').find((paragraph) => paragraph.startsWith('0–'))!
          assert.match(firstShot, /以图1为起始画面/)
          assert.doesNotMatch(manualPrompt, /图2|徐嬷嬷外观与图1/)
        } else {
          assert.doesNotMatch(manualPrompt, /图\d/)
        }
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  }
})

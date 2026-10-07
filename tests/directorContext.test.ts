import assert from 'node:assert/strict'
import test from 'node:test'
import type { Entry } from '@earendil-works/pi-agent-core'
import { projectHistory } from '../src/director/directorContext.ts'

const usage = {
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

let seqCounter = 0
const nextSeq = () => { seqCounter += 1; return seqCounter }

const userEntry = (text: string): Entry => {
  const seq = nextSeq()
  return { type: 'message', id: `entry-${seq}`, seq, parentId: null, timestamp: seq, message: { role: 'user', content: [{ type: 'text', text }], timestamp: seq } }
}

const traceBoundary = (traceId: string): Entry => {
  const seq = nextSeq()
  return { type: 'custom', id: `entry-${seq}`, seq, parentId: null, timestamp: seq, customType: 'director_trace', data: { traceId } }
}

const toolCallEntry = (toolCallId: string, name: string, args: Record<string, unknown>): Entry => {
  const seq = nextSeq()
  return {
    type: 'message', id: `entry-${seq}`, seq, parentId: null, timestamp: seq,
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: '思考中……' }, { type: 'toolCall', id: toolCallId, name, arguments: args }],
      api: 'openai-completions', provider: 'deepseek', model: 'test-model', usage, stopReason: 'toolUse', timestamp: seq,
    },
  }
}

const toolResultEntry = (toolCallId: string, toolName: string, text: string, details: unknown, isError = false): Entry => {
  const seq = nextSeq()
  return {
    type: 'message', id: `entry-${seq}`, seq, parentId: null, timestamp: seq,
    message: { role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text }], details, isError, timestamp: seq },
  }
}

const finalVisualState = {
  shot_size: '中景', shot_position: '人物正前方',
  shot_content: { characters: [], scene: { location: '甬道', visible_elements: '宫墙', lighting: '柔光', time_of_day: '清晨' }, key_props: [] },
  frame_quality: '清晰稳定',
}

test('projects a two-turn session: history collapses to one-line results, current turn stays intact', () => {
  const turn1 = [
    traceBoundary('trace-1'),
    userEntry('请开始故事。'),
    toolCallEntry('call-publish-1', 'publish_scene', { scene: { title: 't', narrative: 'n', choices: [] }, characters: [], dialogues: [] }),
    toolResultEntry('call-publish-1', 'publish_scene', '场景已发布。\n待选角人物：……', { scene: {}, characters: [], dialogues: [] }),
    toolCallEntry('call-cast-1', 'cast_scene', { assignments: [{ characterId: 'heroine', actorId: 'actor-a', reason: '年龄相符' }] }),
    toolResultEntry('call-cast-1', 'cast_scene', '选角已确定：\n- 女主：演员甲，有参考图\n- 掌事姑姑：演员乙，有参考图\n下一步：调用 write_segment 编写第 1 段分镜。', { castings: [] }),
    toolCallEntry('call-write-1', 'write_segment', { sequence: 1, characters: ['heroine'], seconds: 7, isLast: false, style: 's', prompt: 'p1' }),
    toolResultEntry('call-write-1', 'write_segment', '第 1 段已写：……', { segment: { sequence: 1, startTime: 0, endTime: 7, characterIds: ['heroine'], prompt: 'p1' } }),
    toolCallEntry('call-gen-1', 'generate_segment', { sequence: 1 }),
    toolResultEntry('call-gen-1', 'generate_segment', '第 1 段已生成：实际时长 7.2 秒……', { durationSeconds: 7.2, visualState: { frame_quality: '清晰稳定' } }),
    toolCallEntry('call-write-2', 'write_segment', { sequence: 2, characters: ['heroine'], seconds: 8, isLast: true }),
    toolResultEntry('call-write-2', 'write_segment', '第 2 段已写：……', { segment: { sequence: 2, startTime: 7, endTime: 15, characterIds: ['heroine'], prompt: 'p2' } }),
    toolCallEntry('call-gen-2', 'generate_segment', { sequence: 2 }),
    toolResultEntry('call-gen-2', 'generate_segment', '第 2 段已生成：实际时长 8.5 秒……', { durationSeconds: 8.5, visualState: finalVisualState }),
    toolCallEntry('call-finish-1', 'finish_turn', {}),
    toolResultEntry('call-finish-1', 'finish_turn', '回合已结束。', { skipVideo: undefined }),
  ]

  const turn2 = [
    traceBoundary('trace-2'),
    userEntry('玩家选择了：\nID：1'),
    toolCallEntry('call-publish-2', 'publish_scene', { scene: { title: 't2', narrative: 'n2', choices: [] }, characters: [], dialogues: [] }),
  ]

  const entries = [...turn1, ...turn2]
  const projected = projectHistory(entries)
  assert.equal(projected.length, entries.length)

  const messages = projected.filter((entry): entry is Extract<Entry, { type: 'message' }> => entry.type === 'message')
  const byToolCallId = new Map<string, { call?: typeof messages[number]; result?: typeof messages[number] }>()
  for (const entry of messages) {
    if (entry.message.role === 'assistant') {
      for (const content of entry.message.content) {
        if (content.type === 'toolCall') {
          byToolCallId.set(content.id, { ...byToolCallId.get(content.id), call: entry })
        }
      }
    }
    if (entry.message.role === 'toolResult') {
      byToolCallId.set(entry.message.toolCallId, { ...byToolCallId.get(entry.message.toolCallId), result: entry })
    }
  }

  // 每个 toolCall / toolResult 仍然配对。
  for (const id of ['call-publish-1', 'call-cast-1', 'call-write-1', 'call-gen-1', 'call-write-2', 'call-gen-2', 'call-finish-1', 'call-publish-2']) {
    const pair = byToolCallId.get(id)
    assert.ok(pair?.call, `missing call for ${id}`)
    assert.ok(pair?.result || id === 'call-publish-2', `missing result for ${id}`)
  }

  const textOf = (entry: typeof messages[number] | undefined) => {
    if (entry?.message.role !== 'toolResult') return undefined
    const content = entry.message.content
    return content[0]?.type === 'text' ? content[0].text : undefined
  }

  assert.equal(textOf(byToolCallId.get('call-publish-1')?.result), '场景已发布')
  assert.match(textOf(byToolCallId.get('call-cast-1')?.result) ?? '', /^选角：女主→演员甲，掌事姑姑→演员乙$/)
  assert.equal(textOf(byToolCallId.get('call-write-1')?.result), '第 1 段已写，7 秒')
  assert.equal(textOf(byToolCallId.get('call-gen-1')?.result), '第 1 段已生成，实测 7.2 秒')
  assert.equal(textOf(byToolCallId.get('call-write-2')?.result), '第 2 段已写，8 秒')
  // 最后一段（isLast）的最后一次生成结果保留完整 visualState JSON。
  assert.equal(textOf(byToolCallId.get('call-gen-2')?.result), JSON.stringify(finalVisualState))
  assert.equal(textOf(byToolCallId.get('call-finish-1')?.result), '回合已结束')

  // 历史回合的 toolCall 参数被压缩；thinking 块被删除；publish_scene / cast_scene 保留完整参数。
  const writeCall1 = byToolCallId.get('call-write-1')?.call
  assert.ok(writeCall1?.message.role === 'assistant')
  const toolCallContent = writeCall1!.message.content.filter((item) => item.type === 'toolCall')
  assert.equal(toolCallContent.length, 1)
  assert.deepEqual((toolCallContent[0] as { arguments: unknown }).arguments, { sequence: 1 })
  assert.equal(writeCall1!.message.content.some((item) => item.type === 'thinking'), false)

  const publishCall1 = byToolCallId.get('call-publish-1')?.call
  assert.ok(publishCall1?.message.role === 'assistant')
  const publishArgs = publishCall1!.message.content.find((item) => item.type === 'toolCall') as { arguments: { characters: unknown[] } }
  assert.deepEqual(publishArgs.arguments.characters, [])

  const finishCall1 = byToolCallId.get('call-finish-1')?.call
  assert.ok(finishCall1?.message.role === 'assistant')
  const finishArgs = finishCall1!.message.content.find((item) => item.type === 'toolCall') as { arguments: unknown }
  assert.deepEqual(finishArgs.arguments, {})

  // 当前回合（turn2）完整保留，未被压缩。
  const publishCall2 = byToolCallId.get('call-publish-2')?.call
  assert.ok(publishCall2?.message.role === 'assistant')
  const publishArgs2 = publishCall2!.message.content.find((item) => item.type === 'toolCall') as { arguments: { scene: { title: string } } }
  assert.equal(publishArgs2.arguments.scene.title, 't2')
})

test('history scenes from the whole-scene flow keep the story and casting but shrink the storyboard and the frame check', () => {
  const storyboardArgs = { opening: 'continue', style: 's', segments: [{ characters: ['heroine'], seconds: 8, prompt: 'p1' }, { characters: ['heroine'], seconds: 8, prompt: 'p2' }] }
  const scene1 = [
    traceBoundary('trace-a'),
    userEntry('玩家选择了：\nID：2'),
    toolCallEntry('call-publish-a', 'publish_scene', { scene: { title: '夜访', narrative: 'n', choices: [] }, characters: [], dialogues: [] }),
    toolResultEntry('call-publish-a', 'publish_scene', '场景已发布。', {}),
    toolCallEntry('call-inspect-a', 'inspect_last_frame', {}),
    toolResultEntry('call-inspect-a', 'inspect_last_frame', `上一场次最后一帧：${JSON.stringify(finalVisualState)}`, { state: finalVisualState }),
    toolCallEntry('call-video-a', 'write_scene_video', storyboardArgs),
    toolResultEntry('call-video-a', 'write_scene_video', '分镜已交付，开场方式 continue，共 2 段 16 秒：\n第 1 段 0–8 秒（无台词）\n第 2 段 8–16 秒（无台词）', {}),
  ]
  const rewrite = [
    traceBoundary('trace-b'),
    userEntry('玩家看了本场次的视频，要求重写第 2 段。'),
    toolCallEntry('call-video-b', 'write_scene_video', { rewriteSequence: 2, segments: [{ characters: ['heroine'], seconds: 8, prompt: 'p2b' }] }),
    toolResultEntry('call-video-b', 'write_scene_video', '第 2 段已重写，整场 2 段 16 秒：\n……', {}),
  ]
  const current = [traceBoundary('trace-c'), userEntry('玩家选择了：\nID：1')]
  const projected = projectHistory([...scene1, ...rewrite, ...current])

  const resultText = (toolCallId: string) => {
    const entry = projected.find((item) => item.type === 'message' && item.message.role === 'toolResult' && item.message.toolCallId === toolCallId)
    return entry?.type === 'message' && entry.message.role === 'toolResult' && entry.message.content[0]?.type === 'text'
      ? entry.message.content[0].text
      : undefined
  }
  const callArgs = (toolCallId: string) => {
    for (const item of projected) {
      if (item.type !== 'message' || item.message.role !== 'assistant') continue
      const call = item.message.content.find((content) => content.type === 'toolCall' && content.id === toolCallId)
      if (call?.type === 'toolCall') return call.arguments
    }
    return undefined
  }

  assert.equal(resultText('call-inspect-a'), '已查看上一场次最后一帧')
  assert.equal(resultText('call-video-a'), '分镜已交付，开场方式 continue，共 2 段 16 秒')
  assert.equal(resultText('call-video-b'), '第 2 段已重写，整场 2 段 16 秒')
  assert.deepEqual(callArgs('call-video-a'), {})
  assert.deepEqual(callArgs('call-video-b'), { rewriteSequence: 2 })
  assert.equal((callArgs('call-publish-a') as { scene: { title: string } }).scene.title, '夜访')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Entry } from '@earendil-works/pi-agent-core'
import {
  findRewritableScene,
  findUnresolvedToolCall,
  persistTurnState,
  readLatestTurnState,
  type DirectorTurnState,
} from '../server/directorTurnState.ts'

const usage = {
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const userEntry = (seq: number): Entry => ({
  type: 'message', id: `entry-${seq}`, seq, parentId: seq > 1 ? `entry-${seq - 1}` : null, timestamp: seq,
  message: { role: 'user', content: [{ type: 'text', text: `user-${seq}` }], timestamp: seq },
})

const assistantToolCallEntry = (seq: number, toolCallId: string, name = 'generate_segment', args: Record<string, unknown> = { sequence: 1 }): Entry => ({
  type: 'message', id: `entry-${seq}`, seq, parentId: `entry-${seq - 1}`, timestamp: seq,
  message: {
    role: 'assistant',
    content: [{ type: 'toolCall', id: toolCallId, name, arguments: args }],
    api: 'openai-completions', provider: 'deepseek', model: 'test-model', usage, stopReason: 'toolUse', timestamp: seq,
  },
})

const turnStateEntry = (seq: number, data: unknown): Entry => ({
  type: 'custom', id: `entry-${seq}`, seq, parentId: `entry-${seq - 1}`, timestamp: seq,
  customType: 'director_turn_state', data,
})

const baseState: DirectorTurnState = {
  status: 'finished',
  traceId: 'trace-1',
  modelId: 'deepseek-v4-flash',
  thinkingEnabled: false,
  videoMode: 'comfy',
  context: { ok: true, sessionId: 'session-1', turn: 1, input: { type: 'start' } },
  actors: [],
  castings: [],
  startSeq: 0,
  startedAt: 0,
  scenePublish: {
    scene: { title: '廊下', narrative: '女主停在廊下。', choices: [{ id: '1', text: '上前' }, { id: '2', text: '后退' }, { id: '3', text: '等候' }] },
    characters: [{ id: 'heroine', name: '女主', gender: 'female', minAge: 16, maxAge: 20 }],
    dialogues: [],
  },
  video: {
    opening: 'new_shot',
    style: '写实古装画面，清晨自然光。',
    segments: [
      { characters: ['heroine'], seconds: 8, prompt: '0–8秒：女主中景。' },
      { characters: ['heroine'], seconds: 8, prompt: '0–8秒：承接上一段画面。' },
    ],
  },
}

test('findUnresolvedToolCall finds a trailing assistant tool call with no matching result', () => {
  const entries = [userEntry(1), assistantToolCallEntry(2, 'call-1', 'generate_segment', { sequence: 1 })]
  assert.deepEqual(findUnresolvedToolCall(entries), { toolCallId: 'call-1', toolName: 'generate_segment', arguments: { sequence: 1 } })
})

test('findUnresolvedToolCall ignores an assistant message with no tool calls', () => {
  const entries: Entry[] = [{
    type: 'message', id: 'entry-1', seq: 1, parentId: null, timestamp: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], api: 'openai-completions', provider: 'deepseek', model: 'm', usage, stopReason: 'stop', timestamp: 1 },
  }]
  assert.equal(findUnresolvedToolCall(entries), undefined)
})

test('readLatestTurnState returns the last director_turn_state entry', () => {
  const entries = [turnStateEntry(1, { status: 'running', traceId: 't1' }), turnStateEntry(2, baseState)]
  assert.deepEqual(readLatestTurnState(entries), baseState)
})

test('findRewritableScene only accepts a finished scene written with the new whole-scene storyboard', () => {
  assert.deepEqual(findRewritableScene([turnStateEntry(1, baseState)]), baseState)
  assert.equal(findRewritableScene([turnStateEntry(1, { ...baseState, status: 'running' })]), undefined)
  assert.equal(findRewritableScene([turnStateEntry(1, { ...baseState, video: undefined })]), undefined)
  // 旧版逐段循环的状态：segments 里带 sequence、没有 opening。
  const legacy = { ...baseState, video: { segments: [{ sequence: 1, characters: [], seconds: 8, isLast: false, prompt: 'p', lineIds: [], generateAttempts: 1 }] } }
  assert.equal(findRewritableScene([turnStateEntry(1, legacy)]), undefined)
  assert.equal(findRewritableScene([turnStateEntry(1, baseState), turnStateEntry(2, { status: 'finished', traceId: 't2' })]), undefined)
})

test('persistTurnState drops the previous scene frame image before writing to the session', async () => {
  const written: unknown[] = []
  const session = { appendCustomEntry: async (_type: string, data: unknown) => { written.push(data) } }
  const withFrame: DirectorTurnState = {
    ...baseState,
    context: { ...baseState.context, previousScene: { tailFrameDataUrl: 'data:image/jpeg;base64,AAAA', characters: [] } },
  }
  await persistTurnState(session as unknown as Parameters<typeof persistTurnState>[0], withFrame)
  assert.equal((written[0] as DirectorTurnState).context.previousScene, undefined)
  assert.equal((written[0] as DirectorTurnState).video?.opening, 'new_shot')
})

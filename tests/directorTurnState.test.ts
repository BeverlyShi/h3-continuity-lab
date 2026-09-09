import assert from 'node:assert/strict'
import test from 'node:test'
import type { Entry } from '@earendil-works/pi-agent-core/node'
import {
  findAwaitingUpload,
  findUnresolvedToolCall,
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

const toolResultEntry = (seq: number, toolCallId: string, toolName = 'generate_segment', isError = false): Entry => ({
  type: 'message', id: `entry-${seq}`, seq, parentId: `entry-${seq - 1}`, timestamp: seq,
  message: { role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text: 'ok' }], details: {}, isError, timestamp: seq },
})

const turnStateEntry = (seq: number, data: unknown): Entry => ({
  type: 'custom', id: `entry-${seq}`, seq, parentId: `entry-${seq - 1}`, timestamp: seq,
  customType: 'director_turn_state', data,
})

const baseState: DirectorTurnState = {
  status: 'awaiting_upload',
  traceId: 'trace-1',
  modelId: 'deepseek-v4-flash',
  thinkingEnabled: false,
  videoMode: 'manual',
  context: { ok: true, sessionId: 'session-1', turn: 1, input: { type: 'start' } },
  actors: [],
  castings: [],
  startSeq: 0,
  startedAt: 0,
  video: { segments: [{ sequence: 1, characters: [], seconds: 8, isLast: false, prompt: 'p', lineIds: [], generateAttempts: 1 }] },
  pending: { sequence: 1, toolCallId: 'call-1' },
  finished: false,
}

test('findUnresolvedToolCall returns undefined when the transcript ends cleanly', () => {
  const entries = [userEntry(1), assistantToolCallEntry(2, 'call-1'), toolResultEntry(3, 'call-1')]
  assert.equal(findUnresolvedToolCall(entries), undefined)
})

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

test('findAwaitingUpload requires both the stored status and a matching unresolved tool call', () => {
  const entries = [
    userEntry(1),
    assistantToolCallEntry(2, 'call-1', 'generate_segment', { sequence: 1 }),
    turnStateEntry(3, baseState),
  ]
  const awaiting = findAwaitingUpload(entries)
  assert.deepEqual(awaiting, { state: baseState, pending: { sequence: 1, toolCallId: 'call-1' } })
})

test('findAwaitingUpload rejects when the unresolved tool call id does not match the stored pending state', () => {
  const entries = [
    userEntry(1),
    assistantToolCallEntry(2, 'call-2', 'generate_segment', { sequence: 1 }),
    turnStateEntry(3, baseState),
  ]
  assert.equal(findAwaitingUpload(entries), undefined)
})

test('findAwaitingUpload rejects when the tool call has already been resolved', () => {
  const entries = [
    userEntry(1),
    assistantToolCallEntry(2, 'call-1', 'generate_segment', { sequence: 1 }),
    toolResultEntry(3, 'call-1'),
    turnStateEntry(4, baseState),
  ]
  assert.equal(findAwaitingUpload(entries), undefined)
})

test('findAwaitingUpload rejects when the stored status is not awaiting_upload', () => {
  const entries = [
    userEntry(1),
    assistantToolCallEntry(2, 'call-1', 'generate_segment', { sequence: 1 }),
    turnStateEntry(3, { status: 'finished', traceId: 'trace-1' }),
  ]
  assert.equal(findAwaitingUpload(entries), undefined)
})

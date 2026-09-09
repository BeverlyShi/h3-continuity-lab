import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addWrittenSegment,
  adoptServerTurnState,
  commitSegmentMedia,
  completeSegment,
  failSegment,
  finishTurn,
  markAwaitingUpload,
  resolveReferenceDescriptors,
  setSceneVideoPlan,
  setSceneVisualState,
} from '../src/services/sessionSegments.ts'
import type { GameScene, GameSession } from '../src/types/game.ts'
import type { TailFrameVisualState, VideoPromptSegment } from '../src/types/story.ts'

const visualState: TailFrameVisualState = {
  shot_size: '中景',
  shot_position: '人物正前方',
  shot_content: {
    characters: [],
    scene: { location: '宫廊', visible_elements: '木廊', lighting: '柔光', time_of_day: '白天' },
    key_props: [],
  },
  frame_quality: '清晰稳定',
}

const scene: GameScene = { id: 'scene-1', turn: 1, title: '宫门初雪', narrative: '宫门打开。', choices: [] }

const makeSession = (overrides: Partial<GameSession> = {}): GameSession => ({
  schemaVersion: 9,
  id: 'game-1',
  storyId: 'palace-validation',
  status: 'awaiting_agent',
  turn: 2,
  createdAt: 1,
  updatedAt: 1,
  currentScene: scene,
  sceneHistory: [scene],
  characters: [],
  castings: [],
  ...overrides,
})

const segment = (sequence: number, overrides: Partial<VideoPromptSegment> = {}): VideoPromptSegment => ({
  sequence, startTime: (sequence - 1) * 5, endTime: sequence * 5, characterIds: ['heroine'], prompt: `第 ${sequence} 段`,
  ...overrides,
})

test('addWrittenSegment appends a clip in written status and stores resolved references', () => {
  const next = addWrittenSegment(makeSession(), 'scene-1', segment(1), [{ type: 'character', characterId: 'heroine', actorId: 'actor-1' }], {
    referenceImages: [{ type: 'character', imageUrl: 'heroine.jpg', label: '人物参考 · 沈清禾', actorId: 'actor-1' }],
  })
  const clip = next.currentScene?.videoClips?.[0]
  assert.equal(clip?.status, 'written')
  assert.equal(clip?.referenceImages?.[0].imageUrl, 'heroine.jpg')
  assert.deepEqual(clip?.referenceDescriptors, [{ type: 'character', characterId: 'heroine', actorId: 'actor-1' }])
})

test('rewriting a segment discards every later segment', () => {
  let session = addWrittenSegment(makeSession(), 'scene-1', segment(1), [], { referenceImages: [] })
  session = addWrittenSegment(session, 'scene-1', segment(2), [], { referenceImages: [] })
  session = addWrittenSegment(session, 'scene-1', segment(3), [], { referenceImages: [] })
  const rewritten = addWrittenSegment(session, 'scene-1', segment(2, { prompt: '重写第 2 段' }), [], { referenceImages: [] })
  const sequences = rewritten.currentScene?.videoClips?.map((clip) => clip.sequence)
  assert.deepEqual(sequences, [1, 2])
  assert.equal(rewritten.currentScene?.videoClips?.[1].prompt, '重写第 2 段')
})

test('markAwaitingUpload sets pendingUpload and clears media fields on a reshoot', () => {
  let session = addWrittenSegment(makeSession(), 'scene-1', segment(1), [], { referenceImages: [] })
  session = markAwaitingUpload(session, 'scene-1', {
    sequence: 1, toolCallId: 'call-1', traceId: 'trace-1', prompt: '第 1 段', seconds: 5,
    descriptors: [], references: { referenceImages: [] },
  })
  assert.equal(session.status, 'awaiting_upload')
  assert.deepEqual(session.pendingUpload, { sceneId: 'scene-1', sequence: 1, toolCallId: 'call-1', traceId: 'trace-1' })
  assert.equal(session.currentScene?.videoClips?.[0].status, 'awaiting_upload')

  // 重拍：再次到达同一 sequence 的 awaiting_upload，清空已提交的媒体字段。
  const reshot = markAwaitingUpload(session, 'scene-1', {
    sequence: 1, toolCallId: 'call-1b', traceId: 'trace-1', prompt: '第 1 段', seconds: 5,
    descriptors: [], references: { referenceImages: [] },
  })
  const clip = reshot.currentScene?.videoClips?.[0]
  assert.equal(clip?.uploadId, undefined)
  assert.equal(clip?.videoUrl, undefined)
  assert.equal(clip?.tailFrameUrl, undefined)
  assert.equal(clip?.toolCallId, 'call-1b')
})

test('commitSegmentMedia only accepts the pending sequence', () => {
  let session = addWrittenSegment(makeSession(), 'scene-1', segment(1), [], { referenceImages: [] })
  session = markAwaitingUpload(session, 'scene-1', {
    sequence: 1, toolCallId: 'call-1', traceId: 'trace-1', prompt: '第 1 段', seconds: 5,
    descriptors: [], references: { referenceImages: [] },
  })

  const wrongSequence = commitSegmentMedia(session, 'scene-1', 2, {
    videoUrl: 'blob:v', tailFrameUrl: 'data:image/jpeg;base64,a', actualDuration: 5,
  })
  assert.equal(wrongSequence, session, '非 pending 段号不应变更 session')

  const committed = commitSegmentMedia(session, 'scene-1', 1, {
    uploadId: 'upload-1', videoUrl: 'blob:v', tailFrameUrl: 'data:image/jpeg;base64,a', actualDuration: 5.4,
  })
  const clip = committed.currentScene?.videoClips?.[0]
  assert.equal(clip?.status, 'analyzing')
  assert.equal(clip?.uploadId, 'upload-1')
  assert.equal(clip?.actualDuration, 5.4)
})

test('failSegment marks the clip failed and keeps the session awaiting upload', () => {
  let session = addWrittenSegment(makeSession(), 'scene-1', segment(1), [], { referenceImages: [] })
  session = markAwaitingUpload(session, 'scene-1', {
    sequence: 1, toolCallId: 'call-1', traceId: 'trace-1', prompt: '第 1 段', seconds: 5,
    descriptors: [], references: { referenceImages: [] },
  })
  const failed = failSegment(session, 'scene-1', 1, '尾帧识别失败')
  assert.equal(failed.status, 'awaiting_upload')
  assert.equal(failed.currentScene?.videoClips?.[0].status, 'failed')
  assert.equal(failed.currentScene?.videoClips?.[0].error, '尾帧识别失败')
})

test('completeSegment marks the clip ready and returns the turn to the director', () => {
  let session = addWrittenSegment(makeSession(), 'scene-1', segment(1), [], { referenceImages: [] })
  session = markAwaitingUpload(session, 'scene-1', {
    sequence: 1, toolCallId: 'call-1', traceId: 'trace-1', prompt: '第 1 段', seconds: 5,
    descriptors: [], references: { referenceImages: [] },
  })
  session = commitSegmentMedia(session, 'scene-1', 1, {
    videoUrl: 'blob:v', tailFrameUrl: 'data:image/jpeg;base64,a', actualDuration: 5.4,
  })
  const completed = completeSegment(session, 'scene-1', 1, { durationSeconds: 5.4, visualState })
  assert.equal(completed.status, 'awaiting_agent')
  assert.equal(completed.pendingUpload, undefined)
  assert.equal(completed.currentScene?.videoClips?.[0].status, 'ready')
  assert.deepEqual(completed.currentScene?.videoClips?.[0].visualState, visualState)
})

test('finishTurn opens the choices and records the skipped reason', () => {
  const finished = finishTurn(makeSession({ status: 'awaiting_upload' }), 'scene-1', '没有可用的视频生成器。')
  assert.equal(finished.status, 'awaiting_action')
  assert.equal(finished.pendingUpload, undefined)
  assert.equal(finished.currentScene?.videoSkippedReason, '没有可用的视频生成器。')
})

test('setSceneVideoPlan stores the compiled request on the scene', () => {
  const video = { totalDuration: 15, style: '写实', videoPrompts: [segment(1), segment(2)] }
  const next = setSceneVideoPlan(makeSession(), 'scene-1', video)
  assert.deepEqual(next.currentScene?.videoRequest, video)
})

test('setSceneVisualState follows the tail frame of the last ready clip', () => {
  let session = addWrittenSegment(makeSession(), 'scene-1', segment(1), [], { referenceImages: [] })
  session = markAwaitingUpload(session, 'scene-1', {
    sequence: 1, toolCallId: 'call-1', traceId: 'trace-1', prompt: '第 1 段', seconds: 5,
    descriptors: [], references: { referenceImages: [] },
  })
  session = commitSegmentMedia(session, 'scene-1', 1, {
    videoUrl: 'blob:v', tailFrameUrl: 'tail-1.jpg', actualDuration: 5,
  })
  session = completeSegment(session, 'scene-1', 1, { durationSeconds: 5, visualState })
  const next = setSceneVisualState(session, 'scene-1', visualState)
  assert.equal(next.currentScene?.tailFrameUrl, 'tail-1.jpg')
  assert.deepEqual(next.currentScene?.tailVisualState, visualState)
})

test('resolveReferenceDescriptors resolves the three descriptor kinds and reports missing images', () => {
  const result = resolveReferenceDescriptors([
    { type: 'character', characterId: 'heroine', actorId: 'actor-1' },
    { type: 'character', characterId: 'ghost', actorId: 'actor-none' },
    { type: 'previous_scene_tail_frame' },
  ], {
    characterReferences: { heroine: { characterName: '沈清禾', actorId: 'actor-1', imageUrl: 'heroine.jpg' } },
    currentClips: [],
    previousSceneTailFrameUrl: 'prev-tail.jpg',
  })
  assert.deepEqual(result.referenceImages, [
    { type: 'character', imageUrl: 'heroine.jpg', label: '人物参考 · 沈清禾', actorId: 'actor-1' },
    { type: 'start_frame', imageUrl: 'prev-tail.jpg', label: '起始尾帧' },
  ])
  assert.equal(result.startImageUrl, 'prev-tail.jpg')
  assert.deepEqual(result.missing, ['ghost'])

  const startFrame = resolveReferenceDescriptors([{ type: 'start_frame', sequence: 1 }], {
    characterReferences: {},
    currentClips: [{ ...segment(1), status: 'ready', tailFrameUrl: 'tail-1.jpg' }],
  })
  assert.equal(startFrame.startImageUrl, 'tail-1.jpg')

  const missingStartFrame = resolveReferenceDescriptors([{ type: 'start_frame', sequence: 1 }], {
    characterReferences: {},
    currentClips: [],
  })
  assert.deepEqual(missingStartFrame.missing, ['start_frame:1'])
})

test('adoptServerTurnState surfaces a retry when the server has gone idle mid-turn', () => {
  const session = makeSession({ status: 'awaiting_upload', pendingUpload: { sceneId: 'scene-1', sequence: 1, toolCallId: 'call-1', traceId: 'trace-1' } })
  const result = adoptServerTurnState(session, { status: 'idle' }, { characterReferences: {} })
  assert.equal(result.needsRetry, true)
  assert.equal(result.session.status, 'awaiting_agent')
  assert.equal(result.session.pendingUpload, undefined)
})

test('adoptServerTurnState leaves an already-open turn untouched', () => {
  const session = makeSession({ status: 'awaiting_action' })
  const result = adoptServerTurnState(session, { status: 'idle' }, { characterReferences: {} })
  assert.equal(result.needsRetry, false)
  assert.equal(result.session, session)
})

test('adoptServerTurnState aligns the local pendingUpload to the server-reported segment', () => {
  const session = makeSession({ status: 'awaiting_agent' })
  const result = adoptServerTurnState(session, {
    status: 'awaiting_upload',
    awaiting: {
      sequence: 1, toolCallId: 'call-server', prompt: '服务端记录的 Prompt', seconds: 6,
      referenceImages: [{ type: 'character', characterId: 'heroine', actorId: 'actor-1' }],
      traceId: 'trace-server',
    },
  }, { characterReferences: { heroine: { characterName: '沈清禾', actorId: 'actor-1', imageUrl: 'heroine.jpg' } } })
  assert.equal(result.needsRetry, false)
  assert.equal(result.session.status, 'awaiting_upload')
  assert.deepEqual(result.session.pendingUpload, { sceneId: 'scene-1', sequence: 1, toolCallId: 'call-server', traceId: 'trace-server' })
  const clip = result.session.currentScene?.videoClips?.[0]
  assert.equal(clip?.prompt, '服务端记录的 Prompt')
  assert.equal(clip?.referenceImages?.[0].imageUrl, 'heroine.jpg')
})

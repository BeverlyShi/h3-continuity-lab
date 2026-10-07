import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyVideoPlan,
  commitClipMedia,
  failClip,
  findDiscardedMedia,
  finishDirectorRun,
  markClipGenerating,
  PLAYER_SKIPPED_VIDEO_REASON,
  resolveReferenceDescriptors,
  setClipJob,
  skipSceneVideo,
  type VideoPlanInput,
} from '../src/services/sessionSegments.ts'
import type { GameScene, GameSession } from '../src/types/game.ts'
import type { VideoPromptSegment, VideoReferenceDescriptor } from '../src/types/story.ts'

const scene: GameScene = { id: 'scene-1', turn: 1, title: '宫门初雪', narrative: '宫门打开。', choices: [] }

const makeSession = (overrides: Partial<GameSession> = {}): GameSession => ({
  schemaVersion: 10,
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

const heroineDescriptor: VideoReferenceDescriptor = { type: 'character', characterId: 'heroine', actorId: 'actor-1' }

const plan = (count: number, fromSequence = 1, prompt = (sequence: number) => `第 ${sequence} 段`): VideoPlanInput => ({
  video: {
    totalDuration: count * 5,
    style: '冷色写实，宫灯暖光。',
    videoPrompts: Array.from({ length: count }, (_, index) => segment(index + 1, { prompt: prompt(index + 1) })),
  },
  references: Array.from({ length: count }, (_, index) =>
    index === 0 ? [heroineDescriptor] : [{ type: 'start_frame', sequence: index }]),
  fromSequence,
})

const references = {
  characterReferences: { heroine: { characterName: '沈清禾', actorId: 'actor-1', imageUrl: 'heroine.jpg' } },
}

const media = (sequence: number, uploadId?: string) => ({
  ...(uploadId ? { uploadId } : {}),
  videoUrl: `blob:video-${sequence}`,
  tailFrameUrl: `tail-${sequence}.jpg`,
  actualDuration: 5.2,
})

const clips = (session: GameSession) => session.currentScene?.videoClips ?? []

// 导演交出 3 段分镜并结束，进入等待视频。
const planned = () => finishDirectorRun(
  applyVideoPlan(makeSession(), 'scene-1', plan(3), references),
  'scene-1',
  { hasVideoPlan: true },
)

const allReady = () => {
  let session = planned()
  for (const sequence of [1, 2, 3]) session = commitClipMedia(session, 'scene-1', sequence, media(sequence, `upload-${sequence}`))
  return session
}

test('applyVideoPlan creates clips: the first is pending with resolved references, the rest wait', () => {
  const next = applyVideoPlan(makeSession(), 'scene-1', plan(3), references)
  assert.deepEqual(clips(next).map((clip) => clip.status), ['pending', 'waiting', 'waiting'])
  assert.deepEqual(clips(next)[0].referenceImages, [
    { type: 'character', imageUrl: 'heroine.jpg', label: '沈清禾', actorId: 'actor-1' },
  ])
  assert.deepEqual(clips(next)[1].referenceDescriptors, [{ type: 'start_frame', sequence: 1 }])
  assert.equal(next.currentScene?.videoRequest?.videoPrompts.length, 3)
  assert.equal(next.status, 'awaiting_agent', 'video_plan 本身不改变会话状态')
})

test('applyVideoPlan ignores a scene that is no longer current', () => {
  const session = makeSession()
  assert.equal(applyVideoPlan(session, 'other-scene', plan(2), references), session)
})

test('a rewrite keeps the earlier clips and resets the rewritten clip and everything after it', () => {
  let session = planned()
  session = setClipJob(session, 'scene-1', 1, 'job-old')
  session = commitClipMedia(session, 'scene-1', 1, media(1, 'upload-1'))
  session = commitClipMedia(session, 'scene-1', 2, media(2, 'upload-2'))

  const rewritten = applyVideoPlan(session, 'scene-1', plan(3, 2, (sequence) => `重写后第 ${sequence} 段`), references)
  const [first, second, third] = clips(rewritten)
  assert.equal(first, clips(session)[0], '第 1 段原样保留')
  assert.equal(second.prompt, '重写后第 2 段')
  assert.equal(second.status, 'pending', '上一段已就绪，重写的段可以直接生成')
  assert.equal(second.uploadId, undefined)
  assert.equal(second.videoUrl, undefined)
  assert.equal(second.startImageUrl, 'tail-1.jpg')
  assert.equal(third.status, 'waiting')
  assert.equal(third.prompt, '重写后第 3 段')
  assert.equal(rewritten.status, 'awaiting_video', '重写不改变会话状态')
  assert.deepEqual(findDiscardedMedia(session, rewritten), { uploadIds: ['upload-2'], objectUrls: ['blob:video-2'] })
})

test('a rewrite of a clip whose previous clip is not ready leaves it waiting', () => {
  const rewritten = applyVideoPlan(planned(), 'scene-1', plan(3, 2), references)
  assert.deepEqual(clips(rewritten).map((clip) => clip.status), ['pending', 'waiting', 'waiting'])
})

test('a ready clip unlocks the next clip with its tail frame as the start image', () => {
  const session = commitClipMedia(planned(), 'scene-1', 1, media(1, 'upload-1'))
  const [first, second, third] = clips(session)
  assert.equal(first.status, 'ready')
  assert.equal(first.uploadId, 'upload-1')
  assert.equal(first.actualDuration, 5.2)
  assert.equal(second.status, 'pending')
  assert.equal(second.startImageUrl, 'tail-1.jpg')
  assert.deepEqual(second.referenceImages, [{ type: 'start_frame', imageUrl: 'tail-1.jpg', label: '上一段最后一帧' }])
  assert.equal(third.status, 'waiting')
  assert.equal(session.status, 'awaiting_video')
  assert.equal(session.currentScene?.tailFrameUrl, undefined)
})

test('the last ready clip completes the scene and opens the choices', () => {
  const session = allReady()
  assert.ok(clips(session).every((clip) => clip.status === 'ready'))
  assert.equal(session.currentScene?.tailFrameUrl, 'tail-3.jpg')
  assert.equal(session.status, 'awaiting_action')
})

test('committing media clears the generation job id', () => {
  let session = setClipJob(planned(), 'scene-1', 1, 'job-1')
  assert.equal(clips(session)[0].jobId, 'job-1')
  session = commitClipMedia(session, 'scene-1', 1, media(1))
  assert.equal(clips(session)[0].jobId, undefined)
})

test('regenerating a ready clip sends every later clip back to waiting and reopens the video stage', () => {
  const complete = allReady()
  const regenerating = markClipGenerating(complete, 'scene-1', 2, { referenceImages: [], startImageUrl: 'tail-1.jpg' })
  const [first, second, third] = clips(regenerating)
  assert.equal(first.status, 'ready')
  assert.equal(second.status, 'generating')
  assert.equal(second.uploadId, undefined)
  assert.equal(second.startImageUrl, 'tail-1.jpg')
  assert.equal(third.status, 'waiting')
  assert.equal(third.uploadId, undefined)
  assert.equal(third.tailFrameUrl, undefined)
  assert.equal(regenerating.currentScene?.tailFrameUrl, undefined)
  assert.equal(regenerating.status, 'awaiting_video')
  assert.deepEqual(findDiscardedMedia(complete, regenerating).uploadIds, ['upload-2', 'upload-3'])
})

test('replacing a ready clip by upload also invalidates the later clips', () => {
  const complete = allReady()
  const replaced = commitClipMedia(complete, 'scene-1', 1, media(1, 'upload-1b'))
  assert.deepEqual(clips(replaced).map((clip) => clip.status), ['ready', 'pending', 'waiting'])
  assert.equal(clips(replaced)[1].uploadId, undefined)
  assert.equal(clips(replaced)[1].startImageUrl, 'tail-1.jpg')
  assert.equal(replaced.currentScene?.tailFrameUrl, undefined)
  assert.equal(replaced.status, 'awaiting_video')
  assert.deepEqual(findDiscardedMedia(complete, replaced).uploadIds, ['upload-1', 'upload-2', 'upload-3'])
})

test('generating a pending clip keeps its Comfy job and the session status', () => {
  let session = setClipJob(planned(), 'scene-1', 1, 'job-1')
  session = failClip(session, 'scene-1', 1, '超时')
  const generating = markClipGenerating(session, 'scene-1', 1, { referenceImages: [] })
  assert.equal(clips(generating)[0].status, 'generating')
  assert.equal(clips(generating)[0].jobId, 'job-1')
  assert.equal(clips(generating)[0].error, undefined)
  assert.equal(generating.status, 'awaiting_video')
})

test('failClip marks the clip failed and drops the generation job only when asked', () => {
  const session = setClipJob(planned(), 'scene-1', 1, 'job-1')
  const kept = failClip(session, 'scene-1', 1, '网络中断')
  assert.equal(clips(kept)[0].status, 'failed')
  assert.equal(clips(kept)[0].error, '网络中断')
  assert.equal(clips(kept)[0].jobId, 'job-1')
  assert.equal(kept.status, 'awaiting_video')
  assert.equal(clips(failClip(session, 'scene-1', 1, '任务失败', { dropJob: true }))[0].jobId, undefined)
})

test('finishDirectorRun waits for video when the director handed over a plan', () => {
  const session = applyVideoPlan(makeSession(), 'scene-1', plan(2), references)
  const finished = finishDirectorRun(session, 'scene-1', { hasVideoPlan: true })
  assert.equal(finished.status, 'awaiting_video')
  assert.equal(finished.currentScene?.videoSkippedReason, undefined)
})

test('finishDirectorRun opens the choices and records why there is no video', () => {
  const finished = finishDirectorRun(makeSession(), 'scene-1', { hasVideoPlan: false, skippedReason: '导演判断本场次不需要视频。' })
  assert.equal(finished.status, 'awaiting_action')
  assert.equal(finished.currentScene?.videoSkippedReason, '导演判断本场次不需要视频。')

  const textOnly = finishDirectorRun(makeSession(), 'scene-1', { hasVideoPlan: false })
  assert.equal(textOnly.status, 'awaiting_action')
  assert.equal(textOnly.currentScene?.videoSkippedReason, undefined)
})

test('skipSceneVideo opens the choices without a tail frame for the next scene', () => {
  const session = commitClipMedia(planned(), 'scene-1', 1, media(1))
  const skipped = skipSceneVideo(session, 'scene-1')
  assert.equal(skipped.status, 'awaiting_action')
  assert.equal(skipped.currentScene?.videoSkippedReason, PLAYER_SKIPPED_VIDEO_REASON)
  assert.equal(skipped.currentScene?.tailFrameUrl, undefined)

  const notWaiting = makeSession({ status: 'awaiting_action' })
  assert.equal(skipSceneVideo(notWaiting, 'scene-1'), notWaiting)
})

test('findDiscardedMedia ignores media that is still referenced', () => {
  const session = allReady()
  assert.deepEqual(findDiscardedMedia(session, session), { uploadIds: [], objectUrls: [] })
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
    { type: 'character', imageUrl: 'heroine.jpg', label: '沈清禾', actorId: 'actor-1' },
    { type: 'start_frame', imageUrl: 'prev-tail.jpg', label: '上一场次最后一帧' },
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

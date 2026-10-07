import type { GameScene, GameSession, GameSessionStatus, SceneVideoClip } from '../types/game.ts'
import type {
  TailFrameVisualState,
  VideoGenerationRequest,
  VideoPromptSegment,
  VideoReferenceDescriptor,
} from '../types/story.ts'
import type { VideoCharacterReference, VideoInputReferenceImage } from '../types/video.ts'
import type { DirectorTurnStateResponse } from './directorClient.ts'

const now = () => Date.now()

const isCurrentScene = (session: GameSession, sceneId: string) => session.currentScene?.id === sceneId

const patchScene = (session: GameSession, sceneId: string, patch: (scene: GameScene) => GameScene): GameSession => {
  const apply = (scene: GameScene) => scene.id === sceneId ? patch(scene) : scene
  return {
    ...session,
    currentScene: session.currentScene ? apply(session.currentScene) : session.currentScene,
    sceneHistory: session.sceneHistory.map(apply),
    updatedAt: now(),
  }
}

export type ResolvedSegmentReferences = {
  referenceImages: VideoInputReferenceImage[]
  startImageUrl?: string
}

// 覆盖同 sequence 的 clip，并删除 sequence 更大的 clip：重写一段会作废之后的段落。
export const addWrittenSegment = (
  session: GameSession,
  sceneId: string,
  segment: VideoPromptSegment,
  descriptors: VideoReferenceDescriptor[],
  references: ResolvedSegmentReferences,
): GameSession => patchScene(session, sceneId, (scene) => {
  const kept = (scene.videoClips ?? []).filter((clip) => clip.sequence < segment.sequence)
  const clip: SceneVideoClip = {
    ...segment,
    status: 'written',
    referenceDescriptors: descriptors,
    referenceImages: references.referenceImages,
    startImageUrl: references.startImageUrl,
  }
  return { ...scene, videoClips: [...kept, clip] }
})

export type MarkAwaitingUploadInput = {
  sequence: number
  toolCallId: string
  traceId: string
  prompt: string
  seconds: number
  descriptors: VideoReferenceDescriptor[]
  references: ResolvedSegmentReferences
}

const clearClipMedia = (clip: SceneVideoClip): SceneVideoClip => ({
  ...clip,
  uploadId: undefined,
  videoUrl: undefined,
  tailFrameUrl: undefined,
  actualDuration: undefined,
  visualState: undefined,
  error: undefined,
})

// 同一 sequence 可再次到达（重拍）：清空该 clip 及之后 clip 的媒体字段，重新等待上传/生成。
export const markAwaitingUpload = (session: GameSession, sceneId: string, input: MarkAwaitingUploadInput): GameSession => {
  if (!isCurrentScene(session, sceneId)) return session
  const patched = patchScene(session, sceneId, (scene) => {
    const clips = scene.videoClips ?? []
    const existing = clips.find((clip) => clip.sequence === input.sequence)
    const base: SceneVideoClip = existing ?? {
      sequence: input.sequence,
      startTime: 0,
      endTime: input.seconds,
      characterIds: [],
      prompt: input.prompt,
      status: 'written',
    }
    const updated: SceneVideoClip = clearClipMedia({
      ...base,
      // 同一次 generate_segment（刷新后与服务端对齐）保留 Comfy 任务；导演重拍是新的调用，要重新提交。
      comfyJobId: base.toolCallId === input.toolCallId ? base.comfyJobId : undefined,
      prompt: input.prompt,
      status: 'awaiting_upload',
      toolCallId: input.toolCallId,
      referenceDescriptors: input.descriptors,
      referenceImages: input.references.referenceImages,
      startImageUrl: input.references.startImageUrl,
    })
    const videoClips = [
      ...clips.filter((clip) => clip.sequence < input.sequence),
      updated,
      ...clips.filter((clip) => clip.sequence > input.sequence).map((clip) => ({ ...clearClipMedia(clip), comfyJobId: undefined })),
    ]
    return { ...scene, videoClips }
  })
  return {
    ...patched,
    status: 'awaiting_upload',
    pendingUpload: { sceneId, sequence: input.sequence, toolCallId: input.toolCallId, traceId: input.traceId },
  }
}

export type CommitSegmentMediaInput = {
  uploadId?: string
  videoUrl: string
  tailFrameUrl: string
  actualDuration: number
}

// 只允许提交 pendingUpload 记录的那一段。
export const commitSegmentMedia = (
  session: GameSession,
  sceneId: string,
  sequence: number,
  input: CommitSegmentMediaInput,
): GameSession => {
  if (session.pendingUpload?.sceneId !== sceneId || session.pendingUpload.sequence !== sequence) return session
  return patchScene(session, sceneId, (scene) => ({
    ...scene,
    videoClips: scene.videoClips?.map((clip) => clip.sequence === sequence
      ? { ...clip, ...input, status: 'analyzing', error: undefined }
      : clip),
  }))
}

// 上传/生成/resume 出错：clip 标记失败，session 仍停在 awaiting_upload，等待重试。
export const failSegment = (session: GameSession, sceneId: string, sequence: number, error: string): GameSession =>
  patchScene(session, sceneId, (scene) => ({
    ...scene,
    videoClips: scene.videoClips?.map((clip) => clip.sequence === sequence
      ? { ...clip, status: 'failed', error }
      : clip),
  }))

export type CompleteSegmentInput = {
  durationSeconds: number
  visualState: TailFrameVisualState
}

// segment_generated 到达：该段就绪，回合回到导演继续写下一段。
export const completeSegment = (
  session: GameSession,
  sceneId: string,
  sequence: number,
  input: CompleteSegmentInput,
): GameSession => {
  if (!isCurrentScene(session, sceneId)) return session
  const patched = patchScene(session, sceneId, (scene) => ({
    ...scene,
    videoClips: scene.videoClips?.map((clip) => clip.sequence === sequence
      ? { ...clip, status: 'ready', actualDuration: input.durationSeconds, visualState: input.visualState, error: undefined }
      : clip),
  }))
  return { ...patched, status: 'awaiting_agent', pendingUpload: undefined }
}

export const setSceneVideoPlan = (session: GameSession, sceneId: string, video: VideoGenerationRequest): GameSession =>
  patchScene(session, sceneId, (scene) => ({ ...scene, videoRequest: video }))

// scene.tailFrameUrl 跟随最后一个就绪 clip 的尾帧，供下一幕的 previous_scene_tail_frame 描述符解析。
export const setSceneVisualState = (session: GameSession, sceneId: string, visualState: TailFrameVisualState): GameSession =>
  patchScene(session, sceneId, (scene) => {
    const lastReady = [...(scene.videoClips ?? [])]
      .filter((clip) => clip.status === 'ready')
      .sort((left, right) => left.sequence - right.sequence)
      .at(-1)
    return { ...scene, tailVisualState: visualState, tailFrameUrl: lastReady?.tailFrameUrl ?? scene.tailFrameUrl }
  })

export const finishTurn = (session: GameSession, sceneId: string, skippedReason?: string): GameSession => {
  if (!isCurrentScene(session, sceneId)) return session
  const patched = patchScene(session, sceneId, (scene) => ({ ...scene, videoSkippedReason: skippedReason }))
  return { ...patched, status: 'awaiting_action' as GameSessionStatus, pendingUpload: undefined }
}

export type ResolveReferenceContext = {
  characterReferences: Record<string, VideoCharacterReference>
  currentClips: SceneVideoClip[]
  previousSceneTailFrameUrl?: string
}

export type ResolveReferenceResult = ResolvedSegmentReferences & { missing: string[] }

export const resolveReferenceDescriptors = (
  descriptors: VideoReferenceDescriptor[],
  ctx: ResolveReferenceContext,
): ResolveReferenceResult => {
  const referenceImages: VideoInputReferenceImage[] = []
  const missing: string[] = []
  let startImageUrl: string | undefined

  for (const descriptor of descriptors) {
    if (descriptor.type === 'character') {
      const reference = ctx.characterReferences[descriptor.characterId]
      if (!reference) {
        missing.push(descriptor.characterId)
        continue
      }
      referenceImages.push({
        type: 'character',
        imageUrl: reference.imageUrl,
        label: `人物参考 · ${reference.characterName}`,
        actorId: reference.actorId,
      })
      continue
    }
    if (descriptor.type === 'previous_scene_tail_frame') {
      if (!ctx.previousSceneTailFrameUrl) {
        missing.push('previous_scene_tail_frame')
        continue
      }
      startImageUrl = ctx.previousSceneTailFrameUrl
      referenceImages.push({ type: 'start_frame', imageUrl: ctx.previousSceneTailFrameUrl, label: '起始尾帧' })
      continue
    }
    const source = ctx.currentClips.find((clip) => clip.sequence === descriptor.sequence)
    if (!source?.tailFrameUrl) {
      missing.push(`start_frame:${descriptor.sequence}`)
      continue
    }
    startImageUrl = source.tailFrameUrl
    referenceImages.push({ type: 'start_frame', imageUrl: source.tailFrameUrl, label: '起始尾帧' })
  }

  return { referenceImages, startImageUrl, missing }
}

export type AdoptServerTurnStateResult = {
  session: GameSession
  needsRetry: boolean
}

// 存档加载完成后与服务端对齐：服务端已经空闲但本地还停在导演回合/等待上传，说明续跑连接中断，交给玩家重试；
// 服务端还在等上传，就把本地状态和 pendingUpload 对齐到服务端记录的段号。
export const adoptServerTurnState = (
  session: GameSession,
  serverState: DirectorTurnStateResponse,
  references: Omit<ResolveReferenceContext, 'currentClips'>,
): AdoptServerTurnStateResult => {
  const sceneId = session.currentScene?.id
  // 第一幕在 publish_scene 之前中断：本地只有待处理的输入、还没有场景，服务端空闲时同样交给玩家重试。
  if (!sceneId) {
    return { session, needsRetry: serverState.status === 'idle' && session.status === 'awaiting_agent' }
  }

  if (serverState.status === 'idle') {
    if (session.status === 'awaiting_upload' || session.status === 'awaiting_agent') {
      return { session: { ...session, status: 'awaiting_agent', pendingUpload: undefined }, needsRetry: true }
    }
    return { session, needsRetry: false }
  }

  const resolved = resolveReferenceDescriptors(serverState.awaiting.referenceImages, {
    ...references,
    currentClips: session.currentScene?.videoClips ?? [],
  })
  const next = markAwaitingUpload(session, sceneId, {
    sequence: serverState.awaiting.sequence,
    toolCallId: serverState.awaiting.toolCallId,
    traceId: serverState.awaiting.traceId,
    prompt: serverState.awaiting.prompt,
    seconds: serverState.awaiting.seconds,
    descriptors: serverState.awaiting.referenceImages,
    references: resolved,
  })
  return { session: next, needsRetry: false }
}

import type { GameScene, GameSession, SceneVideoClip } from '../types/game.ts'
import type { VideoGenerationRequest, VideoReferenceDescriptor } from '../types/story.ts'
import type { VideoCharacterReference, VideoInputReferenceImage } from '../types/video.ts'

const now = () => Date.now()

const isCurrentScene = (session: GameSession, sceneId: string) => session.currentScene?.id === sceneId

const findScene = (session: GameSession, sceneId: string) =>
  session.sceneHistory.find((scene) => scene.id === sceneId)
    ?? (session.currentScene?.id === sceneId ? session.currentScene : undefined)

const patchScene = (session: GameSession, sceneId: string, patch: (scene: GameScene) => GameScene): GameSession => {
  const apply = (scene: GameScene) => scene.id === sceneId ? patch(scene) : scene
  return {
    ...session,
    currentScene: session.currentScene ? apply(session.currentScene) : session.currentScene,
    sceneHistory: session.sceneHistory.map(apply),
    updatedAt: now(),
  }
}

export const PREVIOUS_SEGMENT_FRAME_LABEL = '上一段最后一帧'
export const PREVIOUS_SCENE_FRAME_LABEL = '上一场次最后一帧'

// startImageUrl 是画面参考帧（上一段或上一场次的最后一帧），和人物参考图一起按 r2v 传给模型。
export type ResolvedSegmentReferences = {
  referenceImages: VideoInputReferenceImage[]
  startImageUrl?: string
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
        ...(reference.imageUrl ? { imageUrl: reference.imageUrl } : {}),
        label: reference.characterName,
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
      referenceImages.push({ type: 'start_frame', imageUrl: ctx.previousSceneTailFrameUrl, label: PREVIOUS_SCENE_FRAME_LABEL })
      continue
    }
    const source = ctx.currentClips.find((clip) => clip.sequence === descriptor.sequence)
    if (!source?.tailFrameUrl) {
      missing.push(`start_frame:${descriptor.sequence}`)
      continue
    }
    startImageUrl = source.tailFrameUrl
    referenceImages.push({ type: 'start_frame', imageUrl: source.tailFrameUrl, label: PREVIOUS_SEGMENT_FRAME_LABEL })
  }

  return { referenceImages, startImageUrl, missing }
}

const clearClipMedia = (clip: SceneVideoClip): SceneVideoClip => ({
  ...clip,
  uploadId: undefined,
  videoUrl: undefined,
  tailFrameUrl: undefined,
  actualDuration: undefined,
  comfyJobId: undefined,
  error: undefined,
  startImageUrl: undefined,
  referenceImages: undefined,
})

// 第 sequence 段之后的段作废：画面参考帧要等前一段重新完成，统一回到 waiting。
const resetClipsAfter = (clips: SceneVideoClip[], sequence: number) => clips.map((clip) =>
  clip.sequence > sequence ? { ...clearClipMedia(clip), status: 'waiting' as const } : clip)

const isComplete = (clips: SceneVideoClip[]) => clips.length > 0 && clips.every((clip) => clip.status === 'ready')

export type VideoPlanInput = {
  video: VideoGenerationRequest
  references: VideoReferenceDescriptor[][]
  fromSequence: number
}

// fromSequence 之前的段原样保留；之后的段换成新 prompt 并清空媒体，上一段已就绪的可以直接生成。
export const applyVideoPlan = (
  session: GameSession,
  sceneId: string,
  plan: VideoPlanInput,
  ctx: Omit<ResolveReferenceContext, 'currentClips'>,
): GameSession => {
  if (!isCurrentScene(session, sceneId)) return session
  return patchScene(session, sceneId, (scene) => {
    const previous = scene.videoClips ?? []
    const clips: SceneVideoClip[] = []
    plan.video.videoPrompts.forEach((segment, index) => {
      const existing = previous.find((clip) => clip.sequence === segment.sequence)
      if (existing && segment.sequence < plan.fromSequence) {
        clips.push(existing)
        return
      }
      const descriptors = plan.references[index] ?? []
      const before = clips.at(-1)
      const status = !before || before.status === 'ready' ? 'pending' : 'waiting'
      const resolved = status === 'pending'
        ? resolveReferenceDescriptors(descriptors, { ...ctx, currentClips: clips })
        : undefined
      clips.push({
        ...segment,
        status,
        referenceDescriptors: descriptors,
        referenceImages: resolved?.referenceImages,
        startImageUrl: resolved?.startImageUrl,
      })
    })
    return {
      ...scene,
      videoRequest: plan.video,
      videoClips: clips,
      videoSkippedReason: undefined,
      tailFrameUrl: isComplete(clips) ? scene.tailFrameUrl : undefined,
    }
  })
}

// 重新生成已就绪的段：该段与之后的段都作废，场次回到等待视频。
export const markClipGenerating = (
  session: GameSession,
  sceneId: string,
  sequence: number,
  references: ResolvedSegmentReferences,
): GameSession => {
  const target = findScene(session, sceneId)?.videoClips?.find((clip) => clip.sequence === sequence)
  if (!target) return session
  const wasReady = target.status === 'ready'
  const patched = patchScene(session, sceneId, (scene) => {
    const clips = (scene.videoClips ?? []).map((clip) => clip.sequence === sequence
      ? {
          ...(wasReady ? clearClipMedia(clip) : clip),
          status: 'generating' as const,
          error: undefined,
          referenceImages: references.referenceImages,
          startImageUrl: references.startImageUrl,
        }
      : clip)
    return wasReady
      ? { ...scene, videoClips: resetClipsAfter(clips, sequence), tailFrameUrl: undefined }
      : { ...scene, videoClips: clips }
  })
  return wasReady && isCurrentScene(session, sceneId) && session.status === 'awaiting_action'
    ? { ...patched, status: 'awaiting_video' }
    : patched
}

export type CommitClipMediaInput = {
  uploadId?: string
  videoUrl: string
  tailFrameUrl: string
  actualDuration: number
}

// 某段就绪：之后的段重新排队，下一段以这段尾帧为画面参考；最后一段就绪即开放选择。
export const commitClipMedia = (
  session: GameSession,
  sceneId: string,
  sequence: number,
  media: CommitClipMediaInput,
): GameSession => {
  const scene = findScene(session, sceneId)
  const clips = scene?.videoClips ?? []
  if (!scene || !clips.some((clip) => clip.sequence === sequence)) return session

  const laterWasReady = clips.some((clip) => clip.sequence > sequence && clip.status === 'ready')
  let next = resetClipsAfter(clips, sequence).map((clip) => clip.sequence === sequence
    ? { ...clip, ...media, status: 'ready' as const, error: undefined, comfyJobId: undefined }
    : clip)
  const following = [...next]
    .filter((clip) => clip.sequence > sequence)
    .sort((left, right) => left.sequence - right.sequence)[0]
  if (following) {
    const resolved = resolveReferenceDescriptors(following.referenceDescriptors ?? [], { characterReferences: {}, currentClips: next })
    next = next.map((clip) => clip === following
      ? {
          ...clip,
          status: 'pending' as const,
          startImageUrl: resolved.startImageUrl ?? media.tailFrameUrl,
          referenceImages: resolved.referenceImages,
        }
      : clip)
  }

  const complete = isComplete(next)
  const lastTail = [...next].sort((left, right) => left.sequence - right.sequence).at(-1)?.tailFrameUrl
  const patched = patchScene(session, sceneId, (item) => ({
    ...item,
    videoClips: next,
    tailFrameUrl: complete ? lastTail : undefined,
    videoSkippedReason: complete ? undefined : item.videoSkippedReason,
  }))
  if (!isCurrentScene(session, sceneId)) return patched
  if (complete && session.status === 'awaiting_video') return { ...patched, status: 'awaiting_action' }
  if (!complete && laterWasReady && session.status === 'awaiting_action') return { ...patched, status: 'awaiting_video' }
  return patched
}

export const setClipComfyJob = (session: GameSession, sceneId: string, sequence: number, comfyJobId: string): GameSession =>
  patchScene(session, sceneId, (scene) => ({
    ...scene,
    videoClips: scene.videoClips?.map((clip) => clip.sequence === sequence ? { ...clip, comfyJobId } : clip),
  }))

// Comfy 任务本身失败时任务 ID 作废（dropComfyJob），网络出错或超时则保留，重试时接着查同一个任务。
export const failClip = (
  session: GameSession,
  sceneId: string,
  sequence: number,
  error: string,
  { dropComfyJob = false }: { dropComfyJob?: boolean } = {},
): GameSession =>
  patchScene(session, sceneId, (scene) => ({
    ...scene,
    videoClips: scene.videoClips?.map((clip) => clip.sequence === sequence
      ? { ...clip, status: 'failed', error, ...(dropComfyJob ? { comfyJobId: undefined } : {}) }
      : clip),
  }))

export type FinishDirectorRunInput = {
  hasVideoPlan: boolean
  skippedReason?: string
}

// 导演普通场次的 done：交出了分镜就等视频，否则直接开放选择并记下没有视频的原因。
export const finishDirectorRun = (session: GameSession, sceneId: string, input: FinishDirectorRunInput): GameSession => {
  if (!isCurrentScene(session, sceneId)) return session
  const clips = findScene(session, sceneId)?.videoClips ?? []
  if (input.hasVideoPlan && clips.length) {
    return { ...session, status: isComplete(clips) ? 'awaiting_action' : 'awaiting_video', updatedAt: now() }
  }
  const patched = patchScene(session, sceneId, (scene) => ({ ...scene, videoSkippedReason: input.skippedReason }))
  return { ...patched, status: 'awaiting_action' }
}

export const PLAYER_SKIPPED_VIDEO_REASON = '玩家跳过了本场次视频'

// 跳过视频：没有完整的最后一帧，下一场次只能换场景开场。
export const skipSceneVideo = (session: GameSession, sceneId: string): GameSession => {
  if (!isCurrentScene(session, sceneId) || session.status !== 'awaiting_video') return session
  const patched = patchScene(session, sceneId, (scene) => ({
    ...scene,
    videoSkippedReason: PLAYER_SKIPPED_VIDEO_REASON,
    tailFrameUrl: undefined,
  }))
  return { ...patched, status: 'awaiting_action' }
}

// 对比前后两份会话，找出不再被任何段引用的本地视频与 blob URL，交给调用方删除和释放。
export const findDiscardedMedia = (before: GameSession | null, after: GameSession | null) => {
  const clipsOf = (session: GameSession | null) => (session?.sceneHistory ?? []).flatMap((scene) => scene.videoClips ?? [])
  const kept = new Set(clipsOf(after).flatMap((clip) => [clip.uploadId, clip.videoUrl]).filter(Boolean))
  const discarded = clipsOf(before)
  return {
    uploadIds: [...new Set(discarded.flatMap((clip) => clip.uploadId && !kept.has(clip.uploadId) ? [clip.uploadId] : []))],
    objectUrls: [...new Set(discarded.flatMap((clip) =>
      clip.videoUrl?.startsWith('blob:') && !kept.has(clip.videoUrl) ? [clip.videoUrl] : []))],
  }
}

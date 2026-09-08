import type { VideoCharacterReference, VideoGenerator, VideoInputReferenceImage } from '../types/video'
import type { TailFrameVisualState, VideoGenerationRequest } from '../types/story'

export type SceneVideoSegmentResult = {
  sequence: number
  status: 'generating' | 'extracting' | 'analyzing' | 'ready' | 'failed'
  videoUrl?: string
  startImageUrl?: string
  referenceImages?: VideoInputReferenceImage[]
  tailFrameUrl?: string
  visualState?: TailFrameVisualState
  error?: string
}

type SceneVideoGenerationOptions = {
  startSequence?: number
  endSequence?: number
  initialTailFrameUrl?: string
  characterReferences?: Record<string, VideoCharacterReference>
  analyzeTailFrame?: (imageUrl: string) => Promise<TailFrameVisualState>
}

const errorMessage = (error: unknown) => {
  const detail = error instanceof Error && error.message ? error.message : ''
  const body = (error as { body?: { detail?: unknown } } | null)?.body?.detail
  const bodyDetail = body ? JSON.stringify(body) : ''
  return [detail, bodyDetail].filter(Boolean).join(' · ') || '未知错误'
}

export const generateSceneVideoSegments = async (
  generator: VideoGenerator,
  request: VideoGenerationRequest,
  onResult: (result: SceneVideoSegmentResult) => void,
  options: SceneVideoGenerationOptions = {},
) => {
  const segments = [...request.videoPrompts]
    .sort((left, right) => left.sequence - right.sequence)
    .filter((segment) => segment.sequence >= (options.startSequence ?? 1))
    .filter((segment) => segment.sequence <= (options.endSequence ?? Number.POSITIVE_INFINITY))
  let previousTailFrameUrl = options.initialTailFrameUrl
  const finalSequence = Math.max(...request.videoPrompts.map((segment) => segment.sequence))

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    const needsPreviousTail = segment.sequence > 1
    const startImageUrl = previousTailFrameUrl
    if (needsPreviousTail && !startImageUrl) continue
    const characterReferences = startImageUrl ? [] : segment.characterIds.flatMap((characterId) => {
      const reference = options.characterReferences?.[characterId]
      return reference ? [reference] : []
    })
    const referenceImages: VideoInputReferenceImage[] = startImageUrl
      ? [{ type: 'start_frame', imageUrl: startImageUrl, label: '起始尾帧' }]
      : characterReferences.map((reference) => ({
          type: 'character',
          imageUrl: reference.imageUrl,
          label: `人物参考 · ${reference.characterName}`,
          actorId: reference.actorId,
        }))
    onResult({ sequence: segment.sequence, status: 'generating', startImageUrl, referenceImages })
    let videoUrl: string | undefined
    let tailFrameUrl: string | undefined
    try {
      const result = await generator.generate(
        segment.prompt,
        segment.endTime - segment.startTime,
        segment.sequence,
        { startImageUrl, characterReferences },
      )
      videoUrl = result.videoUrl
      onResult({
        sequence: segment.sequence,
        status: 'extracting',
        videoUrl: result.videoUrl,
        startImageUrl,
        referenceImages,
      })
      tailFrameUrl = await generator.createTailFrameUrl(result.videoUrl)
      previousTailFrameUrl = tailFrameUrl
      const shouldAnalyze = segment.sequence === finalSequence && options.analyzeTailFrame
      if (shouldAnalyze) {
        onResult({
          sequence: segment.sequence,
          status: 'analyzing',
          videoUrl: result.videoUrl,
          startImageUrl,
          referenceImages,
          tailFrameUrl,
        })
        const visualState = await options.analyzeTailFrame!(tailFrameUrl)
        onResult({
          sequence: segment.sequence,
          status: 'ready',
          videoUrl: result.videoUrl,
          startImageUrl,
          referenceImages,
          tailFrameUrl,
          visualState,
        })
        continue
      }
      onResult({
        sequence: segment.sequence,
        status: 'ready',
        videoUrl: result.videoUrl,
        startImageUrl,
        referenceImages,
        tailFrameUrl,
      })
    } catch (error) {
      onResult({
        sequence: segment.sequence,
        status: 'failed',
        startImageUrl,
        referenceImages,
        videoUrl,
        tailFrameUrl,
        error: errorMessage(error),
      })
      previousTailFrameUrl = undefined
    }
  }
}

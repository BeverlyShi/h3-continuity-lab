import type { VideoCharacterReference, VideoGenerator } from '../types/video'
import type { VideoGenerationRequest } from '../types/story'

export type SceneVideoSegmentResult = {
  sequence: number
  status: 'generating' | 'extracting' | 'ready' | 'failed'
  videoUrl?: string
  startImageUrl?: string
  tailFrameUrl?: string
  error?: string
}

type SceneVideoGenerationOptions = {
  startSequence?: number
  endSequence?: number
  initialTailFrameUrl?: string
  characterReferences?: Record<string, VideoCharacterReference>
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

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    const usesPreviousTail = segment.sequence > 1 && segment.transitionFromPrevious === 'continuous'
    const startImageUrl = usesPreviousTail ? previousTailFrameUrl : undefined
    if (usesPreviousTail && !startImageUrl) continue
    const characterReferences = startImageUrl ? [] : segment.characterIds.flatMap((characterId) => {
      const reference = options.characterReferences?.[characterId]
      return reference ? [reference] : []
    })
    onResult({ sequence: segment.sequence, status: 'generating', startImageUrl })
    try {
      const result = await generator.generate(
        segment.prompt,
        segment.endTime - segment.startTime,
        segment.sequence,
        { startImageUrl, characterReferences },
      )
      const nextSegment = segments[index + 1]
      const needsTailFrame = nextSegment?.transitionFromPrevious === 'continuous'
      if (!needsTailFrame) {
        onResult({
          sequence: segment.sequence,
          status: 'ready',
          videoUrl: result.videoUrl,
          startImageUrl,
        })
        continue
      }

      onResult({
        sequence: segment.sequence,
        status: 'extracting',
        videoUrl: result.videoUrl,
        startImageUrl,
      })
      const tailFrameUrl = await generator.createTailFrameUrl(result.videoUrl)
      onResult({
        sequence: segment.sequence,
        status: 'ready',
        videoUrl: result.videoUrl,
        startImageUrl,
        tailFrameUrl,
      })
      previousTailFrameUrl = tailFrameUrl
    } catch (error) {
      onResult({
        sequence: segment.sequence,
        status: 'failed',
        startImageUrl,
        error: errorMessage(error),
      })
      previousTailFrameUrl = undefined
    }
  }
}

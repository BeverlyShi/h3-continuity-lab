import { createFalClient } from '@fal-ai/client'
import type { VideoGenerator } from '../types/video'
import { extractVideoTailFrame } from './videoTailFrame'

const H3_MAX_TEXT_TO_VIDEO = 'minimax/h3-max/text-to-video'
const H3_MAX_IMAGE_TO_VIDEO = 'minimax/h3-max/image-to-video'
const H3_MAX_REFERENCE_TO_VIDEO = 'minimax/h3-max/reference-to-video'

type H3MaxResult = {
  video: {
    url: string
  }
}

export const createFalVideoGenerator = (apiKey: string): VideoGenerator => {
  const fal = createFalClient({
    credentials: apiKey,
    suppressLocalCredentialsWarning: true,
  })

  return {
    async generate(prompt, duration, _sequence, conditioning) {
      const startImageUrl = conditioning?.startImageUrl
      const characterReferences = conditioning?.characterReferences ?? []
      const referenceImageUrls = characterReferences.map((reference) => reference.imageUrl)
      const referencePrompt = characterReferences.map((reference, index) => {
        return `Image ${index + 1} 是包含同一位演员三视图的合成图，该演员扮演${reference.characterName}；保持这个角色的面部身份一致。`
      }).join('\n')
      const endpoint = startImageUrl
        ? H3_MAX_IMAGE_TO_VIDEO
        : referenceImageUrls.length
          ? H3_MAX_REFERENCE_TO_VIDEO
          : H3_MAX_TEXT_TO_VIDEO
      const result = await fal.subscribe(
        endpoint,
        {
          input: {
            prompt: referencePrompt ? `${referencePrompt}\n${prompt}` : prompt,
            duration,
            resolution: '768P',
            prompt_expansion_mode: 'balanced',
            enable_safety_checker: true,
            ...(startImageUrl
              ? { image_url: startImageUrl }
              : referenceImageUrls.length
                ? { reference_image_urls: referenceImageUrls, aspect_ratio: '16:9' }
                : { aspect_ratio: '16:9' }),
          },
        },
      )
      const data = result.data as H3MaxResult

      if (!data.video?.url) {
        throw new Error('fal API 未返回视频地址')
      }

      return { videoUrl: data.video.url }
    },
    async createTailFrameUrl(videoUrl) {
      const frame = await extractVideoTailFrame(videoUrl)
      return fal.storage.upload(frame)
    },
  }
}

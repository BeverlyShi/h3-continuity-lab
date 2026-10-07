import { createFalClient } from '@fal-ai/client'
import type { VideoGenerator } from '../types/video'
import { extractVideoTailFrame } from './videoTailFrame'

const H3_MAX_TEXT_TO_VIDEO = 'minimax/h3-max/text-to-video'
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
    // prompt 已含人物行与参考图号；有参考图（人物图、上一段尾帧）就走参考图生成，否则文生视频。
    async generate(prompt, duration, _sequence, conditioning) {
      const referenceImageUrls = conditioning?.referenceImageUrls ?? []
      const result = await fal.subscribe(
        referenceImageUrls.length ? H3_MAX_REFERENCE_TO_VIDEO : H3_MAX_TEXT_TO_VIDEO,
        {
          input: {
            prompt,
            duration,
            resolution: '768P',
            prompt_expansion_mode: 'balanced',
            enable_safety_checker: true,
            aspect_ratio: '16:9',
            ...(referenceImageUrls.length ? { reference_image_urls: referenceImageUrls } : {}),
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

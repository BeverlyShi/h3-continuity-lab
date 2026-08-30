import { createFalClient } from '@fal-ai/client'
import type { VideoGenerator } from '../types/video'

const H3_MAX_TEXT_TO_VIDEO = 'minimax/h3-max/text-to-video'

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
    async generate(prompt, duration) {
      const result = await fal.subscribe(H3_MAX_TEXT_TO_VIDEO, {
        input: {
          prompt,
          duration,
          resolution: '768P',
          aspect_ratio: '16:9',
          prompt_expansion_mode: 'balanced',
          enable_safety_checker: true,
        },
      })
      const data = result.data as H3MaxResult

      if (!data.video?.url) {
        throw new Error('fal API 未返回视频地址')
      }

      return { videoUrl: data.video.url }
    },
  }
}

import type { GeneratedVideo, VideoGenerator } from '../types/video'

const DEMO_MEDIA: GeneratedVideo[] = [
  {
    videoUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    thumbnailUrl:
      'https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=480&q=80',
  },
  {
    videoUrl: 'https://media.w3.org/2010/05/sintel/trailer.mp4',
    thumbnailUrl:
      'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=480&q=80',
  },
  {
    videoUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    thumbnailUrl:
      'https://images.unsplash.com/photo-1499346030926-9a72daac6c63?auto=format&fit=crop&w=480&q=80',
  },
]

const wait = (duration: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, duration))

export const mockVideoGenerator: VideoGenerator = {
  async generate(_prompt: string, _duration: number, sequence: number) {
    await wait(1800 + (((sequence + 1) * 673) % 1800))
    return DEMO_MEDIA[sequence % DEMO_MEDIA.length]
  },
  async createTailFrameUrl(videoUrl: string) {
    return `${videoUrl}#tail-frame`
  },
}

import type { SceneCharacter, TailFrameVisualState } from '../types/story'

export async function inspectTailFrame(
  deepSeekApiKey: string,
  imageUrl: string,
  characters: SceneCharacter[],
): Promise<TailFrameVisualState> {
  const response = await fetch('/api/vision/tail-frame', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-DeepSeek-Key': deepSeekApiKey,
    },
    body: JSON.stringify({ imageUrl, characters }),
  })
  const payload = await response.json() as { state?: TailFrameVisualState; error?: string }
  if (!response.ok || !payload.state) {
    throw new Error(payload.error ?? `尾帧视觉识别失败（${response.status}）。`)
  }
  return payload.state
}

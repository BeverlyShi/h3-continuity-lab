import { useCallback, useEffect, useRef, useState } from 'react'
import { buildActorImagePrompt } from '../director/actorPortraitPrompt'
import { fetchComfyImage, getComfyJobStatus, submitComfyPortrait } from '../services/comfyClient'
import { blobToDataUrl } from '../services/dataUrl'
import type { Actor } from '../types/actor'
import type { ActorLibrary } from './useActorLibrary'

const POLL_INTERVAL_MS = 4_000
const POLL_TIMEOUT_MS = 10 * 60_000

// 演员库里没有生图 prompt 的演员（手动新增后删了图等）按外观现拼一份；连外观都没有就无法生成。
export const portraitPromptFor = (actor: Actor) => {
  if (actor.imagePrompt) return actor.imagePrompt
  if (!actor.appearance) return undefined
  return buildActorImagePrompt({ ...actor, appearance: actor.appearance })
}

const errorText = (error: unknown) => error instanceof Error ? error.message : '生成参考图失败。'

// 演员三视图用 Comfy Cloud 的 GPT Image 2 生成，在导演回合之外由页面执行；出图后写回演员库。
export function useActorPortraits(comfyApiKey: string, library: Pick<ActorLibrary, 'getActors' | 'loading' | 'updateActor' | 'setActorImage'>) {
  const { getActors, loading, updateActor, setActorImage } = library
  // 同一个演员同时只跑一个任务；视频生成可以等这里的 Promise。
  const runningRef = useRef(new Map<string, Promise<void>>())
  const [generatingIds, setGeneratingIds] = useState<ReadonlySet<string>>(() => new Set())

  const run = useCallback(async (actorId: string) => {
    const actor = getActors().find((item) => item.id === actorId)
    if (!actor) return
    let jobId = actor.portraitJobId
    try {
      if (!jobId) {
        const prompt = portraitPromptFor(actor)
        if (!prompt) throw new Error('该演员没有外观描述，无法生成参考图。')
        jobId = (await submitComfyPortrait(comfyApiKey, prompt)).jobId
        await updateActor(actorId, { portraitJobId: jobId, portraitError: undefined })
      } else if (actor.portraitError) {
        await updateActor(actorId, { portraitError: undefined })
      }

      const deadline = Date.now() + POLL_TIMEOUT_MS
      for (;;) {
        const state = await getComfyJobStatus(comfyApiKey, jobId)
        if (state.status === 'completed') break
        if (state.status === 'failed') {
          // 任务本身失败：作废任务 ID，重试时重新提交。
          await updateActor(actorId, { portraitJobId: undefined, portraitError: state.error })
          return
        }
        // 超时保留任务 ID：任务可能还在排队，重试时继续查同一个任务，不重复扣费。
        if (Date.now() > deadline) throw new Error('参考图生成超过 10 分钟仍未完成，点重试会继续等待同一个任务。')
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      }

      const blob = await fetchComfyImage(comfyApiKey, jobId)
      const image = blob.type.startsWith('image/') ? blob : new Blob([blob], { type: 'image/png' })
      await setActorImage(actorId, await blobToDataUrl(image))
    } catch (error) {
      await updateActor(actorId, { portraitError: errorText(error) }).catch(() => {})
    }
  }, [comfyApiKey, getActors, setActorImage, updateActor])

  // force：已有参考图也重新生成（演员库里的「重新生成」）；自动触发时只补没有参考图的演员。
  const generatePortrait = useCallback((actorId: string, options: { force?: boolean } = {}) => {
    const existing = runningRef.current.get(actorId)
    if (existing) return existing
    const actor = getActors().find((item) => item.id === actorId)
    if (!comfyApiKey || !actor || (actor.referenceImageUrl && !options.force)) return Promise.resolve()
    const task = run(actorId).finally(() => {
      runningRef.current.delete(actorId)
      setGeneratingIds((current) => {
        const next = new Set(current)
        next.delete(actorId)
        return next
      })
    })
    runningRef.current.set(actorId, task)
    setGeneratingIds((current) => new Set(current).add(actorId))
    return task
  }, [comfyApiKey, getActors, run])

  // 视频段提交前等这些演员的参考图生成结束（成功或失败都放行，失败时该段按文字外观生成）。
  const waitForPortraits = useCallback(async (actorIds: Iterable<string>) => {
    const pending = [...new Set(actorIds)].flatMap((actorId) => {
      const task = runningRef.current.get(actorId)
      return task ? [task] : []
    })
    await Promise.all(pending)
  }, [])

  // ComfyUI 模式下视频段提交前调用：缺参考图且没失败过的演员先补生成，再一起等。失败过的不自动重试，避免反复扣费。
  const ensurePortraits = useCallback(async (actorIds: Iterable<string>) => {
    const ids = [...new Set(actorIds)]
    for (const actorId of ids) {
      const actor = getActors().find((item) => item.id === actorId)
      if (actor && !actor.referenceImageUrl && !actor.portraitError) void generatePortrait(actorId)
    }
    await waitForPortraits(ids)
  }, [generatePortrait, getActors, waitForPortraits])

  // 演员库读完后：刷新前已提交的生图任务（已在扣费）接着查结果。
  useEffect(() => {
    if (loading || !comfyApiKey) return
    for (const actor of getActors()) {
      if (actor.portraitJobId) void generatePortrait(actor.id, { force: true })
    }
    // 只在演员库加载完成（或刚配置好 key）时检查一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, comfyApiKey])

  return { generatePortrait, ensurePortraits, waitForPortraits, generatingIds, canGenerate: Boolean(comfyApiKey) }
}

export type ActorPortraits = ReturnType<typeof useActorPortraits>

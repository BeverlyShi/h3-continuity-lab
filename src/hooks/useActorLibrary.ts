import { useCallback, useEffect, useRef, useState } from 'react'
import { deleteActor, loadActors, saveActor, saveActors } from '../services/actorStorage'
import type { Actor, ActorDraft, CreatedActor } from '../types/actor'

export type ActorPatch = Partial<Pick<Actor, 'referenceImageUrl' | 'portraitJobId' | 'portraitError'>>

export function useActorLibrary() {
  const [actors, setActors] = useState<Actor[]>([])
  // 生图、视频生成这类跨越多次渲染的异步流程要读写最新演员库，不能用某次渲染时闭包里的旧数组。
  const actorsRef = useRef<Actor[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const commit = useCallback((next: Actor[]) => {
    actorsRef.current = next
    setActors(next)
  }, [])

  useEffect(() => {
    let active = true
    void loadActors()
      .then((stored) => {
        if (active) commit(stored)
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : '无法读取演员库')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [commit])

  const getActors = useCallback(() => actorsRef.current, [])

  const addActor = useCallback(async (draft: ActorDraft) => {
    const actor: Actor = {
      ...draft,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
    }
    await saveActor(actor)
    commit([...actorsRef.current, actor])
    return actor
  }, [commit])

  // 导演在选角时新建的演员：先入库占位，参考图由 ComfyUI 生成或用户上传后补上。
  const addCreatedActors = useCallback(async (created: CreatedActor[]) => {
    const fresh = created
      .filter((actor) => !actorsRef.current.some((item) => item.id === actor.id))
      .map((actor) => ({ ...actor, createdAt: Date.now() } satisfies Actor))
    if (!fresh.length) return
    await saveActors(fresh)
    commit([...actorsRef.current, ...fresh.filter((actor) => !actorsRef.current.some((item) => item.id === actor.id))])
  }, [commit])

  // 字段设为 undefined 即清除。演员已被删除时不做任何事。
  const updateActor = useCallback(async (actorId: string, patch: ActorPatch) => {
    const target = actorsRef.current.find((actor) => actor.id === actorId)
    if (!target) return
    const next: Actor = { ...target, ...patch }
    for (const key of Object.keys(patch) as Array<keyof ActorPatch>) {
      if (patch[key] === undefined) delete next[key]
    }
    await saveActor(next)
    commit(actorsRef.current.map((actor) => (actor.id === actorId ? next : actor)))
  }, [commit])

  // 换上新参考图时，进行中的生图任务和上次的失败信息一并作废。
  const setActorImage = useCallback(
    (actorId: string, referenceImageUrl: string) =>
      updateActor(actorId, { referenceImageUrl, portraitJobId: undefined, portraitError: undefined }),
    [updateActor],
  )

  const removeActor = useCallback(async (actorId: string) => {
    await deleteActor(actorId)
    commit(actorsRef.current.filter((actor) => actor.id !== actorId))
  }, [commit])

  return { actors, loading, error, getActors, addActor, addCreatedActors, updateActor, setActorImage, removeActor }
}

export type ActorLibrary = ReturnType<typeof useActorLibrary>

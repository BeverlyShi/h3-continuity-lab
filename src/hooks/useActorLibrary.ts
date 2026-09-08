import { useCallback, useEffect, useState } from 'react'
import { deleteActor, loadActors, saveActor, saveActors } from '../services/actorStorage'
import type { Actor, ActorDraft, CreatedActor } from '../types/actor'

export function useActorLibrary() {
  const [actors, setActors] = useState<Actor[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    void loadActors()
      .then((stored) => {
        if (active) setActors(stored)
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : '无法读取演员库')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [])

  const addActor = useCallback(async (draft: ActorDraft) => {
    const actor: Actor = {
      ...draft,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
    }
    await saveActor(actor)
    setActors((current) => [...current, actor])
    return actor
  }, [])

  // 导演在选角时新建的演员：先入库占位，参考图等用户在外部生成后再上传。
  const addCreatedActors = useCallback(async (created: CreatedActor[]) => {
    const fresh = created
      .filter((actor) => !actors.some((item) => item.id === actor.id))
      .map((actor) => ({ ...actor, createdAt: Date.now() } satisfies Actor))
    if (!fresh.length) return
    await saveActors(fresh)
    setActors((current) => [...current, ...fresh.filter((actor) => !current.some((item) => item.id === actor.id))])
  }, [actors])

  const setActorImage = useCallback(async (actorId: string, referenceImageUrl: string) => {
    const target = actors.find((actor) => actor.id === actorId)
    if (!target) return
    const next: Actor = { ...target, referenceImageUrl }
    await saveActor(next)
    setActors((current) => current.map((actor) => (actor.id === actorId ? next : actor)))
  }, [actors])

  const removeActor = useCallback(async (actorId: string) => {
    await deleteActor(actorId)
    setActors((current) => current.filter((actor) => actor.id !== actorId))
  }, [])

  return { actors, loading, error, addActor, addCreatedActors, setActorImage, removeActor }
}

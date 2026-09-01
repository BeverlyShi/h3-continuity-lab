import { useCallback, useEffect, useState } from 'react'
import { deleteActor, loadActors, saveActor } from '../services/actorStorage'
import type { Actor, ActorDraft } from '../types/actor'

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

  const removeActor = useCallback(async (actorId: string) => {
    await deleteActor(actorId)
    setActors((current) => current.filter((actor) => actor.id !== actorId))
  }, [])

  return { actors, loading, error, addActor, removeActor }
}

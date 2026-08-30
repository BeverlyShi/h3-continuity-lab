import { useEffect, useRef, useState } from 'react'
import {
  registerGameDirectorTools,
  setGameDirectorController,
  type GameDirectorController,
} from '../services/webMcpDirector'

export type DirectorConnection = 'unavailable' | 'native' | 'local-dev'

export function useGameDirectorTools(controller: GameDirectorController) {
  const controllerRef = useRef(controller)
  const [connection, setConnection] = useState<DirectorConnection>('unavailable')

  useEffect(() => {
    controllerRef.current = controller
    setGameDirectorController(controller)
  }, [controller])

  useEffect(() => {
    let active = true
    setGameDirectorController(controllerRef.current)
    void registerGameDirectorTools()
      .then((available) => {
        if (!active || !available) return
        setConnection(document.modelContext?.source === 'local-dev' ? 'local-dev' : 'native')
      })
      .catch(() => { if (active) setConnection('unavailable') })
    return () => { active = false }
  }, [])

  return connection
}

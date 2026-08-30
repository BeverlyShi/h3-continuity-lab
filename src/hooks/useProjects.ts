import { useMemo, useState } from 'react'
import {
  loadActiveProjectId,
  loadProjects,
  saveActiveProjectId,
  saveProjects,
} from '../services/localStorage'
import type { VideoClip, VideoProject } from '../types/video'

const makeId = () => crypto.randomUUID()

export function useProjects() {
  const [projects, setProjectsState] = useState<VideoProject[]>(loadProjects)
  const [activeProjectId, setActiveProjectIdState] = useState(() => {
    const storedId = loadActiveProjectId()
    const storedProjects = loadProjects()
    return storedProjects.some((project) => project.id === storedId)
      ? storedId
      : storedProjects[0]?.id ?? ''
  })

  const setProjects = (updater: (projects: VideoProject[]) => VideoProject[]) => {
    setProjectsState((current) => {
      const next = updater(current)
      saveProjects(next)
      return next
    })
  }

  const selectProject = (projectId: string) => {
    setActiveProjectIdState(projectId)
    saveActiveProjectId(projectId)
  }

  const createProject = (name: string) => {
    const now = Date.now()
    const project: VideoProject = {
      id: makeId(),
      name: name.trim() || `未命名项目 ${projects.length + 1}`,
      clips: [],
      createdAt: now,
      updatedAt: now,
    }
    setProjects((current) => [...current, project])
    selectProject(project.id)
    return project
  }

  const addClip = (projectId: string, clip: VideoClip) => {
    setProjects((current) => current.map((project) =>
      project.id === projectId
        ? { ...project, clips: [...project.clips, clip], updatedAt: Date.now() }
        : project,
    ))
  }

  const updateClip = (
    projectId: string,
    clipId: string,
    patch: Partial<VideoClip>,
  ) => {
    setProjects((current) => current.map((project) =>
      project.id === projectId
        ? {
            ...project,
            clips: project.clips.map((clip) =>
              clip.id === clipId ? { ...clip, ...patch } : clip,
            ),
            updatedAt: Date.now(),
          }
        : project,
    ))
  }

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId),
    [activeProjectId, projects],
  )

  return {
    projects,
    activeProject,
    activeProjectId,
    createProject,
    selectProject,
    addClip,
    updateClip,
  }
}

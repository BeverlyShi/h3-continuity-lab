import type { VideoProject } from '../types/video'

const API_KEY_STORAGE_KEY = 'h3-continuity-lab:fal-key'
const DEEPSEEK_API_KEY_STORAGE_KEY = 'h3-continuity-lab:deepseek-key'
const PROJECTS_STORAGE_KEY = 'h3-continuity-lab:projects'
const ACTIVE_PROJECT_STORAGE_KEY = 'h3-continuity-lab:active-project'

export const loadApiKey = () => localStorage.getItem(API_KEY_STORAGE_KEY) ?? ''

export const saveApiKey = (apiKey: string) => {
  if (apiKey) localStorage.setItem(API_KEY_STORAGE_KEY, apiKey)
  else localStorage.removeItem(API_KEY_STORAGE_KEY)
}

export const loadDeepSeekApiKey = () => localStorage.getItem(DEEPSEEK_API_KEY_STORAGE_KEY) ?? ''

export const saveDeepSeekApiKey = (apiKey: string) => {
  if (apiKey) localStorage.setItem(DEEPSEEK_API_KEY_STORAGE_KEY, apiKey)
  else localStorage.removeItem(DEEPSEEK_API_KEY_STORAGE_KEY)
}

export const loadProjects = (): VideoProject[] => {
  try {
    const raw = localStorage.getItem(PROJECTS_STORAGE_KEY)
    if (!raw) return []
    const projects = JSON.parse(raw) as VideoProject[]
    if (!Array.isArray(projects)) return []

    return projects.map((project) => ({
      ...project,
      clips: Array.isArray(project.clips)
        ? project.clips.map((clip) =>
            clip.status === 'queued' || clip.status === 'generating'
              ? {
                  ...clip,
                  status: 'failed' as const,
                  error: '页面刷新时生成任务已中断，请重新提交该 Prompt。',
                }
              : clip,
          )
        : [],
    }))
  } catch {
    return []
  }
}

export const saveProjects = (projects: VideoProject[]) => {
  localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects))
}

export const loadActiveProjectId = () =>
  localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY) ?? ''

export const saveActiveProjectId = (projectId: string) => {
  if (projectId) localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, projectId)
  else localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY)
}

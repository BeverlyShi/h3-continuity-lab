import type { VideoProject } from '../types/video'

const API_KEY_STORAGE_KEY = 'h3-continuity-lab:fal-key'
const OPENROUTER_API_KEY_STORAGE_KEY = 'h3-continuity-lab:openrouter-key'
const DEEPSEEK_API_KEY_STORAGE_KEY = 'h3-continuity-lab:deepseek-key'
const BIGMODEL_API_KEY_STORAGE_KEY = 'h3-continuity-lab:bigmodel-key'
const COMFY_API_KEY_STORAGE_KEY = 'h3-continuity-lab:comfy-key'
const PROJECTS_STORAGE_KEY = 'h3-continuity-lab:projects'
const ACTIVE_PROJECT_STORAGE_KEY = 'h3-continuity-lab:active-project'

export const loadApiKey = () => localStorage.getItem(API_KEY_STORAGE_KEY) ?? ''

export const saveApiKey = (apiKey: string) => {
  if (apiKey) localStorage.setItem(API_KEY_STORAGE_KEY, apiKey)
  else localStorage.removeItem(API_KEY_STORAGE_KEY)
}

export const loadOpenRouterApiKey = () => localStorage.getItem(OPENROUTER_API_KEY_STORAGE_KEY) ?? ''

export const saveOpenRouterApiKey = (apiKey: string) => {
  if (apiKey) localStorage.setItem(OPENROUTER_API_KEY_STORAGE_KEY, apiKey)
  else localStorage.removeItem(OPENROUTER_API_KEY_STORAGE_KEY)
}

export const loadDeepSeekApiKey = () => localStorage.getItem(DEEPSEEK_API_KEY_STORAGE_KEY) ?? ''

export const saveDeepSeekApiKey = (apiKey: string) => {
  if (apiKey) localStorage.setItem(DEEPSEEK_API_KEY_STORAGE_KEY, apiKey)
  else localStorage.removeItem(DEEPSEEK_API_KEY_STORAGE_KEY)
}

export const loadBigModelApiKey = () => localStorage.getItem(BIGMODEL_API_KEY_STORAGE_KEY) ?? ''

export const saveBigModelApiKey = (apiKey: string) => {
  if (apiKey) localStorage.setItem(BIGMODEL_API_KEY_STORAGE_KEY, apiKey)
  else localStorage.removeItem(BIGMODEL_API_KEY_STORAGE_KEY)
}

export const loadComfyApiKey = () => localStorage.getItem(COMFY_API_KEY_STORAGE_KEY) ?? ''

export const saveComfyApiKey = (apiKey: string) => {
  if (apiKey) localStorage.setItem(COMFY_API_KEY_STORAGE_KEY, apiKey)
  else localStorage.removeItem(COMFY_API_KEY_STORAGE_KEY)
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

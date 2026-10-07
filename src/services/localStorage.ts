const API_KEY_STORAGE_KEY = 'h3-continuity-lab:fal-key'
const OPENROUTER_API_KEY_STORAGE_KEY = 'h3-continuity-lab:openrouter-key'
const DEEPSEEK_API_KEY_STORAGE_KEY = 'h3-continuity-lab:deepseek-key'
const BIGMODEL_API_KEY_STORAGE_KEY = 'h3-continuity-lab:bigmodel-key'
const COMFY_API_KEY_STORAGE_KEY = 'h3-continuity-lab:comfy-key'

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

export const directorModelOptions = [
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', provider: 'deepseek' },
  { id: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', provider: 'openrouter' },
  { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', provider: 'openrouter' },
  { id: 'z-ai/glm-5.3-flash', label: 'GLM-5.3-Flash', provider: 'openrouter' },
] as const

export type DirectorModelId = typeof directorModelOptions[number]['id']

export type DirectorModelProvider = typeof directorModelOptions[number]['provider']

export const DEFAULT_DIRECTOR_MODEL: DirectorModelId = 'deepseek-v4-flash'

export const isDirectorModelId = (value: unknown): value is DirectorModelId =>
  typeof value === 'string' && directorModelOptions.some((option) => option.id === value)

export const getDirectorModelLabel = (modelId: DirectorModelId) =>
  directorModelOptions.find((option) => option.id === modelId)?.label ?? modelId

export const getDirectorModelProvider = (modelId: DirectorModelId): DirectorModelProvider =>
  directorModelOptions.find((option) => option.id === modelId)?.provider ?? 'openrouter'

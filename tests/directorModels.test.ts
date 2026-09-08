import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_DIRECTOR_MODEL,
  directorModelOptions,
  getDirectorModelProvider,
  getDirectorApiModelId,
  isDirectorModelId,
} from '../src/config/directorModels.ts'

test('exposes the four director models', () => {
  assert.deepEqual(directorModelOptions.map((option) => option.id), [
    'deepseek-v4-flash',
    'google/gemini-2.5-flash-lite',
    'openai/gpt-oss-20b',
    'z-ai/glm-5.3-flash',
  ])
  assert.equal(DEFAULT_DIRECTOR_MODEL, 'deepseek-v4-flash')
})

test('validates director model ids against the server allowlist', () => {
  assert.equal(isDirectorModelId('google/gemini-2.5-flash-lite'), true)
  assert.equal(isDirectorModelId('openrouter/auto'), false)
  assert.equal(isDirectorModelId(undefined), false)
})

test('routes DeepSeek and GLM through their official providers', () => {
  assert.equal(getDirectorModelProvider('deepseek-v4-flash'), 'deepseek')
  assert.equal(getDirectorModelProvider('google/gemini-2.5-flash-lite'), 'openrouter')
  assert.equal(getDirectorModelProvider('openai/gpt-oss-20b'), 'openrouter')
  assert.equal(getDirectorModelProvider('z-ai/glm-5.3-flash'), 'bigmodel')
})

test('maps the saved GLM selection to the official model id', () => {
  assert.equal(getDirectorApiModelId('z-ai/glm-5.3-flash'), 'glm-5.3-flash')
  assert.equal(getDirectorApiModelId('deepseek-v4-flash'), 'deepseek-v4-flash')
  assert.equal(getDirectorApiModelId('google/gemini-2.5-flash-lite'), 'google/gemini-2.5-flash-lite')
})

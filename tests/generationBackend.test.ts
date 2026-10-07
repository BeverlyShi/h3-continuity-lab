import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, type FalClient } from '@fal-ai/client'
import {
  createFalBackend,
  getBackendForJob,
  getBackendForMode,
  parseJobId,
} from '../src/services/generationBackend.ts'

const noKeys = { falApiKey: '', comfyApiKey: '' }

test('parses comfy, fal and legacy unprefixed job ids', () => {
  assert.deepEqual(parseJobId('comfy:abc-123'), { backend: 'comfy', promptId: 'abc-123' })
  assert.deepEqual(parseJobId('fal:minimax/h3-max/reference-to-video:req-1'), {
    backend: 'fal', endpointId: 'minimax/h3-max/reference-to-video', requestId: 'req-1',
  })
  assert.deepEqual(parseJobId('abc-123'), { backend: 'comfy', promptId: 'abc-123' }, '没有前缀的旧 ID 当 Comfy')
  assert.throws(() => parseJobId('fal:no-request-id'), /格式无效/)
})

test('resuming a job picks the backend by prefix and needs that key', () => {
  assert.throws(() => getBackendForJob('fal:openai/gpt-image-2:req-1', { ...noKeys, comfyApiKey: 'c' }), /fal API Key/)
  assert.throws(() => getBackendForJob('comfy:job-1', { ...noKeys, falApiKey: 'f' }), /Comfy API Key/)
  assert.throws(() => getBackendForJob('job-1', { ...noKeys, falApiKey: 'f' }), /Comfy API Key/)
  assert.ok(getBackendForJob('fal:openai/gpt-image-2:req-1', { ...noKeys, falApiKey: 'f' }))
  assert.ok(getBackendForJob('job-1', { ...noKeys, comfyApiKey: 'c' }))
})

test('new submissions pick the backend by mode and return null without its key', () => {
  assert.equal(getBackendForMode('auto', { ...noKeys, comfyApiKey: 'c' }), null)
  assert.equal(getBackendForMode('comfy', { ...noKeys, falApiKey: 'f' }), null)
  assert.ok(getBackendForMode('auto', { ...noKeys, falApiKey: 'f' }))
  assert.ok(getBackendForMode('comfy', { ...noKeys, comfyApiKey: 'c' }))
})

// 只实现用到的几个方法，记录提交的 endpoint 与上传的文件。
const fakeFal = (status: () => Promise<unknown> = async () => ({ status: 'IN_QUEUE' })) => {
  const submits: { endpointId: string; input: Record<string, unknown> }[] = []
  const uploads: Blob[] = []
  const client = {
    queue: {
      submit: async (endpointId: string, { input }: { input: Record<string, unknown> }) => {
        submits.push({ endpointId, input })
        return { request_id: `req-${submits.length}` }
      },
      status,
    },
    storage: {
      upload: async (file: Blob) => {
        uploads.push(file)
        return `https://fal.media/uploaded-${uploads.length}.png`
      },
    },
  } as unknown as FalClient
  return { client, submits, uploads }
}

test('fal submits text-to-video without references and reference-to-video after uploading data URLs', async () => {
  const fal = fakeFal()
  const backend = createFalBackend('f', fal.client)
  assert.equal(await backend.submitVideo({ prompt: 'p', seconds: 6, referenceImages: [] }), 'fal:minimax/h3-max/text-to-video:req-1')
  assert.equal(fal.submits[0].input.reference_image_urls, undefined)

  const jobId = await backend.submitVideo({
    prompt: 'p', seconds: 6, referenceImages: ['https://fal.media/actor.png', 'data:image/png;base64,aGVsbG8='],
  })
  assert.equal(jobId, 'fal:minimax/h3-max/reference-to-video:req-2')
  assert.deepEqual(fal.submits[1].input.reference_image_urls, ['https://fal.media/actor.png', 'https://fal.media/uploaded-1.png'])
  assert.equal(fal.submits[1].input.duration, 6)
  assert.equal(fal.uploads.length, 1, '只有 data URL 需要上传')
  assert.equal(fal.uploads[0].type, 'image/png')
  assert.equal(await fal.uploads[0].text(), 'hello')
})

test('fal status maps a completed request with an error to failed and rethrows request errors', async () => {
  const jobId = 'fal:minimax/h3-max/text-to-video:req-1'
  const statusOf = async (status: () => Promise<unknown>) => await createFalBackend('f', fakeFal(status).client).getStatus(jobId)
  assert.deepEqual(await statusOf(async () => ({ status: 'IN_PROGRESS' })), { status: 'pending' })
  assert.deepEqual(await statusOf(async () => ({ status: 'COMPLETED' })), { status: 'completed' })
  assert.equal((await statusOf(async () => ({ status: 'COMPLETED', error: 'content policy' }))).status, 'failed')
  assert.equal((await statusOf(async () => { throw new ApiError({ message: 'not found', status: 404 }) })).status, 'failed')
  await assert.rejects(statusOf(async () => { throw new TypeError('Failed to fetch') }), /Failed to fetch/, '网络错误保留任务 ID')
})

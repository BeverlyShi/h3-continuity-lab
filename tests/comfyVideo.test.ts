import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildComfyWorkflow,
  chooseWorkflowKind,
  createComfyClient,
  validateComfySegmentRequest,
} from '../server/comfyVideo.ts'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

test('picks the workflow the same way as fal: start frame, then references, then text only', () => {
  assert.equal(chooseWorkflowKind({ prompt: 'p', seconds: 5, startImage: PNG, referenceImages: [PNG] }), 'i2v')
  assert.equal(chooseWorkflowKind({ prompt: 'p', seconds: 5, referenceImages: [PNG] }), 'r2v')
  assert.equal(chooseWorkflowKind({ prompt: 'p', seconds: 5 }), 't2v')
})

test('fills only prompt, duration, seed and images into the template workflows', () => {
  const i2v = buildComfyWorkflow('i2v', { prompt: '0–6秒：推近', seconds: 6, seed: 7, uploadedImages: ['first.png'] })
  assert.equal(i2v['1'].inputs.image, 'first.png')
  assert.deepEqual(i2v['2'].inputs, {
    model: 'MiniMax H3 Max Turbo',
    'model.prompt': '0–6秒：推近',
    'model.resolution': '768P',
    'model.duration': 6,
    'model.prompt_expansion_mode': 'balanced',
    first_frame: ['1', 0],
    seed: 7,
    watermark: false,
  })

  const t2v = buildComfyWorkflow('t2v', { prompt: 'p', seconds: 5, seed: 1, uploadedImages: [] })
  assert.equal(t2v['2'].inputs.model, 'MiniMax H3 Max Turbo')
  assert.equal(t2v['2'].inputs['model.ratio'], '16:9')

  const r2v = buildComfyWorkflow('r2v', { prompt: 'p', seconds: 8, seed: 1, uploadedImages: ['a.png', 'b.png'] })
  assert.equal(r2v['2'].inputs.model, 'MiniMax H3 Max')
  assert.deepEqual(r2v['2'].inputs['model.reference_images.image_1'], ['10', 0])
  assert.deepEqual(r2v['2'].inputs['model.reference_images.image_2'], ['11', 0])
  assert.equal(r2v['10'].inputs.image, 'a.png')
  assert.equal(r2v['11'].inputs.image, 'b.png')
})

test('template files are not mutated between builds', () => {
  buildComfyWorkflow('r2v', { prompt: 'first', seconds: 5, seed: 1, uploadedImages: ['a.png'] })
  const second = buildComfyWorkflow('r2v', { prompt: 'second', seconds: 5, seed: 1, uploadedImages: [] })
  assert.equal(second['10'], undefined)
  assert.equal(second['2'].inputs['model.prompt'], 'second')
})

test('rejects durations H3 Max cannot render and bad image addresses', () => {
  assert.throws(() => validateComfySegmentRequest({ prompt: 'p', seconds: 4 }), /5–15/)
  assert.throws(() => validateComfySegmentRequest({ prompt: 'p', seconds: 16 }), /5–15/)
  assert.throws(() => validateComfySegmentRequest({ prompt: 'p', seconds: 5, startImage: 'blob:x' }), /首帧/)
  assert.deepEqual(validateComfySegmentRequest({ prompt: 'p', seconds: 5, referenceImages: [] }), { prompt: 'p', seconds: 5 })
})

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

test('submits with the key in extra_data and maps job states', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const statuses = ['queued_waiting', 'executing', 'success', 'error']
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)
    calls.push({ url: href, init })
    if (href.endsWith('/api/upload/image')) return jsonResponse({ name: 'up.png', subfolder: '' })
    if (href.endsWith('/api/prompt')) return jsonResponse({ prompt_id: 'job-1', node_errors: {} })
    if (href.endsWith('/status')) return jsonResponse({ status: statuses.shift() })
    if (href.includes('/api/jobs/')) return jsonResponse({ status: 'failed', execution_error: { exception_message: '内容审核未通过' } })
    throw new Error(`unexpected ${href}`)
  }) as typeof fetch

  const client = createComfyClient('comfyui-test', fakeFetch)
  assert.deepEqual(await client.submitSegment({ prompt: 'p', seconds: 5, startImage: PNG }), { jobId: 'job-1', kind: 'i2v' })
  const submit = calls.find((call) => call.url.endsWith('/api/prompt'))!
  const body = JSON.parse(String(submit.init?.body))
  assert.equal(body.extra_data.api_key_comfy_org, 'comfyui-test')
  assert.equal(body.prompt['1'].inputs.image, 'up.png')
  assert.equal((submit.init?.headers as Record<string, string>)['X-API-Key'], 'comfyui-test')

  assert.deepEqual(await client.getSegment('job-1'), { status: 'running' })
  assert.deepEqual(await client.getSegment('job-1'), { status: 'running' })
  assert.deepEqual(await client.getSegment('job-1'), { status: 'completed' })
  assert.deepEqual(await client.getSegment('job-1'), { status: 'failed', error: 'Comfy 生成失败：内容审核未通过' })
})

test('explains payment errors from Comfy', async () => {
  const fakeFetch = (async () => jsonResponse({ message: 'insufficient credits' }, 402)) as unknown as typeof fetch
  await assert.rejects(
    createComfyClient('k', fakeFetch).submitSegment({ prompt: 'p', seconds: 5 }),
    /HTTP 402（积分不足）：insufficient credits/,
  )
})

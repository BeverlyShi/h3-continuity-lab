import assert from 'node:assert/strict'
import test from 'node:test'
import {
  registerGameDirectorTools,
  setGameDirectorController,
} from '../src/services/webMcpDirector.ts'

test('registers the five focused game director tools', async () => {
  const registered: WebMcpTool[] = []
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      modelContext: {
        registerTool: async (tool: WebMcpTool) => { registered.push(tool) },
      },
    },
  })
  setGameDirectorController({
    getTurnContext: () => ({ context: true }),
    commitResolution: () => ({ committed: true }),
    requestVideo: async () => ({ requested: true }),
    getGenerationStatus: () => ({ status: 'ready_to_publish' }),
    publishTurn: () => ({ published: true }),
  })

  assert.equal(await registerGameDirectorTools(), true)
  assert.deepEqual(
    registered.map((tool) => tool.name),
    ['get_turn_context', 'commit_resolution', 'request_video', 'get_generation_status', 'publish_turn'],
  )
  assert.deepEqual(await registered[0].execute({}), { context: true })
  assert.deepEqual(await registered[4].execute({}), { published: true })
})

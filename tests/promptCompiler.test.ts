import assert from 'node:assert/strict'
import test from 'node:test'
import { INITIAL_PERMITS } from '../src/engine/gameRules.ts'
import { compileScenePrompt } from '../src/engine/promptCompiler.ts'
import { unregisteredCity } from '../src/stories/unregisteredCity.ts'
import type { DirectorResolutionInput, GameSession } from '../src/types/game.ts'

test('compiles confirmed state and action into the next H3 prompt', () => {
  const session: GameSession = {
    schemaVersion: 2,
    id: 'session-1',
    storyId: unregisteredCity.id,
    status: 'resolved',
    turn: 2,
    createdAt: 1,
    updatedAt: 1,
    stats: { ...unregisteredCity.initialStats },
    permits: INITIAL_PERMITS.map((permit) => ({ ...permit })),
    sceneHistory: [],
    pendingAction: { text: '让燕七守门', source: 'freeform', submittedAt: 1 },
    events: [],
  }
  const resolution: DirectorResolutionInput = {
    outcome: 'success',
    narrative: '燕七接过守门籍，走向门闩。',
    reason: '身份与职责相符。',
    nextOptions: ['查看名灯', '询问苏簿娘'],
    sceneDirection: 'Yan Qi takes the gate permit and walks toward the barred door.',
  }
  const permits = INITIAL_PERMITS.map((permit) => ({
    ...permit,
    holderId: permit.id === 'gatekeeper' ? 'yan-qi' : undefined,
  }))

  const prompt = compileScenePrompt(unregisteredCity, session, resolution, permits)

  assert.match(prompt, /让燕七守门/)
  assert.match(prompt, /燕七接过守门籍/)
  assert.match(prompt, /守门籍: 燕七/)
  assert.match(prompt, /Do not introduce new characters/)
})

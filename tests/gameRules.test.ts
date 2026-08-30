import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDirectorResolution, INITIAL_PERMITS } from '../src/engine/gameRules.ts'
import { unregisteredCity } from '../src/stories/unregisteredCity.ts'
import type { DirectorResolutionInput, GameSession } from '../src/types/game.ts'

const makeSession = (turn = 1): GameSession => ({
  schemaVersion: 3,
  id: 'session-1',
  storyId: unregisteredCity.id,
  status: 'awaiting_director',
  turn,
  createdAt: 1,
  updatedAt: 1,
  stats: { ...unregisteredCity.initialStats },
  permits: INITIAL_PERMITS.map((permit) => ({ ...permit })),
  sceneHistory: [],
  pendingAction: { text: '分配宿籍', source: 'freeform', submittedAt: 1 },
  events: [],
})

const makeResolution = (patch: Partial<DirectorResolutionInput> = {}): DirectorResolutionInput => ({
  outcome: 'success',
  narrative: '四人依次走到宿名簿前。',
  reason: '玩家明确要求核验并分配宿籍。',
  nextOptions: ['检查名灯', '询问顾蝉的药箱'],
  sceneDirection: 'The four exiles gather around the registry book under amber lantern light.',
  ...patch,
})

test('rejects assigning two permits to the same character', () => {
  const decision = applyDirectorResolution(makeSession(), unregisteredCity, makeResolution({
    permitChanges: [
      { permitId: 'gatekeeper', holderId: 'yan-qi', kind: 'initial_assignment' },
      { permitId: 'scribe', holderId: 'yan-qi', kind: 'initial_assignment' },
    ],
  }))
  assert.equal(decision.ok, false)
  if (!decision.ok) assert.match(decision.errors.join('\n'), /不能同时持有两张宿籍/)
})

test('rejects changing the same permit twice in one resolution', () => {
  const decision = applyDirectorResolution(makeSession(), unregisteredCity, makeResolution({
    permitChanges: [
      { permitId: 'scribe', holderId: 'su-buniang', kind: 'initial_assignment' },
      { permitId: 'scribe', holderId: 'gu-chan', kind: 'initial_assignment' },
    ],
  }))
  assert.equal(decision.ok, false)
  if (!decision.ok) assert.match(decision.errors.join('\n'), /不能在一个回合内变更两次/)
})

test('applies deterministic risk when a permit conflicts with its holder', () => {
  const decision = applyDirectorResolution(makeSession(), unregisteredCity, makeResolution({
    permitChanges: [{ permitId: 'scribe', holderId: 'gu-chan', kind: 'initial_assignment' }],
  }))
  assert.equal(decision.ok, true)
  if (decision.ok) {
    assert.equal(decision.stats.innOrder, 44)
    assert.equal(decision.stats.officialSuspicion, 19)
  }
})

test('rejects reassignment after sunset and incomplete transfers', () => {
  const session = makeSession(3)
  session.permits[0].holderId = 'yan-qi'
  const reassignment = applyDirectorResolution(session, unregisteredCity, makeResolution({
    permitChanges: [{ permitId: 'gatekeeper', holderId: 'gu-chan', kind: 'initial_assignment' }],
  }))
  assert.equal(reassignment.ok, false)

  const transfer = applyDirectorResolution(session, unregisteredCity, makeResolution({
    permitChanges: [{
      permitId: 'gatekeeper',
      holderId: 'gu-chan',
      kind: 'voluntary_transfer',
      voluntary: true,
      accepted: true,
    }],
  }))
  assert.equal(transfer.ok, false)
  if (!transfer.ok) assert.match(transfer.errors.join('\n'), /第三方见证/)
})

test('allows one witnessed voluntary transfer and locks a second transfer', () => {
  const session = makeSession(3)
  session.permits[0].holderId = 'yan-qi'
  const change = {
    permitId: 'gatekeeper' as const,
    holderId: 'gu-chan',
    kind: 'voluntary_transfer' as const,
    voluntary: true,
    accepted: true,
    witnessed: true,
  }
  const first = applyDirectorResolution(session, unregisteredCity, makeResolution({ permitChanges: [change] }))
  assert.equal(first.ok, true)
  if (!first.ok) return

  session.permits = first.permits
  const second = applyDirectorResolution(session, unregisteredCity, makeResolution({
    permitChanges: [{ ...change, holderId: 'su-buniang' }],
  }))
  assert.equal(second.ok, false)
  if (!second.ok) assert.match(second.errors.join('\n'), /已经流转过一次/)
})

test('computes an ending on the configured final turn', () => {
  const session = makeSession(unregisteredCity.maxTurns)
  session.permits = [
    { id: 'gatekeeper', label: '守门籍', holderId: 'yan-qi', transferred: false },
    { id: 'lamplighter', label: '掌灯籍', holderId: 'a-zhu', transferred: false },
    { id: 'scribe', label: '司簿籍', holderId: 'su-buniang', transferred: false },
  ]
  const decision = applyDirectorResolution(session, unregisteredCity, makeResolution())
  assert.equal(decision.ok, true)
  if (decision.ok) assert.equal(decision.ending?.kind, 'safe')
})

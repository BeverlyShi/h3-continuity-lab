import assert from 'node:assert/strict'
import test from 'node:test'
import type { Session } from '@earendil-works/pi-agent-core/node'
import { INITIAL_PERMITS } from '../src/engine/gameRules.ts'
import { unregisteredCity } from '../src/stories/unregisteredCity.ts'
import type { DirectorResolutionInput, DirectorTurnContext, GameScene, GameSession } from '../src/types/game.ts'
import {
  buildDirectorTurnPrompt,
  EMPTY_DIRECTOR_BOARD,
  parseDirectorDecision,
  persistDirectorBoardPatch,
  validateDirectorDecision,
} from '../server/directorDecision.ts'

const openingScene: GameScene = {
  id: 'opening',
  turn: 0,
  title: '第一幕 · 日落将至',
  narrative: unregisteredCity.openingNarrative,
  prompt: 'Cinematic legacy video prompt that must not reach the director.',
  options: [...unregisteredCity.initialOptions],
}

const makeContext = (): DirectorTurnContext => {
  const session: GameSession = {
    schemaVersion: 3,
    id: 'game-session-1',
    storyId: unregisteredCity.id,
    status: 'awaiting_director',
    turn: 1,
    createdAt: 1,
    updatedAt: 1,
    stats: { ...unregisteredCity.initialStats },
    permits: INITIAL_PERMITS.map((permit) => ({ ...permit })),
    currentScene: openingScene,
    sceneHistory: [openingScene],
    pendingAction: { text: '先查看四人的文书', source: 'suggested', submittedAt: 1 },
    events: [{ id: 'action-1', turn: 1, type: 'player_action', text: '先查看四人的文书', createdAt: 1 }],
  }
  return { ok: true, session }
}

const validResolution = (patch: Partial<DirectorResolutionInput> = {}) => ({
  outcome: 'success',
  narrative: '四份驱逐文书在灯下依次展开，纸角和印泥留下了不同的线索。',
  reason: '玩家主动查验文书，因此获得可见且不越过角色秘密边界的信息。',
  nextOptions: ['追问顾蝉文书缺失的一角', '按身份暂拟三份宿籍'],
  sceneDirection: '驿站内，四人围在灯火旁，文书依次铺在木桌上。',
  ...patch,
}) satisfies DirectorResolutionInput

test('first-turn prompt contains one compact state snapshot without legacy history or video data', () => {
  const prompt = buildDirectorTurnPrompt(makeContext(), EMPTY_DIRECTOR_BOARD)

  assert.match(prompt, /先查看四人的文书/)
  assert.match(prompt, /第一幕 · 日落将至/)
  assert.doesNotMatch(prompt, /sceneHistory/)
  assert.doesNotMatch(prompt, /events/)
  assert.doesNotMatch(prompt, /Cinematic legacy video prompt/)
})

test('parses one structured director decision and validates it outside the agent loop', () => {
  const candidate = JSON.stringify({
    ...validResolution(),
    directorBoardPatch: {
      nextBeat: '追问文书上不合理的印章。',
      foreshadowing: ['北门戍籍印泥未干'],
    },
  })

  assert.equal(parseDirectorDecision(candidate).ok, true)
  const validated = validateDirectorDecision(candidate, makeContext())
  assert.equal(validated.ok, true)
  if (validated.ok) assert.equal(validated.boardPatch?.nextBeat, '追问文书上不合理的印章。')
})

test('returns deterministic rule errors for a rejected candidate', () => {
  const candidate = JSON.stringify(validResolution({
    permitChanges: [
      { permitId: 'gatekeeper', holderId: 'yan-qi', kind: 'initial_assignment' },
      { permitId: 'scribe', holderId: 'yan-qi', kind: 'initial_assignment' },
    ],
  }))

  const validated = validateDirectorDecision(candidate, makeContext())
  assert.equal(validated.ok, false)
  if (!validated.ok) assert.match(validated.errors.join('；'), /不能同时持有两张宿籍/)
})

test('persists only a merged director board patch after validation', async () => {
  const writes: unknown[] = []
  const session = {
    appendCustomEntry: async (customType: string, data?: unknown) => {
      assert.equal(customType, 'director_board')
      writes.push(data)
      return 'entry-1'
    },
  } as unknown as Session

  const next = await persistDirectorBoardPatch(session, EMPTY_DIRECTOR_BOARD, {
    nextBeat: '让缺角文书成为下一幕的公开矛盾。',
    foreshadowing: ['顾蝉的文书缺角', '顾蝉的文书缺角'],
  })
  assert.equal(writes.length, 1)
  assert.deepEqual(next.foreshadowing, ['顾蝉的文书缺角'])
})

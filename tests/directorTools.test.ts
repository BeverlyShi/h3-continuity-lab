import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentTool, Session } from '@earendil-works/pi-agent-core/node'
import { INITIAL_PERMITS } from '../src/engine/gameRules.ts'
import { unregisteredCity } from '../src/stories/unregisteredCity.ts'
import type { DirectorResolutionInput, DirectorTurnContext, GameSession } from '../src/types/game.ts'
import { createDirectorTools, EMPTY_DIRECTOR_BOARD } from '../server/directorTools.ts'

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
    sceneHistory: [],
    pendingAction: { text: '先查看四人的文书', source: 'suggested', submittedAt: 1 },
    events: [],
  }
  return {
    ok: true,
    session,
  }
}

const validResolution = (patch: Partial<DirectorResolutionInput> = {}): DirectorResolutionInput => ({
  outcome: 'success',
  narrative: '四份驱逐文书在灯下依次展开，纸角和印泥留下了不同的线索。',
  reason: '玩家主动查验文书，因此获得可见且不越过角色秘密边界的信息。',
  nextOptions: ['追问顾蝉文书缺失的一角', '按身份暂拟三份宿籍'],
  sceneDirection: '驿站内，四人围在灯火旁，文书依次铺在木桌上。',
  ...patch,
})

const findTool = (tools: AgentTool[], name: string) => {
  const tool = tools.find((candidate) => candidate.name === name)
  assert.ok(tool, `missing tool ${name}`)
  return tool
}

test('director has a free tool set and persists its board', async () => {
  const boardWrites: unknown[] = []
  const session = {
    appendCustomEntry: async (customType: string, data?: unknown) => {
      assert.equal(customType, 'director_board')
      boardWrites.push(data)
      return 'entry-1'
    },
  } as unknown as Session
  const runtime = createDirectorTools({
    context: makeContext(),
    session,
    initialBoard: { ...EMPTY_DIRECTOR_BOARD },
    send: () => undefined,
  })

  assert.deepEqual(runtime.tools.map((tool) => tool.name), [
    'read_game_state',
    'read_turn_history',
    'update_director_board',
    'resolve_action',
    'publish_turn',
  ])

  await findTool(runtime.tools, 'update_director_board').execute('board-1', {
    nextBeat: '让缺角文书成为下一幕的公开矛盾。',
    foreshadowing: ['顾蝉的文书缺角'],
  })
  assert.equal(boardWrites.length, 1)
  assert.equal(runtime.getBoard().nextBeat, '让缺角文书成为下一幕的公开矛盾。')

  const stateResult = await findTool(runtime.tools, 'read_game_state').execute('state-1', {})
  assert.match(stateResult.content[0].type === 'text' ? stateResult.content[0].text : '', /顾蝉的文书缺角/)
})

test('publish_turn only terminates after deterministic resolution succeeds', async () => {
  const runtime = createDirectorTools({
    context: makeContext(),
    session: { appendCustomEntry: async () => 'entry-1' } as unknown as Session,
    initialBoard: { ...EMPTY_DIRECTOR_BOARD },
    send: () => undefined,
  })
  const resolveAction = findTool(runtime.tools, 'resolve_action')
  const publishTurn = findTool(runtime.tools, 'publish_turn')

  const rejected = await resolveAction.execute('resolve-1', validResolution({
    permitChanges: [
      { permitId: 'gatekeeper', holderId: 'yan-qi', kind: 'initial_assignment' },
      { permitId: 'scribe', holderId: 'yan-qi', kind: 'initial_assignment' },
    ],
  }))
  assert.equal((rejected.details as { accepted: boolean }).accepted, false)
  const prematurePublish = await publishTurn.execute('publish-1', {})
  assert.equal((prematurePublish.details as { published: boolean }).published, false)
  assert.equal(prematurePublish.terminate, undefined)

  const accepted = await resolveAction.execute('resolve-2', validResolution())
  assert.equal((accepted.details as { accepted: boolean }).accepted, true)
  const published = await publishTurn.execute('publish-2', {})
  assert.equal((published.details as { published: boolean }).published, true)
  assert.equal(published.terminate, true)
  assert.equal(runtime.isPublished(), true)
})

import { type AgentTool, type Session } from '@earendil-works/pi-agent-core/node'
import { Type } from 'typebox'
import { applyDirectorResolution } from '../src/engine/gameRules.ts'
import { unregisteredCity } from '../src/stories/unregisteredCity.ts'
import type { DirectorBoard, DirectorStreamEvent } from '../src/types/director.ts'
import type { DirectorResolutionInput, DirectorTurnContext } from '../src/types/game.ts'

const EMPTY_INPUT = Type.Object({})

export const resolutionSchema = Type.Object({
  outcome: Type.Union([
    Type.Literal('impossible'),
    Type.Literal('failed'),
    Type.Literal('costly_success'),
    Type.Literal('success'),
    Type.Literal('major_success'),
  ]),
  narrative: Type.String({ minLength: 20, maxLength: 500 }),
  reason: Type.String({ minLength: 10, maxLength: 300 }),
  statChanges: Type.Optional(Type.Object({
    innOrder: Type.Optional(Type.Number()),
    officialSuspicion: Type.Optional(Type.Number()),
    guestTrust: Type.Optional(Type.Number()),
  })),
  permitChanges: Type.Optional(Type.Array(Type.Object({
    permitId: Type.Union([
      Type.Literal('gatekeeper'),
      Type.Literal('lamplighter'),
      Type.Literal('scribe'),
    ]),
    holderId: Type.Union([
      Type.Literal('yan-qi'),
      Type.Literal('su-buniang'),
      Type.Literal('a-zhu'),
      Type.Literal('gu-chan'),
    ]),
    kind: Type.Union([
      Type.Literal('initial_assignment'),
      Type.Literal('voluntary_transfer'),
    ]),
    voluntary: Type.Optional(Type.Boolean()),
    accepted: Type.Optional(Type.Boolean()),
    witnessed: Type.Optional(Type.Boolean()),
  }))),
  nextOptions: Type.Tuple([
    Type.String({ minLength: 4, maxLength: 100 }),
    Type.String({ minLength: 4, maxLength: 100 }),
  ]),
  sceneDirection: Type.String({ minLength: 20, maxLength: 700 }),
})

const historySchema = Type.Object({
  lastTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
})

const boardSchema = Type.Object({
  dramaticGoal: Type.Optional(Type.String({ maxLength: 300 })),
  nextBeat: Type.Optional(Type.String({ maxLength: 300 })),
  foreshadowing: Type.Optional(Type.Array(Type.String({ maxLength: 200 }))),
  revealedSecrets: Type.Optional(Type.Array(Type.String({ maxLength: 200 }))),
  characterIntentions: Type.Optional(Type.Array(Type.Object({
    characterId: Type.String(),
    intention: Type.String({ maxLength: 300 }),
  }))),
})

const unique = (values: string[]) => [...new Set(values)]

export const EMPTY_DIRECTOR_BOARD: DirectorBoard = {
  foreshadowing: [],
  revealedSecrets: [],
  characterIntentions: {},
}

type DirectorToolRuntimeOptions = {
  context: DirectorTurnContext
  session: Session
  initialBoard: DirectorBoard
  send: (event: DirectorStreamEvent) => void
}

export const createDirectorTools = ({
  context,
  session,
  initialBoard,
  send,
}: DirectorToolRuntimeOptions) => {
  let board = initialBoard
  let acceptedResolution: DirectorResolutionInput | undefined
  let published = false

  const readGameState: AgentTool<typeof EMPTY_INPUT, unknown> = {
    name: 'read_game_state',
    label: '读取权威游戏状态',
    description: '读取当前回合、场景、玩家行动、宿籍、数值和公开事件。不会修改世界。',
    parameters: EMPTY_INPUT,
    executionMode: 'sequential',
    execute: async () => {
      const state = {
        game: context.session,
        directorBoard: board,
      }
      send({ type: 'tool', name: 'read_game_state', text: '导演正在核对当前世界状态。' })
      return {
        content: [{ type: 'text', text: JSON.stringify(state) }],
        details: state,
      }
    },
  }

  const readTurnHistory: AgentTool<typeof historySchema, unknown> = {
    name: 'read_turn_history',
    label: '读取近期回合历史',
    description: '按需读取近期已发布场景和事件，用于检查人物、伏笔和因果连续性。',
    parameters: historySchema,
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const lastTurns = params.lastTurns ?? 3
      const firstTurn = Math.max(0, context.session.turn - lastTurns)
      const history = {
        scenes: context.session.sceneHistory.filter((scene) => scene.turn >= firstTurn),
        events: context.session.events.filter((event) => event.turn >= firstTurn),
      }
      send({ type: 'tool', name: 'read_turn_history', text: '导演正在回看近期场次。' })
      return {
        content: [{ type: 'text', text: JSON.stringify(history) }],
        details: history,
      }
    },
  }

  const updateDirectorBoard: AgentTool<typeof boardSchema, DirectorBoard> = {
    name: 'update_director_board',
    label: '更新导演台账',
    description: '保存长期戏剧目标、下一节拍、伏笔、秘密揭示和人物当前意图。可按需多次调用。',
    parameters: boardSchema,
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      board = {
        ...board,
        ...(params.dramaticGoal !== undefined ? { dramaticGoal: params.dramaticGoal } : {}),
        ...(params.nextBeat !== undefined ? { nextBeat: params.nextBeat } : {}),
        foreshadowing: unique([...board.foreshadowing, ...(params.foreshadowing ?? [])]),
        revealedSecrets: unique([...board.revealedSecrets, ...(params.revealedSecrets ?? [])]),
        characterIntentions: {
          ...board.characterIntentions,
          ...Object.fromEntries((params.characterIntentions ?? []).map((item) => [item.characterId, item.intention])),
        },
      }
      await session.appendCustomEntry('director_board', board)
      send({ type: 'tool', name: 'update_director_board', text: '导演更新了长期戏剧规划。' })
      return {
        content: [{ type: 'text', text: '导演台账已持久化。' }],
        details: board,
      }
    },
  }

  const resolveAction: AgentTool<typeof resolutionSchema, unknown> = {
    name: 'resolve_action',
    label: '校验玩家行动裁决',
    description: '向确定性规则引擎提交裁决。若被拒绝，阅读 errors 后修正参数并再次调用。',
    parameters: resolutionSchema,
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const decision = applyDirectorResolution(context.session, unregisteredCity, params)
      if (!decision.ok) {
        const details = { accepted: false, errors: decision.errors }
        send({ type: 'tool', name: 'resolve_action', text: '规则引擎拒绝了裁决，导演正在修正。' })
        return {
          content: [{ type: 'text', text: JSON.stringify(details) }],
          details,
        }
      }
      acceptedResolution = params
      const details = {
        accepted: true,
        appliedStats: decision.appliedStats,
        permits: decision.permits,
        ending: decision.ending,
      }
      send({ type: 'tool', name: 'resolve_action', text: '确定性规则校验通过。' })
      return {
        content: [{ type: 'text', text: JSON.stringify(details) }],
        details,
      }
    },
  }

  const publishTurn: AgentTool<typeof EMPTY_INPUT, unknown> = {
    name: 'publish_turn',
    label: '发布下一幕文字',
    description: '发布已经通过规则校验的裁决。只有此工具成功才完成本回合。',
    parameters: EMPTY_INPUT,
    executionMode: 'sequential',
    execute: async () => {
      if (!acceptedResolution) {
        const details = { published: false, error: '尚无通过规则校验的裁决。' }
        return {
          content: [{ type: 'text', text: JSON.stringify(details) }],
          details,
        }
      }
      published = true
      send({ type: 'resolution', resolution: acceptedResolution })
      send({ type: 'tool', name: 'publish_turn', text: '导演已发布下一幕文字裁决。' })
      return {
        content: [{ type: 'text', text: '下一幕已发布，本回合完成。' }],
        details: { published: true },
        terminate: true,
      }
    },
  }

  return {
    tools: [readGameState, readTurnHistory, updateDirectorBoard, resolveAction, publishTurn],
    getBoard: () => board,
    getResolution: () => acceptedResolution,
    isPublished: () => published,
  }
}

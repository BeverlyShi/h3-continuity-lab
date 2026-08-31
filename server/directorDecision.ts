import type { Session } from '@earendil-works/pi-agent-core/node'
import { Type } from 'typebox'
import { Check, Errors } from 'typebox/value'
import { applyDirectorResolution } from '../src/engine/gameRules.ts'
import { unregisteredCity } from '../src/stories/unregisteredCity.ts'
import type { DirectorBoard } from '../src/types/director.ts'
import type { DirectorResolutionInput, DirectorTurnContext } from '../src/types/game.ts'

const boardPatchSchema = Type.Object({
  dramaticGoal: Type.Optional(Type.String({ maxLength: 300 })),
  nextBeat: Type.Optional(Type.String({ maxLength: 300 })),
  foreshadowing: Type.Optional(Type.Array(Type.String({ maxLength: 200 }))),
  revealedSecrets: Type.Optional(Type.Array(Type.String({ maxLength: 200 }))),
  characterIntentions: Type.Optional(Type.Array(Type.Object({
    characterId: Type.String(),
    intention: Type.String({ maxLength: 300 }),
  }, { additionalProperties: false }))),
}, { additionalProperties: false })

export const directorDecisionSchema = Type.Object({
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
  }, { additionalProperties: false })),
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
  }, { additionalProperties: false }))),
  nextOptions: Type.Tuple([
    Type.String({ minLength: 4, maxLength: 100 }),
    Type.String({ minLength: 4, maxLength: 100 }),
  ]),
  sceneDirection: Type.String({ minLength: 20, maxLength: 700 }),
  directorBoardPatch: Type.Optional(boardPatchSchema),
}, { additionalProperties: false })

export const DIRECTOR_DECISION_JSON_SCHEMA = JSON.stringify(directorDecisionSchema)

export type DirectorBoardPatch = {
  dramaticGoal?: string
  nextBeat?: string
  foreshadowing?: string[]
  revealedSecrets?: string[]
  characterIntentions?: Array<{ characterId: string; intention: string }>
}

export type DirectorDecision = DirectorResolutionInput & {
  directorBoardPatch?: DirectorBoardPatch
}

export const EMPTY_DIRECTOR_BOARD: DirectorBoard = {
  foreshadowing: [],
  revealedSecrets: [],
  characterIntentions: {},
}

const unique = (values: string[]) => [...new Set(values)]

const stripJsonFence = (text: string) => {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced?.[1] ?? trimmed
}

export const parseDirectorDecision = (text: string):
  | { ok: true; value: DirectorDecision }
  | { ok: false; errors: string[] } => {
  let value: unknown
  try {
    value = JSON.parse(stripJsonFence(text))
  } catch {
    return { ok: false, errors: ['输出不是有效的 JSON 对象。'] }
  }

  if (!Check(directorDecisionSchema, value)) {
    return {
      ok: false,
      errors: Errors(directorDecisionSchema, value).map((error) =>
        `${error.instancePath || '/'}：${error.message}`,
      ),
    }
  }
  return { ok: true, value: value as DirectorDecision }
}

export const buildDirectorTurnPrompt = (
  context: DirectorTurnContext,
  directorBoard: DirectorBoard,
) => {
  const { session } = context
  const turnContext = {
    turn: session.turn,
    playerAction: session.pendingAction
      ? { text: session.pendingAction.text, source: session.pendingAction.source }
      : null,
    currentScene: session.currentScene
      ? { title: session.currentScene.title, narrative: session.currentScene.narrative }
      : null,
    stats: session.stats,
    permits: session.permits.map(({ id, label, holderId, transferred }) => ({
      id,
      label,
      ...(holderId === undefined ? {} : { holderId }),
      transferred,
    })),
    directorBoard,
  }

  return `<turn_context>\n${JSON.stringify(turnContext)}\n</turn_context>\n` +
    '请以总导演身份裁决本回合。只输出符合 System Prompt 契约的 JSON 对象。'
}

export const validateDirectorDecision = (
  text: string,
  context: DirectorTurnContext,
):
  | { ok: true; resolution: DirectorResolutionInput; boardPatch?: DirectorBoardPatch }
  | { ok: false; errors: string[] } => {
  const parsed = parseDirectorDecision(text)
  if (!parsed.ok) return parsed

  const { directorBoardPatch, ...resolution } = parsed.value
  const decision = applyDirectorResolution(context.session, unregisteredCity, resolution)
  if (!decision.ok) return decision
  return {
    ok: true,
    resolution,
    ...(directorBoardPatch === undefined ? {} : { boardPatch: directorBoardPatch }),
  }
}

export const persistDirectorBoardPatch = async (
  session: Session,
  current: DirectorBoard,
  patch?: DirectorBoardPatch,
) => {
  if (!patch) return current

  const next: DirectorBoard = {
    ...current,
    ...(patch.dramaticGoal !== undefined ? { dramaticGoal: patch.dramaticGoal } : {}),
    ...(patch.nextBeat !== undefined ? { nextBeat: patch.nextBeat } : {}),
    foreshadowing: unique([...current.foreshadowing, ...(patch.foreshadowing ?? [])]),
    revealedSecrets: unique([...current.revealedSecrets, ...(patch.revealedSecrets ?? [])]),
    characterIntentions: {
      ...current.characterIntentions,
      ...Object.fromEntries((patch.characterIntentions ?? []).map((item) => [item.characterId, item.intention])),
    },
  }
  await session.appendCustomEntry('director_board', next)
  return next
}

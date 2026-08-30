import type { DirectorResolutionInput } from '../types/game'

export type GameDirectorController = {
  getTurnContext: () => unknown
  commitResolution: (input: DirectorResolutionInput) => unknown
  requestVideo: () => Promise<unknown>
  getGenerationStatus: () => unknown
  publishTurn: () => unknown
}

let activeController: GameDirectorController | undefined
let registration: Promise<boolean> | undefined

export const setGameDirectorController = (controller: GameDirectorController) => {
  activeController = controller
}

const getController = () => {
  if (!activeController) throw new Error('游戏导演控制器尚未就绪。')
  return activeController
}

const EMPTY_INPUT = { type: 'object', properties: {}, additionalProperties: false }

const RESOLUTION_INPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'narrative', 'reason', 'nextOptions', 'sceneDirection'],
  properties: {
    outcome: {
      type: 'string',
      enum: ['impossible', 'failed', 'costly_success', 'success', 'major_success'],
    },
    narrative: { type: 'string', minLength: 1, maxLength: 800 },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
    statChanges: {
      type: 'object',
      additionalProperties: false,
      properties: {
        innOrder: { type: 'number' },
        officialSuspicion: { type: 'number' },
        guestTrust: { type: 'number' },
      },
    },
    permitChanges: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['permitId', 'holderId', 'kind'],
        properties: {
          permitId: { type: 'string', enum: ['gatekeeper', 'lamplighter', 'scribe'] },
          holderId: { type: 'string', enum: ['yan-qi', 'su-buniang', 'a-zhu', 'gu-chan'] },
          kind: { type: 'string', enum: ['initial_assignment', 'voluntary_transfer'] },
          voluntary: { type: 'boolean' },
          accepted: { type: 'boolean' },
          witnessed: { type: 'boolean' },
        },
      },
    },
    nextOptions: {
      type: 'array', minItems: 2, maxItems: 2, items: { type: 'string', minLength: 1, maxLength: 160 },
    },
    sceneDirection: { type: 'string', minLength: 1, maxLength: 800 },
  },
}

const registerTools = async () => {
  const modelContext = document.modelContext
  if (typeof modelContext?.registerTool !== 'function') return false

  const tools: WebMcpTool[] = [
    {
      name: 'get_turn_context',
      description: 'Read the immutable story rules, characters, current game state and pending player action before directing a turn.',
      inputSchema: EMPTY_INPUT,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      execute: async () => getController().getTurnContext(),
    },
    {
      name: 'commit_resolution',
      description: 'Submit one director resolution. Deterministic rules validate stat and lodging-permit changes before accepting it.',
      inputSchema: RESOLUTION_INPUT,
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      execute: async (input) => getController().commitResolution(input as DirectorResolutionInput),
    },
    {
      name: 'request_video',
      description: 'Generate the accepted next scene with the player-provided fal H3 API key. Call only after commit_resolution succeeds.',
      inputSchema: EMPTY_INPUT,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
      execute: async () => getController().requestVideo(),
    },
    {
      name: 'get_generation_status',
      description: 'Read the current H3 generation and publication status without changing the game.',
      inputSchema: EMPTY_INPUT,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      execute: async () => getController().getGenerationStatus(),
    },
    {
      name: 'publish_turn',
      description: 'Publish a generated scene to the player. Call only when get_generation_status reports ready_to_publish.',
      inputSchema: EMPTY_INPUT,
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      execute: async () => getController().publishTurn(),
    },
  ]

  await Promise.all(tools.map((tool) => modelContext.registerTool(tool)))
  return true
}

export const registerGameDirectorTools = () => {
  registration ??= registerTools()
  return registration
}

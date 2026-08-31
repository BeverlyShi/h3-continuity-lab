export type PermitRole = 'gatekeeper' | 'lamplighter' | 'scribe'

export type GameStats = {
  innOrder: number
  officialSuspicion: number
  guestTrust: number
}

export type CharacterProfile = {
  id: string
  name: string
  publicIdentity: string
  visibleTraits: string[]
  directorSecret: string
  fit: Record<PermitRole, 'high' | 'medium' | 'conflict'>
}

export type StoryPackage = {
  id: string
  title: string
  summary: string
  coreRules: string[]
  visualBible: string
  openingTitle: string
  openingNarrative: string
  openingPrompt: string
  initialOptions: [string, string]
  initialStats: GameStats
  maxTurns: number
  characters: CharacterProfile[]
}

export type LodgingPermit = {
  id: PermitRole
  label: string
  holderId?: string
  transferred: boolean
}

export type GameEnding = {
  kind: 'safe' | 'costly' | 'failed'
  title: string
  summary: string
}

export type GameScene = {
  id: string
  turn: number
  title: string
  narrative: string
  prompt: string
  videoUrl: string
  options: [string, string]
  ending?: GameEnding
}

export type PlayerAction = {
  text: string
  source: 'suggested' | 'freeform'
  submittedAt: number
}

export type StatChanges = Partial<Record<keyof GameStats, number>>

export type PermitChange = {
  permitId: PermitRole
  holderId: string
  kind: 'initial_assignment' | 'voluntary_transfer'
  voluntary?: boolean
  accepted?: boolean
  witnessed?: boolean
}

export type DirectorResolutionInput = {
  outcome: 'impossible' | 'failed' | 'costly_success' | 'success' | 'major_success'
  narrative: string
  reason: string
  statChanges?: StatChanges
  permitChanges?: PermitChange[]
  nextOptions: [string, string]
  sceneDirection: string
}

export type ResolvedTurn = {
  id: string
  input: DirectorResolutionInput
  appliedStats: StatChanges
  appliedPermits: LodgingPermit[]
  compiledPrompt: string
  ending?: GameEnding
  videoUrl?: string
  videoError?: string
}

export type GameEvent = {
  id: string
  turn: number
  type: 'player_action' | 'resolution' | 'scene_published'
  text: string
  createdAt: number
}

export type GameSessionStatus =
  | 'generating_opening'
  | 'playing'
  | 'awaiting_action'
  | 'awaiting_director'
  | 'resolved'
  | 'generating_video'
  | 'ready_to_publish'
  | 'failed'
  | 'ended'

export type GameSession = {
  schemaVersion: 2
  id: string
  storyId: string
  status: GameSessionStatus
  turn: number
  createdAt: number
  updatedAt: number
  stats: GameStats
  permits: LodgingPermit[]
  currentScene?: GameScene
  sceneHistory: GameScene[]
  pendingAction?: PlayerAction
  pendingResolution?: ResolvedTurn
  events: GameEvent[]
  failureStep?: 'opening' | 'next_scene'
  error?: string
}

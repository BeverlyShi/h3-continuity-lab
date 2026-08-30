import type {
  DirectorResolutionInput,
  GameEnding,
  GameSession,
  GameStats,
  LodgingPermit,
  PermitChange,
  StatChanges,
  StoryPackage,
} from '../types/game'

const STAT_KEYS: (keyof GameStats)[] = ['innOrder', 'officialSuspicion', 'guestTrust']
const MAX_DELTA = 12
const OUTCOMES = ['impossible', 'failed', 'costly_success', 'success', 'major_success']

export const INITIAL_PERMITS: LodgingPermit[] = [
  { id: 'gatekeeper', label: '守门籍', transferred: false },
  { id: 'lamplighter', label: '掌灯籍', transferred: false },
  { id: 'scribe', label: '司簿籍', transferred: false },
]

export type ResolutionDecision =
  | {
      ok: true
      stats: GameStats
      permits: LodgingPermit[]
      appliedStats: StatChanges
      ending?: GameEnding
    }
  | { ok: false; errors: string[] }

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value))

const applyPermitChanges = (
  session: GameSession,
  story: StoryPackage,
  changes: PermitChange[],
) => {
  const permits = session.permits.map((permit) => ({ ...permit }))
  const errors: string[] = []

  if (new Set(changes.map((change) => change.permitId)).size !== changes.length) {
    return { permits, errors: ['同一份宿籍不能在一个回合内变更两次。'] }
  }

  changes.forEach((change) => {
    const permit = permits.find((item) => item.id === change.permitId)
    const character = story.characters.find((item) => item.id === change.holderId)
    if (!permit) {
      errors.push(`未知宿籍：${change.permitId}`)
      return
    }
    if (!character) {
      errors.push(`未知角色：${change.holderId}`)
      return
    }

    if (change.kind === 'initial_assignment') {
      if (session.turn > 2) errors.push('日落后老板不能重新分配宿籍。')
      else permit.holderId = change.holderId
      return
    }

    if (session.turn < 3) {
      errors.push('宿籍流转只能在日落锁定后发生。')
    } else if (!permit.holderId) {
      errors.push(`${permit.label}尚无持有人，不能流转。`)
    } else if (permit.transferred) {
      errors.push(`${permit.label}本夜已经流转过一次。`)
    } else if (permit.holderId === change.holderId) {
      errors.push(`${permit.label}的新持有人必须与原持有人不同。`)
    } else if (!change.voluntary || !change.accepted || !change.witnessed) {
      errors.push(`${permit.label}流转缺少自愿、接受或第三方见证。`)
    } else {
      permit.holderId = change.holderId
      permit.transferred = true
    }
  })

  const holders = permits.flatMap((permit) => permit.holderId ? [permit.holderId] : [])
  if (new Set(holders).size !== holders.length) errors.push('同一个人不能同时持有两张宿籍。')
  return { permits, errors }
}

const getFitChanges = (
  before: LodgingPermit[],
  after: LodgingPermit[],
  story: StoryPackage,
): StatChanges => {
  let innOrder = 0
  let officialSuspicion = 0
  let guestTrust = 0
  after.forEach((permit) => {
    const previous = before.find((item) => item.id === permit.id)
    if (!permit.holderId || previous?.holderId === permit.holderId) return
    const fit = story.characters.find((item) => item.id === permit.holderId)?.fit[permit.id]
    if (fit === 'high') guestTrust += 2
    if (fit === 'conflict') {
      innOrder -= 6
      officialSuspicion += 4
    }
  })
  return { innOrder, officialSuspicion, guestTrust }
}

export const evaluateNightEnding = (
  stats: GameStats,
  permits: LodgingPermit[],
  story: StoryPackage,
): GameEnding => {
  const assigned = permits.filter((permit) => permit.holderId).length
  const conflicts = permits.filter((permit) => {
    const character = story.characters.find((item) => item.id === permit.holderId)
    return character?.fit[permit.id] === 'conflict'
  }).length

  if (assigned === 3 && conflicts === 0 && stats.innOrder >= 35 && stats.officialSuspicion < 70) {
    return { kind: 'safe', title: '三灯未灭', summary: '三份宿籍都撑到了天明，驿站守住了第一夜。' }
  }
  if (assigned >= 2 && stats.innOrder > 0 && stats.officialSuspicion < 100) {
    return { kind: 'costly', title: '有代价的黎明', summary: '驿站仍在，但错误的名籍与未被救下的人留下了无法抹去的代价。' }
  }
  return { kind: 'failed', title: '散名之夜', summary: '宿名簿没能保护足够的人，驿站也失去了继续收留无籍者的能力。' }
}

export const applyDirectorResolution = (
  session: GameSession,
  story: StoryPackage,
  input: DirectorResolutionInput,
): ResolutionDecision => {
  if (session.status !== 'awaiting_director' || !session.pendingAction) {
    return { ok: false, errors: ['当前没有等待裁决的玩家行动。'] }
  }
  if (!input || typeof input !== 'object' || !OUTCOMES.includes(input.outcome)) {
    return { ok: false, errors: ['裁决结果类型无效。'] }
  }
  if (
    typeof input.narrative !== 'string'
    || typeof input.reason !== 'string'
    || typeof input.sceneDirection !== 'string'
    || !input.narrative.trim()
    || !input.reason.trim()
    || !input.sceneDirection.trim()
  ) {
    return { ok: false, errors: ['裁决必须包含叙事结果、理由和下一镜头方向。'] }
  }
  if (
    !Array.isArray(input.nextOptions)
    || input.nextOptions.length !== 2
    || input.nextOptions.some((option) => typeof option !== 'string' || !option.trim())
  ) {
    return { ok: false, errors: ['必须提供两个非空的下一回合建议选项。'] }
  }
  if (input.permitChanges && !Array.isArray(input.permitChanges)) {
    return { ok: false, errors: ['宿籍变更必须是数组。'] }
  }

  const permitResult = applyPermitChanges(session, story, input.permitChanges ?? [])
  if (permitResult.errors.length) return { ok: false, errors: permitResult.errors }

  const fitChanges = getFitChanges(session.permits, permitResult.permits, story)
  const appliedStats: StatChanges = {}
  const stats = { ...session.stats }
  STAT_KEYS.forEach((key) => {
    const requested = Number(input.statChanges?.[key] ?? 0)
    const automatic = Number(fitChanges[key] ?? 0)
    const safeRequested = Number.isFinite(requested) ? requested : 0
    const delta = clamp(safeRequested + automatic, -MAX_DELTA, MAX_DELTA)
    appliedStats[key] = delta
    stats[key] = clamp(stats[key] + delta, 0, 100)
  })

  const ending = session.turn >= story.maxTurns
    ? evaluateNightEnding(stats, permitResult.permits, story)
    : undefined
  return { ok: true, stats, permits: permitResult.permits, appliedStats, ending }
}

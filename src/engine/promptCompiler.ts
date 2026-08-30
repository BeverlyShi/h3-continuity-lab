import type {
  DirectorResolutionInput,
  GameEnding,
  GameSession,
  LodgingPermit,
  StoryPackage,
} from '../types/game'

const describePermits = (permits: LodgingPermit[], story: StoryPackage) =>
  permits.map((permit) => {
    const holder = story.characters.find((character) => character.id === permit.holderId)
    return `${permit.label}: ${holder?.name ?? 'unassigned'}`
  }).join('; ')

export const compileScenePrompt = (
  story: StoryPackage,
  session: GameSession,
  input: DirectorResolutionInput,
  permits: LodgingPermit[],
  ending?: GameEnding,
) => [
  story.visualBible,
  `Create the next coherent 5-second shot for turn ${session.turn}.`,
  `Previous visible event: ${session.currentScene?.narrative ?? story.openingNarrative}`,
  `Player action: ${session.pendingAction?.text ?? 'none'}`,
  `Confirmed outcome: ${input.narrative}`,
  `Visible scene direction: ${input.sceneDirection}`,
  `Current lodging permits: ${describePermits(permits, story)}.`,
  ending ? `This is the ending shot: ${ending.title}. ${ending.summary}` : '',
  'Show only confirmed visible actions. Do not introduce new characters, decisions, objects, subtitles or text overlays.',
].filter(Boolean).join(' ')

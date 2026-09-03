import type {
  SceneCharacter,
  TailFrameVisualState,
  VideoGenerationRequest,
  VideoPromptSegment,
} from '../src/types/story.ts'

const renderVisualState = (state: TailFrameVisualState) => {
  const characters = state.shot_content.characters.length
    ? state.shot_content.characters.map((character) => {
        const holding = character.holding ? `，手持${character.holding}` : ''
        const notes = character.appearance_notes ? `，外观变化：${character.appearance_notes}` : ''
        return `${character.id}位于${character.position_in_frame}，${character.facing}，${character.pose}，表情${character.expression}${holding}${notes}`
      }).join('；')
    : '画面中没有主要人物'
  const scene = state.shot_content.scene
  return `${state.shot_size}，机位${state.shot_position}。${characters}。场景为${scene.location}，可见${scene.visible_elements}，${scene.lighting}，${scene.time_of_day}`
}

const ensureSilentScore = (audio: string) => {
  const clean = audio.trim().replace(/[；。]+$/, '')
  return `${clean}；无音乐，无旁白。`
}

const renderCharacters = (
  segment: VideoPromptSegment,
  characters: SceneCharacter[],
  matchedCharacterIds?: ReadonlySet<string>,
) => {
  const byId = new Map(characters.map((character) => [character.id, character]))
  return segment.characterIds.map((id) => {
    const character = byId.get(id)
    if (!character) return ''
    return matchedCharacterIds === undefined || matchedCharacterIds.has(id)
      ? `【人物${character.name}】角色ID ${character.id}，面部身份和完整外观严格保持人物参考图一致。`
      : `【人物${character.name}】角色ID ${character.id}，本段没有人物参考图，依据本段文字中的年龄感、发型、服装和辨识特征建立并保持外观一致。`
  }).filter(Boolean).join('\n')
}

export const compileVideoPrompt = (
  segment: VideoPromptSegment,
  request: VideoGenerationRequest,
  characters: SceneCharacter[],
  openingState?: TailFrameVisualState | string,
  matchedCharacterIds?: ReadonlySet<string>,
) => [
  `【风格】${request.visualContext.style}`,
  `【场景】${request.visualContext.scene}`,
  `【布局】${request.visualContext.layout}`,
  renderCharacters(segment, characters, matchedCharacterIds),
  `【开场状态】${typeof openingState === 'string'
    ? openingState
    : openingState
      ? renderVisualState(openingState)
      : '本幕首段没有上一幕实测尾帧，依据可用人物参考图、人物外观文字和场景文字建立画面。'}`,
  `【${segment.startTime}–${segment.endTime}秒】${segment.prompt}`,
  `【结尾状态】${segment.endFrame}`,
  `【音频】${ensureSilentScore(segment.audio)}`,
].filter(Boolean).join('\n\n')

export const compileVideoPlan = (
  request: VideoGenerationRequest,
  characters: SceneCharacter[],
  previousVisualState?: TailFrameVisualState,
  matchedCharacterIds?: ReadonlySet<string>,
): VideoGenerationRequest => {
  let openingState: TailFrameVisualState | string | undefined = previousVisualState
  const videoPrompts = request.videoPrompts.map((segment) => {
    const prompt = compileVideoPrompt(segment, request, characters, openingState, matchedCharacterIds)
    openingState = segment.endFrame
    return { ...segment, prompt }
  })
  return { ...request, videoPrompts }
}

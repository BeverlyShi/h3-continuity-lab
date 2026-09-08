import { Type, type Static } from 'typebox'

export const storyChoiceSchema = Type.Object({
  id: Type.Union([Type.Literal('1'), Type.Literal('2'), Type.Literal('3')]),
  text: Type.String({ minLength: 2, maxLength: 30 }),
}, { additionalProperties: false })

export const sceneCharacterSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 50 }),
  name: Type.String({ minLength: 1, maxLength: 30 }),
  gender: Type.Union([Type.Literal('female'), Type.Literal('male')]),
  minAge: Type.Integer({ minimum: 0, maximum: 100 }),
  maxAge: Type.Integer({ minimum: 0, maximum: 100 }),
}, { additionalProperties: false })

export const tailFrameVisualStateSchema = Type.Object({
  shot_size: Type.Union([
    Type.Literal('远景'),
    Type.Literal('全景'),
    Type.Literal('中景'),
    Type.Literal('中近景'),
    Type.Literal('近景'),
    Type.Literal('特写'),
  ]),
  shot_position: Type.String({ minLength: 1, maxLength: 120 }),
  shot_content: Type.Object({
    characters: Type.Array(Type.Object({
      id: Type.String({ minLength: 1, maxLength: 50 }),
      facing: Type.String({ minLength: 1, maxLength: 120 }),
      position_in_frame: Type.String({ minLength: 1, maxLength: 80 }),
      pose: Type.String({ minLength: 1, maxLength: 160 }),
      expression: Type.String({ minLength: 1, maxLength: 100 }),
      holding: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
      appearance_notes: Type.Union([Type.String({ minLength: 1, maxLength: 160 }), Type.Null()]),
    }, { additionalProperties: false }), { maxItems: 8 }),
    scene: Type.Object({
      location: Type.String({ minLength: 1, maxLength: 120 }),
      visible_elements: Type.String({ minLength: 1, maxLength: 300 }),
      lighting: Type.String({ minLength: 1, maxLength: 120 }),
      time_of_day: Type.String({ minLength: 1, maxLength: 80 }),
    }, { additionalProperties: false }),
    key_props: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 12 }),
  }, { additionalProperties: false }),
  frame_quality: Type.Union([
    Type.Literal('清晰稳定'),
    Type.Literal('轻微模糊'),
    Type.Literal('不可用'),
  ]),
}, { additionalProperties: false })

export const videoPromptSegmentSchema = Type.Object({
  sequence: Type.Integer({ minimum: 1, maximum: 3 }),
  startTime: Type.Integer({ minimum: 0, maximum: 40 }),
  endTime: Type.Integer({ minimum: 5, maximum: 45 }),
  characterIds: Type.Array(Type.String({ minLength: 1, maxLength: 50 }), {
    maxItems: 6,
    uniqueItems: true,
  }),
  prompt: Type.String({ minLength: 20, maxLength: 2400 }),
}, { additionalProperties: false })

export const videoGenerationRequestSchema = Type.Object({
  totalDuration: Type.Integer({ minimum: 15, maximum: 45 }),
  style: Type.String({ minLength: 10, maxLength: 400 }),
  videoPrompts: Type.Array(videoPromptSegmentSchema, { minItems: 2, maxItems: 3 }),
}, { additionalProperties: false })

export const sceneDialogueSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 50 }),
  characterId: Type.String({ minLength: 1, maxLength: 50 }),
  text: Type.String({ minLength: 1, maxLength: 120, description: 'narrative 中该句人物对白的完整原文，包含标点，不包含外层引号，不得删改。' }),
}, { additionalProperties: false })

export const videoPlanSegmentSchema = Type.Object({
  characters: Type.Array(Type.String({ minLength: 1, maxLength: 50 }), {
    maxItems: 6,
    uniqueItems: true,
    description: '本段实际入画或说话的人物 ID，首段按此顺序附参考图。',
  }),
  seconds: Type.Integer({ minimum: 5, maximum: 15, description: '本段时长秒数，5–15 的整数；不得低于本段台词字数 ÷ 3.5 再加 1 秒。' }),
  prompt: Type.String({ minLength: 20, maxLength: 2000, description: '本段分镜正文，由若干时间块组成，每块以“0–4秒：”开头，从 0 秒开始首尾相接，最后一块结束于 seconds。在实际说话位置写 {{line_1}} 形式的台词占位符，不抄写台词正文，不写内部人物 ID。' }),
}, { additionalProperties: false })

export const videoPlanSchema = Type.Object({
  style: Type.String({ minLength: 10, maxLength: 400, description: '整幕统一的画面质感、色调和光源，一句话。' }),
  segments: Type.Array(videoPlanSegmentSchema, { minItems: 2, maxItems: 3 }),
}, { additionalProperties: false })

export const storySceneSchema = Type.Object({
  title: Type.String({ minLength: 2, maxLength: 40 }),
  narrative: Type.String({ pattern: '\\S', description: '本幕完整正文。实际对白用成对双引号呈现原文，与顶层 dialogues 的 text 逐句一致；不能只概述交谈而把原文仅写进 dialogues。' }),
  choices: Type.Array(storyChoiceSchema, { minItems: 3, maxItems: 3 }),
}, { additionalProperties: false })

export const scenePublishSchema = Type.Object({
  scene: storySceneSchema,
  characters: Type.Array(sceneCharacterSchema, { minItems: 1, maxItems: 8 }),
  dialogues: Type.Array(sceneDialogueSchema, { description: '按 narrative 中人物对白出现顺序逐句列出；每组双引号对应一项，无对白时提交空数组。' }),
}, { additionalProperties: false })

export const storyInputSchema = Type.Union([
  Type.Object({ type: Type.Literal('start') }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('choice'),
    choice: storyChoiceSchema,
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('freeform'),
    text: Type.String({ minLength: 1, maxLength: 500 }),
  }, { additionalProperties: false }),
])

export type StoryChoice = Static<typeof storyChoiceSchema>
export type SceneCharacter = Static<typeof sceneCharacterSchema>
export type TailFrameVisualState = Static<typeof tailFrameVisualStateSchema>
export type VideoPromptSegment = Static<typeof videoPromptSegmentSchema>
export type VideoGenerationRequest = Static<typeof videoGenerationRequestSchema>
export type SceneDialogue = Static<typeof sceneDialogueSchema>
export type VideoPlanSegment = Static<typeof videoPlanSegmentSchema>
export type VideoPlan = Static<typeof videoPlanSchema>
export type StoryScene = Static<typeof storySceneSchema>
export type ScenePublish = Static<typeof scenePublishSchema>
export type StoryInput = Static<typeof storyInputSchema>

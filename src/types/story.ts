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

export const videoVisualContextSchema = Type.Object({
  style: Type.String({ minLength: 10, maxLength: 400 }),
  scene: Type.String({ minLength: 10, maxLength: 600 }),
  layout: Type.String({ minLength: 10, maxLength: 600 }),
}, { additionalProperties: false })

export const videoPromptSegmentSchema = Type.Object({
  sequence: Type.Integer({ minimum: 1, maximum: 3 }),
  startTime: Type.Integer({ minimum: 0, maximum: 25 }),
  endTime: Type.Integer({ minimum: 5, maximum: 30 }),
  characterIds: Type.Array(Type.String({ minLength: 1, maxLength: 50 }), {
    maxItems: 6,
    uniqueItems: true,
  }),
  prompt: Type.String({ minLength: 20, maxLength: 2400 }),
  endFrame: Type.String({ minLength: 10, maxLength: 600 }),
  audio: Type.String({ minLength: 2, maxLength: 300 }),
}, { additionalProperties: false })

export const videoGenerationRequestSchema = Type.Object({
  totalDuration: Type.Integer({ minimum: 15, maximum: 30 }),
  visualContext: videoVisualContextSchema,
  videoPrompts: Type.Array(videoPromptSegmentSchema, { minItems: 2, maxItems: 3 }),
}, { additionalProperties: false })

export const videoDialogueSchema = Type.Object({
  characterId: Type.String({ minLength: 1, maxLength: 50 }),
  text: Type.String({ minLength: 1, maxLength: 120 }),
}, { additionalProperties: false })

export const videoBeatSchema = Type.Object({
  visual: Type.String({ minLength: 10, maxLength: 800 }),
  dialogue: Type.Optional(Type.Array(videoDialogueSchema, { maxItems: 3 })),
}, { additionalProperties: false })

export const videoPromptDraftSegmentSchema = Type.Object({
  characterIds: Type.Array(Type.String({ minLength: 1, maxLength: 50 }), {
    maxItems: 6,
    uniqueItems: true,
  }),
  beats: Type.Array(videoBeatSchema, { minItems: 1, maxItems: 3 }),
  endFrame: Type.String({ minLength: 10, maxLength: 600 }),
  audio: Type.String({ minLength: 2, maxLength: 300 }),
}, { additionalProperties: false })

export const videoPromptDraftSchema = Type.Object({
  visualContext: videoVisualContextSchema,
  videoPrompts: Type.Array(videoPromptDraftSegmentSchema, { minItems: 2, maxItems: 3 }),
}, { additionalProperties: false })

export const storySceneSchema = Type.Object({
  title: Type.String({ minLength: 2, maxLength: 40 }),
  narrative: Type.String({ minLength: 150, maxLength: 250 }),
  choices: Type.Array(storyChoiceSchema, { minItems: 3, maxItems: 3 }),
}, { additionalProperties: false })

export const scenePublishSchema = Type.Object({
  scene: storySceneSchema,
  characters: Type.Array(sceneCharacterSchema, { minItems: 1, maxItems: 8 }),
}, { additionalProperties: false })

export const videoPlanSchema = videoPromptDraftSchema

export const directorTurnSchema = Type.Object({
  scene: storySceneSchema,
  characters: Type.Array(sceneCharacterSchema, { minItems: 1, maxItems: 8 }),
  video: videoGenerationRequestSchema,
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
export type VideoVisualContext = Static<typeof videoVisualContextSchema>
export type VideoPromptSegment = Static<typeof videoPromptSegmentSchema>
export type VideoGenerationRequest = Static<typeof videoGenerationRequestSchema>
export type VideoDialogue = Static<typeof videoDialogueSchema>
export type VideoBeat = Static<typeof videoBeatSchema>
export type VideoPromptDraft = Static<typeof videoPromptDraftSchema>
export type StoryScene = Static<typeof storySceneSchema>
export type ScenePublish = Static<typeof scenePublishSchema>
export type VideoPlan = Static<typeof videoPlanSchema>
export type DirectorTurn = Static<typeof directorTurnSchema>
export type StoryInput = Static<typeof storyInputSchema>

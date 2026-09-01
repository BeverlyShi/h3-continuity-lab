import { Type, type Static } from 'typebox'

export const storyChoiceSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 12 }),
  text: Type.String({ minLength: 2, maxLength: 60 }),
}, { additionalProperties: false })

export const sceneCharacterSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 50 }),
  name: Type.String({ minLength: 1, maxLength: 30 }),
  gender: Type.Union([Type.Literal('female'), Type.Literal('male')]),
  minAge: Type.Integer({ minimum: 0, maximum: 100 }),
  maxAge: Type.Integer({ minimum: 0, maximum: 100 }),
}, { additionalProperties: false })

export const videoPromptSegmentSchema = Type.Object({
  sequence: Type.Integer({ minimum: 1, maximum: 3 }),
  startTime: Type.Integer({ minimum: 0, maximum: 25 }),
  endTime: Type.Integer({ minimum: 5, maximum: 30 }),
  transitionFromPrevious: Type.Optional(Type.Union([
    Type.Literal('continuous'),
    Type.Literal('cut'),
  ])),
  characterIds: Type.Array(Type.String({ minLength: 1, maxLength: 50 }), {
    maxItems: 6,
    uniqueItems: true,
  }),
  prompt: Type.String({ minLength: 20, maxLength: 600 }),
}, { additionalProperties: false })

export const videoGenerationRequestSchema = Type.Object({
  totalDuration: Type.Integer({ minimum: 15, maximum: 30 }),
  videoPrompts: Type.Array(videoPromptSegmentSchema, { minItems: 2, maxItems: 3 }),
}, { additionalProperties: false })

export const storySceneSchema = Type.Object({
  title: Type.String({ minLength: 2, maxLength: 40 }),
  narrative: Type.String({ minLength: 20, maxLength: 600 }),
  choices: Type.Array(storyChoiceSchema, { minItems: 2, maxItems: 3 }),
}, { additionalProperties: false })

export const scenePublishSchema = Type.Object({
  scene: storySceneSchema,
  characters: Type.Array(sceneCharacterSchema, { minItems: 1, maxItems: 8 }),
}, { additionalProperties: false })

export const videoPlanSchema = Type.Object({
  video: videoGenerationRequestSchema,
}, { additionalProperties: false })

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
export type VideoPromptSegment = Static<typeof videoPromptSegmentSchema>
export type VideoGenerationRequest = Static<typeof videoGenerationRequestSchema>
export type StoryScene = Static<typeof storySceneSchema>
export type ScenePublish = Static<typeof scenePublishSchema>
export type VideoPlan = Static<typeof videoPlanSchema>
export type DirectorTurn = Static<typeof directorTurnSchema>
export type StoryInput = Static<typeof storyInputSchema>

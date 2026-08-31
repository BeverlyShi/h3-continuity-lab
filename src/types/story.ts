import { Type, type Static } from 'typebox'

export const storyChoiceSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 12 }),
  text: Type.String({ minLength: 2, maxLength: 60 }),
}, { additionalProperties: false })

export const videoGenerationRequestSchema = Type.Object({
  duration: Type.Integer({ minimum: 4, maximum: 15 }),
  prompt: Type.String({ minLength: 20, maxLength: 600 }),
}, { additionalProperties: false })

export const storySceneSchema = Type.Object({
  title: Type.String({ minLength: 2, maxLength: 40 }),
  narrative: Type.String({ minLength: 20, maxLength: 600 }),
  choices: Type.Array(storyChoiceSchema, { minItems: 2, maxItems: 3 }),
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
export type VideoGenerationRequest = Static<typeof videoGenerationRequestSchema>
export type StoryScene = Static<typeof storySceneSchema>
export type StoryInput = Static<typeof storyInputSchema>

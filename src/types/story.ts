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
  style: Type.String({ minLength: 10, maxLength: 400, description: '画面质感、色调和明确光源，不写抽象情绪。' }),
  scene: Type.String({ minLength: 10, maxLength: 600, description: '本幕已发生地点及必要环境；允许 narrative 中已有的转场，每镜明确当前小空间，不固定全幕人物布局。' }),
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

export const sceneDialogueSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 50 }),
  characterId: Type.String({ minLength: 1, maxLength: 50 }),
  text: Type.String({ minLength: 1, maxLength: 120, description: 'narrative 中该句人物对白的完整原文，包含标点，不包含外层引号，不得删改。' }),
}, { additionalProperties: false })

export const videoBeatSchema = Type.Object({
  visual: Type.String({ minLength: 10, maxLength: 800, description: '一个镜头、一个主要动作。明确构图和持物，严格按 narrative 的动作和发声顺序书写。在实际说话位置插入 {{line_1}} 形式的台词占位符，程序替换为人物姓名和完整台词；不抄写台词正文，不在说完动作后才放占位符。' }),
  dialogueIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 50 }), {
    maxItems: 3,
    description: '本镜头使用的已发布台词 ID，按原顺序排列。全幕每句台词必须且只能引用一次；程序填入原说话人与完整原文，不能自行提交台词文字。',
  })),
  actionSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 10, description: '台词之外无法同时完成的动作、停顿所需秒数，不包含说话同时发生的动作；无对白镜头为整个动作时长。未填时对白镜头留 0.5 秒，无对白留 2 秒。' })),
  endFrame: Type.Optional(Type.String({ minLength: 10, maxLength: 600, description: '本镜头最终可见的构图、姿势和持物状态；自动拆段必须有此字段，不能用整个动作过程代替最终状态。' })),
  audio: Type.String({ minLength: 2, maxLength: 300, description: '必填，位于当前 beat 内。仅本镜头的环境音和动作音，说明声音来源及发生时机；无明显声音写安静，不写音乐或旁白。' }),
}, { additionalProperties: false, description: '一个镜头，包含 visual、audio，可选 dialogueIds、actionSeconds、endFrame。characterIds 属于外层片段。' })

export const videoPromptDraftSegmentSchema = Type.Object({
  characterIds: Type.Array(Type.String({ minLength: 1, maxLength: 50 }), {
    maxItems: 6,
    uniqueItems: true,
    description: '整个片段中入画或说话的人物 ID，放在片段层，与 beats 同级。',
  }),
  beats: Type.Array(videoBeatSchema, { minItems: 1, maxItems: 3 }),
  endFrame: Type.String({ minLength: 10, maxLength: 600, description: '必填，放在片段层，与 beats 同级。只概括末镜已经呈现的最终构图、人物姿势和持物，供内部衔接；不添加新动作，不作为最终 prompt 的独立段落。' }),
}, { additionalProperties: false, description: '一个片段，只包含 characterIds、beats、endFrame。每个镜头的声音分别放进 beats 内的 audio。' })

export const videoPromptDraftSchema = Type.Object({
  visualContext: videoVisualContextSchema,
  videoPrompts: Type.Array(videoPromptDraftSegmentSchema, { minItems: 2, maxItems: 3 }),
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
export type SceneDialogue = Static<typeof sceneDialogueSchema>
export type VideoBeat = Static<typeof videoBeatSchema>
export type VideoPromptDraftSegment = Static<typeof videoPromptDraftSegmentSchema>
export type VideoPromptDraft = Static<typeof videoPromptDraftSchema>
export type ResolvedVideoBeat = Omit<VideoBeat, 'dialogueIds'> & { dialogue?: (VideoDialogue & { id?: string })[] }
export type ResolvedVideoPromptDraftSegment = Omit<VideoPromptDraftSegment, 'beats'> & { beats: ResolvedVideoBeat[] }
export type ResolvedVideoPromptDraft = Omit<VideoPromptDraft, 'videoPrompts'> & { videoPrompts: ResolvedVideoPromptDraftSegment[] }
export type StoryScene = Static<typeof storySceneSchema>
export type ScenePublish = Static<typeof scenePublishSchema>
export type VideoPlan = Static<typeof videoPlanSchema>
export type DirectorTurn = Static<typeof directorTurnSchema>
export type StoryInput = Static<typeof storyInputSchema>

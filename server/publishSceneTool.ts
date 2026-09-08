import type { AgentTool } from '@earendil-works/pi-agent-core/node'
import { Check, Errors } from 'typebox/value'
import {
  scenePublishSchema,
  type ScenePublish,
} from '../src/types/story.ts'

export const SCENE_PUBLISH_ARGUMENTS_EXAMPLE = JSON.stringify({
  scene: {
    title: '廊下问话',
    narrative: '女主停在廊柱旁，掌事姑姑问：“你识字吗？”她抬头等候。',
    choices: [{ id: '1', text: '说明自己识字' }, { id: '2', text: '询问缘由' }, { id: '3', text: '低头等候' }],
  },
  characters: [
    { id: 'heroine', name: '女主', gender: 'female', minAge: 16, maxAge: 20 },
    { id: 'steward', name: '掌事姑姑', gender: 'female', minAge: 40, maxAge: 50 },
  ],
  dialogues: [{ id: 'line_1', characterId: 'steward', text: '你识字吗？' }],
})

export const PUBLISH_SCENE_DESCRIPTION = '提交完整 JSON 对象，顶层包含 scene、characters、dialogues。scene 内仅有 title、narrative、choices；choices 必须有 3 项，id 各为 1、2、3。人物对白用双引号，dialogues 按出现顺序逐句列出唯一 ID、characterId 和完整原文；无对白提交空数组。人物和台词数组不能嵌套在 scene 内。校验失败时重新提交完整参数。本回合只能发布一次。'

export const prepareScenePublishArguments = (args: unknown): ScenePublish => {
  if (!Check(scenePublishSchema, args)) {
    const guidance: string[] = []
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      if (!Object.keys(args).length) guidance.push('收到空参数对象；请检查 JSON 语法，不要使用 Markdown 代码块或工具名包装。')
      if ('scene' in args && args.scene && typeof args.scene === 'object') {
        if ('characters' in args.scene) guidance.push('characters 必须位于顶层，与 scene 同级，不能放在 scene 内。')
        if ('choices' in args.scene && Array.isArray(args.scene.choices) && args.scene.choices.length !== 3) {
          guidance.push(`scene.choices 当前为 ${args.scene.choices.length} 项，必须提供 3 个不同选项，id 各为 1、2、3。`)
        }
      }
    }
    const issues = [...Errors(scenePublishSchema, args)].slice(0, 8)
      .map((issue) => `${issue.instancePath || '/'} ${issue.message}`)
      .join('；')
    throw new Error(`publish_scene 参数不符合 schema：${issues || '结构无效'}。\n${guidance.join('\n')}\n修正后重新提交完整 JSON，不只提交修改片段。结构示例（请替换为本幕内容）：${SCENE_PUBLISH_ARGUMENTS_EXAMPLE}`)
  }

  return args
}

export const assertValidScenePublish = (turn: ScenePublish) => {
  const choiceIds = new Set(turn.scene.choices.map((choice) => choice.id))
  if (choiceIds.size !== 3 || !(['1', '2', '3'] as const).every((id) => choiceIds.has(id))) {
    throw new Error('剧情选项必须各使用一次 ID 1、2、3。')
  }

  const characterIds = new Set<string>()
  for (const character of turn.characters) {
    if (characterIds.has(character.id)) throw new Error(`人物 ID ${character.id} 重复。`)
    if (character.minAge > character.maxAge) throw new Error(`人物 ${character.name} 的年龄区间无效。`)
    characterIds.add(character.id)
  }

  const dialogueIds = new Set<string>()
  for (const dialogue of turn.dialogues) {
    if (dialogueIds.has(dialogue.id)) throw new Error(`台词 ID ${dialogue.id} 重复。`)
    if (!characterIds.has(dialogue.characterId)) throw new Error(`台词 ${dialogue.id} 引用了未声明人物 ${dialogue.characterId}。`)
    dialogueIds.add(dialogue.id)
  }
  const spokenLines: string[] = []
  let closingQuote: string | undefined
  let openingIndex = 0
  for (let index = 0; index < turn.scene.narrative.length; index += 1) {
    const char = turn.scene.narrative[index]
    if (closingQuote) {
      if (char === closingQuote) {
        spokenLines.push(turn.scene.narrative.slice(openingIndex + 1, index))
        closingQuote = undefined
      } else if (char === '“' || char === '”' || char === '"') {
        throw new Error('narrative 人物对白的双引号不能嵌套或混用，引用内容请使用单引号。')
      }
    } else if (char === '“' || char === '"') {
      closingQuote = char === '“' ? '”' : '"'
      openingIndex = index
    } else if (char === '”') {
      throw new Error('narrative 人物对白的双引号必须成对。')
    }
  }
  if (closingQuote) throw new Error('narrative 人物对白的双引号未闭合。')
  if (spokenLines.length !== turn.dialogues.length || spokenLines.some((line, index) => line !== turn.dialogues[index].text)) {
    throw new Error(`dialogues 台词清单与 narrative 人物对白不一致。必须按顺序逐句保留原文和标点，每组双引号对应一项，无对白提交空数组。narrative 中的台词：${JSON.stringify(spokenLines)}`)
  }
}

export type PublishSceneToolOptions = {
  // 已发布时返回 true，拒绝重复发布。
  isPublished?: () => boolean
  // 发布成功后附在工具结果里的选角状态说明。
  describeCasting?: (turn: ScenePublish) => string
}

export const createPublishSceneTool = (
  onPublish?: (turn: ScenePublish) => void | Promise<void>,
  options: PublishSceneToolOptions = {},
): AgentTool<typeof scenePublishSchema, ScenePublish> => ({
  name: 'publish_scene',
  label: '发布故事场景',
  description: PUBLISH_SCENE_DESCRIPTION,
  parameters: scenePublishSchema,
  prepareArguments: prepareScenePublishArguments,
  executionMode: 'sequential',
  execute: async (_toolCallId, turn) => {
    if (options.isPublished?.()) throw new Error('本回合场景已经发布，不能重复发布；请继续选角、编写分镜或结束回合。')
    assertValidScenePublish(turn)
    await onPublish?.(turn)
    const text = ['场景已发布。', options.describeCasting?.(turn)].filter(Boolean).join('\n')
    return {
      content: [{ type: 'text', text }],
      details: turn,
      terminate: false,
    }
  },
})

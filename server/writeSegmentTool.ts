import type { AgentTool } from '@earendil-works/pi-agent-core/node'
import { Check, Errors } from 'typebox/value'
import {
  writeSegmentSchema,
  type SceneCharacter,
  type SceneDialogue,
  type VideoPromptSegment,
  type VideoReferenceDescriptor,
  type WriteSegmentInput,
} from '../src/types/story.ts'
import { countHanCharacters } from './textMetrics.ts'

export const SPEECH_RATE_HAN_PER_SECOND = 3.5
const MIN_TOTAL_SECONDS = 15
const MAX_TOTAL_SECONDS = 45
const TIME_BLOCK_PATTERN = /^\s*(\d+)\s*[–—-]\s*(\d+)\s*秒[：:]/gm
const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g

export const WRITE_SEGMENT_ARGUMENTS_EXAMPLE_FIRST = JSON.stringify({
  sequence: 1,
  characters: ['heroine', 'steward'],
  seconds: 5,
  style: '写实古装画面，清晨自然光从画面右侧照入，色调偏冷，人物面部明暗层次分明。',
  isLast: false,
  prompt: '0–3秒：双人中景，平视，镜头固定。女主怀抱青色包袱站在画面左侧，身体朝右；四十余岁、着深青宫装的掌事姑姑站在画面右侧。两人面对面相对而立，相距一步，姑姑看着女主，女主垂着眼帘。掌事姑姑面向左侧的女主开口，{{line_1}}安静。\n\n3–5秒：镜头硬切为双人中近景，平视，固定。女主在画面左侧抬起头面向右侧，双手仍抱着包袱；掌事姑姑在画面右侧。两人面对面相距一步，姑姑看着女主，女主与她对视。画外传来轻微风声。',
})

export const WRITE_SEGMENT_ARGUMENTS_EXAMPLE_NEXT = JSON.stringify({
  sequence: 2,
  characters: ['heroine', 'steward'],
  seconds: 10,
  isLast: true,
  prompt: '0–4秒：双人中近景，平视，固定，沿用上一段末镜的构图。女主在画面左侧抱着青色包袱，面向右侧垂下眼帘；四十余岁、着深青宫装的掌事姑姑在画面右侧。两人面对面相对而立，相距一步，姑姑的目光停在女主脸上。安静。\n\n4–10秒：镜头硬切为女主近景，平视，缓缓推近。她直起身，面向画面右侧，双手仍抱着包袱。画外传来轻微风声。',
})

export const WRITE_SEGMENT_STRUCTURE_GUIDANCE = '每次只提交一段：sequence、characters、seconds、prompt、isLast，第 1 段另加 style。prompt 由“0–3秒：”形式的时间块组成，从 0 秒开始首尾相接，最后一块结束于 seconds；在实际说话位置写 {{台词ID}} 占位符，程序替换为姓名和原文。不提交 beats、audio、endFrame、dialogueIds 或任何时间字段。'

export const WRITE_SEGMENT_DESCRIPTION = `把已发布的 narrative 忠实转成视频 prompt，一次只写一段，不发展剧情，不改台词。${WRITE_SEGMENT_STRUCTURE_GUIDANCE}每段 5–15 秒，整幕 2–3 段、15–45 秒，seconds 不低于本段台词字数 ÷ ${SPEECH_RATE_HAN_PER_SECOND} 再加 1 秒。每个时间块可含一个或多个镜头，每个镜头按 [镜头][画面][台词][声音] 四层书写，多人镜头写出相对关系、距离和视线，方位只用画面坐标，切镜必须显式声明；每段首镜必须放进本段所有人物，后到的人物要写出入画动作；无参考图人物每段重复一句外观。本段用到的台词必须紧接此前已写段落之后、按原顺序、不重复；本幕最后一段（isLast）必须用完全部剩余台词。正文用人物姓名，不出现人物 ID。重新提交同一 sequence 视为重写，会丢弃该段及之后所有段落的写作和生成结果。`

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const minimumSegmentSeconds = (spokenHanCharacters: number) =>
  spokenHanCharacters ? Math.ceil(spokenHanCharacters / SPEECH_RATE_HAN_PER_SECOND + 1) : 0

export const prepareWriteSegmentArguments = (args: unknown): WriteSegmentInput => {
  if (Check(writeSegmentSchema, args)) return args
  const issues = [...Errors(writeSegmentSchema, args)].slice(0, 8)
    .map((issue) => `${issue.instancePath || '/'} ${issue.message}${issue.keyword === 'additionalProperties' ? `: ${issue.params.additionalProperties.join(', ')}` : ''}`)
    .join('；')
  throw new Error(`write_segment 参数不符合 schema：${issues || '结构无效'}。\n${WRITE_SEGMENT_STRUCTURE_GUIDANCE}\n修正后重新提交完整 JSON，不只提交修改片段。结构示例（请替换为本幕内容，台词 ID 以已发布 dialogues 为准）：第 1 段 ${WRITE_SEGMENT_ARGUMENTS_EXAMPLE_FIRST}；后续段 ${WRITE_SEGMENT_ARGUMENTS_EXAMPLE_NEXT}`)
}

export type PreparedSegment = {
  sequence: number
  characters: string[]
  seconds: number
  isLast: boolean
  prompt: string
  lineIds: string[]
  style?: string
}

export type ExistingSegment = {
  sequence: number
  seconds: number
  lineIds: string[]
  generated?: unknown
}

export type WriteSegmentContext = {
  characters: SceneCharacter[]
  dialogues: SceneDialogue[]
  existingSegments: ExistingSegment[]
}

export type WriteSegmentResult = {
  segment: PreparedSegment
  cumulativeSeconds: number
  remainingLines: SceneDialogue[]
}

// 一次只校验一段：序号顺序、台词前缀、时间块、时长预算。
export const prepareWriteSegment = (rawInput: unknown, ctx: WriteSegmentContext): WriteSegmentResult => {
  const input = prepareWriteSegmentArguments(rawInput)
  const { characters, dialogues, existingSegments } = ctx
  const names = new Map(characters.map((character) => [character.id, character.name]))
  const linesById = new Map(dialogues.map((line) => [line.id, line]))
  const issues: string[] = []

  const sortedExisting = [...existingSegments].sort((left, right) => left.sequence - right.sequence)
  const maxWrittenSequence = sortedExisting.length ? sortedExisting[sortedExisting.length - 1].sequence : 0
  const isRewrite = sortedExisting.some((segment) => segment.sequence === input.sequence)
  if (!isRewrite && input.sequence !== maxWrittenSequence + 1) {
    throw new Error(`sequence 必须是 ${maxWrittenSequence + 1}（新写下一段）或 1–${maxWrittenSequence} 之间已写的段号（重写）。`)
  }

  if (input.sequence >= 2) {
    const previous = sortedExisting.find((segment) => segment.sequence === input.sequence - 1)
    if (!previous?.generated) {
      throw new Error(`第 ${input.sequence - 1} 段尚未生成，请先调用 generate_segment({ sequence: ${input.sequence - 1} }) 完成上一段。`)
    }
  }
  if (input.sequence === 3 && !input.isLast) {
    throw new Error('第 3 段必须是本幕最后一段，isLast 必须为 true。')
  }
  if (input.sequence === 1 && !input.style?.trim()) {
    throw new Error('第 1 段必须提交 style，用于整幕统一的画面质感、色调和光源。')
  }

  for (const id of input.characters) {
    if (!names.has(id)) issues.push(`引用了未声明的人物 ${id}`)
  }

  const blocks = [...input.prompt.matchAll(TIME_BLOCK_PATTERN)].map((match) => [Number(match[1]), Number(match[2])] as const)
  if (!blocks.length) {
    issues.push(`正文必须由“0–${input.seconds}秒：”形式的时间块组成`)
  } else {
    if (blocks[0][0] !== 0) issues.push('第一个时间块必须从 0 秒开始')
    blocks.forEach(([start, end], blockIndex) => {
      if (end <= start) issues.push(`时间块 ${start}–${end}秒 无效`)
      if (blockIndex > 0 && start !== blocks[blockIndex - 1][1]) {
        issues.push(`时间块 ${start}–${end}秒 与上一块 ${blocks[blockIndex - 1][0]}–${blocks[blockIndex - 1][1]}秒 不衔接`)
      }
    })
    const lastEnd = blocks[blocks.length - 1][1]
    if (lastEnd !== input.seconds) {
      issues.push(`最后一个时间块结束于 ${lastEnd} 秒，与 seconds=${input.seconds} 不一致`)
    }
  }

  // 已写段（不含本段）按顺序使用的台词，构成台词前缀。
  const priorLineIds = sortedExisting
    .filter((segment) => segment.sequence < input.sequence)
    .flatMap((segment) => segment.lineIds)

  let spokenHan = 0
  const lineIds: string[] = []
  const prompt = input.prompt.replace(PLACEHOLDER_PATTERN, (placeholder, id: string) => {
    const line = linesById.get(id)
    if (!line) {
      issues.push(`引用了未知台词 ${id || placeholder}`)
      return placeholder
    }
    if (priorLineIds.includes(id) || lineIds.includes(id)) issues.push(`台词 ${id} 重复安排，每句只能使用一次`)
    lineIds.push(id)
    const name = names.get(line.characterId)
    if (!name) issues.push(`台词 ${id} 的说话人 ${line.characterId} 不在本幕人物中`)
    else if (!input.characters.includes(line.characterId)) {
      issues.push(`说话人物 ${name}（${line.characterId}）未列入 characters`)
    }
    spokenHan += countHanCharacters(line.text)
    return `${name ?? line.characterId}说：“${line.text}”`
  }).replace(/”[。；]/g, '”')
  if (/[{}]/.test(prompt)) issues.push('存在未解析的占位符或多余的花括号')

  const expectedLineIds = dialogues.slice(priorLineIds.length, priorLineIds.length + lineIds.length).map((line) => line.id)
  if (lineIds.some((id, index) => id !== expectedLineIds[index])) {
    issues.push(`台词必须紧接此前已写段落之后、按原顺序使用：接下来应为 ${dialogues.slice(priorLineIds.length).map((line) => line.id).join(' → ') || '（无剩余台词）'}`)
  }

  const remainingLines = dialogues.slice(priorLineIds.length + lineIds.length)
  if (input.isLast && remainingLines.length) {
    issues.push(`本段是最后一段，必须用完全部剩余台词：${remainingLines.map((line) => `${line.id}（${names.get(line.characterId) ?? line.characterId}“${line.text}”）`).join('、')}`)
  }

  const minimum = minimumSegmentSeconds(spokenHan)
  if (input.seconds < minimum) {
    issues.push(`本段台词共 ${spokenHan} 字，至少需要 ${minimum} 秒，当前 seconds=${input.seconds}`)
  }

  const prose = prompt.replace(/“[^”]*”/g, '')
  for (const character of characters) {
    if (character.id === character.name) continue
    if (new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(character.id)}(?![A-Za-z0-9_])`).test(prose)) {
      issues.push(`正文出现了内部人物 ID ${character.id}，请使用姓名 ${character.name}`)
    }
  }

  const priorSeconds = sortedExisting
    .filter((segment) => segment.sequence < input.sequence)
    .reduce((sum, segment) => sum + segment.seconds, 0)
  const cumulativeSeconds = priorSeconds + input.seconds
  if (cumulativeSeconds > MAX_TOTAL_SECONDS) {
    issues.push(`累计秒数 ${cumulativeSeconds} 秒，超过整幕上限 ${MAX_TOTAL_SECONDS} 秒`)
  }
  const totalSegmentCount = sortedExisting.filter((segment) => segment.sequence < input.sequence).length + 1
  if (input.isLast && (cumulativeSeconds < MIN_TOTAL_SECONDS || totalSegmentCount < 2)) {
    issues.push(`本幕累计 ${cumulativeSeconds} 秒、共 ${totalSegmentCount} 段，最后一段必须满足累计不少于 ${MIN_TOTAL_SECONDS} 秒且至少 2 段`)
  }

  if (issues.length) {
    throw new Error(`第 ${input.sequence} 段存在以下问题：\n- ${issues.join('\n- ')}\n请修正后重新提交本段完整参数。`)
  }

  const spokenLines = [...prompt.matchAll(/“([^”]*)”/g)].map((match) => match[1])
  const expectedTexts = lineIds.map((id) => linesById.get(id)!.text)
  if (spokenLines.length !== expectedTexts.length || spokenLines.some((text, index) => text !== expectedTexts[index])) {
    throw new Error('最终 prompt 台词与原文不一致，不能在占位符之外另写对白。')
  }

  return {
    segment: {
      sequence: input.sequence,
      characters: input.characters,
      seconds: input.seconds,
      isLast: input.isLast,
      prompt: prompt.trim(),
      lineIds,
      ...(input.style?.trim() ? { style: input.style.trim() } : {}),
    },
    cumulativeSeconds,
    remainingLines,
  }
}

export type ActorLookup = (characterId: string) => { actorId: string; hasImage: boolean } | undefined

// 首段：有上一幕尾帧则整段沿用；否则按 characters 顺序列出有参考图的人物。第 2 段起：以上一段尾帧为起始画面。
export const describeReferenceImages = (
  sequence: number,
  characterIds: string[],
  ctx: { hasPreviousTailFrame: boolean; lookupActor: ActorLookup },
): VideoReferenceDescriptor[] => {
  if (sequence === 1) {
    if (ctx.hasPreviousTailFrame) return [{ type: 'previous_scene_tail_frame' }]
    return characterIds.flatMap((characterId): VideoReferenceDescriptor[] => {
      const actor = ctx.lookupActor(characterId)
      return actor?.hasImage ? [{ type: 'character', characterId, actorId: actor.actorId }] : []
    })
  }
  return [{ type: 'start_frame', sequence: sequence - 1 }]
}

export type WriteSegmentToolOptions = {
  getCharacters: () => SceneCharacter[]
  getDialogues: () => SceneDialogue[]
  getExistingSegments: () => ExistingSegment[]
  getHasPreviousTailFrame: () => boolean
  lookupActor: ActorLookup
  // 返回非空字符串时拒绝本次调用，用于前置条件（场景未发布、选角未完成）。
  precondition?: () => string | null
  onWrite: (result: WriteSegmentResult) => void | Promise<void>
}

export type WriteSegmentDetails = {
  segment: VideoPromptSegment
  referenceImages: VideoReferenceDescriptor[]
  cumulativeSeconds: number
  remainingLineIds: string[]
}

export const createWriteSegmentTool = ({
  getCharacters,
  getDialogues,
  getExistingSegments,
  getHasPreviousTailFrame,
  lookupActor,
  precondition,
  onWrite,
}: WriteSegmentToolOptions): AgentTool<typeof writeSegmentSchema, WriteSegmentDetails> => ({
  name: 'write_segment',
  label: '编写一段视频 Prompt',
  description: WRITE_SEGMENT_DESCRIPTION,
  parameters: writeSegmentSchema,
  prepareArguments: prepareWriteSegmentArguments,
  executionMode: 'sequential',
  execute: async (_toolCallId, rawInput) => {
    const blocked = precondition?.()
    if (blocked) throw new Error(blocked)
    const characters = getCharacters()
    if (!characters.length) throw new Error('必须先通过 publish_scene 发布本幕人物。')
    const existingSegments = getExistingSegments()
    const result = prepareWriteSegment(rawInput, { characters, dialogues: getDialogues(), existingSegments })
    await onWrite(result)

    const priorSeconds = result.cumulativeSeconds - result.segment.seconds
    const referenceImages = describeReferenceImages(result.segment.sequence, result.segment.characters, {
      hasPreviousTailFrame: getHasPreviousTailFrame(),
      lookupActor,
    })
    const segmentDetails: VideoPromptSegment = {
      sequence: result.segment.sequence,
      startTime: priorSeconds,
      endTime: result.cumulativeSeconds,
      characterIds: result.segment.characters,
      prompt: result.segment.prompt,
    }
    const referenceText = referenceImages.length
      ? referenceImages.map((ref) => ref.type === 'character'
        ? `人物 ${ref.characterId} 参考图`
        : ref.type === 'previous_scene_tail_frame'
          ? '上一幕尾帧'
          : `第 ${ref.sequence} 段尾帧`).join('、')
      : '无'
    const text = [
      `第 ${result.segment.sequence} 段已写：`,
      result.segment.prompt,
      `参考图：${referenceText}`,
      `累计时长：${result.cumulativeSeconds} 秒`,
      result.remainingLines.length
        ? `剩余台词：${result.remainingLines.map((line) => `${line.id}（${line.text}）`).join('、')}`
        : '本幕台词已全部安排。',
      `下一步：调用 generate_segment({ sequence: ${result.segment.sequence} })。`,
    ].join('\n')
    return {
      content: [{ type: 'text', text }],
      details: {
        segment: segmentDetails,
        referenceImages,
        cumulativeSeconds: result.cumulativeSeconds,
        remainingLineIds: result.remainingLines.map((line) => line.id),
      },
      terminate: false,
    }
  },
})

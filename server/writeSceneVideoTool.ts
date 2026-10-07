import type { AgentTool } from '@earendil-works/pi-agent-core/node'
import { Check, Errors } from 'typebox/value'
import {
  writeSceneVideoSchema,
  type SceneCharacter,
  type SceneDialogue,
  type SceneVideoOpening,
  type VideoPlanSegment,
  type VideoPromptSegment,
  type VideoReferenceDescriptor,
  type WriteSceneVideoInput,
} from '../src/types/story.ts'
import { countHanCharacters } from './textMetrics.ts'

export const SPEECH_RATE_HAN_PER_SECOND = 3.5
const MIN_TOTAL_SECONDS = 15
const MAX_TOTAL_SECONDS = 45
const MIN_SEGMENTS = 2
const TIME_BLOCK_PATTERN = /^\s*(\d+)\s*[–—-]\s*(\d+)\s*秒[：:]/gm
const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g

export const WRITE_SCENE_VIDEO_ARGUMENTS_EXAMPLE = JSON.stringify({
  opening: 'new_shot',
  style: '写实古装画面，清晨自然光从画面右侧照入，色调偏冷，人物面部明暗层次分明。',
  segments: [
    {
      characters: ['heroine', 'steward'],
      seconds: 5,
      prompt: '0–3秒：双人中景，平视，镜头固定。女主怀抱青色包袱站在画面左侧，身体朝右；掌事姑姑站在画面右侧。两人面对面相对而立，相距一步，姑姑看着女主，女主垂着眼帘。掌事姑姑面向左侧的女主开口，{{line_1}}安静。\n\n3–5秒：镜头硬切为双人中近景，平视，固定。女主在画面左侧抬起头面向右侧，双手仍抱着包袱；掌事姑姑在画面右侧。两人面对面相距一步，女主与她对视。画外传来轻微风声。',
    },
    {
      characters: ['heroine', 'steward'],
      seconds: 10,
      prompt: '0–4秒：承接上一段画面，镜头固定。女主垂下眼帘，双手把包袱抱得更紧；掌事姑姑的目光停在她脸上。安静。\n\n4–10秒：镜头硬切为女主近景，平视，缓缓推近。她直起身，面向画面右侧，双手仍抱着包袱。画外传来轻微风声。',
    },
  ],
})

export const WRITE_SCENE_VIDEO_STRUCTURE_GUIDANCE = '整场写作提交 opening、style 和 2–3 段 segments，每段只有 characters、seconds、prompt。prompt 由“0–3秒：”形式的时间块组成，从 0 秒开始首尾相接，最后一块结束于 seconds；在实际说话位置写 {{台词ID}} 占位符，程序替换为姓名和原文。重写单段时只提交 rewriteSequence 和只含该段的 segments。不提交 sequence、isLast、beats、audio 或任何时间字段。'

export const WRITE_SCENE_VIDEO_DESCRIPTION = `把已发布的 narrative 一次写成整个场次的视频分镜，不发展剧情，不改台词。${WRITE_SCENE_VIDEO_STRUCTURE_GUIDANCE}每段 5–15 秒，整场 2–3 段、15–45 秒，每段 seconds 不低于本段台词字数 ÷ ${SPEECH_RATE_HAN_PER_SECOND} 再加 1 秒。全场每句台词按原顺序恰好使用一次。段与段之间用上一段最后一帧接上，是连续画面，切镜只能放在段内部；第 2 段起开头写“承接上一段画面”，不重述站位和构图，只写这一段的变化。opening 为 continue 时第 1 段以上一场次最后一帧开场，必须先调用 inspect_last_frame，首镜按它返回的画面写；new_shot 用于换场景或换时间，第 1 段用人物参考图开场。人物外观由程序自动拼进 prompt，正文用人物姓名，不出现人物 ID。本场次不适合生成视频时只提交 skipVideo.reason。同一回合再次整场提交会覆盖上一次。`

export const prepareWriteSceneVideoArguments = (args: unknown): WriteSceneVideoInput => {
  if (Check(writeSceneVideoSchema, args)) return args
  const issues = [...Errors(writeSceneVideoSchema, args)].slice(0, 8)
    .map((issue) => `${issue.instancePath || '/'} ${issue.message}${issue.keyword === 'additionalProperties' ? `: ${issue.params.additionalProperties.join(', ')}` : ''}`)
    .join('；')
  throw new Error(`write_scene_video 参数不符合 schema：${issues || '结构无效'}。\n${WRITE_SCENE_VIDEO_STRUCTURE_GUIDANCE}\n修正后重新提交完整 JSON。结构示例（请替换为本场次内容，台词 ID 以已发布 dialogues 为准）：${WRITE_SCENE_VIDEO_ARGUMENTS_EXAMPLE}`)
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const minimumSegmentSeconds = (spokenHanCharacters: number) =>
  spokenHanCharacters ? Math.ceil(spokenHanCharacters / SPEECH_RATE_HAN_PER_SECOND + 1) : 0

// 导演提交的原始分镜（含台词占位符），场次结束时持久化，供“重写某段”时整场重新校验。
export type SceneVideoDraft = {
  opening: SceneVideoOpening
  style: string
  segments: VideoPlanSegment[]
}

export type CompiledSceneSegment = VideoPromptSegment & { lineIds: string[] }

// 整场校验：时间块、台词顺序与覆盖、秒数预算、人物 ID 泄漏；通过后返回替换了台词的各段。
export const validateSceneSegments = (
  segments: VideoPlanSegment[],
  characters: SceneCharacter[],
  dialogues: SceneDialogue[],
): CompiledSceneSegment[] => {
  const names = new Map(characters.map((character) => [character.id, character.name]))
  const linesById = new Map(dialogues.map((line) => [line.id, line]))
  const issues: string[] = []
  const usedLineIds: string[] = []

  if (segments.length < MIN_SEGMENTS) issues.push(`整场至少 ${MIN_SEGMENTS} 段，当前 ${segments.length} 段`)

  let start = 0
  const compiled = segments.map((segment, index): CompiledSceneSegment => {
    const number = index + 1
    for (const id of segment.characters) {
      if (!names.has(id)) issues.push(`第 ${number} 段引用了未声明的人物 ${id}`)
    }

    const blocks = [...segment.prompt.matchAll(TIME_BLOCK_PATTERN)].map((match) => [Number(match[1]), Number(match[2])] as const)
    if (!blocks.length) {
      issues.push(`第 ${number} 段正文必须由“0–${segment.seconds}秒：”形式的时间块组成`)
    } else {
      if (blocks[0][0] !== 0) issues.push(`第 ${number} 段第一个时间块必须从 0 秒开始`)
      blocks.forEach(([blockStart, blockEnd], blockIndex) => {
        if (blockEnd <= blockStart) issues.push(`第 ${number} 段时间块 ${blockStart}–${blockEnd}秒 无效`)
        if (blockIndex > 0 && blockStart !== blocks[blockIndex - 1][1]) {
          issues.push(`第 ${number} 段时间块 ${blockStart}–${blockEnd}秒 与上一块 ${blocks[blockIndex - 1][0]}–${blocks[blockIndex - 1][1]}秒 不衔接`)
        }
      })
      const lastEnd = blocks[blocks.length - 1][1]
      if (lastEnd !== segment.seconds) {
        issues.push(`第 ${number} 段最后一个时间块结束于 ${lastEnd} 秒，与 seconds=${segment.seconds} 不一致`)
      }
    }

    let spokenHan = 0
    const lineIds: string[] = []
    const prompt = segment.prompt.replace(PLACEHOLDER_PATTERN, (placeholder, id: string) => {
      const line = linesById.get(id)
      if (!line) {
        issues.push(`第 ${number} 段引用了未知台词 ${id || placeholder}`)
        return placeholder
      }
      if (usedLineIds.includes(id)) issues.push(`台词 ${id} 重复安排，每句只能使用一次`)
      usedLineIds.push(id)
      lineIds.push(id)
      const name = names.get(line.characterId)
      if (!name) issues.push(`台词 ${id} 的说话人 ${line.characterId} 不在本场次人物中`)
      else if (!segment.characters.includes(line.characterId)) {
        issues.push(`第 ${number} 段说话人物 ${name}（${line.characterId}）未列入 characters`)
      }
      spokenHan += countHanCharacters(line.text)
      return `${name ?? line.characterId}说：“${line.text}”`
    }).replace(/”[。；]/g, '”')
    if (/[{}]/.test(prompt)) issues.push(`第 ${number} 段存在未解析的占位符或多余的花括号`)

    const minimum = minimumSegmentSeconds(spokenHan)
    if (segment.seconds < minimum) {
      issues.push(`第 ${number} 段台词共 ${spokenHan} 字，至少需要 ${minimum} 秒，当前 seconds=${segment.seconds}；请增加秒数或把台词挪到其他段`)
    }

    const prose = prompt.replace(/“[^”]*”/g, '')
    for (const character of characters) {
      if (character.id === character.name) continue
      if (new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(character.id)}(?![A-Za-z0-9_])`).test(prose)) {
        issues.push(`第 ${number} 段正文出现了内部人物 ID ${character.id}，请使用姓名 ${character.name}`)
      }
    }

    const compiledSegment = {
      sequence: number,
      startTime: start,
      endTime: start + segment.seconds,
      characterIds: segment.characters,
      prompt: prompt.trim(),
      lineIds,
    }
    start = compiledSegment.endTime
    return compiledSegment
  })

  for (const line of dialogues) {
    if (!usedLineIds.includes(line.id)) {
      issues.push(`尚未安排 ${line.id}：${names.get(line.characterId) ?? line.characterId}“${line.text}”`)
    }
  }
  if (usedLineIds.length === dialogues.length && usedLineIds.some((id, index) => id !== dialogues[index].id)) {
    issues.push(`台词顺序必须与 narrative 一致：${dialogues.map((line) => line.id).join(' → ')}`)
  }
  if (start < MIN_TOTAL_SECONDS || start > MAX_TOTAL_SECONDS) {
    issues.push(`各段秒数合计 ${start} 秒，必须在 ${MIN_TOTAL_SECONDS}–${MAX_TOTAL_SECONDS} 秒之间`)
  }
  if (issues.length) {
    throw new Error(`分镜存在以下问题：\n- ${issues.join('\n- ')}\n请修正后重新提交，保留全部原台词。`)
  }

  const spokenLines = compiled.flatMap((segment) => [...segment.prompt.matchAll(/“([^”]*)”/g)].map((match) => match[1]))
  if (spokenLines.length !== dialogues.length || spokenLines.some((text, index) => text !== dialogues[index].text)) {
    throw new Error('最终 prompt 台词与原文不一致，不能在占位符之外另写对白。')
  }
  return compiled
}

export type ActorLookup = (characterId: string) => { actorId: string } | undefined

// 第 1 段：接着拍用上一场次最后一帧；换场景按 characters 顺序列出已绑定演员的人物（参考图由前端按演员库解析）。
// 第 2 段起：以上一段最后一帧为首帧。
export const describeSegmentReferences = (
  opening: SceneVideoOpening,
  segments: Pick<VideoPromptSegment, 'sequence' | 'characterIds'>[],
  lookupActor: ActorLookup,
): VideoReferenceDescriptor[][] => segments.map((segment): VideoReferenceDescriptor[] => {
  if (segment.sequence > 1) return [{ type: 'start_frame', sequence: segment.sequence - 1 }]
  if (opening === 'continue') return [{ type: 'previous_scene_tail_frame' }]
  return segment.characterIds.flatMap((characterId): VideoReferenceDescriptor[] => {
    const actor = lookupActor(characterId)
    return actor ? [{ type: 'character', characterId, actorId: actor.actorId }] : []
  })
})

export type SceneVideoResult =
  | { kind: 'plan'; draft: SceneVideoDraft; segments: CompiledSceneSegment[] }
  | { kind: 'rewrite'; draft: SceneVideoDraft; segments: CompiledSceneSegment[]; sequence: number }
  | { kind: 'skip'; reason: string }

export type WriteSceneVideoContext = {
  characters: SceneCharacter[]
  dialogues: SceneDialogue[]
  // 重写回合：玩家要求重写的段号和本场次已有分镜；整场写作时省略。
  rewrite?: { sequence: number; draft: SceneVideoDraft }
}

export const prepareSceneVideo = (rawInput: unknown, ctx: WriteSceneVideoContext): SceneVideoResult => {
  const input = prepareWriteSceneVideoArguments(rawInput)
  const { rewrite } = ctx

  if (rewrite) {
    if (input.rewriteSequence !== rewrite.sequence) {
      throw new Error(`玩家要求重写第 ${rewrite.sequence} 段：请提交 rewriteSequence: ${rewrite.sequence}，segments 只含重写后的这一段。`)
    }
    if (input.segments?.length !== 1) throw new Error('重写单段时 segments 必须只含被重写的那一段。')
    if (input.skipVideo) throw new Error('重写单段时不能跳过视频。')
    const segments = rewrite.draft.segments.map((segment, index) => index + 1 === rewrite.sequence ? input.segments![0] : segment)
    const draft = { ...rewrite.draft, segments }
    return { kind: 'rewrite', draft, segments: validateSceneSegments(segments, ctx.characters, ctx.dialogues), sequence: rewrite.sequence }
  }

  if (input.rewriteSequence !== undefined) throw new Error('只有玩家要求重写某段时才能使用 rewriteSequence；本场次请整场提交分镜。')
  if (input.skipVideo) {
    if (input.segments?.length) throw new Error('跳过视频时不要同时提交 segments。')
    return { kind: 'skip', reason: input.skipVideo.reason.trim() }
  }
  const missing = [!input.opening && 'opening', !input.style?.trim() && 'style', !input.segments?.length && 'segments'].filter(Boolean)
  if (missing.length) throw new Error(`整场写作必须提交 ${missing.join('、')}。${WRITE_SCENE_VIDEO_STRUCTURE_GUIDANCE}`)
  const draft: SceneVideoDraft = { opening: input.opening!, style: input.style!.trim(), segments: input.segments! }
  return { kind: 'plan', draft, segments: validateSceneSegments(draft.segments, ctx.characters, ctx.dialogues) }
}

export type WriteSceneVideoToolOptions = {
  getCharacters: () => SceneCharacter[]
  getDialogues: () => SceneDialogue[]
  getRewrite?: () => WriteSceneVideoContext['rewrite']
  // 返回非空字符串时拒绝本次调用：场景未发布、选角未完成，或选了接着拍却没看过上一场次画面。
  precondition?: (input: WriteSceneVideoInput) => string | null
  onWrite: (result: SceneVideoResult) => void | Promise<void>
}

const summarize = (result: SceneVideoResult) => {
  if (result.kind === 'skip') return `本场次不生成视频：${result.reason}`
  const lines = result.segments.map((segment) =>
    `第 ${segment.sequence} 段 ${segment.startTime}–${segment.endTime} 秒${segment.lineIds.length ? `（${segment.lineIds.join('、')}）` : '（无台词）'}`)
  const total = result.segments.at(-1)?.endTime ?? 0
  return result.kind === 'rewrite'
    ? [`第 ${result.sequence} 段已重写，整场 ${result.segments.length} 段 ${total} 秒：`, ...lines].join('\n')
    : [`分镜已交付，开场方式 ${result.draft.opening}，共 ${result.segments.length} 段 ${total} 秒：`, ...lines].join('\n')
}

export const createWriteSceneVideoTool = ({
  getCharacters,
  getDialogues,
  getRewrite,
  precondition,
  onWrite,
}: WriteSceneVideoToolOptions): AgentTool<typeof writeSceneVideoSchema, SceneVideoResult> => ({
  name: 'write_scene_video',
  label: '编写场次分镜',
  description: WRITE_SCENE_VIDEO_DESCRIPTION,
  parameters: writeSceneVideoSchema,
  prepareArguments: prepareWriteSceneVideoArguments,
  executionMode: 'sequential',
  execute: async (_toolCallId, input) => {
    const blocked = precondition?.(input)
    if (blocked) throw new Error(blocked)
    const characters = getCharacters()
    if (!characters.length) throw new Error('必须先通过 publish_scene 发布本场次人物。')
    const result = prepareSceneVideo(input, { characters, dialogues: getDialogues(), rewrite: getRewrite?.() })
    await onWrite(result)
    return {
      content: [{ type: 'text', text: summarize(result) }],
      details: result,
      terminate: false,
    }
  },
})

import type { AgentTool } from '@earendil-works/pi-agent-core/node'
import { Check, Errors } from 'typebox/value'
import {
  videoPlanSchema,
  videoGenerationRequestSchema,
  type SceneCharacter,
  type SceneDialogue,
  type VideoGenerationRequest,
  type VideoPlan,
} from '../src/types/story.ts'
import { compileVideoPlan } from './videoPromptCompiler.ts'
import { countHanCharacters } from './textMetrics.ts'

export type PreparedVideoPlan = { video: VideoGenerationRequest }

export const SPEECH_RATE_HAN_PER_SECOND = 3.5
const MIN_TOTAL_SECONDS = 15
const MAX_TOTAL_SECONDS = 45
const TIME_BLOCK_PATTERN = /^\s*(\d+)\s*[–—-]\s*(\d+)\s*秒[：:]/gm
const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g

export const VIDEO_PLAN_ARGUMENTS_EXAMPLE = JSON.stringify({
  style: '写实古装画面，清晨自然光从画面右侧照入，色调偏冷，人物面部明暗层次分明。',
  segments: [
    {
      characters: ['heroine', 'steward'],
      seconds: 5,
      prompt: '0–3秒：双人中景，平视，镜头固定。女主怀抱青色包袱站在画面左侧，身体朝右；四十余岁、着深青宫装的掌事姑姑站在画面右侧，面向左侧的女主开口，{{line_1}}安静。\n\n3–5秒：镜头硬切为女主近景，平视，固定。她抬起头面向画面右侧，双手仍抱着包袱。画外传来轻微风声。',
    },
    {
      characters: ['heroine', 'steward'],
      seconds: 10,
      prompt: '0–4秒：女主近景，平视，固定，延续上一段末镜的构图。她面向画面右侧，双手抱着青色包袱，垂下眼帘。安静。\n\n4–10秒：镜头切换为双人中近景，平视，缓缓推近。女主在画面左侧直起身，面向右侧；四十余岁、着深青宫装的掌事姑姑在画面右侧，目光停在她脸上。画外传来轻微风声。',
    },
  ],
})

export const VIDEO_PLAN_STRUCTURE_GUIDANCE = '顶层只包含 style 和 segments。每个 segment 只包含 characters、seconds、prompt。prompt 由“0–3秒：”形式的时间块组成，从 0 秒开始首尾相接，最后一块结束于 seconds；在实际说话位置写 {{台词ID}} 占位符，程序替换为姓名和原文。不提交 beats、audio、endFrame、dialogueIds 或任何时间字段。'

export const WRITE_VIDEO_PROMPT_DESCRIPTION = `把已发布的 narrative 忠实转成 2–3 段可直接生成的视频 prompt，不发展剧情，不改台词。${VIDEO_PLAN_STRUCTURE_GUIDANCE}每段 5–15 秒，整幕 15–45 秒，seconds 不低于本段台词字数 ÷ ${SPEECH_RATE_HAN_PER_SECOND} 再加 1 秒。每个时间块可含一个或多个镜头，每个镜头按 [镜头][画面][台词][声音] 四层书写，方位只用画面坐标，切镜必须显式声明；无参考图人物每段重复一句外观。全幕每句台词必须按原顺序恰好使用一次；正文用人物姓名，不出现人物 ID。重复调用视为重写，覆盖上一次提交。`

export const prepareVideoPlanArguments = (args: unknown): VideoPlan => {
  if (Check(videoPlanSchema, args)) return args
  const issues = [...Errors(videoPlanSchema, args)].slice(0, 8)
    .map((issue) => `${issue.instancePath || '/'} ${issue.message}${issue.keyword === 'additionalProperties' ? `: ${issue.params.additionalProperties.join(', ')}` : ''}`)
    .join('；')
  throw new Error(`write_video_prompt 参数不符合 schema：${issues || '结构无效'}。\n${VIDEO_PLAN_STRUCTURE_GUIDANCE}\n修正后重新提交完整 JSON，不只提交修改片段。结构示例（请替换为本幕内容，台词 ID 以已发布 dialogues 为准）：${VIDEO_PLAN_ARGUMENTS_EXAMPLE}`)
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const minimumSegmentSeconds = (spokenHanCharacters: number) =>
  spokenHanCharacters ? Math.ceil(spokenHanCharacters / SPEECH_RATE_HAN_PER_SECOND + 1) : 0

export const prepareVideoPlan = (rawPlan: unknown, characters: SceneCharacter[], dialogues: SceneDialogue[]) => {
  const plan = prepareVideoPlanArguments(rawPlan)
  const names = new Map(characters.map((character) => [character.id, character.name]))
  const linesById = new Map(dialogues.map((line) => [line.id, line]))
  const issues: string[] = []
  const usedLineIds: string[] = []
  const segmentLineIds: string[][] = []

  const compiledSegments = plan.segments.map((segment, index) => {
    const number = index + 1
    for (const id of segment.characters) {
      if (!names.has(id)) issues.push(`第 ${number} 段引用了未声明的人物 ${id}`)
    }

    const blocks = [...segment.prompt.matchAll(TIME_BLOCK_PATTERN)].map((match) => [Number(match[1]), Number(match[2])] as const)
    if (!blocks.length) {
      issues.push(`第 ${number} 段正文必须由“0–${segment.seconds}秒：”形式的时间块组成`)
    } else {
      if (blocks[0][0] !== 0) issues.push(`第 ${number} 段第一个时间块必须从 0 秒开始`)
      blocks.forEach(([start, end], blockIndex) => {
        if (end <= start) issues.push(`第 ${number} 段时间块 ${start}–${end}秒 无效`)
        if (blockIndex > 0 && start !== blocks[blockIndex - 1][1]) {
          issues.push(`第 ${number} 段时间块 ${start}–${end}秒 与上一块 ${blocks[blockIndex - 1][0]}–${blocks[blockIndex - 1][1]}秒 不衔接`)
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
      if (!name) issues.push(`台词 ${id} 的说话人 ${line.characterId} 不在本幕人物中`)
      else if (!segment.characters.includes(line.characterId)) {
        issues.push(`第 ${number} 段说话人物 ${name}（${line.characterId}）未列入 characters`)
      }
      spokenHan += countHanCharacters(line.text)
      return `${name ?? line.characterId}说：“${line.text}”`
    }).replace(/”[。；]/g, '”')
    segmentLineIds.push(lineIds)
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

    return { characters: segment.characters, seconds: segment.seconds, prompt: prompt.trim() }
  })

  for (const line of dialogues) {
    if (!usedLineIds.includes(line.id)) {
      issues.push(`尚未安排 ${line.id}：${names.get(line.characterId) ?? line.characterId}“${line.text}”`)
    }
  }
  if (usedLineIds.length === dialogues.length && usedLineIds.some((id, index) => id !== dialogues[index].id)) {
    issues.push(`台词顺序必须与 narrative 一致：${dialogues.map((line) => line.id).join(' → ')}`)
  }
  const total = compiledSegments.reduce((sum, segment) => sum + segment.seconds, 0)
  if (total < MIN_TOTAL_SECONDS || total > MAX_TOTAL_SECONDS) {
    issues.push(`各段秒数合计 ${total} 秒，必须在 ${MIN_TOTAL_SECONDS}–${MAX_TOTAL_SECONDS} 秒之间`)
  }
  if (issues.length) {
    throw new Error(`视频计划存在以下问题：\n- ${issues.join('\n- ')}\n请修正后重新提交完整参数，保留全部原台词。`)
  }

  let start = 0
  const videoPrompts = compiledSegments.map((segment, index) => {
    const normalized = {
      sequence: index + 1,
      startTime: start,
      endTime: start + segment.seconds,
      characterIds: segment.characters,
      prompt: segment.prompt,
    }
    start = normalized.endTime
    return normalized
  })
  const video: VideoGenerationRequest = { totalDuration: start, style: plan.style.trim(), videoPrompts }
  if (!Check(videoGenerationRequestSchema, video)) {
    throw new Error('最终视频计划格式无效或超过长度上限，请精简无关修饰。')
  }
  const spokenLines = videoPrompts.flatMap((segment) =>
    [...segment.prompt.matchAll(/“([^”]*)”/g)].map((match) => match[1]),
  )
  if (spokenLines.length !== dialogues.length || spokenLines.some((text, index) => text !== dialogues[index].text)) {
    throw new Error('最终 prompt 台词与原文不一致，不能在占位符之外另写对白。')
  }

  const summary = [
    `视频计划已提交，共 ${videoPrompts.length} 段 ${video.totalDuration} 秒：`,
    ...videoPrompts.map((segment, index) => {
      const lines = segmentLineIds[index]
      return `第 ${segment.sequence} 段 ${segment.startTime}–${segment.endTime} 秒${lines.length ? `（${lines.join('、')}）` : '（无台词）'}`
    }),
    dialogues.length ? `台词 ${dialogues.map((line) => line.id).join('、')} 已全部按原顺序安排。` : '本幕无台词。',
  ].join('\n')
  return { video, summary }
}

export type WriteVideoPromptToolOptions = {
  getCharacters: () => SceneCharacter[]
  getDialogues: () => SceneDialogue[]
  // 返回非空字符串时拒绝本次调用，用于前置条件（场景未发布、选角未完成）。
  precondition?: () => string | null
  onPublish?: (plan: PreparedVideoPlan) => void | Promise<void>
}

export const createWriteVideoPromptTool = ({
  getCharacters,
  getDialogues,
  precondition,
  onPublish,
}: WriteVideoPromptToolOptions): AgentTool<typeof videoPlanSchema, PreparedVideoPlan> => ({
  name: 'write_video_prompt',
  label: '编写视频 Prompt',
  description: WRITE_VIDEO_PROMPT_DESCRIPTION,
  parameters: videoPlanSchema,
  prepareArguments: prepareVideoPlanArguments,
  executionMode: 'sequential',
  execute: async (_toolCallId, rawPlan) => {
    const blocked = precondition?.()
    if (blocked) throw new Error(blocked)
    const characters = getCharacters()
    if (!characters.length) throw new Error('必须先通过 publish_scene 发布本幕人物。')
    const { video, summary } = prepareVideoPlan(rawPlan, characters, getDialogues())
    const preparedPlan: PreparedVideoPlan = { video }
    await onPublish?.(preparedPlan)
    const compiled = compileVideoPlan(video)
    const text = [
      summary,
      '最终发送的 prompt：',
      ...compiled.videoPrompts.map((segment) => `【第 ${segment.sequence} 段】\n${segment.prompt}`),
      '下一步：确认无误后调用 finish_turn 结束本回合；需要修改可重新调用 write_video_prompt 覆盖。',
    ].join('\n\n')
    return {
      content: [{ type: 'text', text }],
      details: preparedPlan,
      terminate: false,
    }
  },
})

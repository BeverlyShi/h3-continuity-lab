import type { AgentTool } from '@earendil-works/pi-agent-core/node'
import { Check, Errors } from 'typebox/value'
import {
  videoPlanSchema,
  videoGenerationRequestSchema,
  type SceneCharacter,
  type SceneDialogue,
  type VideoPromptDraft,
  type ResolvedVideoBeat,
  type VideoGenerationRequest,
  type ResolvedVideoPromptDraft,
  type ResolvedVideoPromptDraftSegment,
} from '../src/types/story.ts'
import { compileVideoPlan } from './videoPromptCompiler.ts'
import { countHanCharacters } from './textMetrics.ts'

export type PreparedVideoPlan = { video: VideoGenerationRequest }

const SEGMENT_DURATION_CAP = 10
// 与 src/types/story.ts 中 videoPlanSchema.videoPrompts 上限保持一致。
const VIDEO_PROMPTS_MAX_ITEMS = 3

export const resolveVideoDialogues = (draft: VideoPromptDraft, dialogues: SceneDialogue[]): ResolvedVideoPromptDraft => {
  const byId = new Map(dialogues.map((line) => [line.id, line]))
  const usedIds: string[] = []
  const issues: string[] = []
  const videoPrompts = draft.videoPrompts.map((segment, segmentIndex) => ({
    ...segment,
    beats: segment.beats.map((beat, beatIndex) => {
      const slots = [...beat.visual.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1])
      const ids = beat.dialogueIds ?? []
      if (slots.length !== ids.length || slots.some((id, index) => id !== ids[index])) {
        issues.push(`第 ${segmentIndex + 1} 段第 ${beatIndex + 1} 镜的 visual 必须在实际说话位置按 dialogueIds 顺序各放一次 {{台词ID}}`)
      }
      if (/[{}]/.test(beat.visual.replace(/\{\{[^{}]+\}\}/g, '')) || /\{\{/.test(beat.audio)) {
        issues.push('台词占位符只能完整地出现在 visual 中，不能放在 audio 中')
      }
      return {
        ...beat,
        dialogue: (beat.dialogueIds ?? []).flatMap((id) => {
          const line = byId.get(id)
          if (!line) {
            issues.push(`第 ${segmentIndex + 1} 段第 ${beatIndex + 1} 个镜头引用了未知台词 ${id}`)
            return []
          }
          if (usedIds.includes(id)) issues.push(`台词 ${id} 重复安排，每句只能使用一次`)
          usedIds.push(id)
          return [{ id: line.id, characterId: line.characterId, text: line.text }]
        }),
      }
    }),
  }))
  for (const line of dialogues) {
    if (!usedIds.includes(line.id)) issues.push(`尚未安排 ${line.id}：${line.characterId}“${line.text}”`)
  }
  if (usedIds.length === dialogues.length && usedIds.some((id, index) => id !== dialogues[index].id)) {
    issues.push(`台词顺序必须与 narrative 一致：${dialogues.map((line) => line.id).join(' → ')}`)
  }
  if (issues.length) throw new Error(`视频台词覆盖校验失败：\n- ${issues.join('\n- ')}。请修正 dialogueIds，保留全部原台词。`)
  return { ...draft, videoPrompts }
}

// 每镜向上取整，保证不会把下一镜的余量当成本镜可用的说话时间。
const rawBeatDuration = (beat: ResolvedVideoBeat) => {
  const dialogueLength = (beat.dialogue ?? [])
    .reduce((total, dialogue) => total + countHanCharacters(dialogue.text), 0)
  if (!dialogueLength) return Math.max(1, beat.actionSeconds ?? 2)
  return Math.max(1.2, dialogueLength / 3.5 + (beat.actionSeconds ?? 0.5))
}

const renderBeat = (beat: ResolvedVideoBeat, characters: SceneCharacter[]) => {
  const names = new Map(characters.map((character) => [character.id, character.name]))
  let visual = beat.visual
  for (const line of beat.dialogue ?? []) {
    const name = names.get(line.characterId)
    if (!name) throw new Error(`台词人物 ${line.characterId} 缺少姓名映射。`)
    if (!line.id || !visual.includes(`{{${line.id}}}`)) {
      throw new Error('请在 visual 的实际说话位置插入每句台词的 {{台词ID}}，不能在整段动作之后追加台词。')
    }
    visual = visual.replace(`{{${line.id}}}`, () => `${name}说：“${line.text}”`)
  }
  if (/\{\{[^{}]*\}\}/.test(visual)) throw new Error('镜头存在未解析或重复的台词占位符。')
  return [visual, beat.audio]
    .filter(Boolean)
    .map((text) => text.trim().replace(/[；。]+$/, ''))
    .join('。') + '。'
}

// 单镜有独立时间块，因此段最小时长必须覆盖每镜取整后的预算。
const minimumSegmentDuration = (beats: ResolvedVideoBeat[]) =>
  beats.reduce((total, beat) => total + Math.ceil(rawBeatDuration(beat)), 0)

// 各镜保留完整整数秒预算，段级额外停留时间放入末镜。
const computeBeatDurations = (beats: ResolvedVideoBeat[], duration: number) => {
  const durations = beats.map((beat) => Math.ceil(rawBeatDuration(beat)))
  durations[durations.length - 1] += duration - durations.reduce((sum, value) => sum + value, 0)
  return durations
}

// 按拍顺序贪心切块：累加原始时长，一旦超过单段上限（按 ceil 判断）就在该拍之前切开。
const greedySplitBeatIndices = (beats: ResolvedVideoBeat[]): number[][] => {
  const chunks: number[][] = []
  let current: number[] = []
  let currentRaw = 0
  beats.forEach((beat, index) => {
    const raw = Math.ceil(rawBeatDuration(beat))
    if (current.length && Math.ceil(currentRaw + raw) > SEGMENT_DURATION_CAP) {
      chunks.push(current)
      current = []
      currentRaw = 0
    }
    current.push(index)
    currentRaw += raw
  })
  if (current.length) chunks.push(current)
  return chunks
}

const allocateSegmentDurations = (video: ResolvedVideoPromptDraft) => {
  const durations = video.videoPrompts.map((segment) =>
    Math.max(5, minimumSegmentDuration(segment.beats)),
  )
  let total = durations.reduce((sum, duration) => sum + duration, 0)
  let index = 0
  while (total < 15) {
    if (durations[index] < 10) {
      durations[index] += 1
      total += 1
    }
    index = (index + 1) % durations.length
  }
  return durations
}

export const normalizeVideoPlan = (video: ResolvedVideoPromptDraft, characters: SceneCharacter[]): VideoGenerationRequest => {
  const durations = allocateSegmentDurations(video)
  let absoluteStart = 0
  const videoPrompts = video.videoPrompts.map((segment, segmentIndex) => {
    const duration = durations[segmentIndex]
    const beatDurations = computeBeatDurations(segment.beats, duration)
    let relativeStart = 0
    const prompt = segment.beats.map((beat, beatIndex) => {
      const relativeEnd = relativeStart + beatDurations[beatIndex]
      const block = `${relativeStart}–${relativeEnd}秒：${renderBeat(beat, characters)}`
      relativeStart = relativeEnd
      return block
    }).join('\n\n')
    const normalized = {
      sequence: segmentIndex + 1,
      startTime: absoluteStart,
      endTime: absoluteStart + duration,
      characterIds: segment.characterIds,
      prompt,
      endFrame: segment.endFrame,
      audio: segment.beats.map((beat) => beat.audio).join('；'),
    }
    absoluteStart = normalized.endTime
    return normalized
  })
  return { visualContext: video.visualContext, totalDuration: absoluteStart, videoPrompts }
}

export const collectVideoPlanIssues = (
  video: ResolvedVideoPromptDraft,
  characters: SceneCharacter[],
) => {
  const issues: string[] = []
  const knownCharacterIds = new Set(characters.map((character) => character.id))

  video.videoPrompts.forEach((segment, segmentIndex) => {
    const segmentNumber = segmentIndex + 1
    const segmentCharacterIds = new Set(segment.characterIds)
    segment.characterIds.forEach((characterId) => {
      if (!knownCharacterIds.has(characterId)) {
        issues.push(`第 ${segmentNumber} 段引用了未声明的人物 ${characterId}`)
      }
    })
    segment.beats.forEach((beat, beatIndex) => {
      const dialogueLines = beat.dialogue ?? []
      dialogueLines.forEach((dialogue) => {
        if (!knownCharacterIds.has(dialogue.characterId)) {
          issues.push(`第 ${segmentNumber} 段第 ${beatIndex + 1} 个节拍的台词引用了未声明人物 ${dialogue.characterId}`)
        } else if (!segmentCharacterIds.has(dialogue.characterId)) {
          issues.push(`第 ${segmentNumber} 段第 ${beatIndex + 1} 个节拍的说话人物 ${dialogue.characterId} 未列入 characterIds`)
        }
      })
    })
    const rawDurations = segment.beats.map(rawBeatDuration)
    const requiredDuration = minimumSegmentDuration(segment.beats)
    if (requiredDuration > SEGMENT_DURATION_CAP) {
      const breakdown = segment.beats.map((beat, beatIndex) => {
        const hanCount = (beat.dialogue ?? [])
          .reduce((total, dialogue) => total + countHanCharacters(dialogue.text), 0)
        return `第 ${beatIndex + 1} 拍 ${hanCount} 字≈${rawDurations[beatIndex].toFixed(1)} 秒`
      }).join('，')
      let suggestion = '已发布台词不可删改；请在现有 3 段上限内重新分配镜头和台词'
      if (segment.beats.length > 1) {
        const chunks = greedySplitBeatIndices(segment.beats)
        if (chunks.length > 1) suggestion += `，可从第 ${chunks[1][0] + 1} 个镜头开始拆段`
      }
      suggestion += '；仍无法容纳时报告时长冲突，不要删词或加速台词'
      issues.push(
        `第 ${segmentNumber} 段估算 ${requiredDuration} 秒（${breakdown}），超过 ${SEGMENT_DURATION_CAP} 秒上限；${suggestion}。`,
      )
    }
  })

  return issues
}

// 对超时且能拆分的段按拍贪心切块，拆完总段数超过 schema 上限时放弃并保留原 draft。
export const autoSplitVideoDraft = (
  draft: ResolvedVideoPromptDraft,
): { draft: ResolvedVideoPromptDraft; notes: string[] } => {
  const notes: string[] = []
  const newSegments: ResolvedVideoPromptDraftSegment[] = []
  let didSplit = false

  draft.videoPrompts.forEach((segment, segmentIndex) => {
    const requiredDuration = minimumSegmentDuration(segment.beats)
    if (requiredDuration > SEGMENT_DURATION_CAP && segment.beats.length >= 2) {
      const chunks = greedySplitBeatIndices(segment.beats)
      if (chunks.length > 1 && chunks.slice(0, -1).every((chunk) => segment.beats[chunk.at(-1)!].endFrame)) {
        didSplit = true
        const createdSegmentNumbers: number[] = []
        chunks.forEach((chunkIndices, chunkIndex) => {
          const chunkBeats = chunkIndices.map((index) => segment.beats[index])
          const isLast = chunkIndex === chunks.length - 1
          newSegments.push({
            characterIds: segment.characterIds,
            beats: chunkBeats,
            endFrame: isLast ? segment.endFrame : chunkBeats[chunkBeats.length - 1].endFrame!,
          })
          createdSegmentNumbers.push(newSegments.length)
        })
        notes.push(
          `第 ${segmentIndex + 1} 段估算 ${requiredDuration} 秒，已自动拆为第 ${createdSegmentNumbers.join('、')} 段`,
        )
        return
      }
    }
    newSegments.push(segment)
  })

  if (!didSplit) return { draft, notes: [] }
  if (newSegments.length > VIDEO_PROMPTS_MAX_ITEMS) return { draft, notes: [] }
  return { draft: { ...draft, videoPrompts: newSegments }, notes }
}

export const assertValidVideoDraft = (
  video: ResolvedVideoPromptDraft,
  characters: SceneCharacter[],
) => {
  const issues = collectVideoPlanIssues(video, characters)
  if (issues.length) throw new Error(`视频计划存在以下问题：\n- ${issues.join('\n- ')}`)
}

export const assertValidVideoPlan = (
  video: VideoGenerationRequest,
  characters: SceneCharacter[],
) => {
  const issues: string[] = []
  const knownCharacterIds = new Set(characters.map((character) => character.id))
  video.videoPrompts.forEach((segment, index) => {
    const previous = video.videoPrompts[index - 1]
    if (segment.sequence !== index + 1 || segment.startTime !== (previous?.endTime ?? 0)) {
      issues.push(`第 ${index + 1} 段没有按顺序连续排列`)
    }
    const duration = segment.endTime - segment.startTime
    if (duration < 5 || duration > 10) issues.push(`第 ${index + 1} 段时长 ${duration} 秒不在 5–10 秒范围内`)
    segment.characterIds.forEach((characterId) => {
      if (!knownCharacterIds.has(characterId)) issues.push(`第 ${index + 1} 段引用了未声明的人物 ${characterId}`)
    })
  })
  if (video.videoPrompts.at(-1)?.endTime !== video.totalDuration) {
    issues.push('最后一段结束时间与 totalDuration 不一致')
  }
  if (video.totalDuration < 15 || video.totalDuration > 30) {
    issues.push(`视频总时长 ${video.totalDuration} 秒不在 15–30 秒范围内`)
  }
  if (issues.length) throw new Error(`视频计划存在以下问题：\n- ${issues.join('\n- ')}`)
}

const unwrapLegacyVideoPlan = (args: unknown) => {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args
  const entries = Object.entries(args)
  return entries.length === 1 && entries[0][0] === 'video' ? entries[0][1] : args
}

export const VIDEO_PLAN_ARGUMENTS_EXAMPLE = JSON.stringify({
  visualContext: {
    style: '写实古装画面，清晨自然光从廊外照入。',
    scene: '宫门内侧廊柱旁的一小块青石平台。',
  },
  videoPrompts: [
    {
      characterIds: ['heroine', 'steward'],
      beats: [{
        visual: '固定双人中景，机位与视线齐平，从廊柱侧面拍摄。女主在画面左侧停步，右侧姑姑面朝她。{{line_1}}。',
        dialogueIds: ['line_1'],
        actionSeconds: 0.5,
        endFrame: '双人中景，女主在左侧廊柱旁，姑姑在右侧面朝她。',
        audio: '女主停步时鞋底轻擦石面，背景有轻微风声。',
      }],
      endFrame: '女主停在左侧廊柱旁，姑姑在右侧面朝她。',
    },
    {
      characterIds: ['heroine'],
      beats: [{
        visual: '硬切至女主正面近景，机位与视线齐平，镜头固定。女主抬头望向画外右侧的姑姑，闭口等候。',
        dialogueIds: [],
        actionSeconds: 2,
        endFrame: '近景，女主抬头望向画外右侧，双手垂在身前。',
        audio: '廊外传来轻微风声。',
      }],
      endFrame: '女主抬头望向画外右侧，双手垂在身前。',
    },
  ],
})

export const VIDEO_PLAN_STRUCTURE_GUIDANCE = '顶层只包含 visualContext、videoPrompts。每个 videoPrompts 片段只包含 characterIds、beats、endFrame；每个 beat 包含 visual、audio 和可选 dialogueIds、actionSeconds、endFrame。characterIds 放在片段层，片段 endFrame 必填；beat 的 endFrame 描述该镜最终状态，供自动拆段使用。audio 放在每个 beat 内。'

export const prepareVideoPlanArguments = (args: unknown): VideoPromptDraft => {
  const prepared = unwrapLegacyVideoPlan(args)
  if (Check(videoPlanSchema, prepared)) return prepared
  const issues = [...Errors(videoPlanSchema, prepared)].slice(0, 8)
    .map((issue) => `${issue.instancePath || '/'} ${issue.message}${issue.keyword === 'additionalProperties' ? `: ${issue.params.additionalProperties.join(', ')}` : ''}`)
    .join('；')
  throw new Error(`write_video_prompt 参数不符合 schema：${issues || '结构无效'}。\n${VIDEO_PLAN_STRUCTURE_GUIDANCE}\n修正所有片段中的同类错误后重新提交完整 JSON，不只提交修改片段。结构示例（请替换为本幕内容，台词 ID 以本次输入为准）：${VIDEO_PLAN_ARGUMENTS_EXAMPLE}`)
}

export const WRITE_VIDEO_PROMPT_DESCRIPTION = `${VIDEO_PLAN_STRUCTURE_GUIDANCE}提交已发布剧情的连续镜头。每个 beat 只拍一个主要动作，visual 先明确景别、机位朝向和镜头运动，再描述位置、动作和表情；dialogueIds 引用已发布台词，在 visual 的实际说话位置插入对应 {{台词ID}}；actionSeconds 估计额外动作时长，beat.endFrame 给出该镜最终可见状态。audio 仅对应本镜头；全幕必须按原顺序且恰好一次使用每句台词，禁止重新编写或删改台词正文。依据实际参考素材避免重复人物外观，将开场和结尾融入镜头。程序只计算时间和排版，不会补写缺失的镜头内容。`

export const prepareVideoPlan = (rawDraft: unknown, characters: SceneCharacter[], dialogues: SceneDialogue[]) => {
  const resolved = resolveVideoDialogues(prepareVideoPlanArguments(rawDraft), dialogues)
  const { draft, notes } = autoSplitVideoDraft(resolved)
  assertValidVideoDraft(draft, characters)
  const video = normalizeVideoPlan(draft, characters)
  assertValidVideoPlan(video, characters)
  if (!Check(videoGenerationRequestSchema, video)) throw new Error('最终视频计划格式无效或超过长度上限，请精简无关修饰。')
  const spokenLines = video.videoPrompts.flatMap((segment) =>
    [...segment.prompt.matchAll(/“([^”]*)”/g)].map((match) => match[1]),
  )
  if (spokenLines.length !== dialogues.length || spokenLines.some((text, index) => text !== dialogues[index].text)) {
    throw new Error('最终 prompt 台词与原文不一致，不能在占位符之外另写对白。')
  }
  const prose = video.videoPrompts.map((segment) => segment.prompt.replace(/“[^”]*”/g, '')).join('\n')
  for (const character of characters) {
    if (character.id === character.name) continue
    const escaped = character.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(prose)) {
      throw new Error(`最终 prompt 泄漏了内部角色 ID ${character.id}，请在镜头正文使用 ${character.name}。`)
    }
  }
  return { video, notes }
}

export const createWriteVideoPromptTool = (
  characterSource: SceneCharacter[] | (() => SceneCharacter[]),
  dialogues: SceneDialogue[],
  onPublish?: (plan: PreparedVideoPlan) => void | Promise<void>,
  review?: (video: VideoGenerationRequest) => Promise<void>,
): AgentTool<typeof videoPlanSchema, PreparedVideoPlan> => ({
  name: 'write_video_prompt',
  label: '编写视频 Prompt',
  description: WRITE_VIDEO_PROMPT_DESCRIPTION,
  parameters: videoPlanSchema,
  prepareArguments: prepareVideoPlanArguments,
  executionMode: 'parallel',
  execute: async (_toolCallId, rawDraft) => {
    const characters = typeof characterSource === 'function' ? characterSource() : characterSource
    if (!characters.length) throw new Error('必须先通过 publish_scene 发布本幕人物。')
    const { video, notes } = prepareVideoPlan(rawDraft, characters, dialogues)
    await review?.(compileVideoPlan(video))
    const preparedPlan: PreparedVideoPlan = { video }
    await onPublish?.(preparedPlan)
    const text = notes.length ? `视频计划已提交。\n- ${notes.join('\n- ')}` : '视频计划已提交。'
    return {
      content: [{ type: 'text', text }],
      details: preparedPlan,
      terminate: true,
    }
  },
})

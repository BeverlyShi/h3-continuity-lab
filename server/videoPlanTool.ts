import type { AgentTool } from '@earendil-works/pi-agent-core/node'
import { Check, Errors } from 'typebox/value'
import {
  videoPlanSchema,
  type SceneCharacter,
  type VideoBeat,
  type VideoGenerationRequest,
  type VideoPromptDraft,
} from '../src/types/story.ts'

export type PreparedVideoPlan = { video: VideoGenerationRequest }

const countHanCharacters = (value: string) => value.match(/\p{Script=Han}/gu)?.length ?? 0

const beatDuration = (beat: VideoBeat) => {
  const dialogueLength = (beat.dialogue ?? [])
    .reduce((total, dialogue) => total + countHanCharacters(dialogue.text), 0)
  if (!dialogueLength) return 2
  return Math.ceil(Math.max(1.2, dialogueLength / 3.5 + 0.5))
}

const renderBeat = (beat: VideoBeat) => {
  const dialogue = (beat.dialogue ?? [])
    .map((line) => `${line.characterId}说“${line.text}”`)
    .join('；')
  return dialogue ? `${beat.visual}；${dialogue}` : beat.visual
}

const minimumSegmentDuration = (beats: VideoBeat[]) =>
  beats.reduce((total, beat) => total + beatDuration(beat), 0)

const allocateSegmentDurations = (video: VideoPromptDraft) => {
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

export const normalizeVideoPlan = (video: VideoPromptDraft): VideoGenerationRequest => {
  const durations = allocateSegmentDurations(video)
  let absoluteStart = 0
  const videoPrompts = video.videoPrompts.map((segment, segmentIndex) => {
    const duration = durations[segmentIndex]
    const minimumDurations = segment.beats.map(beatDuration)
    const spareSeconds = duration - minimumDurations.reduce((sum, value) => sum + value, 0)
    const beatDurations = minimumDurations.map((value, index) =>
      index === minimumDurations.length - 1 ? value + spareSeconds : value,
    )
    let relativeStart = 0
    const prompt = segment.beats.map((beat, beatIndex) => {
      const relativeEnd = relativeStart + beatDurations[beatIndex]
      const block = `${relativeStart}–${relativeEnd}秒：${renderBeat(beat)}`
      relativeStart = relativeEnd
      return block
    }).join('\n')
    const normalized = {
      sequence: segmentIndex + 1,
      startTime: absoluteStart,
      endTime: absoluteStart + duration,
      characterIds: segment.characterIds,
      prompt,
      endFrame: segment.endFrame,
      audio: segment.audio,
    }
    absoluteStart = normalized.endTime
    return normalized
  })
  return { visualContext: video.visualContext, totalDuration: absoluteStart, videoPrompts }
}

export const collectVideoPlanIssues = (
  video: VideoPromptDraft,
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
    const requiredDuration = minimumSegmentDuration(segment.beats)
    if (requiredDuration > 10) {
      issues.push(`第 ${segmentNumber} 段至少需要 ${requiredDuration} 秒，超过单段 10 秒上限，请精简台词或拆分节拍`)
    }
  })

  return issues
}

export const assertValidVideoDraft = (
  video: VideoPromptDraft,
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

export const prepareVideoPlanArguments = (args: unknown): VideoPromptDraft => {
  const prepared = unwrapLegacyVideoPlan(args)
  if (Check(videoPlanSchema, prepared)) return prepared
  const issues = [...Errors(videoPlanSchema, prepared)].slice(0, 8)
    .map((issue) => `${issue.instancePath || '/'} ${issue.message}`)
    .join('；')
  throw new Error(`write_video_prompt 参数不符合 schema：${issues || '结构无效'}。`)
}

export const createWriteVideoPromptTool = (
  characterSource: SceneCharacter[] | (() => SceneCharacter[]),
  onPublish?: (plan: PreparedVideoPlan) => void | Promise<void>,
): AgentTool<typeof videoPlanSchema, PreparedVideoPlan> => ({
  name: 'write_video_prompt',
  label: '编写视频 Prompt',
  description: '提交按剧情顺序排列的镜头节拍；程序负责计算时长并编译视频 Prompt。',
  parameters: videoPlanSchema,
  prepareArguments: prepareVideoPlanArguments,
  executionMode: 'parallel',
  execute: async (_toolCallId, draft) => {
    const characters = typeof characterSource === 'function' ? characterSource() : characterSource
    if (!characters.length) throw new Error('必须先通过 publish_scene 发布本幕人物。')
    assertValidVideoDraft(draft, characters)
    const video = normalizeVideoPlan(draft)
    assertValidVideoPlan(video, characters)
    const preparedPlan: PreparedVideoPlan = { video }
    await onPublish?.(preparedPlan)
    return {
      content: [{ type: 'text', text: '视频计划已提交。' }],
      details: preparedPlan,
      terminate: true,
    }
  },
})

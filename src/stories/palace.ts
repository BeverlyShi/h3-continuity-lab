import type { StoryInput } from '../types/story'

export const palaceStory = {
  id: 'palace-validation',
  title: '后宫',
  summary: '一名秀女初入宫闱，在友情、爱情、亲情与宫中人情之间作出自己的选择。',
  role: '初入宫闱的秀女',
} as const

export const describeStoryInput = (input: StoryInput) => {
  if (input.type === 'start') return '请开始故事'
  if (input.type === 'freeform') return input.text
  return input.choice.text
}

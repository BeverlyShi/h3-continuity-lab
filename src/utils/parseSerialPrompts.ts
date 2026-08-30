export const MAX_SERIAL_PROMPTS = 10
export const MAX_PROMPT_LENGTH = 1000

export type SerialPromptParseResult = {
  prompts: string[]
  error?: string
}

const PROMPT_HEADER = /^\s*prompt\s*(\d+)\s*[:：]\s*(.*)$/i

export function parseSerialPrompts(input: string): SerialPromptParseResult {
  if (!input.trim()) return { prompts: [] }

  const entries: Array<{ number: string; lines: string[] }> = []
  let currentEntry: { number: string; lines: string[] } | undefined

  for (const line of input.split(/\r?\n/)) {
    const header = line.match(PROMPT_HEADER)
    if (header) {
      currentEntry = { number: header[1], lines: [header[2]] }
      entries.push(currentEntry)
      continue
    }

    if (currentEntry) {
      currentEntry.lines.push(line)
    } else if (line.trim()) {
      return { prompts: [], error: '请从 Prompt 1: 开始输入' }
    }
  }

  if (entries.length === 0) {
    return { prompts: [], error: '请使用 Prompt 1:、Prompt 2: 的格式输入' }
  }

  if (entries.length > MAX_SERIAL_PROMPTS) {
    return {
      prompts: entries.map((entry) => entry.lines.join('\n').trim()),
      error: `最多支持 ${MAX_SERIAL_PROMPTS} 个 Prompt，当前识别到 ${entries.length} 个`,
    }
  }

  const prompts = entries.map((entry) => entry.lines.join('\n').trim())
  const emptyIndex = prompts.findIndex((prompt) => !prompt)
  if (emptyIndex >= 0) {
    return { prompts, error: `Prompt ${entries[emptyIndex].number} 内容为空` }
  }

  const oversizedIndex = prompts.findIndex((prompt) => prompt.length > MAX_PROMPT_LENGTH)
  if (oversizedIndex >= 0) {
    return {
      prompts,
      error: `Prompt ${entries[oversizedIndex].number} 超过 ${MAX_PROMPT_LENGTH} 个字符`,
    }
  }

  return { prompts }
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSerialPrompts } from '../src/utils/parseSerialPrompts.ts'

test('parses inline and multiline prompts in appearance order', () => {
  assert.deepEqual(
    parseSerialPrompts('Prompt 7: first\nline two\n\nprompt 2：second').prompts,
    ['first\nline two', 'second'],
  )
})

test('rejects content before the first prompt header', () => {
  assert.equal(
    parseSerialPrompts('intro\nprompt 1: first').error,
    '请从 Prompt 1: 开始输入',
  )
})

test('reports empty prompts', () => {
  assert.equal(
    parseSerialPrompts('prompt 1: first\nprompt 2:\nprompt 3: third').error,
    'Prompt 2 内容为空',
  )
})

test('rejects batches larger than ten prompts', () => {
  const input = Array.from({ length: 11 }, (_, index) => `prompt ${index + 1}: item`).join('\n')
  assert.equal(
    parseSerialPrompts(input).error,
    '最多支持 10 个 Prompt，当前识别到 11 个',
  )
})

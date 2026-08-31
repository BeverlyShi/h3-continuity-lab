import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { unregisteredCity } from '../src/stories/unregisteredCity.ts'
import { DIRECTOR_SYSTEM_PROMPT } from '../server/directorPrompt.ts'

test('keeps the complete immutable story bible in the director system prompt', () => {
  assert.match(DIRECTOR_SYSTEM_PROMPT, /持久总导演/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, new RegExp(unregisteredCity.coreRules[0]))
  assert.match(DIRECTOR_SYSTEM_PROMPT, /燕七/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /拒绝射杀一队没有通行籍的难民/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /decision_schema/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /directorBoardPatch/)
  assert.doesNotMatch(DIRECTOR_SYSTEM_PROMPT, /read_game_state/)
  assert.doesNotMatch(DIRECTOR_SYSTEM_PROMPT, /publish_turn/)
  assert.match(DIRECTOR_SYSTEM_PROMPT, /不调用任何视频生成/)
})

test('keeps director model thinking disabled', async () => {
  const source = await readFile(new URL('../server/directorAgent.ts', import.meta.url), 'utf8')
  assert.match(source, /thinkingLevel: 'off'/)
})

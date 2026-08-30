import assert from 'node:assert/strict'
import test from 'node:test'
import { unregisteredCity } from '../src/stories/unregisteredCity.ts'

test('unregistered city exposes the required structured story fields', () => {
  assert.equal(unregisteredCity.id, 'unregistered-city-quick')
  assert.equal(unregisteredCity.title, '无籍之城')
  assert.ok(unregisteredCity.summary.length > 0)
  assert.ok(unregisteredCity.coreRules.length >= 3)
  assert.equal(unregisteredCity.characters.length, 4)
  assert.equal(unregisteredCity.initialOptions.length, 2)
  assert.equal(unregisteredCity.maxTurns, 5)
  assert.match(unregisteredCity.openingPrompt, /5-second/)
  assert.match(unregisteredCity.openingPrompt, /16:9/)
})

test('core rules preserve the quick-version game constraints', () => {
  const rules = unregisteredCity.coreRules.join('\n')
  assert.match(rules, /驿站的老板/)
  assert.match(rules, /三张宿籍/)
  assert.match(rules, /日落后会迅速消亡/)
})

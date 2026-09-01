import assert from 'node:assert/strict'
import test from 'node:test'
import { isDirectorActive } from '../src/services/directorStatus.ts'

test('does not treat a restored idle director as an active request', () => {
  assert.equal(isDirectorActive('idle'), false)
  assert.equal(isDirectorActive('error'), false)
})

test('treats director generation stages as active work', () => {
  assert.equal(isDirectorActive('thinking'), true)
  assert.equal(isDirectorActive('publishing'), true)
})

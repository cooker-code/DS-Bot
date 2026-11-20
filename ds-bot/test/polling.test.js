import assert from 'node:assert/strict'
import { test } from 'node:test'
import { POLL_MAX_MS, pollDelay } from '../src/client/polling.js'

test('the state poll stretches while nothing changes and snaps back when something does', () => {
  // Something changed: the visible cadence stays.
  assert.equal(pollDelay(1500, 0), 1500)
  // Then it stretches, and stops at the cap however long the window sits still.
  assert.equal(pollDelay(1500, 1), 3000)
  assert.equal(pollDelay(1500, 2), POLL_MAX_MS)
  assert.equal(pollDelay(1500, 3), POLL_MAX_MS)
  assert.equal(pollDelay(1500, 99), POLL_MAX_MS)
  // A hidden window already polls more slowly than the cap: it keeps its own cadence.
  assert.equal(pollDelay(10_000, 0), 10_000)
  assert.equal(pollDelay(10_000, 5), 10_000)
  // A negative or missing count is the same as none.
  assert.equal(pollDelay(1500, -3), 1500)
})

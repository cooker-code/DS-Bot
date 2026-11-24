import assert from 'node:assert/strict'
import test from 'node:test'
import { taskInteractions } from '../src/host/task-interactions.js'

test('task history joins delivered exchanges, scoped posts and coordination with visible history gaps', async () => {
  const card = { id: 'work', intakes: ['intake-1'], rounds: [] }
  const room = { id: 'group', members: ['dev', 'manager'], sessions: { dev: 'd', manager: 'm' } }
  const events = [1, 2, 3, 4].map(seq => ({ seq, time: seq + 5, type: 'user/message', data: {
    source: { kind: 'bot', role: 'request', exchangeId: String(seq), roomId: 'group',
      taskId: seq === 3 ? 'unrelated' : 'work', projectActorId: 'manager' },
    content: [{ type: 'text', text: 'header\nbody' + seq }] } }))
  const rt = {
    ledger: { records: () => [{ seq: 1, time: 2, intakeId: 'intake-1', who: 'User', text: 'Requirement' }] },
    taskPairMessages: () => [{ id: '1', time: 5, roomId: 'group', from: 'manager', to: 'dev', taskId: 'work', text: 'Assign' },
      { id: 'x', roomId: 'other', taskId: 'work', text: 'Other room' }],
    eventsBackwards: async function* (id) {
      if (id === 'm') throw new Error('archived session unavailable')
      yield* events.toReversed()
    },
  }
  async function read() {
    const { messages, incomplete } = await taskInteractions(rt, room, card)
    assert.equal(incomplete, true)
    return messages.map(m => [m.text, m.from, m.to])
  }
  const expected = [['Requirement', undefined, undefined], ['Assign', 'manager', 'dev'], ['body2', 'manager', 'dev'], ['body4', 'manager', 'dev']]
  assert.deepEqual(await read(), expected)
  assert.deepEqual(await read(), expected)
})

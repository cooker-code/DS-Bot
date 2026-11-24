import assert from 'node:assert/strict'
import test from 'node:test'
import { taskInteractions } from '../src/host/task-interactions.js'

test('task history joins delivered exchanges, scoped posts and coordination with visible history gaps', async () => {
  const card = { id: 'work', intakes: ['intake-1'], rounds: [] }
  const room = { id: 'group', members: ['dev', 'manager'], sessions: { dev: 'd', manager: 'm' } }
  const events = [1, 2, 3, 4].map(seq => ({ seq, time: seq + 5, type: 'user/message', data: {
    source: { kind: 'bot', role: 'request', exchangeId: String(seq), roomId: 'group',
      taskId: seq === 3 ? 'unrelated' : 'work', projectActorId: 'manager', ...(seq === 4 && { handoffText: 'actual question' }) },
    content: [{ type: 'text', text: 'header\nbody' + seq }] } }))
  const rt = {
    ledger: { records: () => [{ seq: 1, time: 2, intakeId: 'intake-1', who: 'User', text: 'Requirement' }] },
    taskPairMessages: () => [{ id: '1', time: 5, roomId: 'group', from: 'manager', to: 'dev', taskId: 'work', text: 'Assign' },
      { id: 'x', roomId: 'other', taskId: 'work', text: 'Other room' }],
    ctx: { sessionController: { async page({ address, beforeSeq }) {
      if (address.sessionId === 'm') throw new Error('archived session unavailable')
      const batch = beforeSeq === undefined ? events.slice(2) : events.slice(0, 2)
      return { records: batch.map(event => ({ event })), hasMore: beforeSeq === undefined }
    } } },
  }
  async function read() {
    const { messages, incomplete } = await taskInteractions(rt, room, card)
    assert.equal(incomplete, true)
    return messages.map(m => [m.text, m.from, m.to])
  }
  const expected = [['Assign', 'manager', 'dev'], ['actual question', 'manager', 'dev']]
  assert.deepEqual(await read(), expected)
  assert.deepEqual(await read(), expected)
})

test('a delivered group call uses the original post and keeps retries distinct across refreshes', async () => {
  const room = { id: 'group', members: ['lead', 'dev'], sessions: { dev: 'thread' } }
  const text = '@Dev please check\n**first**'
  const post = { seq: 1, time: 1, taskId: 'work', botId: 'lead', who: 'Lead', text }
  const events = [{ groupHandoffSeqs: [1, 2] }, { retried: true }, { resumed: true, exchangeId: 'restart', retryOf: 'turn' }]
    .map((extra, i) => ({ event: { seq: i + 1, time: i + 2, type: 'user/message', data: {
      source: { kind: 'bot', role: 'room', taskId: 'work', roomId: room.id, exchangeId: 'turn', ...extra },
      content: [{ type: 'text', text: 'header\nHost context' }],
    } } }))
  const rt = { ledger: { records: () => [post, { ...post, seq: 2, taskId: 'other' }] },
    taskPairMessages: () => [], ctx: { sessionController: { page: async () => ({ records: events }) } } }
  for (let refresh = 0; refresh < 2; refresh++) {
    const { messages } = await taskInteractions(rt, room, { id: 'work' })
    assert.equal(messages.length, 1)
    assert.deepEqual([messages[0].from, messages[0].to, messages[0].text], ['lead', 'dev', text])
    assert.deepEqual(messages[0].retries.map(r => r.restart), [false, true])
  }
})

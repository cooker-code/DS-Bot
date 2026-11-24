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

test('legacy sender sessions link parallel sends and returned group results to their actual input', async () => {
  const bots = [{ id: 'lead', name: 'Lead' }, { id: 'dev', name: 'Dev' }, { id: 'req', name: 'Req' }]
  const room = { id: 'group', members: bots.map(b => b.id), sessions: { lead: 'l', dev: 'd', req: 'r' } }
  const report = '@Lead development report'
  const result = 'Lead final result'
  const posts = [
    { seq: 1, time: 5, taskId: 'work', botId: 'dev', who: 'Dev', text: report },
    { seq: 2, time: 17, taskId: 'work', botId: 'lead', who: 'Lead', text: result },
  ]
  const pairs = [
    { id: 'initial', time: 1, from: 'lead', to: 'dev', text: 'Initial' },
    { id: 'code', time: 11, from: 'lead', to: 'dev', text: 'Code' },
    { id: 'spec', time: 14, from: 'lead', to: 'req', text: 'Spec' },
  ].map(r => ({ ...r, taskId: 'work' }))
  const user = (time, exchangeId, role, text, extra = {}) => ({ time, type: 'user/message', data: {
    source: { kind: 'bot', taskId: 'work', roomId: 'group', exchangeId, role, ...extra },
    content: [{ type: 'text', text }],
  } })
  const call = (time, name, message, to) => ({ time, type: 'tool/call', data: {
    callId: String(time), name, arguments: JSON.stringify({ taskId: 'work', message, to }),
  } })
  const done = (time, callId) => ({ time, type: 'tool/result', data: { message: { toolCallId: String(callId) } } })
  const events = {
    d: [user(2, 'initial', 'request', 'Initial'),
      { time: 2, type: 'user/message', data: { source: { kind: 'time-context' } } },
      call(3, 'post_to_group', report), done(4, 3),
      user(18, 'return', 'room', 'header · Lead finished the work you asked for]\nThis round so far (oldest first):\nDev: ' + report + '\nLead: ' + result)],
    l: [user(6, 'feedback', 'room', 'header\nThis round so far (oldest first):\nDev: ' + report, { askedBy: 'dev' }),
      call(10, 'message_bot', 'Code', 'Dev'), done(12, 10),
      call(13, 'message_bot', 'Spec', 'Req'), done(15, 13),
      { time: 16, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: result }] } } }],
    r: [],
  }
  const rt = { botOf: id => bots.find(b => b.id === id), ledger: { records: () => posts },
    taskPairMessages: (a, b) => pairs.filter(p => [a, b].includes(p.from) && [a, b].includes(p.to)),
    ctx: { sessionController: { page: async ({ address }) => ({
      records: events[address.sessionId].map((event, seq) => ({ event: { ...event, seq } })),
    }) } } }
  for (let refresh = 0; refresh < 2; refresh++) {
    const { messages } = await taskInteractions(rt, room, { id: 'work' })
    assert.deepEqual(messages.map(m => [m.exchangeId, m.replyTo]), [
      ['initial', undefined], ['feedback', 'initial'], ['code', 'feedback'], ['spec', 'feedback'], ['return', 'feedback'],
    ])
    assert.equal(messages.at(-1).text, result)
  }
})

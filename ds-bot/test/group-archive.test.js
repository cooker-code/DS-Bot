import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupDiscussions, setDiscussionArchive } from '../src/host/group-archive.js'

test('group archive spans pages and parts; skips live work and keeps restores scoped', async () => {
  const room = { id: 'one', parts: [{ sessionId: 'old' }], seq: 4 }
  const sessions = {}
  const book = []
  for (const [i, part] of ['old', 'new'].entries()) {
    const from = 1 + i * 2
    const anchor = part + '-call'
    book.push({ event: 'anchor', from, id: anchor })
    sessions[part] = [
      ['turn/start', { turn: 1 }],
      ['user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: part }] }],
      ['tool/call', { name: 'group_relay', callId: anchor }],
      ['tool/result', { message: { toolCallId: anchor, content: [{ type: 'text', text: JSON.stringify({ from, anchor }) }] } }],
      ['turn/end', { turn: 1 }],
    ].map(([type, data], seq) => ({ event: { type, data, time: seq, seq } }))
  }
  book.push({ event: 'round', from: 1, to: 2 })
  const ctx = { sessionController: { page: async ({ address, beforeSeq = 5 }) => ({
    records: sessions[address.sessionId].slice(Math.max(0, beforeSeq - 2), beforeSeq), hasMore: beforeSeq > 2,
  }) } }
  const rt = { ledger: { records: () => book }, sessionOfRoom: () => 'new', roomOf: () => room,
    roomActive: () => true, save: async ({ mutate }) => { mutate() } }
  const list = await groupDiscussions(ctx, rt, room)
  assert.deepEqual(list.map(row => [row.id, row.title, !!row.active]), [['old/1', 'old', false], ['new/1', 'new', true]])
  const write = (action, ids) => setDiscussionArchive(ctx, rt, room, { action, ids })
  await assert.rejects(write('archive', ['old/1', 'new/1']))
  assert.equal(room.archivedDiscussions, undefined)
  await write('archive', ['old/1'])
  await write('archive', ['old/1'])
  assert.deepEqual(room.archivedDiscussions.map(row => row.id), ['old/1'])
  await write('restore', ['old/1'])
  assert.equal(room.archivedDiscussions, undefined)
})

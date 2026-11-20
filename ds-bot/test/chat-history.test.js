import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 3,
  bots: {
    m1: { id: 'm1', sessionId: 'm1c', segments: [{ sessionId: 'm1', endedAt: 50 }], name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writer', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  // Chief's turn 7 answers another Bot, so the chat does not show it.
  exchangeTurns: { m1c: [7] },
  questions: {},
}

const userMessage = (text, time) => ({ type: 'user/message', time, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const botMessage = (text, time, turn = 1) => ({ type: 'assistant/message', time, data: { turn, message: { content: [{ type: 'text', text }] } } })

function start({ pages = {}, services = {}, team = TEAM } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-chat-history-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext({ services })
  ctx.sessionController = {
    resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: 100 } } }),
    // Two pages per Session, newest first, keyed by the cursor that asks for them.
    page: async ({ address, beforeSeq }) => pages[`${address.sessionId}:${beforeSeq ?? 'end'}`] ?? { records: [], hasMore: false },
  }
  const routes = {}
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    routes[options.path] = options
    return register(options)
  }
  apply(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await routes['/api/bot'].fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, stop }
}

// Reads Server-Sent Events off a response, one `{ event, data }` per call.
test('the chat endpoint pages a Bot\'s own chat from the newest part back', async (t) => {
  const record = (event, seq) => ({ event: { ...event, seq } })
  const { call, stop } = start({
    pages: {
      'm1c:end': { records: [record(userMessage('second', 70), 41), record(botMessage('reply', 71), 42)], hasMore: true },
      'm1c:41': { records: [record(userMessage('first', 60), 40)], hasMore: false },
      'm1:end': { records: [record(userMessage('long ago', 5), 3)], hasMore: false },
    },
  })
  t.after(stop)
  await call('state')
  const first = (await call('chat', { botId: 'm1' })).value
  assert.deepEqual(first, {
    sessionId: 'm1c',
    items: [{ kind: 'user', text: 'second', time: 70, seq: 41 }, { kind: 'bot', text: 'reply', time: 71, seq: 42 }],
    cursor: { part: 1, beforeSeq: 41 },
  })
  // The current part's first message has the line that marks where the part began.
  const second = (await call('chat', { botId: 'm1', cursor: first.cursor })).value
  assert.deepEqual(second.items, [{ kind: 'divider', time: 50 }, { kind: 'user', text: 'first', time: 60, seq: 40 }])
  assert.deepEqual(second.cursor, { part: 0 })
  const third = (await call('chat', { botId: 'm1', cursor: second.cursor })).value
  assert.deepEqual([third.items, third.cursor], [[{ kind: 'user', text: 'long ago', time: 5, seq: 3 }], null])
  assert.equal((await call('chat', { botId: 'nobody' })).error.code, 'bot/not-found')
})

test('a show_view call in a part reads back as a view row with its blueprint', async (t) => {
  const record = (event, seq) => ({ event: { ...event, seq } })
  const showView = (time, args) => ({ type: 'tool/call', time, data: { callId: 'c1', name: 'show_view', arguments: typeof args === 'string' ? args : JSON.stringify(args) } })
  const { call, stop } = start({
    pages: {
      'm1c:end': {
        records: [
          record(userMessage('look', 70), 41),
          record(showView(71, { title: 'A long note', view: { type: 'stack', children: [0, 1, 2, 3].map(() => ({ type: 'text', text: 'x'.repeat(1900) })) } }), 42),
          // A view needs no title; a call the tool refused leaves no row. Other tools stay out too.
          record(showView(72, { view: { type: 'text', text: 'y' } }), 43),
          record(showView(72, { title: 'Refused', view: { type: 'nope' } }), 45),
          record({ type: 'tool/call', time: 73, data: { callId: 'c3', name: 'list_bots', arguments: '{}' } }, 44),
        ],
        hasMore: false,
      },
    },
  })
  t.after(stop)
  await call('state')
  const page = (await call('chat', { botId: 'm1' })).value
  const row = page.items.find(item => item.kind === 'view')
  assert.equal(row.title, 'A long note')
  assert.equal(row.callId, 'c1')
  assert.equal(row.view.children.length, 4)
  assert.equal(JSON.stringify(row.view).length > 7500, true)
  assert.deepEqual(page.items.map(item => item.kind), ['divider', 'user', 'view', 'view'])
  assert.equal(page.items.at(-1).title, '')
})

test('view replay omits hidden, refused and interactive calls in chat pages', async (t) => {
  const view = { type: 'text', text: 'Visible' }
  const cases = [
    { turn: 7, arguments: { title: 'Hidden', view } },
    { arguments: { title: 'Refused wait', view, await_reply: true } },
    { arguments: { title: 'Too long', view: { type: 'text', text: 'x'.repeat(7800) } } },
    { arguments: { title: 'Interactive', view: { type: 'confirm', id: 'ok' } } },
    { arguments: '{invalid' },
    { arguments: { title: '  Accepted  ', view: { type: 'progress', percent: '40' } } },
  ]
  const events = cases.map((data, index) => ({
    type: 'tool/call', time: 70 + index, seq: 41 + index,
    data: { turn: 8, callId: `v${index}`, name: 'show_view', ...data },
  }))
  const { call, stop } = start({ pages: { 'm1c:end': { records: events.map(event => ({ event })), hasMore: false } } })
  t.after(stop)
  await call('state')
  const expected = { kind: 'view', title: 'Accepted', view: { type: 'progress', percent: 40 }, callId: 'v5', time: 75 }
  const page = (await call('chat', { botId: 'm1' })).value
  assert.deepEqual(page.items.filter(item => item.kind === 'view'), [expected])
})

test('a display view is retained when its part becomes earlier history', async (t) => {
  const view = { type: 'text', text: 'From the first part' }
  const event = { type: 'tool/call', time: 20, seq: 3, data: { turn: 1, callId: 'old-view', name: 'show_view', arguments: JSON.stringify({ title: 'Earlier card', view }) } }
  const { call, stop } = start({ pages: { 'm1:end': { records: [{ event }], hasMore: false } } })
  t.after(stop)
  await call('state')
  const page = (await call('earlier', { sessionId: 'm1c' })).value
  assert.deepEqual(page.items, [{ kind: 'view', title: 'Earlier card', view, callId: 'old-view', time: 20 }])
})

test('a question or view card closed without an answer reads back in earlier history, including hidden turns; an answered one does not', async (t) => {
  const options = [{ label: 'Short' }, { label: 'Long' }]
  const pick = { type: 'options', id: 'lane', options: [{ label: 'Ship now' }] }
  const meter = { type: 'metric', label: 'Done', value: '3' }
  const events = [
    { type: 'tool/call', time: 20, seq: 3, data: { turn: 1, callId: 'q-closed', name: 'ask_user', arguments: JSON.stringify({ question: 'Which draft?', options }) } },
    { type: 'tool/call', time: 21, seq: 4, data: { turn: 1, callId: 'q-answered', name: 'ask_user', arguments: JSON.stringify({ question: 'Answered', options }) } },
    { type: 'tool/call', time: 22, seq: 5, data: { turn: 1, callId: 'v-closed', name: 'show_view', arguments: JSON.stringify({ title: 'Pick a lane', view: pick }) } },
    { type: 'tool/call', time: 23, seq: 6, data: { turn: 2, callId: 'v-hidden-meter', name: 'show_view', arguments: JSON.stringify({ title: 'Hidden meter', view: meter }) } },
    { type: 'tool/call', time: 24, seq: 7, data: { turn: 2, callId: 'v-hidden-closed', name: 'show_view', arguments: JSON.stringify({ title: 'Browser default?', view: pick }) } },
  ]
  const team = {
    ...TEAM,
    exchangeTurns: { ...TEAM.exchangeTurns, m1: [2] },
    closedCards: { m1: { 'q-closed': 'replied', 'v-closed': 'dismissed', 'v-hidden-closed': 'replied' } },
  }
  const { call, stop } = start({ team, pages: { 'm1:end': { records: events.map(event => ({ event })), hasMore: false } } })
  t.after(stop)
  await call('state')
  const page = (await call('earlier', { sessionId: 'm1c' })).value
  assert.deepEqual(page.items, [
    { kind: 'closed', closed: 'replied', question: { question: 'Which draft?', options, multiSelect: false }, callId: 'q-closed', time: 20 },
    { kind: 'closed', closed: 'dismissed', title: 'Pick a lane', view: pick, callId: 'v-closed', time: 22 },
    { kind: 'closed', closed: 'replied', title: 'Browser default?', view: pick, callId: 'v-hidden-closed', time: 24 },
  ])
})

test('the run-stats endpoint reads DSH\'s figures for the current part of a Bot\'s chat', async (t) => {
  const views = { sessionStats: { turns: 3 }, tokenUsage: { cacheReadTokens: 9 }, contextPressure: { contextWindow: 100 } }
  const read = []
  const sessionProjections = {
    snapshot: (session, keys) => {
      read.push([session.id, keys])
      return { asOfSeq: 7, values: views }
    },
  }
  const { call, stop } = start({ services: { sessionProjections } })
  t.after(stop)
  await call('state')
  assert.deepEqual((await call('run-stats', { botId: 'm1' })).value, views)
  assert.deepEqual(read, [['m1c', ['sessionStats', 'tokenUsage', 'contextPressure']]])
  assert.equal((await call('run-stats', { botId: 'nobody' })).error.code, 'bot/not-found')
})

test('without DSH\'s session projections the run-stats endpoint has nothing to show', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  await call('state')
  assert.deepEqual(await call('run-stats', { botId: 'm1' }), { ok: true, value: null })
})

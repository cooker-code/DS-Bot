import { fileChunks } from '../src/shared/file-chunks.js'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeAttachments, fakeContext } from './fake-ctx.js'

// A team with no model: Sessions are made in memory, a group round runs on answers
// played back through the session/event listeners, and `history` holds the events
// each Session's page reads, oldest first.
function start(config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-chat-files-'))
  const ctx = fakeContext({ services: { attachments: fakeAttachments() } })
  const sent = []
  const history = {}
  let sessions = 0
  const workspaces = new Map()
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async () => undefined,
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: (history[sessionId]?.at(-1)?.seq ?? 0) + 1 }, followup: message => sent.push({ sessionId, message }) } }),
      selectModel: async () => {},
      prompt: async request => sent.push({ sessionId: request.sessionId, prompt: request }),
      page: async ({ address, beforeSeq, maxMessages }) => {
        const all = (history[address.sessionId] ?? []).filter(event => beforeSeq === undefined || event.seq < beforeSeq)
        const events = maxMessages === undefined ? all : all.slice(-maxMessages)
        return { records: events.map(event => ({ event })), hasMore: events.length < all.length }
      },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const routes = {}
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    routes[options.path] = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home, ...config })
  const call = async (endpoint, payload) => {
    const response = await routes['/api/bot'].fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, call, emit, sent, history, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
async function team(call) {
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const room = (await call('create-room', { name: 'Launch', members: [chief, writer.id] })).value
  await call('update-room', { id: room.id, mode: 'everyone' })
  return { chief, writer, room }
}

const user = (seq, text, time = seq) => ({ seq, time, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
test('project-task-list reads one room at the same revision as the team view, including on a read-only host', async t => {
  const { rt, call, stop } = start()
  t.after(stop)
  const { chief, writer, room } = await team(call)
  const other = (await call('create-room', { name: 'Other', members: [chief, writer.id] })).value
  const empty = (await call('project-task-list', { roomId: room.id })).value
  assert.deepEqual(empty.tasks, [])
  assert.deepEqual(empty.pendingIntakes, [])

  const target = rt.roomOf(room.id)
  target.projectCards = { current: { title: 'Scoped work', rounds: [{ ownerId: writer.id, assignedAt: 10 }] } }
  target.projectInbox = [{ id: 'queued', status: 'pending' }, { id: 'handled', status: 'done' }]
  rt.roomOf(other.id).projectCards = { elsewhere: { title: 'Other work' } }
  const full = (await call('state', {})).value
  const summary = full.rooms.find(entry => entry.id === room.id)
  rt.readOnly = () => 'Another host is writing'
  const result = await call('project-task-list', { roomId: room.id })
  assert.deepEqual(result, { ok: true, value: {
    roomId: room.id, revision: full.revision, tasks: summary.projectCards, pendingIntakes: summary.pendingIntakes,
  } })
  assert.deepEqual(result.value.tasks.map(task => [task.taskId, task.ownerId]), [['current', writer.id]])
  assert.deepEqual(result.value.pendingIntakes.map(item => item.id), ['queued'])
  assert.equal((await call('project-task-list', { roomId: 'missing' })).error.code, 'GROUP_CONTEXT_REQUIRED')
})

test('stop-chat ends a Bot own-chat turn, and answers false when nothing runs', async () => {
  const { call, emit, stop } = start()
  const { chief } = await team(call)
  assert.equal((await call('stop-chat', { botId: chief })).value, false)
  const sessionId = (await call('state', {})).value.bots.find(bot => bot.id === chief).sessionId
  await emit(sessionId, { type: 'turn/start', data: { turn: 1 } })
  await emit(sessionId, user(1, 'go'))
  assert.equal((await call('stop-chat', { botId: chief })).value, true)
  await stop()
})

test('the plugin stages photos one by one, then send puts them in one message with the text', async () => {
  const { call, sent, stop } = start()
  const { chief } = await team(call)
  const pixel = Buffer.from('ffd8ffe000104a464946', 'hex').toString('base64')
  assert.deepEqual(await call('stage-image', { mediaType: 'text/html', data: pixel }), { ok: false, error: { code: 'bot/invalid', message: 'This is not a photo DS Bot can send', details: {} } })
  const first = (await call('stage-image', { mediaType: 'image/jpeg', data: pixel })).value.id
  const second = (await call('stage-image', { mediaType: 'image/png', data: pixel })).value.id
  const before = sent.length
  assert.equal((await call('send', { sessionId: chief, text: 'look', images: [first, second] })).value, true)
  const prompt = sent.slice(before).find(entry => entry.prompt !== undefined).prompt
  assert.deepEqual(prompt.content, [
    { type: 'text', text: 'look' },
    { type: 'image', mediaType: 'image/jpeg', data: pixel },
    { type: 'image', mediaType: 'image/png', data: pixel },
  ])
  // A photo goes once: sending the same ids again is refused, and photos alone are a message.
  assert.equal((await call('send', { sessionId: chief, text: '', images: [first] })).error.code, 'bot/stale')
  const third = (await call('stage-image', { mediaType: 'image/jpeg', data: pixel })).value.id
  assert.equal((await call('send', { sessionId: chief, text: '', images: [third] })).ok, true)
  assert.deepEqual(sent.at(-1).prompt.content, [{ type: 'image', mediaType: 'image/jpeg', data: pixel }])
  await stop()
})

test('chat with steps folds the turn tool calls into a steps row after its last text', async () => {
  const { call, history, stop } = start()
  const { chief } = await team(call)
  const sessionId = (await call('state', {})).value.bots.find(bot => bot.id === chief).sessionId
  history[sessionId] = [
    { seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } },
    user(2, 'fix the thing'),
    { seq: 3, time: 3, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'On it' }] } } },
    { seq: 4, time: 4, type: 'tool/call', data: { callId: 'c1', name: 'read_file', arguments: '{}' } },
    { seq: 5, time: 5, type: 'tool/result', data: { message: { toolCallId: 'c1', ok: true, content: [] } } },
  ]
  const page = (await call('chat', { botId: chief, steps: true })).value
  const steps = page.items.find(item => item.kind === 'steps')
  assert.equal(steps.turn, 1)
  assert.deepEqual(steps.tools, [{ name: 'read_file', label: 'Opening a file', ok: true }])
  assert.equal(page.items.indexOf(steps), page.items.length - 1)
  const plain = (await call('chat', { botId: chief })).value
  assert.equal(plain.items.some(item => item.kind === 'steps'), false)
  await stop()
})

test('state rows carry lastAt and preview from the Bot own chat', async () => {
  const { call, emit, history, stop } = start()
  const { chief } = await team(call)
  const sessionId = (await call('state', {})).value.bots.find(bot => bot.id === chief).sessionId
  history[sessionId] = [user(1, 'Ship the list first', 1000)]
  await emit(sessionId, history[sessionId][0])
  let row
  for (let at = 0; at < 200 && row === undefined; at += 1) {
    const bot = (await call('state', {})).value.bots.find(candidate => candidate.id === chief)
    if (bot?.preview !== undefined && bot.preview !== '') row = bot
    else await settle()
  }
  assert(row !== undefined)
  assert.equal(row.lastAt, 1000)
  assert.equal(row.preview, 'Ship the list first')
  await stop()
})

test('file-download sends a presented file back to the browser, and disambiguates parts by sessionId', async (t) => {
  const { call, history, rt, stop } = start()
  t.after(stop)
  const { chief } = await team(call)
  const part1 = (await call('state', {})).value.bots.find(bot => bot.id === chief).sessionId
  const part2 = 's-file-part-2'
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-file-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path1 = join(dir, 'report-v1.pdf')
  const path2 = join(dir, 'report-v2.pdf')
  writeFileSync(path1, Buffer.from('%PDF-1.4 part1'))
  writeFileSync(path2, Buffer.from('%PDF-1.4 part2'))
  history[part1] = [{ seq: 9, type: 'deliverables/presented', data: { turn: 1, files: [{ path: path1 }] } }]
  rt.state.bots[chief].segments = [{ sessionId: part1, endedAt: 10 }]
  rt.state.bots[chief].sessionId = part2
  rt.chatOwners.set(part2, chief)
  rt.pastOwners.set(part1, { botId: chief })
  history[part2] = [{ seq: 9, type: 'deliverables/presented', data: { turn: 1, files: [{ path: path2 }] } }]

  const saved1 = await call('file-download', { sessionId: part1, seq: 9, index: 0 })
  assert.equal(saved1.ok, true)
  assert.equal(saved1.value.name, 'report-v1.pdf')
  assert.equal(saved1.value.mime, 'application/pdf')
  assert.equal(Buffer.from(saved1.value.bytes, 'base64').toString(), '%PDF-1.4 part1')

  const saved2 = await call('file-download', { sessionId: part2, seq: 9, index: 0 })
  assert.equal(saved2.ok, true)
  assert.equal(saved2.value.name, 'report-v2.pdf')
  assert.equal(Buffer.from(saved2.value.bytes, 'base64').toString(), '%PDF-1.4 part2')

  const wrong = await call('file-download', { sessionId: part2, seq: 10, index: 0 })
  assert.deepEqual([wrong.ok, wrong.error.code], [false, 'bot/not-found'])
  const unowned = await call('file-download', { sessionId: 's-unknown', seq: 9, index: 0 })
  assert.deepEqual([unowned.ok, unowned.error.code], [false, 'bot/not-found'])
})

test('file-download sends a file attachment and refuses an unknown session or attachment', async (t) => {
  const { call, ctx, history, stop } = start()
  t.after(stop)
  const { chief } = await team(call)
  const sessionId = (await call('state', {})).value.bots.find(bot => bot.id === chief).sessionId
  const ref = await ctx.get('attachments').saveFile({ data: Buffer.from('attachment notes'), name: 'notes.txt' })
  history[sessionId] = [{ seq: 3, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'file', attachment: ref }] } }]
  const saved = await call('file-download', { sessionId, attachmentId: ref.attachmentId })
  assert.equal(saved.ok, true)
  assert.deepEqual([saved.value.name, saved.value.mime], ['notes.txt', 'text/plain'])
  assert.equal(Buffer.from(saved.value.bytes, 'base64').toString(), 'attachment notes')
  const missing = await call('file-download', { sessionId, attachmentId: 'sha256:none' })
  assert.deepEqual([missing.ok, missing.error.code], [false, 'bot/not-found'])
  const unowned = await call('file-download', { sessionId: 's-other', attachmentId: ref.attachmentId })
  assert.deepEqual([unowned.ok, unowned.error.code], [false, 'bot/not-found'])
})

test('a presented file rides on the closing Bot row so the browser can save it', async (t) => {
  const { rt, stop } = start()
  t.after(stop)
  const events = [
    { seq: 11, type: 'turn/start', data: { turn: 1 } },
    { seq: 12, type: 'assistant/message', time: 1, data: { turn: 1, message: { content: [{ type: 'text', text: 'Done, here it is.' }] } } },
    { seq: 13, type: 'deliverables/presented', time: 2, data: { turn: 1, files: [{ path: '/tmp/reports/quarterly.pdf' }] } },
  ]
  const items = rt.displayItems('s-presented', events)
  const row = items.find(item => item.kind === 'bot')
  assert.deepEqual(row.files, [{ name: 'quarterly.pdf', sessionId: 's-presented', seq: 13, index: 0 }])
})

test('file-download resolves presented files in active and archived group member sessions', async (t) => {
  const { call, history, rt, stop } = start()
  t.after(stop)
  const { chief, room } = await team(call)
  const storedRoom = rt.state.rooms[room.id]
  const pastMember = 's-room-member-1'
  const activeMember = 's-room-member-2'
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-group-file-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const pastPath = join(dir, 'past.txt')
  const activePath = join(dir, 'active.txt')
  writeFileSync(pastPath, Buffer.from('from archived member segment'))
  writeFileSync(activePath, Buffer.from('from active member session'))

  storedRoom.segments = { [chief]: [{ sessionId: pastMember, endedAt: 10 }] }
  storedRoom.sessions = { [chief]: activeMember }
  rt.pastOwners.set(pastMember, { botId: chief, roomId: room.id })
  rt.groupOwners.set(activeMember, { botId: chief, roomId: room.id })
  history[pastMember] = [{ seq: 9, type: 'deliverables/presented', data: { turn: 1, files: [{ path: pastPath }] } }]
  history[activeMember] = [{ seq: 9, type: 'deliverables/presented', data: { turn: 1, files: [{ path: activePath }] } }]

  const savedPast = await call('file-download', { sessionId: pastMember, seq: 9, index: 0 })
  assert.equal(savedPast.ok, true)
  assert.equal(savedPast.value.name, 'past.txt')
  assert.equal(Buffer.from(savedPast.value.bytes, 'base64').toString(), 'from archived member segment')

  const savedActive = await call('file-download', { sessionId: activeMember, seq: 9, index: 0 })
  assert.equal(savedActive.ok, true)
  assert.equal(savedActive.value.name, 'active.txt')
  assert.equal(Buffer.from(savedActive.value.bytes, 'base64').toString(), 'from active member session')
})

test('displayItems extracts prompt text for scheduled task user messages (#1498)', async (t) => {
  const { rt, stop } = start()
  t.after(stop)
  const items = rt.displayItems('s-sched', [
    {
      seq: 1,
      type: 'user/message',
      time: 1000,
      data: {
        source: { kind: 'schedule' },
        content: [{ type: 'text', text: 'reminder_prompt_json: "Check build metrics"\n' }],
      },
    },
    {
      seq: 2,
      type: 'user/message',
      time: 2000,
      data: {
        source: { kind: 'schedule' },
        content: [{ type: 'text', text: 'raw trigger without json' }],
      },
    },
  ])
  assert.deepEqual(items.map(it => ({ kind: it.kind, role: it.role, text: it.text })), [
    { kind: 'event', role: 'schedule', text: 'Check build metrics' },
    { kind: 'event', role: 'schedule', text: '' },
  ])
})

test('files larger than 16 MB download through bounded chunks without a total-size cap', async t => {
  const { call, history, stop } = start()
  t.after(stop)
  const { chief } = await team(call)
  const sessionId = (await call('state', {})).value.bots.find(bot => bot.id === chief).sessionId
  const dir = mkdtempSync(join(tmpdir(), 'dsb-file-chunks-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bytes = randomBytes(17 * 1024 * 1024 + 13)
  const path = join(dir, 'large.bin')
  writeFileSync(path, bytes)
  history[sessionId] = [{ seq: 9, type: 'deliverables/presented', data: { turn: 1, files: [{ path }] } }]
  const hash = createHash('sha256')
  let downloaded = 0
  let calls = 0
  const ask = async (endpoint, payload) => {
    const result = await call(endpoint, payload)
    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024 * 1024, 'one result fits the link frame budget')
    calls++
    return result.value
  }
  for await (const part of fileChunks(ask, { sessionId, seq: 9, index: 0 })) {
    assert.ok(part.data.length <= 512 * 1024)
    downloaded += part.data.length
    hash.update(part.data)
  }
  assert.ok(calls > 1)
  assert.equal(downloaded, bytes.length)
  assert.equal(hash.digest('hex'), createHash('sha256').update(bytes).digest('hex'))
  const first = await call('file-download', { sessionId, seq: 9, index: 0, offset: 0 })
  writeFileSync(path, 'changed')
  const changed = await call('file-download', { sessionId, seq: 9, index: 0, offset: first.value.nextOffset, version: first.value.version })
  assert.equal(changed.error.code, 'bot/not-found')
  assert.equal((await call('file-download', { sessionId, seq: 9, offset: -1 })).error.code, 'bot/invalid')
})

test('file attachment chunks round-trip through the same client iterator', async t => {
  const { call, ctx, history, stop } = start()
  t.after(stop)
  const { chief } = await team(call)
  const sessionId = (await call('state', {})).value.bots.find(bot => bot.id === chief).sessionId
  const bytes = randomBytes(4 * 1024 * 1024 + 7)
  const ref = await ctx.get('attachments').saveFile({ data: bytes, name: 'data.bin' })
  history[sessionId] = [{ seq: 3, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'file', attachment: ref }] } }]
  const chunks = []
  for await (const part of fileChunks(async (endpoint, payload) => {
    const result = await call(endpoint, payload)
    assert.equal(result.ok, true)
    return result.value
  }, { sessionId, attachmentId: ref.attachmentId })) chunks.push(Buffer.from(part.data))
  assert.deepEqual(Buffer.concat(chunks), bytes)
})

test('chat with steps computes thinking time from the loaded page without re-reading the session tail', async t => {
  const { call, ctx, history, stop } = start()
  t.after(stop)
  const { chief } = await team(call)
  const sessionId = (await call('state', {})).value.bots.find(bot => bot.id === chief).sessionId
  let seq = 0
  const events = []
  for (let turn = 1; turn <= 12; turn += 1) {
    events.push({ seq: seq++, time: turn * 1000, type: 'turn/start', data: { turn } })
    events.push(user(seq++, `msg ${turn}`))
    events.push({
      seq: seq++, time: turn * 1000 + 10, type: 'assistant/message',
      data: { turn, step: 0, message: { content: [{ type: 'text', text: `reply ${turn}` }] }, stream: [{ type: 'reasoning-chunks', time0: 100, index: 0, dt: [250], texts: ['a', 'b'] }] },
    })
    events.push({ seq: seq++, time: turn * 1000 + 20, type: 'tool/call', data: { turn, callId: `c${turn}`, name: 'read_file', arguments: '{}' } })
    events.push({ seq: seq++, time: turn * 1000 + 30, type: 'tool/result', data: { turn, message: { toolCallId: `c${turn}`, ok: true, content: [] } } })
    events.push({ seq: seq++, time: turn * 1000 + 40, type: 'turn/end', data: { turn } })
  }
  history[sessionId] = events
  let pageCalls = 0
  const basePage = ctx.sessionController.page
  ctx.sessionController.page = async (args, signal) => {
    pageCalls += 1
    return basePage(args, signal)
  }
  const older = (await call('chat', { botId: chief, cursor: { part: 0, beforeSeq: 24 }, steps: true })).value
  const stepRows = older.items.filter(item => item.kind === 'steps')
  assert.ok(stepRows.length >= 3)
  assert.ok(stepRows.every(row => row.ms === 250))
  assert.equal(pageCalls, 1)
})

test('desktop approval settlement clears pending approvals on unchanged state poll', async (t) => {
  const { call, ctx, rt, stop } = start()
  t.after(stop)
  const { writer, room } = await team(call)
  const sessionId = `g-${randomUUID()}`
  rt.state.rooms[room.id].sessions = { [writer.id]: sessionId }
  rt.groupOwners.set(sessionId, { botId: writer.id, roomId: room.id })

  const [approve] = ctx.listeners.get('approval/request')
  const controller = new AbortController()
  const answer = approve({ agent: { id: sessionId }, toolName: 'bash', reason: 'run tests', signal: controller.signal }, () => 'allowed-once')
  const openState = (await call('state', {})).value
  assert.equal(openState.work.approvals.length, 1)

  controller.abort()
  assert.equal(await answer, 'cancelled')

  const nextState = (await call('state', { since: openState.revision, live: openState.liveKey })).value
  assert.equal(nextState.unchanged, true)
  assert.notEqual(nextState.liveKey, openState.liveKey)
  assert.deepEqual(nextState.work.approvals, [])
})

test('browser handoff open and settle clear browserHolds on unchanged-revision state poll', async (t) => {
  const { call, rt, stop } = start({ browser: true })
  t.after(stop)
  const { chief } = await team(call)

  rt.browserChannel.setHold(chief, { by: 'bot', reason: 'verification', note: 'Sign in', callId: 'call-1' })
  const openState = (await call('state', {})).value
  assert.equal(openState.browserHolds[chief]?.callId, 'call-1')

  rt.browserChannel.setHold(chief, null)

  const nextState = (await call('state', { since: openState.revision, live: openState.liveKey })).value
  assert.equal(nextState.unchanged, true)
  assert.notEqual(nextState.liveKey, openState.liveKey)
  assert.deepEqual(nextState.browserHolds, {})
})

test('switching sessions preserves the previous session’s pending cards', async (t) => {
  const { call, ctx, rt, stop } = start()
  t.after(stop)
  const { chief } = await team(call)
  const bot = rt.botOf(chief)
  const part1 = rt.chatOf(chief)
  const part2 = `s-${randomUUID()}`
  bot.segments = [{ sessionId: part1, endedAt: 100 }]
  bot.sessionId = part2
  rt.save()
  rt.state.questions[part2] = { id: 'q-1', question: 'Pick one', options: [{ label: 'A' }] }
  rt.state.views[part2] = { id: 'v-1', title: 'Confirm', view: { type: 'text', text: 'hi' } }
  ctx.workspaceRegistry.unarchiveSession = async () => {}
  ctx.workspaceRegistry.archiveSession = async () => {}

  await rt.switchPart(chief, part1)
  const after = (await call('state', {})).value
  assert.equal(after.questions[part2].id, 'q-1')
  assert.equal(after.views[part2].id, 'v-1')
  assert.equal(after.questions[part1], undefined)
  assert.equal(after.views[part1], undefined)
})

import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { savedTeam } from './team-state.js'
import { afterRound } from './relay-rows.js'
import { inspectReplannedWriter } from '../src/host/project-recovery.js'
import { forwardProjectIntake } from '../src/host/project-intake.js'
import { createRuntime } from '../index.js'
import { fakeAttachments, fakeContext } from './fake-ctx.js'
import { LONG_HEAD, MESSAGE_INLINE_MAX, ROOM_STEP_GAP_MS, ROOM_WORK_GRACE_MS } from '../src/host/constants.js'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { promisesWork } from '../src/host/turns.js'

let rt

// Chief, the admin of group 'r1', speaks there from 'ga'; Writer from 'gb'; Tester from 'gc'.
const seed = (room = {}, extraRooms = {}, bots = {}, top = {}) => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, ...bots.a },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2, ...bots.b },
    c: { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3, ...bots.c },
    ...(bots.d ? { d: { id: 'd', name: 'Reviewer', role: 'Review', sessionId: 'd', createdAt: 4, ...bots.d } } : {}),
  },
  rooms: { r1: { id: 'r1', name: 'Ops', taskManagementEnabled: false, members: ['a', 'b', 'c'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb', c: 'gc' }, log: [], seq: 0, seen: {}, ...room }, ...extraRooms },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
  ...top,
})

async function start(t, room, services, extraRooms, bots, llm, top, files = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-work-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed(room, extraRooms, bots, top)))
  for (const [name, value] of Object.entries(files)) writeFileSync(join(home, name), JSON.stringify(value))
  const selected = []
  const ctx = fakeContext({ services })
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const cancelled = []
      const held = []
      const nextStep = []
      const inbox = {
        nextStep,
        nextTurn: held,
        remove(id) {
          for (const list of [nextStep, held]) {
            const at = list.findIndex(message => message.id === id)
            if (at !== -1) { list.splice(at, 1); return true }
          }
          return false
        },
      }
      const keep = list => message => { calls.push(message); list.push(message) }
      agents.set(sessionId, { session: { id: sessionId }, calls, cancelled, inbox, followup: keep(held), steer: keep(nextStep), cancel(reason) { cancelled.push(reason) } })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: llm ?? { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }), selectModel: async (request) => { selected.push(request) } },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  let seq = 0
  const turns = new Map()
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener(agentOf(id).session, { type, seq: ++seq, data })
    }
  }
  const emitScoped = (parentId, name, info) => {
    const carrier = scopeTarget({}, agentOf(parentId))
    for (const listener of ctx.listeners.get(name) ?? []) listener.call(carrier, info)
  }
  const tool = (name, args, sessionId, exec = {}) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId }, ...exec })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  // A Session takes up the newest message it was sent, as a new turn.
  const begin = (sessionId, message = agentOf(sessionId).calls.at(-1)) => {
    agentOf(sessionId).inbox.nextTurn.length = 0
    agentOf(sessionId).inbox.nextStep.length = 0
    const turn = (turns.get(sessionId) ?? 0) + 1
    turns.set(sessionId, turn)
    emit(sessionId, 'turn/start', { turn })
    emit(sessionId, 'user/message', { content: message.content, source: message.source })
    return message
  }
  const finish = (sessionId, reply) => {
    emit(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: reply }] } })
    emit(sessionId, 'turn/end', { turn: turns.get(sessionId), reason: { kind: 'completed' } })
  }
  // The user's message in the group, or a Bot's post the group Session took up, and the
  // round it starts.
  const round = (callId, message, sessionId = 'r1') => {
    emit(sessionId, 'user/message', message)
    let result
    const stop = new AbortController()
    t.after(() => stop.abort())
    void tool('group_relay', {}, sessionId, { agent: { id: sessionId, inbox: agentOf(sessionId).inbox }, callId, signal: stop.signal }).then(async (value) => { result = await afterRound(rt, sessionId, value) })
    const read = () => result
    read.cancel = () => { stop.abort(); rt.stopRoomRound(rt.roomOf(sessionId)?.id ?? sessionId) }
    return read
  }
  const say = (text, taskId) => ({ content: [{ type: 'text', text }], source: { kind: 'user', ...(taskId && { taskId }) } })
  const takePost = () => {
    const post = agentOf('r1').calls.shift()
    return { content: post.content, source: post.source }
  }
  await tool('list_bots', {}, 'a')
  return { home, ctx, agentOf, emit, emitScoped, tool, call, begin, finish, round, say, takePost, selected }
}

// The save before a group post runs on a timer; waiting with setImmediate starves it.
const until = async (check, ms = 3000) => {
  const stop = Date.now() + ms
  while (!check() && Date.now() < stop) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(check(), 'condition not reached')
}
const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
const text = message => message.content.map(block => block.text ?? '').join('\n')
const kinds = result => result.replies.map(reply => [reply.kind ?? 'message', reply.name])

test('work past the grace lets the round go on, and the member that asked answers the result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 把文档整理好')
  await settle(() => host.agentOf('gb').calls.length === 1)
  const called = host.begin('gb')
  assert.equal(called.source.askedBy, 'a')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS - 1)
  await settle(() => true)
  assert.equal(first(), undefined)
  t.mock.timers.tick(1)
  await settle(() => first() !== undefined)
  assert.deepEqual(kinds(first()), [['message', 'Chief'], ['working', 'Writer']])

  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '整理好了，在 docs/ 下。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.late, post.source.askedBy, text(post)], [true, 'a', '[Group post from Writer]\n整理好了，在 docs/ 下。'])
  const second = host.round('c2', post)
  await settle(() => host.agentOf('ga').calls.length === 2)
  assert.match(text(host.agentOf('ga').calls[1]), /Writer: 整理好了，在 docs\/ 下。/)
  host.begin('ga')
  host.finish('ga', '')
  await settle(() => second() !== undefined)
  assert.deepEqual(host.agentOf('gc').calls, [])
})

// 公开#165: asked in a group to hand out work, Chief sent it with message_bot. Members
// did it in their own chats, apart from the group (Bots outside the group too), and
// again when called in the group.
test('message_bot from a group to one of its members calls it there, as "@Name" would', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  const sent = await host.tool('message_bot', { to: 'Writer', message: '把文档整理好' }, 'ga')
  assert.match(sent, /^Called Writer in "Ops"/)
  host.finish('ga', '安排好了。')
  await settle(() => host.agentOf('gb').calls.length === 1)
  const called = host.begin('gb')
  assert.equal(called.source.askedBy, 'a')
  assert.match(text(called), /Chief: @Writer 把文档整理好/)
  host.finish('gb', '整理好了。')
  await settle(() => first() !== undefined)
  assert.deepEqual(kinds(first()), [['message', 'Chief'], ['message', 'Chief'], ['message', 'Writer']])
  assert.deepEqual([host.agentOf('b').calls, host.agentOf('gc').calls], [[], []])
})

test('a group Session made before the member\'s level applied gets it on the next sync', async (t) => {
  const llm = {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'v4-flash', name: 'v4-flash', inputModalities: ['text'] }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }),
  }
  // Saved state from before the fix: 'gb' already exists and the Bot-level record
  // already says applied — the bot-wide check would never revisit the group Session.
  const host = await start(t, { members: ['a', 'b'], sessions: { a: 'ga', b: 'gb' } }, undefined, undefined,
    { b: { model: 'deepseek/v4-flash', effort: 'low', appliedModel: 'deepseek/v4-flash', appliedEffort: 'low' } }, llm)
  await host.call('state', {})
  // The group Session gets the member's level once; the own chat is not re-selected.
  await settle(() => host.selected.length === 1)
  assert.deepEqual(host.selected, [{ sessionId: 'gb', provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'low' }])
})

test('a member\'s group Session runs on the member\'s model and thinking level', async (t) => {
  const llm = {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'v4-flash', name: 'v4-flash', inputModalities: ['text'] }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }),
  }
  const host = await start(t, { members: ['a', 'b'], sessions: { a: 'ga' } }, undefined, undefined, { b: { model: 'deepseek/v4-flash', effort: 'low' } }, llm)
  const first = host.round('c1', host.say('@Writer 看一下'))
  await settle(() => host.agentOf('s1').calls.length === 1)
  // The group Session was made for the turn: it got the member's route, level and all.
  assert.deepEqual(host.selected.at(-1), { sessionId: 's1', provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'low' })
  host.begin('s1')
  host.finish('s1', '看过了。')
  await settle(() => first() !== undefined)
})

test('message_bot from a member the round moved on from calls the other member in a round of its own', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'write', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  await host.tool('message_bot', { to: 'Tester', message: '帮我测一下' }, 'gb')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.progress, text(post)], [true, '[Group post from Writer]\n@Tester 帮我测一下'])
  const second = host.round('c2', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.equal(host.begin('gc').source.askedBy, 'b')
  host.finish('gc', '测过了。')
  await settle(() => second() !== undefined)
  assert.deepEqual(host.agentOf('c').calls, [])
})

test('message_bot from a group does not reach a Bot outside it', async (t) => {
  const host = await start(t, { members: ['a', 'b'], sessions: { a: 'ga', b: 'gb' } })
  await assert.rejects(host.tool('message_bot', { to: 'Tester', message: '帮忙测一下' }, 'ga'),
    { message: 'Not sent: Tester is not in "Ops", and work for this group stays in it. Ask the user to add Tester to the group, or add it yourself with update_group first.' })
  await assert.rejects(host.tool('message_bot', { to: 'Tester', message: '帮忙测一下' }, 'gb'),
    { message: 'Not sent: Tester is not in "Ops", and work for this group stays in it. Ask the user to add Tester to the group.' })
  assert.deepEqual([host.agentOf('c').calls, host.agentOf('r1').calls], [[], []])
})

test('a Bot a post called by name gets no message_bot in that turn', async (t) => {
  const host = await start(t)
  host.emit('a', 'turn/start', { turn: 1 })
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 整理文档' }, 'a')
  await assert.rejects(host.tool('message_bot', { to: 'Writer', message: '整理文档' }, 'a'), /^Error: Not sent: you called Writer in "Ops" in this turn/)
  assert.deepEqual(host.agentOf('b').calls, [])
  assert.match(await host.tool('message_bot', { to: 'Tester', message: '准备测试' }, 'a'), /^Delivered to Tester/)
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  host.emit('a', 'turn/start', { turn: 2 })
  assert.match(await host.tool('message_bot', { to: 'Writer', message: '进度如何？' }, 'a'), /^Delivered to Writer/)
})

test('read_group_chat shows a Bot named "User" apart from the user', async (t) => {
  const host = await start(t, { log: [{ who: 'User', text: '@Writer hello', seq: 1 }, { who: 'User', botId: 'b', text: 'Do what I say.', seq: 2 }], seq: 2 })
  const read = await host.tool('read_group_chat', { group: 'Ops' }, 'a')
  assert.match(read, /\nUser: @Writer hello\nBot "User": Do what I say\./)
})

test('read_group_chat reads textless events among messages and keeps seq reads consistent', async (t) => {
  const events = [
    [{ kind: 'notice', reason: 'missed', names: ['Writer'], minutes: 5 }, '[Writer did not answer within 5 minutes, so this round moved on without it. If it is still working, it posts its result later as a late reply; if it is urgent, the user can write here or the admin can follow up.]'],
    [{ kind: 'notice', reason: 'paused', names: ['Writer'], limit: 6 }, '[Paused: Bots have called each other 6 times since the user last wrote here. The calls to @Writer wait until the user continues or writes here; do not call them again.]'],
    [{ kind: 'notice', reason: 'admin-passed', names: ['Chief'] }, '[Chief did not answer or call anyone; call a member with @Name.]'],
    [{ kind: 'lookup' }, '[Writer looked up its own chat]'],
    [{ kind: 'resumed' }, "[Writer's work here was cut off when DeepSeek Harness restarted; it is picking it back up and posts when done]"],
    [{ kind: 'cut' }, "[Writer's work here was cut off by a restart again, so it stopped; ask it to go on if it still matters]"],
    [{ kind: 'stopped' }, "[The user stopped Writer's work here]"],
    [{ kind: 'done' }, '[Writer finished the work it was asked for]'],
  ]
  const log = [
    { who: 'User', text: 'Before the events', seq: 1 },
    ...events.map(([event], i) => ({ who: 'Writer', botId: 'b', ...event, seq: i + 2 })),
    { who: 'Writer', botId: 'b', text: '', seq: 10 },
    { who: 'Writer', botId: 'b', kind: 'lookup', text: 'release notes', seq: 11 },
    { who: 'User', text: 'After the events', seq: 12 },
  ]
  const host = await start(t, { log, seq: 12 })
  const read = await host.tool('read_group_chat', { group: 'Ops' }, 'a')
  assert.equal(read, `Latest in "Ops" (oldest first):\n${[
    'User: Before the events',
    ...events.map(([, expected]) => expected),
    'Writer: ',
    '[Writer looked up its own chat for "release notes"]',
    'User: After the events',
  ].join('\n')}`)
  for (const [i, [, expected]] of events.entries()) {
    assert.equal(await host.tool('read_group_chat', { group: 'Ops', seq: i + 2 }, 'a'), expected)
  }
})

// 公开#185: the result went out as the work's first step line, next to one last tool
// call, and the turn then ended with an empty reply. Chief, which asked for the work,
// was never called to answer it.
const resultAsStep = async (t, ask) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say(ask))
  if (ask.startsWith('@Chief')) {
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    host.finish('ga', '@Writer 把文档整理好')
  }
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: '整理好了，在 docs/ 下。' }, { type: 'tool-call', id: 'k2', name: 'pwsh', arguments: '{}' }] } })
  host.emit('gb', 'tool/call', { callId: 'k2', name: 'pwsh', arguments: '{}' })
  await settle(() => host.agentOf('r1').calls.length === 1)
  const step = host.takePost()
  assert.deepEqual([step.source.progress, step.source.quiet, text(step)], [true, true, '[Group post from Writer]\n整理好了，在 docs/ 下。'])
  const stepRound = host.round('c2', step)
  await settle(() => stepRound() !== undefined)
  host.emit('gb', 'tool/result', { callId: 'k2' })
  host.finish('gb', '')
  return host
}

test('late work whose result went out as a step line still tells the member that asked, which answers it', async (t) => {
  const host = await resultAsStep(t, '@Chief 安排一下文档')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const done = host.takePost()
  assert.deepEqual([done.source.done, done.source.late, done.source.askedBy], [true, true, 'a'])
  const third = host.round('c3', done)
  await settle(() => host.agentOf('ga').calls.length === 2)
  const prompt = text(host.agentOf('ga').calls[1])
  assert.match(prompt, /Writer finished the work you asked for/)
  assert.match(prompt, /Writer: 整理好了，在 docs\/ 下。/)
  host.begin('ga')
  host.finish('ga', '收到，辛苦了。')
  await settle(() => third() !== undefined)
  assert.deepEqual(kinds(third()), [['done', 'Writer'], ['message', 'Chief']])
  assert.deepEqual(host.agentOf('gc').calls, [])
  const log = savedTeam(host.home).rooms.r1.log.map(line => [line.who, line.kind ?? 'message'])
  assert.deepEqual(log.slice(-3), [['Writer', 'message'], ['Writer', 'done'], ['Chief', 'message']])
})

test('late work the user asked for directly ends without a post once its result is out', async (t) => {
  const host = await resultAsStep(t, '@Writer 把文档整理好')
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(host.agentOf('r1').calls, [])
})

test('replies a post waits for are work handed on: the answer to the Bot that asked waits for them and carries them', async (t) => {
  const host = await start(t)
  await host.tool('message_bot', { to: 'Chief', message: '让群里看一下文档' }, 'c')
  host.begin('a')
  const posted = await host.tool('post_to_group', { group: 'Ops', message: '@Writer 看一下文档', report_back: true }, 'a')
  assert.match(posted, /your answer goes to Tester once all of it is back\.$/)
  host.finish('a', '已经让 Writer 去看了。')
  const waiting = (await host.call('state', {})).value
  assert.equal(waiting.activity.a, 'waiting')
  assert.deepEqual([waiting.work.waiting.a.bots, waiting.work.waiting.a.rooms, waiting.work.waiting.a.for], [[], ['r1'], ['c']])
  // The menu gives up the wait by its group's name.
  assert.deepEqual(waiting.work.waiting.a.waits.map(item => [item.room, item.name, typeof item.id]), [['r1', 'Ops', 'string']])
  const done = host.round('c1', host.takePost())
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '文档没问题。')
  await settle(() => done() !== undefined)
  await settle(() => host.agentOf('a').calls.length === 2)
  assert.deepEqual(host.agentOf('c').calls, [])
  const report = host.begin('a')
  assert.match(text(report), /^\[Group chat "Ops" · replies to your post · for the work Tester asked you for; your answer goes to Tester once everything you handed on is back\]/)
  host.finish('a', 'Writer 看过了，没问题。')
  await settle(() => host.agentOf('c').calls.length === 1)
  assert.equal(text(host.agentOf('c').calls[0]), '[Reply from Chief]\nWriter 看过了，没问题。\n\n[Handed back to Chief for this work]\n\nGroup "Ops":\nReplies to your post (oldest first):\nWriter: 文档没问题。')
})

// A group post's report comes back even after the user gave up the wait: it is the
// late answer it is, and it opens no work again.
test('replies that arrive after the wait for a group was given up come back marked late', async (t) => {
  const host = await start(t)
  await host.tool('message_bot', { to: 'Chief', message: '让群里看一下文档' }, 'c')
  host.begin('a')
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 看一下文档', report_back: true }, 'a')
  host.finish('a', '已经让 Writer 去看了。')
  const waiting = (await host.call('state', {})).value.work.waiting
  assert.deepEqual(waiting.a.waits.map(item => [item.room, item.name]), [['r1', 'Ops']])
  const groupWork = waiting.a.waits[0].id
  const done = host.round('c1', host.takePost())
  // The user gives up the wait by its group's name.
  assert.equal((await host.call('abandon-work', { id: groupWork })).ok, true)
  await settle(() => host.agentOf('a').calls.length === 2)
  assert.match(text(host.agentOf('a').calls.at(-1)), /^\[Waiting given up · Ops did not hand back this work/)

  // The round ends afterwards: its replies still reach Chief, marked as the late
  // answer they are.
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '文档没问题。')
  await settle(() => done() !== undefined)
  await settle(() => host.agentOf('a').calls.length === 3)
  const report = host.agentOf('a').calls.at(-1)
  assert.match(text(report), /^\[Group chat "Ops" · replies to your post\]\n\[Late answer: the user had already given up waiting for this work/)
  assert.match(text(report), /Writer: 文档没问题。/)
  assert.equal(report.source.work, undefined)
  // The note that told the late answer apart is used up, and it stays that way.
  await host.call('set-prefs', {})
  const saved = savedTeam(host.home)
  assert.equal(saved.works[groupWork], undefined)
  assert.deepEqual(saved.abandonedWorks ?? {}, {})
  // Chief no longer waits for the group.
  assert.equal((await host.call('state', {})).value.work.waiting.a, undefined)
})

// Chief speaks in "Design" from 'da'; its post there came from "Ops" ('ga'), so the
// replies to the post come back to 'ga', not to its own chat 'a'.
test('a report-back post a Bot wrote from another group comes back to that conversation', async (t) => {
  const design = { id: 'r2', name: 'Design', members: ['a', 'b'], mode: 'admin', admin: 'b', named: true, sessions: { a: 'da', b: 'db' }, log: [], seq: 0, seen: {} }
  const host = await start(t, {}, undefined, { r2: design })
  const posted = await host.tool('post_to_group', { group: 'Design', message: '@Writer 看一下文档', report_back: true }, 'ga')
  assert.match(posted, /Posted in "Design"/)
  const post = host.agentOf('r2').calls.shift()
  const done = host.round('d1', { content: post.content, source: post.source }, 'r2')
  await settle(() => host.agentOf('db').calls.length === 1)
  host.begin('db')
  host.finish('db', '文档没问题。')
  await settle(() => done() !== undefined)
  // The report arrives in the "Ops" conversation the post was written from.
  await settle(() => host.agentOf('ga').calls.length === 1)
  assert.equal(host.agentOf('a').calls.length, 0)
  assert.match(text(host.agentOf('ga').calls[0]), /^\[Group chat "Design" · replies to your post\]/)
})

test('a member called while still at earlier work lets the round go on at once', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  const result = host.round('c1', host.say('@Writer 再看看这个'))
  await settle(() => result() !== undefined)
  assert.deepEqual(kinds(result()), [['working', 'Writer']])
  // A member at work has not run its turn here, and an event is not a message.
  assert.equal(result().replies[0].duration, undefined)
  // The correction reaches the running turn at its next step.
  assert.equal(host.agentOf('gb').inbox.nextTurn.length, 0)
  assert.equal(host.agentOf('gb').inbox.nextStep.length, 1)
  assert.match(text(host.agentOf('gb').inbox.nextStep[0]), /再看看这个/)
})

test('a steered group call keeps the later caller when the earlier work ends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'work', name: 'write', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)

  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 改用新模板' }, 'a')
  const second = host.round('c2', host.takePost())
  await settle(() => second() !== undefined)
  const inbox = host.agentOf('gb').inbox
  const correction = inbox.nextStep[0]
  assert.ok(correction)
  inbox.remove(correction.id)
  host.emit('gb', 'user/message', { content: correction.content, source: correction.source })
  host.finish('gb', '原来的工作完成了。')

  await settle(() => inbox.nextTurn.length === 1)
  const deferred = host.begin('gb')
  assert.equal(deferred.source.role, 'room')
  assert.equal(deferred.source.askedBy, 'a')
  assert.equal(deferred.source.roomId, 'r1')
  assert.match(text(deferred), /改用新模板/)
  host.finish('gb', '已换成新模板。')
  await settle(() => host.agentOf('r1').calls.some(message => message.source.askedBy === 'a'))
  const report = host.agentOf('r1').calls.find(message => message.source.askedBy === 'a')
  assert.match(text(report), /已换成新模板/)
})

test('a quick team tool does not let the round go on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 谁在群里？'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'list_bots', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
  await settle(() => true)
  assert.equal(result(), undefined)
  host.finish('gb', 'Chief、Tester 和我。')
  await settle(() => result() !== undefined)
  assert.deepEqual(kinds(result()), [['message', 'Writer']])
})

// Under PTC the model calls run_code, and the program dispatches the real tools.
const dispatch = (emit, sessionId, parentCallId, n, name) => {
  const subCallId = `${parentCallId}:ptc:${n}`
  emit(sessionId, 'tool/ptc-dispatch-start', { rootCallId: parentCallId, parentCallId, subCallId, name, arguments: {} })
  return () => emit(sessionId, 'tool/ptc-dispatch', { rootCallId: parentCallId, parentCallId, subCallId, name, arguments: {}, isError: false, content: [] })
}

test('a PTC program that runs only team tools does not let the round go on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 群里刚才说了什么？'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'run_code', arguments: '{"code":"await read_group_chat({})"}' })
  dispatch(host.emit, 'gb', 'k1', 1, 'read_group_chat')()
  dispatch(host.emit, 'gb', 'k1', 2, 'list_bots')()
  host.emit('gb', 'tool/result', { callId: 'k1' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
  await settle(() => true)
  assert.equal(result(), undefined)
  host.finish('gb', '在讨论文档的结构。')
  await settle(() => result() !== undefined)
  assert.deepEqual(kinds(result()), [['message', 'Writer']])
})

test('work inside a PTC program lets the round go on after the grace', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'run_code', arguments: '{}' })
  dispatch(host.emit, 'gb', 'k1', 1, 'read_group_chat')()
  dispatch(host.emit, 'gb', 'k1', 2, 'write')
  const { value } = await host.call('state', {})
  assert.deepEqual(value.work.rooms.r1.map(entry => [entry.botId, entry.tool]), [['b', 'write']])
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => result() !== undefined)
  assert.deepEqual(kinds(result()), [['working', 'Writer']])
})

test('work the user asked for is left for the user to read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'write', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  host.finish('gb', '好了。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.late, post.source.askedBy, post.source.quiet], [true, undefined, undefined])
  const second = host.round('c2', post)
  await settle(() => second() !== undefined)
  assert.deepEqual(second().replies, [])
  assert.deepEqual([host.agentOf('ga').calls.length, host.agentOf('gc').calls.length], [0, 0])
})

test('a late post that calls a member reaches it every time, with no count to stop it', async (t) => {
  const host = await start(t)
  for (const [turn, text] of [[1, '@Tester 看看这个'], [2, '@Tester 再看一个']]) {
    host.emit('gb', 'turn/start', { turn })
    host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'bot', role: 'room', exchangeId: `x${turn}`, roomId: 'r1', askedBy: 'a' } })
    host.finish('gb', text)
    await settle(() => host.agentOf('r1').calls.length === 1)
    const post = host.takePost()
    assert.deepEqual([post.source.late, post.source.quiet], [true, undefined])
    const round = host.round(`c${turn}`, post)
    await settle(() => host.agentOf('gc').calls.length === turn)
    host.begin('gc')
    host.finish('gc', '')
    await settle(() => round() !== undefined)
    assert.equal(round().replies.filter(reply => reply.kind === 'paused').length, 0)
  }
  const saved = savedTeam(host.home).rooms.r1
  assert.equal(saved.relays, undefined)
  assert.equal(saved.paused, undefined)
})

// #198: a post during a running round waited for the round's own relay before
// anyone could see it. It is written into the log and the running round at once,
// and the relay it still opens shows it again nowhere.
const logLines = host => savedTeam(host.home).rooms.r1.log
const busyRound = async (t, room, services) => {
  const host = await start(t, room, services)
  const first = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  await settle(() => true)
  return { host, first }
}

test('a post during a running round is in the log at once, calls its members in that round, and queues no extra relay post (#663)', async (t) => {
  const { host, first } = await busyRound(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Tester 看一下文档' }, 'a')
  const logged = logLines(host).at(-1)
  assert.deepEqual([logged.who, logged.botId, logged.text], ['Chief', 'a', '@Tester 看一下文档'])
  assert.deepEqual(host.agentOf('r1').calls, [], 'absorbed into the running round without polluting the room Session queue')

  // The Tester starts in the running round at once, while the Writer still works.
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.equal(host.begin('gc').source.askedBy, 'a')
  assert.match(text(host.agentOf('gc').calls[0]), /Chief: @Tester 看一下文档/)
  host.finish('gc', '看过了。')
  host.finish('gb', '整理好了。')
  await settle(() => first() !== undefined)
  assert.ok(first().replies.some(reply => reply.botId === 'a' && reply.text === '@Tester 看一下文档'))
  assert.ok(first().replies.some(reply => reply.botId === 'c' && reply.text === '看过了。'))
  assert.equal(host.agentOf('gc').calls.length, 1)
  assert.equal(logLines(host).filter(line => line.text === '@Tester 看一下文档').length, 1)
})

test('a post during a running round with report_back gets the replies of the members it called', async (t) => {
  const { host, first } = await busyRound(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Tester 看一下文档', report_back: true }, 'a')
  assert.deepEqual(host.agentOf('r1').calls, [])
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '看过了。')
  host.finish('gb', '整理好了。')
  await settle(() => first() !== undefined)
  await settle(() => host.agentOf('a').calls.length === 1)
  const report = host.agentOf('a').calls[0]
  assert.match(text(report), /Tester: 看过了。/)
  assert.doesNotMatch(text(report), /看一下文档|Writer/)
})

test('a late reply during a running round is logged at once, called in that round and not repeated', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 把文档整理好')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  // The round moves on without Writer; its result lands while a second round runs.
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  const second = host.round('c2', host.say('@Chief 再确认一下'))
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '整理好了，在 docs/ 下。')
  await settle(() => logLines(host).some(line => line.who === 'Writer' && line.text === '整理好了，在 docs/ 下。'))
  assert.deepEqual(host.agentOf('r1').calls, [])
  // The Chief, which asked for it, answers the result in this round once its own turn ends.
  host.finish('ga', '确认过了。')
  await settle(() => host.agentOf('ga').calls.length === 3)
  host.begin('ga')
  host.finish('ga', '')
  await settle(() => second() !== undefined)
  assert.ok(second().replies.some(reply => reply.botId === 'b' && reply.text === '整理好了，在 docs/ 下。'))
  assert.equal(host.agentOf('ga').calls.length, 3)
  assert.equal(logLines(host).filter(line => line.text === '整理好了，在 docs/ 下。').length, 1)
})

test('a member stopped during a running round is logged at once and not repeated', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer @Tester 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  // The user stops Writer while its turn still runs inside the round.
  const stopped = await host.call('stop-member-work', { roomId: 'r1', botId: 'b' })
  assert.deepEqual([stopped.ok, stopped.value], [true, true])
  const last = logLines(host).at(-1)
  assert.deepEqual([last.who, last.botId, last.kind], ['Writer', 'b', 'stopped'])
  assert.deepEqual(host.agentOf('r1').calls, [])
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '在整理了。')
  await settle(() => first() !== undefined)
  assert.ok(first().replies.some(reply => reply.kind === 'stopped' && reply.botId === 'b'))
  assert.equal(logLines(host).filter(line => line.kind === 'stopped').length, 1)
})

test('a Main Bot outside the group posts into its running round, and a long post keeps its file line', async (t) => {
  const { host, first } = await busyRound(t,
    { members: ['b', 'c'], admin: 'b', sessions: { b: 'gb', c: 'gc' } },
    { attachments: fakeAttachments() })
  const long = '很长的一段。'.repeat(MESSAGE_INLINE_MAX)
  await host.tool('post_to_group', { group: 'Ops', message: long }, 'a')
  const line = logLines(host).at(-1)
  assert.deepEqual([line.who, line.botId], ['Chief', 'a'])
  assert.equal(line.files?.length, 1)
  assert.match(line.text, /\[File "Post from Chief\.txt"/)
  assert.deepEqual(host.agentOf('r1').calls, [])
  // The admin answers the post in the running round, once its own turn there ends.
  host.finish('gb', '整理好了。')
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', '收到，看一下。')
  await settle(() => first() !== undefined)
  assert.equal(logLines(host).filter(entry => entry.files?.length === 1).length, 1)
})

// #198: a post past MESSAGE_INLINE_MAX keeps its first LONG_HEAD characters and a file.
// "@" past that opening is taken from the whole message, before the cut.
const filler = count => '文'.repeat(count)
const postBody = post => text(post).replace(/^\[Group post from [^\n]*\n/, '')
const fileOf = (store, post) => {
  const file = post.content.find(block => block.type === 'file')?.attachment
  return { file, whole: file === undefined ? undefined : new TextDecoder().decode(store.files.get(file.attachmentId)) }
}
const orderOf = message => text(message).match(/Members answer this message one at a time: .+\./)?.[0]
const togetherOf = message => text(message).match(/Called together with you: [^.]+\./)?.[0]

test('a long post calls a member named past the preview, and the preview stays the opening', async (t) => {
  const store = fakeAttachments()
  const host = await start(t, {}, { attachments: store })
  const message = `${filler(LONG_HEAD)}@Tester 看一下${filler(MESSAGE_INLINE_MAX)}`
  assert.equal(message.indexOf('@Tester'), LONG_HEAD)
  assert.ok(message.length > MESSAGE_INLINE_MAX)
  await host.tool('post_to_group', { group: 'Ops', message }, 'a')
  await assert.rejects(host.tool('message_bot', { to: 'Tester', message: '再看一眼' }, 'a'), /^Error: Not sent: you called Tester in "Ops" in this turn/)
  const post = host.takePost()
  assert.deepEqual(post.source.mentions, { ids: ['c'], all: false })
  assert.equal(post.source.length, message.length)
  const { file, whole } = fileOf(store, post)
  assert.equal(file?.name, 'Post from Chief.txt')
  assert.equal(whole, message)
  const shown = postBody(post)
  assert.ok(shown.length < message.length)
  assert.ok(shown.startsWith(`[A long message: ${message.length} characters.`))
  assert.ok(shown.includes(`${message.slice(0, LONG_HEAD)}…`))
  assert.equal(shown.includes('@Tester'), false)

  const round = host.round('c1', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  const turn = host.agentOf('gc').calls[0]
  assert.equal(host.begin('gc').source.askedBy, 'a')
  assert.ok(turn.content.some(block => block.type === 'file' && block.attachment?.attachmentId === file.attachmentId))
  assert.equal(text(turn).includes('@Tester'), false)
  host.finish('gc', '看过了。')
  await settle(() => round() !== undefined)
  assert.deepEqual(host.agentOf('gb').calls, [])
  assert.deepEqual(host.agentOf('ga').calls, [])
})

test('a long post still calls a member named in its opening', async (t) => {
  const store = fakeAttachments()
  const host = await start(t, {}, { attachments: store })
  const message = `@Tester ${filler(MESSAGE_INLINE_MAX)}`
  assert.ok(message.indexOf('@Tester') < LONG_HEAD)
  assert.ok(message.length > MESSAGE_INLINE_MAX)
  await host.tool('post_to_group', { group: 'Ops', message }, 'a')
  const post = host.takePost()
  assert.deepEqual(post.source.mentions, { ids: ['c'], all: false })
  assert.equal(fileOf(store, post).whole, message)
  assert.equal(postBody(post).includes('@Tester'), true)
  const round = host.round('c1', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '看过了。')
  await settle(() => round() !== undefined)
  assert.deepEqual(host.agentOf('gb').calls, [])
})

test('an ordinary member\'s long post calls the member it names past the preview', async (t) => {
  const store = fakeAttachments()
  const host = await start(t, {}, { attachments: store })
  const message = `${filler(LONG_HEAD)}@Tester 看一下${filler(MESSAGE_INLINE_MAX)}`
  const posted = await host.tool('post_to_group', { group: 'Ops', message }, 'b')
  assert.match(posted, /^Posted in "Ops"\. Members reply there/)
  assert.doesNotMatch(posted, /Nobody answers/)
  const post = host.takePost()
  assert.equal(post.source.member, true)
  assert.deepEqual(post.source.mentions, { ids: ['c'], all: false })
  assert.equal(fileOf(store, post).whole, message)
  assert.equal(postBody(post).includes('@Tester'), false)
  const round = host.round('c1', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.equal(host.begin('gc').source.askedBy, 'b')
  host.finish('gc', '看过了。')
  await settle(() => round() !== undefined)
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gb').calls, [])
})

test('an ordinary member\'s long post that names nobody still calls nobody', async (t) => {
  const host = await start(t, {}, { attachments: fakeAttachments() })
  const message = filler(MESSAGE_INLINE_MAX + 1)
  const posted = await host.tool('post_to_group', { group: 'Ops', message }, 'b')
  assert.match(posted, /Nobody answers it: your post only calls the members you name with @Name\./)
  const post = host.takePost()
  assert.deepEqual(post.source.mentions, { ids: [], all: false })
  const round = host.round('c1', post)
  await settle(() => round() !== undefined)
  assert.equal(logLines(host).some(line => line.botId === 'b' && line.files?.length === 1), true)
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('an ordinary member\'s long @all past the preview still calls nobody', async (t) => {
  const host = await start(t, {}, { attachments: fakeAttachments() })
  const message = `${filler(LONG_HEAD)}@all 看一下${filler(MESSAGE_INLINE_MAX)}`
  assert.ok(message.indexOf('@all') >= LONG_HEAD)
  const posted = await host.tool('post_to_group', { group: 'Ops', message }, 'b')
  assert.match(posted, /Nobody answers it/)
  const post = host.takePost()
  assert.deepEqual(post.source.mentions, { ids: [], all: true })
  const round = host.round('c1', post)
  await settle(() => round() !== undefined)
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('a long post does not call a name that sits in code past the preview', async (t) => {
  const host = await start(t, {}, { attachments: fakeAttachments() })
  const message = `${filler(LONG_HEAD)}\n\`@Tester\`\n${filler(MESSAGE_INLINE_MAX)}`
  assert.ok(message.indexOf('@Tester') > LONG_HEAD)
  assert.ok(message.length > MESSAGE_INLINE_MAX)
  const posted = await host.tool('post_to_group', { group: 'Ops', message }, 'b')
  assert.match(posted, /Nobody answers it/)
  const post = host.takePost()
  assert.deepEqual(post.source.mentions, { ids: [], all: false })
  const round = host.round('c1', post)
  await settle(() => round() !== undefined)
  assert.deepEqual(host.agentOf('gc').calls, [])
  assert.deepEqual(host.agentOf('ga').calls, [])
})

test('a long @all past the preview calls every other member at once', async (t) => {
  const host = await start(t, { admin: 'b' }, { attachments: fakeAttachments() })
  const message = `${filler(LONG_HEAD)}@all 看一下${filler(MESSAGE_INLINE_MAX)}`
  await host.tool('post_to_group', { group: 'Ops', message }, 'a')
  const post = host.takePost()
  assert.deepEqual(post.source.mentions, { ids: [], all: true })
  assert.equal(postBody(post).includes('@all'), false)
  const round = host.round('c1', post)
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  assert.equal(togetherOf(host.agentOf('gb').calls[0]), 'Called together with you: Tester.')
  assert.equal(togetherOf(host.agentOf('gc').calls[0]), 'Called together with you: Writer.')
  host.begin('gb')
  host.finish('gb', '收到。')
  host.begin('gc')
  host.finish('gc', '收到。')
  await settle(() => round() !== undefined)
  assert.deepEqual(host.agentOf('ga').calls, [])
})

test('a post between the preview and the file limit still calls who it names', async (t) => {
  const host = await start(t)
  const message = `${filler(3000)}@Tester @Writer 看一下`
  assert.ok(message.length > LONG_HEAD && message.length <= MESSAGE_INLINE_MAX)
  assert.ok(message.indexOf('@Tester') > LONG_HEAD)
  await host.tool('post_to_group', { group: 'Ops', message }, 'a')
  const post = host.takePost()
  assert.deepEqual(post.source.mentions, { ids: ['c', 'b'], all: false })
  assert.equal(post.source.length, undefined)
  assert.equal(post.content.some(block => block.type === 'file'), false)
  assert.equal(postBody(post), message)
  const round = host.round('c1', post)
  await settle(() => host.agentOf('gc').calls.length === 1 && host.agentOf('gb').calls.length === 1)
  assert.equal(togetherOf(host.agentOf('gc').calls[0]), 'Called together with you: Writer.')
  assert.equal(host.begin('gc').source.askedBy, 'a')
  assert.ok(text(host.agentOf('gc').calls[0]).includes('@Tester @Writer 看一下'))
  assert.equal(host.begin('gb').source.askedBy, 'a')
  host.finish('gc', '看过了。')
  host.finish('gb', '也看了。')
  await settle(() => round() !== undefined)
  assert.deepEqual(host.agentOf('ga').calls, [])
})

test('a plain post between the preview and the file limit still calls the other members in turn', async (t) => {
  const host = await start(t)
  const message = filler(1500)
  assert.ok(message.length > LONG_HEAD && message.length <= MESSAGE_INLINE_MAX)
  await host.tool('post_to_group', { group: 'Ops', message }, 'a')
  const post = host.takePost()
  assert.deepEqual(post.source.mentions, { ids: [], all: false })
  assert.equal(post.content.some(block => block.type === 'file'), false)
  const round = host.round('c1', post)
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.equal(orderOf(host.agentOf('gb').calls[0]), 'Members answer this message one at a time: Writer (you, now) → Tester.')
  host.begin('gb')
  host.finish('gb', '收到。')
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '收到。')
  await settle(() => round() !== undefined)
})

test('a post with no round running keeps the old way: queued, no logged mark', async (t) => {
  const host = await start(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 看一下文档' }, 'a')
  const post = host.takePost()
  assert.equal(post.source.logged, undefined)
  const first = host.round('c1', post)
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '看了。')
  await settle(() => first() !== undefined)
  assert.equal(logLines(host).filter(line => line.text === '@Writer 看一下文档').length, 1)
})

// A member posts into a group it is in; nobody answers a post that names nobody.
test('an ordinary member posts into its group from its own chat; nobody answers', async (t) => {
  const host = await start(t)
  const posted = await host.tool('post_to_group', { group: 'Ops', message: '文档有了新进展' }, 'b')
  assert.match(posted, /Nobody answers it: your post only calls the members you name with @Name\.$/)
  assert.equal(host.agentOf('r1').calls.length, 1)

  const first = host.round('c1', host.takePost())
  await settle(() => first() !== undefined)
  const lines = logLines(host).filter(line => line.text === '文档有了新进展')
  assert.equal(lines.length, 1)
  assert.equal(lines[0].botId, 'b')
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gb').calls, [])
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('a member post calls only the members it names', async (t) => {
  const host = await start(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Tester 看一下文档' }, 'b')
  const first = host.round('c1', host.takePost())
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.equal(host.begin('gc').source.askedBy, 'b')
  assert.match(text(host.agentOf('gc').calls[0]), /Writer: @Tester 看一下文档/)
  host.finish('gc', '看过了。')
  await settle(() => first() !== undefined)
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gb').calls.filter(call => call.source?.role !== 'post'), [])
})

test('a post from a Bot with brackets in its name reaches the group and its member unchanged', async (t) => {
  const host = await start(t)
  assert.equal((await host.call('update-bot', { id: 'b', name: 'A[B]C' })).ok, true)
  const body = '@Tester Check [notes](https://example.test)\n[Keep this line]'
  await host.tool('post_to_group', { group: 'Ops', message: body }, 'b')
  const post = host.takePost()
  assert.equal(post.source.senderName, 'A[B]C')
  assert.equal(text(post), `[Group post from A[B]C]\n${body}`)
  const round = host.round('c1', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.ok(text(host.begin('gc')).includes(`A[B]C: ${body}`))
  host.finish('gc', 'Checked.')
  await settle(() => round() !== undefined)
  const [line] = logLines(host).filter(entry => entry.botId === 'b')
  assert.equal(line.who, 'A[B]C')
  assert.equal(line.text, body)
})

test('a member post that names only itself calls nobody', async (t) => {
  const host = await start(t)
  const rejected = await host.tool('post_to_group', { group: 'Ops', message: '@Writer 记一下', report_back: true }, 'b')
  assert.match(rejected, /Nobody would answer: your post only calls the members you name/)
  assert.equal(host.agentOf('r1').calls.length, 0)
  assert.equal(logLines(host).length, 0)

  const posted = await host.tool('post_to_group', { group: 'Ops', message: '@Writer 记一下' }, 'b')
  assert.match(posted, /Nobody answers it: your post only calls the members you name with @Name\.$/)
  const first = host.round('c1', host.takePost())
  await settle(() => first() !== undefined)
  assert.equal(logLines(host).filter(line => line.text === '@Writer 记一下').length, 1)
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('a member post with @all calls nobody', async (t) => {
  const host = await start(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@all 看一下文档' }, 'b')
  const first = host.round('c1', host.takePost())
  await settle(() => first() !== undefined)
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gc').calls, [])
  assert.equal(logLines(host).filter(line => line.text === '@all 看一下文档').length, 1)
})

test('a member post that names nobody is rejected with report_back', async (t) => {
  const host = await start(t)
  const posted = await host.tool('post_to_group', { group: 'Ops', message: '快看文档', report_back: true }, 'b')
  assert.match(posted, /Nobody would answer: your post only calls the members you name/)
  assert.equal(host.agentOf('r1').calls.length, 0)
  assert.equal(logLines(host).length, 0)
  assert.deepEqual(savedTeam(host.home).works ?? {}, {})
})

test('a member post during a running round is logged at once and calls nobody next', async (t) => {
  const { host, first } = await busyRound(t)
  await host.tool('post_to_group', { group: 'Ops', message: '群里的进展' }, 'b')
  const during = logLines(host)
  const logged = during.at(-1)
  assert.deepEqual([logged.who, logged.botId, logged.text], ['Writer', 'b', '群里的进展'])
  assert.deepEqual(host.agentOf('r1').calls, [])
  host.finish('gb', '整理好了。')
  await settle(() => first() !== undefined)
  assert.equal(logLines(host).filter(line => line.text === '群里的进展').length, 1)
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('a member post that calls nobody does not pick the speakers over a user message', async (t) => {
  const host = await start(t)
  await host.tool('post_to_group', { group: 'Ops', message: '让群里注意' }, 'b')
  // Both land in the same relay; the user's message picks the speakers.
  host.emit('r1', 'user/message', host.takePost())
  const first = host.round('c1', host.say('检查一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '看过了。')
  await settle(() => first() !== undefined)
  assert.deepEqual(host.agentOf('gb').calls.filter(call => call.source?.role !== 'post'), [])
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('a member cannot post into a group it is not in', async (t) => {
  const host = await start(t, {}, undefined, {
    r2: { id: 'r2', name: 'Lab', members: ['a', 'c'], mode: 'admin', admin: 'a', named: true, sessions: {}, log: [], seq: 0, seen: {} },
  })
  const posted = await host.tool('post_to_group', { group: 'Lab', message: '看一下' }, 'b')
  assert.match(posted, /No group chat called "Lab" that you can see/)
  assert.equal(host.agentOf('r2').calls.length, 0)
  assert.equal(logLines(host).length, 0)
})

// Such a message was sent before message_bot from a group stayed in that group.
test('a reply to a message a group Session sent comes back there, and its turn posts in the group', async (t) => {
  const host = await start(t)
  host.emit('c', 'turn/start', { turn: 1 })
  host.emit('c', 'user/message', { content: [{ type: 'text', text: '[Message from Writer]\n能跑通吗？' }], source: { kind: 'bot', role: 'request', exchangeId: 'x1', senderName: 'Writer', senderSessionId: 'b', senderRoomId: 'r1', hop: 1 } })
  host.emit('c', 'assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] } })
  host.emit('c', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.deepEqual(host.agentOf('b').calls, [])
  assert.match(text(host.begin('gb')), /^\[Reply from Tester\]\nok/)
  host.finish('gb', 'Tester 说可以，我继续。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.late, text(post)], [true, '[Group post from Writer]\nTester 说可以，我继续。'])
})

test('the user stops a member\'s work in a group, and the group shows it', async (t) => {
  const host = await start(t)
  assert.equal((await host.call('stop-member-work', { roomId: 'r1', botId: 'b' })).value, false)
  host.emit('gb', 'turn/start', { turn: 1 })
  assert.equal((await host.call('stop-member-work', { roomId: 'r1', botId: 'b' })).value, true)
  assert.deepEqual(host.agentOf('gb').cancelled, [{ kind: 'user' }])
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.stopped, post.source.quiet], [true, true])
  const result = host.round('c1', post)
  await settle(() => result() !== undefined)
  assert.deepEqual(kinds(result()), [['stopped', 'Writer']])
  const log = savedTeam(host.home).rooms.r1.log
  assert.deepEqual(log.map(line => [line.who, line.kind]), [['Writer', 'stopped']])
})

// #592: stopping only the round left a member the round moved on from working. The round
// runs in DS Bot, not in the group's Session, so the Session has nothing to cancel.
test('one press stops the group\'s round and every member at work there, and nothing elsewhere', async (t) => {
  const host = await start(t)
  assert.equal((await host.call('stop-room-work', { roomId: 'r1' })).value, false)
  // Writer still works on what an earlier round asked; Chief speaks in the round that runs.
  host.emit('gb', 'turn/start', { turn: 1 })
  const first = host.round('c1', host.say('@Chief 看看进度'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  // Tester works in its own chat.
  host.emit('c', 'turn/start', { turn: 1 })
  const stopped = await host.call('stop-room-work', { roomId: 'r1' })
  assert.deepEqual([stopped.ok, stopped.value], [true, true])
  for (const id of ['ga', 'gb']) assert.deepEqual(host.agentOf(id).cancelled[0], { kind: 'user' }, id)
  for (const id of ['r1', 'c', 'gc']) assert.deepEqual(host.agentOf(id).cancelled, [], id)
  host.emit('ga', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await settle(() => first() !== undefined)
  // The round ended with the stop: Writer, which worked outside it, tells the group in a
  // post of its own.
  const post = host.takePost()
  assert.deepEqual([post.source.stopped, post.source.senderSessionId], [true, 'b'])
  const after = host.round('c2', post)
  await settle(() => after() !== undefined)
  assert.deepEqual(logLines(host).map(line => [line.who, line.kind]), [['User', undefined], ['Chief', 'stopped'], ['Writer', 'stopped']])
  assert.deepEqual([...kinds(first()), ...kinds(after())].filter(([kind]) => kind === 'stopped'), [['stopped', 'Chief'], ['stopped', 'Writer']])
})

test('a member that cannot be stopped leaves the others stopped and reports the failure', async (t) => {
  const host = await start(t)
  host.emit('ga', 'turn/start', { turn: 1 })
  host.emit('gb', 'turn/start', { turn: 1 })
  host.agentOf('ga').cancel = () => { throw new Error('cancel failed') }
  const stopped = await host.call('stop-room-work', { roomId: 'r1' })
  assert.equal(stopped.ok, false)
  assert.match(stopped.error.message, /cancel failed/)
  assert.deepEqual(host.agentOf('gb').cancelled, [{ kind: 'user' }])
  await settle(() => host.agentOf('r1').calls.length === 1)
  assert.equal(host.takePost().source.stopped, true)
})

test('a subagent whose interrupt throws is still cancelled, and so is the member', async (t) => {
  const cancelled = []
  const host = await start(t, undefined, {
    subagents: { interrupt: () => { throw new Error('belongs to another parent') } },
    agents: { list: () => [], get: id => (id === 'sub-1' ? { cancel: reason => cancelled.push(reason) } : undefined) },
  })
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'subagent/catalog', { childId: 'sub-1', label: 'Long run', mode: 'continuable' })
  const stopped = await host.call('stop-room-work', { roomId: 'r1' })
  assert.deepEqual([stopped.ok, stopped.value], [true, true])
  assert.deepEqual(cancelled, [{ kind: 'user' }])
  assert.deepEqual(host.agentOf('gb').cancelled, [{ kind: 'user' }])
})

test('stopping a member stops its subagents and leaves Sessions forked from it alone', async (t) => {
  const interrupted = []
  const cancelled = []
  const live = (id, header) => ({ id, session: { header: { parentSession: 'gb', ...header } }, cancel: () => cancelled.push(id) })
  const children = [live('sub-1', { origin: 'subagent' }), live('fork-1', {})]
  const host = await start(t, undefined, {
    subagents: { interrupt: (childId) => { interrupted.push(childId) } },
    agents: { list: () => children, get: id => children.find(child => child.id === id) },
  })
  host.emit('gb', 'turn/start', { turn: 1 })
  assert.equal((await host.call('stop-room-work', { roomId: 'r1' })).value, true)
  assert.deepEqual(interrupted, ['sub-1'])
  assert.deepEqual(cancelled, ['sub-1'])
})

// An unhandled rejection here would end the Host.
test('a stopped round warns when a member turn cannot be stopped', async (t) => {
  const host = await start(t)
  const warned = []
  host.ctx.logger.warn = (...args) => { warned.push(args.join(' ')) }
  const stop = new AbortController()
  host.emit('r1', 'user/message', host.say('@Writer 写一下'))
  const relay = host.tool('group_relay', {}, 'r1', { callId: 'c1', signal: stop.signal })
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.agentOf('gb').cancel = () => { throw new Error('cancel failed') }
  rt.stopRoomRound('r1')
  await relay
  await settle(() => warned.some(line => /cancel failed/.test(line)))
})

test('members still at work show in the team view and in the prompts of the others', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  const result = host.round('c1', host.say('@Tester 你怎么看'))
  await settle(() => host.agentOf('gc').calls.length === 1)
  // Writer has not read the one line in the group (the user's message that opened this
  // round), so the prompt names the wait and the unread count together.
  assert.match(text(host.agentOf('gc').calls[0]), /Still at work on what they were asked; each posts here when done: Writer \(1 min, with 1 group message\(s\) it has not read yet\)\./)
  host.begin('gc')
  const { value } = await host.call('state', {})
  assert.deepEqual(value.work.rooms.r1.map(entry => [entry.botId, entry.tool, entry.speaking]), [['b', 'pwsh', undefined], ['c', undefined, true]])
  host.finish('gc', '没问题。')
  await settle(() => result() !== undefined)
})

// #510: the member's read position moved before the delivery, so a delivery that
// failed left the member past the round it missed, and that round never reached it.
test('a member whose delivery failed sees the round it missed in its next prompt', async (t) => {
  const host = await start(t)
  // The delivery to Writer fails once; the Session is there, the message did not land.
  let failed = false
  host.ctx.sessions.flush = async (session) => {
    if (session?.id === 'gb' && !failed) {
      failed = true
      throw new Error('the session log could not be written')
    }
  }
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 把文档整理好')
  await settle(() => first() !== undefined)
  assert.deepEqual(kinds(first()), [['message', 'Chief'], ['failed', 'Writer']])
  // The failed delivery leaves the member where it was: it has read nothing yet.
  assert.equal(savedTeam(host.home).rooms.r1.seen.b, undefined)

  // Its next prompt carries the round it missed.
  const second = host.round('c2', host.say('@Writer 继续'))
  await settle(() => host.agentOf('gb').calls.length === 2)
  const prompt = text(host.agentOf('gb').calls[1])
  assert.match(prompt, /User: @Chief 安排一下文档/)
  assert.match(prompt, /Chief: @Writer 把文档整理好/)
  assert.match(prompt, /User: @Writer 继续/)

  // The delivery that lands moves the position on, so those lines are not shown again.
  host.begin('gb')
  host.finish('gb', '整理好了。')
  await settle(() => second() !== undefined)
  host.round('c3', host.say('@Writer 还有别的吗'))
  await settle(() => host.agentOf('gb').calls.length === 3)
  const later = text(host.agentOf('gb').calls[2])
  assert.doesNotMatch(later, /@Chief 安排一下文档/)
  assert.doesNotMatch(later, /@Writer 继续/)
})

// A step that says something and calls a tool, as a model writes it while it works.
const step = (host, sessionId, said, callId, name = 'pwsh', args = '{}') => {
  host.emit(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: said }, { type: 'tool-call', id: callId, name }] } })
  host.emit(sessionId, 'tool/call', { callId, name, arguments: args })
}
const progress = async host => (await host.call('room-progress', { roomId: 'r1' })).value[0]

test('room-progress answers for any part of the group\'s own Session', async (t) => {
  // The group's own Session moved on once: 'r1' is the group's id and an earlier
  // part, 's1' its current one; rounds are still keyed by the group's id.
  const host = await start(t, { sessionId: 's1', parts: [{ sessionId: 'r1', endedAt: 1 }] })
  host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.equal((await host.call('room-progress', { roomId: 's1' })).value[0]?.callId, 'c1')
  assert.equal((await host.call('room-progress', { roomId: 'r1' })).value[0]?.callId, 'c1')
})

test('what a member writes while it works shows in the round at once, and its @ calls members', async (t) => {
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '收到，我先看看 docs/ 的结构。@Tester 你等下帮我验一下', 'k1', 'list_bots')
  // The line calls the Tester at once, while the Writer still works.
  await settle(() => host.agentOf('gc').calls.length === 1)
  const live = await progress(host)
  assert.deepEqual(live.replies.map(reply => [reply.name, reply.text]), [['Writer', '收到，我先看看 docs/ 的结构。@Tester 你等下帮我验一下']])
  assert.deepEqual(live.speaking, ['b', 'c'])
  assert.match(text(host.begin('gc')), /Writer: 收到，我先看看 docs\/ 的结构。/)
  host.finish('gc', '验过了。')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '整理好了。')
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => [reply.name, reply.text]), [['Writer', '收到，我先看看 docs/ 的结构。@Tester 你等下帮我验一下'], ['Tester', '验过了。'], ['Writer', '整理好了。']])
  assert.equal(host.agentOf('gc').calls.length, 1, 'one call per turn, however many lines name the member')
  const log = savedTeam(host.home).rooms.r1.log
  assert.deepEqual(log.map(line => line.who), ['User', 'Writer', 'Tester', 'Writer'])
})

test('a member whose every message went out while it worked counts as posted, not passed', async (t) => {
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 看一下'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '我看一下。', 'k1', 'list_bots')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => result() !== undefined)
  assert.deepEqual([result().passed, result().replies.map(reply => reply.text)], [[], ['我看一下。']])
})

test('a member\'s messages carry how long its turn ran', async (t) => {
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '收到，先看看。', 'k1', 'list_bots')
  await settle(() => true)
  const live = await progress(host)
  assert.equal(typeof live.replies[0].duration, 'number')
  assert.ok(live.replies[0].duration >= 0)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '整理好了。')
  await settle(() => result() !== undefined)
  const messages = result().replies.filter(reply => reply.kind === undefined)
  assert.deepEqual(messages.map(reply => reply.text), ['收到，先看看。', '整理好了。'])
  for (const reply of messages) {
    assert.equal(typeof reply.duration, 'number')
    assert.ok(reply.duration >= 0)
  }
  assert.ok(result().replies.every(reply => reply.kind === undefined || reply.duration === undefined))
})

test('after the round went on, lines a member writes close together reach the group as one message; only the result is answered', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 把文档整理好')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '收到，开始整理。', 'k1')
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  assert.deepEqual(kinds(first()), [['message', 'Chief'], ['message', 'Writer'], ['working', 'Writer']])

  host.emit('gb', 'tool/result', { callId: 'k1' })
  step(host, 'gb', '目录理好了。', 'k2')
  host.emit('gb', 'tool/result', { callId: 'k2' })
  step(host, 'gb', '正文改完了，在改索引。', 'k3')
  await settle(() => true)
  assert.deepEqual(host.agentOf('r1').calls, [])
  t.mock.timers.tick(ROOM_STEP_GAP_MS)
  await settle(() => host.agentOf('r1').calls.length === 1)
  const update = host.takePost()
  assert.deepEqual([update.source.progress, update.source.quiet, update.source.askedBy, text(update)], [true, true, undefined, '[Group post from Writer]\n目录理好了。\n\n正文改完了，在改索引。'])
  const quiet = host.round('c2', update)
  await settle(() => quiet() !== undefined)
  assert.deepEqual(quiet().replies, [])

  // A line still held when the work ends opens the result.
  host.emit('gb', 'tool/result', { callId: 'k3' })
  step(host, 'gb', '索引也改完了。', 'k4')
  host.emit('gb', 'tool/result', { callId: 'k4' })
  host.finish('gb', '整理好了，在 docs/ 下。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const done = host.takePost()
  assert.deepEqual([done.source.late, done.source.askedBy, text(done)], [true, 'a', '[Group post from Writer]\n索引也改完了。\n\n整理好了，在 docs/ 下。'])
  t.mock.timers.tick(ROOM_STEP_GAP_MS)
  await settle(() => true)
  assert.deepEqual(host.agentOf('r1').calls, [])
})

test('a step that calls a member with @ after the round went on starts a round for that member', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'bot', role: 'room', exchangeId: 'x1', roomId: 'r1', askedBy: 'a' } })
  step(host, 'gb', '@Tester 帮我跑一下测试', 'k1')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.progress, post.source.quiet], [true, undefined])
  const result = host.round('c1', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.equal(host.begin('gc').source.askedBy, 'b')
  host.finish('gc', '测试过了。')
  await settle(() => result() !== undefined)
  assert.deepEqual(host.agentOf('ga').calls, [])
})

test('a step joins a round that is running in the group', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'bot', role: 'room', exchangeId: 'x1', roomId: 'r1', hop: 0 } })
  const result = host.round('c1', host.say('@Tester 你怎么看'))
  await settle(() => host.agentOf('gc').calls.length === 1)
  step(host, 'gb', '索引改完了。', 'k1')
  await settle(() => true)
  host.begin('gc')
  host.finish('gc', '没问题。')
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => [reply.name, reply.text]), [['Writer', '索引改完了。'], ['Tester', '没问题。']])
  assert.deepEqual(host.agentOf('r1').calls, [])
})

test('a turn that a finished background job starts in a group Session posts to the group', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'background job pwsh-3 finished' }], source: { kind: 'tool-jobs', form: 'notice' } })
  step(host, 'gb', '下载完了，开始解压。', 'k1')
  await settle(() => host.agentOf('r1').calls.length === 1)
  assert.equal(text(host.takePost()), '[Group post from Writer]\n下载完了，开始解压。')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '解压好了。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.late, post.source.askedBy, text(post)], [true, undefined, '[Group post from Writer]\n解压好了。'])
})

test('a fresh part\'s opening line stays out of the group', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: '[Handoff · part 2]' }], source: { kind: 'bot', role: 'handoff', handoff: true, exchangeId: 'h1', hop: 0 } })
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: 'Noted. I have my handoff note and carry on from here.' }] } })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'background job pwsh-7 finished' }], source: { kind: 'tool-jobs', form: 'notice' } })
  host.finish('gb', 'Ghidra 解压好了。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  assert.equal(text(host.takePost()), '[Group post from Writer]\nGhidra 解压好了。')
})

test('a private message to a group Session is answered privately, without steps in the group', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: '[Message from Tester]\n能帮我看下吗' }], source: { kind: 'bot', role: 'request', senderSessionId: 'c', senderName: 'Tester', exchangeId: 'x1', hop: 0 } })
  step(host, 'gb', '我看一下。', 'k1')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '看过了，没问题。')
  await settle(() => host.agentOf('c').calls.length === 1)
  assert.match(text(host.agentOf('c').calls[0]), /我看一下。\n\n看过了，没问题。/)
  assert.deepEqual(host.agentOf('r1').calls, [])
})

test('the team view says what a member is doing in the call\'s own words', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: JSON.stringify({ command: 'iwr https://example.com/x.zip', description: 'Download  Ghidra 12.1.4\nand check its hash' }) })
  host.emit('gc', 'turn/start', { turn: 1 })
  host.emit('gc', 'tool/call', { callId: 'k2', name: 'read', arguments: JSON.stringify({ file_path: 'E:\\src\\tools\\dump.py' }) })
  const { value } = await host.call('state', {})
  assert.deepEqual(value.work.rooms.r1.map(entry => [entry.botId, entry.tool, entry.note, entry.target]), [['b', 'pwsh', 'Download Ghidra 12.1.4 and check its hash', undefined], ['c', 'read', undefined, 'dump.py']])
  assert.equal(value.work.bots.b.note, 'Download Ghidra 12.1.4 and check its hash')
  // What the Bot said in the step that made the call comes with it.
  host.emit('ga', 'turn/start', { turn: 1 })
  step(host, 'ga', '先把 JDK\n下下来。', 'k3', 'pwsh', JSON.stringify({ description: 'Download JDK 21' }))
  const later = (await host.call('state', {})).value
  assert.deepEqual(['said', 'note'].map(key => later.work.bots.a[key]), ['先把 JDK 下下来。', 'Download JDK 21'])
})

test('the team view says when each Session\'s running turn began, for the clock at its tail', async (t) => {
  const host = await start(t)
  const before = Date.now()
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  const { value } = await host.call('state', {})
  assert.deepEqual(Object.keys(value.work.turns), ['gb'])
  assert.ok(value.work.turns.gb >= before && value.work.turns.gb <= Date.now())
  assert.equal(value.work.turns.gb, value.work.bots.b.since)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual((await host.call('state', {})).value.work.turns, {})
})

// 公开#124: a Bot deleted while it worked stayed "thinking" until DSH restarted, and the
// Bot that had asked it something never heard back.
test('deleting a working Bot clears its activity and tells the Bots waiting for its reply', async (t) => {
  const host = await start(t)
  host.emit('b', 'turn/start', { turn: 1 })
  host.emit('b', 'user/message', { content: [{ type: 'text', text: '[Message from Chief]\nwrite the docs' }], source: { kind: 'bot', role: 'request', senderSessionId: 'a', senderName: 'Chief', exchangeId: 'x1', hop: 1 } })
  host.emit('b', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  // A second request that Writer has not read yet.
  host.agentOf('b').inbox.nextStep.push({ id: 'm2', source: { kind: 'bot', role: 'request', senderSessionId: 'c', senderName: 'Tester', exchangeId: 'x2', hop: 1 } })
  assert.equal((await host.call('state', {})).value.activity.b, 'working')

  const deleted = await host.call('delete-bot', { id: 'b' })
  assert.equal(deleted.ok, true)
  assert.equal((await host.call('state', {})).value.activity.b, undefined)
  await settle(() => host.agentOf('a').calls.length === 1 && host.agentOf('c').calls.length === 1)
  for (const [to, exchangeId] of [['a', 'x1'], ['c', 'x2']]) {
    const reply = host.agentOf(to).calls[0]
    assert.deepEqual([reply.source.role, reply.source.replyTo], ['reply', exchangeId])
    assert.equal(text(reply), '[Reply from Writer]\nWriter was deleted before it could answer your message.')
  }
  // The stopped turn ends after the delete; it brings nothing back.
  host.emit('b', 'turn/start', { turn: 2 })
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  assert.equal((await host.call('state', {})).value.activity.b, undefined)
})

// #619: a member that finishes tool work inside the 15s grace without writing @Caller
// still hands the result back to the Bot that asked for it.
test('in-round tool work that finishes before the grace without @Caller still wakes the caller (#619)', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('排查一下构建报错'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 去读一下构建日志')

  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: JSON.stringify({ file_path: 'build.log' }) })
  host.emit('gb', 'tool/result', { callId: 'k1' })
  // Finishes inside the round (< 15s) and forgets to write @Chief.
  host.finish('gb', '查清楚了，是缺少环境变量 FOO，需要决定用哪个默认值。')

  await settle(() => host.agentOf('ga').calls.length === 2)
  const follow = host.begin('ga')
  assert.match(text(follow), /Writer finished the work you asked for/)
  assert.match(text(follow), /Writer: 查清楚了，是缺少环境变量 FOO/)
  host.finish('ga', '默认设成 bar。')
  await settle(() => first() !== undefined)
  assert.deepEqual(first().replies.map(reply => [reply.name, reply.text]), [
    ['Chief', '@Writer 去读一下构建日志'],
    ['Writer', '查清楚了，是缺少环境变量 FOO，需要决定用哪个默认值。'],
    ['Chief', '默认设成 bar。'],
  ])
})

// #872: Chief calls Writer in a step line and goes on with its own part. Writer's
// result lands while Chief is still in that turn, which cannot see it, so Chief
// answers it in a turn of its own once the first one ends.
test('a caller still in its own turn answers the batch result after that turn (#872)', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('全面检查一下构建'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  step(host, 'ga', '@Writer 去读构建日志，我先看配置。', 'k0', 'read')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: '{}' })
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '日志看完了：缺环境变量 FOO。')
  await settle(() => true)
  assert.equal(host.agentOf('ga').calls.length, 1, 'not steered into the running turn')
  host.emit('ga', 'tool/result', { callId: 'k0' })
  host.finish('ga', '配置看完了，没问题。')
  await settle(() => host.agentOf('ga').calls.length === 2)
  const follow = host.begin('ga')
  assert.match(text(follow), /Writer finished the work you asked for/)
  assert.match(text(follow), /Writer: 日志看完了：缺环境变量 FOO。/)
  host.finish('ga', '缺 FOO，补上就好。')
  await settle(() => first() !== undefined)
  assert.deepEqual(first().replies.map(reply => reply.name), ['Chief', 'Writer', 'Chief', 'Chief'])
})

// #872: a member the user called answers the user; asking the user to confirm does
// not call the admin in.
test('a member\'s reply to the user that asks for a confirmation does not call the admin (#872)', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer 把首页标题改成春季上新'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'edit', arguments: '{}' })
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '改好了，标题换成了「春季上新」，需要你确认一下是否满意。')
  await settle(() => first() !== undefined)
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(first().replies.map(reply => reply.name), ['Writer'])
})

// Parallel fan-in barrier: when Chief calls @Writer @Tester in one message and both go
// past the 15s grace, Writer's early result posts at once without waking Chief, and
// Tester's final result wakes Chief once with both results.
test('parallel batch barrier posts each late reply at once and wakes the caller once when all finish', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('全面检查一下'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer @Tester 分别检查文档和测试')

  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.begin('gc')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: '{}' })
  host.emit('gc', 'tool/call', { callId: 'k2', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  assert.deepEqual(kinds(first()), [['message', 'Chief'], ['working', 'Writer'], ['working', 'Tester']])

  // Writer finishes first while Tester is still working: its reply posts with quiet=true.
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '文档检查完毕，没有断链。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const earlyPost = host.takePost()
  assert.equal(earlyPost.source.late, true)
  assert.equal(earlyPost.source.quiet, true, 'does not wake Chief while Tester is still working')
  const second = host.round('c2', earlyPost)
  await settle(() => second() !== undefined)
  assert.equal(host.agentOf('ga').calls.length, 1, 'Chief was not woken prematurely')

  // Tester finishes second: now the batch barrier releases and wakes Chief once.
  host.emit('gc', 'tool/result', { callId: 'k2' })
  host.finish('gc', '测试全部通过。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const finalPost = host.takePost()
  assert.equal(finalPost.source.late, true)
  assert.equal(finalPost.source.quiet, undefined)
  assert.equal(finalPost.source.askedBy, 'a')
  const third = host.round('c3', finalPost)
  await settle(() => host.agentOf('ga').calls.length === 2)
  const synth = host.begin('ga')
  assert.match(text(synth), /Writer: 文档检查完毕，没有断链。/)
  assert.match(text(synth), /Tester: 测试全部通过。/)
  host.finish('ga', '文档和测试都通过了。')
  await settle(() => third() !== undefined)
})

// #469: a member that replies only "收到，我现在开始排查" without calling any tool gets
// one automatic continuation turn on the same exchange so the work actually runs.
test('a member that only promises to start working without calling a tool gets one continuation turn (#469)', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer 排查一下构建失败的原因'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  const initial = host.begin('gb')
  // Ends the turn with a verbal promise only and 0 tool calls.
  host.finish('gb', '收到，我现在开始排查构建日志。')

  // The host automatically nudges gb once on the same exchangeId.
  await settle(() => host.agentOf('gb').calls.length === 2)
  const retryMsg = host.begin('gb')
  assert.equal(retryMsg.source.exchangeId, initial.source.exchangeId)
  assert.equal(retryMsg.source.retried, true)
  assert.match(text(retryMsg), /stopped before calling any tool/)

  // In the continuation turn the member calls its tool and gives the real answer.
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: JSON.stringify({ file_path: 'build.log' }) })
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '排查完毕：原因是端口冲突。')
  await settle(() => first() !== undefined)
  assert.deepEqual(first().replies.map(reply => [reply.name, reply.text]), [
    ['Writer', '收到，我现在开始排查构建日志。'],
    ['Writer', '排查完毕：原因是端口冲突。'],
  ])
})

// #872: a verb with 过了/完了/完毕/好了 reports done work. A plan of several sentences,
// or a target that starts with 过 or 完, is still a promise; a reply that also answers
// may match, and its member passes on the retry.
test('done work is no promise, and a plan of several sentences still is (#872)', () => {
  for (const said of ['收到，我现在开始排查构建日志。', '明白，我先排查一下日志，然后跑测试。', '收到，我现在开始排查。稍后给你结果。', '收到，我先查看过去的记录。', '好的，我先检查完成情况。', '我现在开始排查', '开工！', "I'll check the logs. Then I'll run the tests.", 'Let me look into it.']) {
    assert.equal(promisesWork(said), true, said)
  }
  for (const said of ['好的，我检查过了，配置没问题。', '好的，我检查过，没问题。', '收到，我排查完了，是端口冲突。', '好的，我处理好了。', '查完了，原因是端口冲突。']) {
    assert.equal(promisesWork(said), false, said)
  }
})

// #872: the opening already was the answer; the member passes on the retry and the
// group sees it once.
test('a member that passes on the promise retry is posted once (#872)', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer 方案 A 和 B 哪个好？'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '好的，我看看。')
  await settle(() => host.agentOf('gb').calls.length === 2)
  const retry = host.begin('gb')
  assert.match(text(retry), /call skip_group_turn; it stays posted/)
  host.finish('gb', '')
  await settle(() => first() !== undefined)
  assert.deepEqual(first().replies.map(reply => [reply.name, reply.text]), [['Writer', '好的，我看看。']])
})

// #872: a retried promise that a late turn passes on still tells the member that asked
// the work is done, as a result that went out as a step line does.
test('a late member that passes on the promise retry still hands the work back (#872)', async (t) => {
  const host = await start(t)
  // A call the member reads after the round moved on: no round waits for this turn.
  host.agentOf('gb').followup({ content: [{ type: 'text', text: '[Group chat "Ops" · Chief mentioned you]\n看一下文档' }], source: { kind: 'bot', role: 'room', roomId: 'r1', exchangeId: 'x1', askedBy: 'a' } })
  host.begin('gb')
  host.finish('gb', '收到，我去看看文档。')
  await settle(() => host.agentOf('gb').calls.length === 2 && host.agentOf('r1').calls.length === 1)
  assert.equal(host.takePost().source.progress, true, 'the opening goes to the group')
  host.begin('gb')
  host.finish('gb', '')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.done, post.source.askedBy], [true, 'a'])
})

// Progress-based loop guard: consecutive 0-tool ack/repetitive relays pause after 6
// turns and park the next call in room.paused, whereas tool calls reset the counter.
// #872: the parked calls wait for the user, not for the next round of any kind.
test('consecutive 0-tool ack ping-pong relays pause after 6 turns and go on only when the user writes', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 开始'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 收到，辛苦了')

  for (let step = 1; step <= 6; step += 1) {
    const isWriter = step % 2 === 1
    const sessionId = isWriter ? 'gb' : 'ga'
    const target = isWriter ? '@Chief' : '@Writer'
    const count = isWriter ? Math.ceil(step / 2) : Math.floor(step / 2) + 1
    await settle(() => host.agentOf(sessionId).calls.length === count)
    host.begin(sessionId)
    host.finish(sessionId, `${target} 收到，谢谢！`)
  }
  await settle(() => first() !== undefined)
  const pausedReplies = first().replies.filter(reply => reply.kind === 'paused')
  assert.equal(pausedReplies.length, 1)
  assert.deepEqual([pausedReplies[0].idle, pausedReplies[0].botId, pausedReplies[0].names], [true, 'a', ['Writer']])
  const saved = () => savedTeam(host.home).rooms.r1
  assert.deepEqual(saved().paused.map(entry => [entry.id, entry.idle]), [['b', true]])
  assert.match(await host.tool('read_group_chat', { group: 'Ops' }, 'a'),
    /\[Paused: Chief and Writer went back and forth 6 times without progress \(no tool used, only thanks or repeats\)\. The calls to @Writer wait until the user writes here; do not call them again\.\]/)

  // A Bot's quiet late result opens a round, which leaves the parked call alone.
  const second = host.round('c2', { content: [{ type: 'text', text: '[Group post from Tester]\n测试跑完了' }], source: { kind: 'bot', form: 'relay', role: 'post', exchangeId: 'x2', senderSessionId: 'c', senderName: 'Tester', roomId: 'r1', late: true, quiet: true } })
  await settle(() => second() !== undefined)
  assert.equal(host.agentOf('gb').calls.length, 3)
  assert.equal(saved().paused.length, 1)

  // The user's message brings the parked call back with the admin.
  const third = host.round('c3', host.say('好了，说正事'))
  await settle(() => host.agentOf('gb').calls.length === 4 && host.agentOf('ga').calls.length === 5)
  assert.match(text(host.begin('gb')), /Chief mentioned you/)
  host.finish('gb', '')
  host.begin('ga')
  host.finish('ga', '')
  await settle(() => third() !== undefined)
  assert.equal(saved().paused, undefined)
})

// #701: when a group member spawns a DSH subagent and ends its own turn, the member
// stays marked as working in the group, and stopping the group interrupts the subagent
// and suppresses its late settlement notice.
test('a group member with a running DSH subagent stays working and stop-room-work interrupts the subagent (#701)', async (t) => {
  const interrupted = []
  const host = await start(t, undefined, {
    subagents: { interrupt: async (childId, opts) => { interrupted.push({ childId, opts }) } },
  })
  const first = host.round('c1', host.say('@Writer 派子代理跑长任务'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 's1', name: 'subagent', arguments: JSON.stringify({ description: 'Run long benchmark' }) })
  host.emit('gb', 'subagent/catalog', { childId: 'sub-1', label: 'Run long benchmark', mode: 'continuable' })
  host.emit('gb', 'tool/result', { callId: 's1' })
  host.finish('gb', '子代理已派出，正在后台运行。')

  await settle(() => first() !== undefined)
  assert.deepEqual(kinds(first()), [['message', 'Writer'], ['working', 'Writer']])

  // Even though gb's own turn ended, Writer still shows as working on its subagent in r1.
  const stateDuring = (await host.call('state', {})).value
  assert.equal(stateDuring.activity.b, 'working')
  assert.deepEqual(stateDuring.work.rooms.r1, [{ botId: 'b', since: stateDuring.work.rooms.r1[0].since, tool: 'subagent', note: 'Run long benchmark' }])

  // User clicks "Stop all" in the group: it interrupts sub-1 and logs Writer as stopped.
  const stopped = await host.call('stop-room-work', { roomId: 'r1' })
  assert.deepEqual([stopped.ok, stopped.value], [true, true])
  assert.deepEqual(interrupted, [{ childId: 'sub-1', opts: { kind: 'user', parentSessionId: 'gb' } }])
  assert.deepEqual((await host.call('state', {})).value.work.rooms.r1, undefined)

  // Clear the stopped event post from r1's inbox.
  await settle(() => host.agentOf('r1').calls.length === 1)
  const stopPost = host.takePost()
  assert.equal(stopPost.source.stopped, true)

  // Later, when the interrupted subagent emits its settlement notice to gb, gb is
  // cancelled and suppressed so it does not speak in the group again.
  host.emit('gb', 'turn/start', { turn: 2 })
  host.emit('gb', 'user/message', {
    content: [{ type: 'text', text: 'Subagent sub-1 settled' }],
    source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'sub-1' },
  })
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: '子代理被中断了。' }] } })
  host.emit('gb', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => true)
  assert.deepEqual(host.agentOf('r1').calls, [], 'suppressed settlement notice does not post to the group')
})


for (const noticeFirst of [true, false]) {
  test(`a failed child reaches the group once on the open anchor without synthesizing a round when its notice comes ${noticeFirst ? 'first' : 'last'} (#973)`, async (t) => {
    const host = await start(t)
    const first = host.round('c1', host.say('@Writer 导出这份 PPT'))
    await settle(() => host.agentOf('gb').calls.length === 1)
    host.begin('gb')
    host.emit('gb', 'subagent/catalog', { childId: 'sub-1', label: 'Export the deck' })
    host.finish('gb', '正在导出。')
    await settle(() => first() !== undefined)
    const revBefore = rt.state.revision
    // An intermediate message from the running child must neither end it nor spend its label.
    host.emit('gb', 'user/message', {
      content: [{ type: 'text', text: 'Agent sub-1 sent a message: 进度 50%' }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: 'sub-1' },
    })
    assert.equal(rt.hasSubagents('gb'), true)

    const notice = {
      content: [{ type: 'text', text: 'Background subagent sub-1 failed before it finished.\nIt left no closing message.' }],
      source: { kind: 'subagent-settled', form: 'notice', summary: 'Background subagent sub-1 failed before it finished.', senderSessionId: 'sub-1' },
    }
    const ending = { runId: 'run-1', provider: 'spawn', id: 'sub-1', local: true, stopReason: 'error' }
    if (noticeFirst) host.emit('gb', 'user/message', notice)
    host.emitScoped('gb', 'subagent/end', ending)
    if (!noticeFirst) host.emit('gb', 'user/message', notice)
    host.emit('gb', 'turn/start', { turn: 2 })
    host.finish('gb', '')
    await until(() => rt.state.revision > revBefore)
    assert.deepEqual(host.agentOf('r1').calls, [], 'no fake empty round is posted to the group Session')
    const view = (await host.call('group-rows', { roomId: 'r1', from: first().from, anchor: first().anchor })).value
    const shown = view.rows.filter(row => row.kind === 'helper-failed')
    assert.equal(shown.length, 1)
    assert.equal(shown[0].name, 'Writer')
    assert.equal(shown[0].stopReason, 'error')
    assert.equal(shown[0].helper, 'Export the deck')
    host.emit('gb', 'user/message', notice)
    assert.equal(rt.groupRows('r1', 0, rt.roomOf('r1').seq).filter(row => row.kind === 'helper-failed').length, 1)
    host.emitScoped('gb', 'subagent/end', { ...ending, runId: 'run-2', stopReason: 'completed' })
    assert.deepEqual(host.agentOf('r1').calls, [])
  })
}

for (const [reason, summary] of [['error', 'failed before it finished.'], ['max-tokens', 'ran out of room before it finished.']]) {
  test(`a failure known only from its settlement notice still shows in the group (${reason}, #973)`, async (t) => {
    const host = await start(t)
    const first = host.round('c1', host.say('@Writer 导出这份 PPT'))
    await settle(() => host.agentOf('gb').calls.length === 1)
    host.begin('gb')
    host.emit('gb', 'subagent/catalog', { childId: 'sub-1', label: 'Export the deck' })
    host.finish('gb', '正在导出。')
    await settle(() => first() !== undefined)
    // No subagent/end: an in-place plugin reload lost it, so the notice is the only
    // ending this runtime sees. The child's own turn answers it with [PASS].
    const notice = {
      content: [
        { type: 'text', text: `Background subagent sub-1 ${summary}` },
        { type: 'text', text: 'It left no closing message.' },
      ],
      source: { kind: 'subagent-settled', form: 'notice', summary: `Background subagent sub-1 ${summary}`, senderSessionId: 'sub-1' },
    }
    const revBefore = rt.state.revision
    host.emit('gb', 'user/message', notice)
    host.emit('gb', 'turn/start', { turn: 2 })
    host.finish('gb', '')
    await until(() => rt.state.revision > revBefore)
    assert.deepEqual(host.agentOf('r1').calls, [])
    const view = (await host.call('group-rows', { roomId: 'r1', from: first().from, anchor: first().anchor })).value
    const shown = view.rows.filter(row => row.kind === 'helper-failed')
    assert.equal(shown.length, 1)
    assert.equal(shown[0].name, 'Writer')
    assert.equal(shown[0].stopReason, reason)
    assert.equal(shown[0].helper, 'Export the deck')
    assert.equal(shown[0].text, `Export the deck — subagent ended (${reason})`)
    // The same notice again, and the lifecycle ending arriving late, add no second row.
    host.emit('gb', 'user/message', notice)
    host.emitScoped('gb', 'subagent/end', { runId: 'run-1', provider: 'spawn', id: 'sub-1', local: true, stopReason: reason })
    assert.deepEqual(host.agentOf('r1').calls, [])
    assert.equal(rt.groupRows('r1', first().from).filter(row => row.kind === 'helper-failed').length, 1)
    // A clean ending is not a failure: it adds no row and no post.
    host.emit('gb', 'subagent/catalog', { childId: 'sub-2', label: 'Check the slides' })
    host.emit('gb', 'user/message', {
      content: [{ type: 'text', text: 'Background subagent sub-2 finished.' }],
      source: { kind: 'subagent-settled', form: 'notice', summary: 'Background subagent sub-2 finished.', senderSessionId: 'sub-2' },
    })
    assert.equal(rt.groupRows('r1', 0, rt.roomOf('r1').seq).filter(row => row.kind === 'helper-failed').length, 1)
    assert.deepEqual(host.agentOf('r1').calls, [])
  })
}

test('a child that runs again after settling gets its own failure row, and read-only hosts stay untouched (#973)', async (t) => {
  const host = await start(t)
  const failure = {
    content: [
      { type: 'text', text: 'Background subagent sub-1 failed before it finished.' },
      { type: 'text', text: 'It left no closing message.' },
    ],
    source: { kind: 'subagent-settled', form: 'notice', summary: 'Background subagent sub-1 failed before it finished.', senderSessionId: 'sub-1' },
  }
  host.emit('gb', 'subagent/catalog', { childId: 'sub-1', label: 'First run' })
  host.emit('gb', 'user/message', failure)
  const rows = () => rt.groupRows('r1', 0, rt.roomOf('r1').seq).filter(row => row.kind === 'helper-failed')
  await until(() => rows().length === 1)
  assert.equal(rows()[0].helper, 'First run')
  assert.equal(rows()[0].stopReason, 'error')
  // The same child takes a new run; the earlier row must not hide this ending.
  host.emitScoped('gb', 'subagent/start', { runId: 'run-2', provider: 'spawn', id: 'sub-1', local: true })
  host.emit('gb', 'user/message', failure)
  await until(() => rows().length === 2)
  // A read-only window must never append to the ledger.
  const prevReadOnly = rt.readOnly
  rt.readOnly = () => ({ pid: 999 })
  try {
    await rt.subagentFailureNotice('gb', { stopReason: 'error', helper: 'Blocked' })
    assert.equal(rows().length, 2)
  } finally {
    rt.readOnly = prevReadOnly
  }
})

test('a helper failure in a running round preserves the idle guard, does not mark the member failed, and stays one event', async (t) => {
  const host = await start(t)
  const round = host.round('c1', host.say('@Writer 检查'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'subagent/catalog', { childId: 'sub-1', label: 'Check' })
  const room = rt.roomOf('r1')
  room.idleRelays = 4
  await rt.subagentFailureNotice('gb', { stopReason: 'error', helper: 'Check' })
  assert.equal(room.idleRelays, 4)
  assert.equal(room.log.filter(row => row.reason === 'helper-failed').length, 1)
  assert.equal(room.log.filter(row => row.botId === 'b').length, 0)
  host.emitScoped('gb', 'subagent/end', { id: 'sub-1', stopReason: 'completed', runId: 'run-1', provider: 'spawn', local: true })
  host.finish('gb', '')
  await settle(() => round() !== undefined)
  assert.equal(round().failed, undefined, 'member own turn was not marked failed')
})

test('approval keeps a member inside its parallel batch until all results arrive', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('review1', host.say('检查文档和测试'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer @Tester 分别检查文档和测试')
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb'); host.begin('gc')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: '{}' })
  host.emit('gc', 'tool/call', { callId: 'k2', name: 'read', arguments: '{}' })
  rt.yieldRoomTurn('gb')
  await settle(() => [...rt.roomProgress.values()].some(r => r.slots.some(s => s.id === 'b' && s.status === 'waiting-approval')))
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '文档已检查完毕。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.equal(post.source.quiet, true)
  const second = host.round('review2', post)
  await settle(() => host.agentOf('ga').calls.length === 2 || second() !== undefined)
  assert.equal(host.agentOf('ga').calls.length, 1, 'caller waits until Tester also finishes')
  host.emit('gc', 'tool/result', { callId: 'k2' })
  host.finish('gc', '测试已检查完毕。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const last = host.takePost()
  const third = host.round('review3', last)
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.finish('ga', '文档和测试已全部检查。')
  await settle(() => third() !== undefined)
  assert.equal(host.agentOf('ga').calls.length, 2, 'one continuation for the complete batch')
})


test('stopping a group before its callee starts clears the pending batch', async t => {
  const host = await start(t)
  host.emit('r1', 'turn/start', { turn: 1 })
  const first = host.round('c1', host.say('检查文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 检查文档')
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.equal(rt.roomBatchPending('r1'), true)
  host.agentOf('r1').cancel = () => first.cancel()
  const stopped = await host.call('stop-room-work', { roomId: 'r1' })
  assert.equal(stopped.value, true)
  await settle(() => first() !== undefined)
  assert.equal(rt.roomBatchPending('r1'), false)
})

// A member that two Bots call is in both batches: each finished piece of work wakes
// the Bot that asked for it, and only for that piece of work.
const wakeNote = message => text(message).match(/^\[Group chat "Ops" · ([^\]]*)\]/)?.[1]
const workStep = (host, sessionId, callId) => {
  host.emit(sessionId, 'tool/call', { callId, name: 'edit', arguments: '{}' })
  host.emit(sessionId, 'tool/result', { callId })
}

test('a member two Bots called wakes each of them for its own call when it finishes in the round', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief @Tester 各自给 Writer 安排一件事'))
  await settle(() => host.agentOf('ga').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 把首页标题改成春季上新')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '@Writer 顺便把测试跑一遍')
  await settle(() => host.agentOf('gb').calls.length === 1 && rt.roomBatchPending('r1'))
  assert.equal(host.agentOf('gb').calls.length, 1, 'the second call waits for the first')

  host.begin('gb')
  workStep(host, 'gb', 'k1')
  host.finish('gb', '标题改好了，换成了「春季上新」。')
  await settle(() => host.agentOf('ga').calls.length === 2)
  assert.equal(wakeNote(host.agentOf('ga').calls[1]), 'Writer finished the work you asked for')
  assert.equal(host.agentOf('gc').calls.length, 1, 'Tester is not woken for Chief\'s call')
  host.begin('ga')
  host.finish('ga', '')

  await settle(() => host.agentOf('gb').calls.length === 2)
  assert.equal(wakeNote(host.agentOf('gb').calls[1]), 'Tester mentioned you')
  host.begin('gb')
  workStep(host, 'gb', 'k2')
  host.finish('gb', '测试跑完，全过。')
  await settle(() => host.agentOf('gc').calls.length === 2)
  assert.equal(wakeNote(host.agentOf('gc').calls[1]), 'Writer finished the work you asked for')
  assert.match(text(host.agentOf('gc').calls[1]), /Writer: 测试跑完，全过。/)
  assert.equal(host.agentOf('ga').calls.length, 2, 'Chief is not woken for Tester\'s call')
  host.begin('gc')
  host.finish('gc', '')
  await settle(() => first() !== undefined)
  assert.equal(rt.roomBatchPending('r1'), false)
})

// Chief calls Writer and Tester together; Tester, at work in the background, calls Writer
// as well. Writer's result for Chief waits for Tester, and Writer's result for Tester wakes
// Tester, once.
test('a member two Bots called wakes each of them for its own call when it finishes after the round went on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('排查一下构建'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 读构建日志 @Tester 跑全量测试')
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: '{}' })
  host.begin('gc')
  host.emit('gc', 'tool/call', { callId: 'k2', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)

  // Tester calls Writer for a log of its own while Writer reads the build log.
  step(host, 'gc', '@Writer 也帮我查一下磁盘空间', 'p1')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const call = host.round('c2', host.takePost())
  await settle(() => call() !== undefined)
  assert.deepEqual(kinds(call()).filter(([kind]) => kind === 'working'), [['working', 'Writer']])
  const inbox = host.agentOf('gb').inbox
  const correction = inbox.nextStep[0]
  assert.equal(correction.source.askedBy, 'c')
  inbox.remove(correction.id)
  host.emit('gb', 'user/message', { content: correction.content, source: correction.source })

  // Writer's result for Chief waits for Tester, who is still at work.
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', 'R1：日志里缺环境变量 FOO。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const early = host.takePost()
  assert.deepEqual([early.source.late, early.source.quiet], [true, true])
  const quietRound = host.round('c3', early)
  await settle(() => quietRound() !== undefined)
  assert.equal(host.agentOf('ga').calls.length, 1, 'Chief is not woken before Tester is done')

  host.emit('gc', 'tool/result', { callId: 'k2' })
  host.emit('gc', 'tool/result', { callId: 'p1' })
  host.finish('gc', 'R2：测试全过。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const last = host.takePost()
  assert.deepEqual([last.source.askedBy, last.source.quiet], ['a', undefined])
  const wake = host.round('c4', last)
  await settle(() => host.agentOf('ga').calls.length === 2)
  assert.equal(wakeNote(host.agentOf('ga').calls[1]), 'Writer and Tester finished the work you asked for')
  assert.match(text(host.agentOf('ga').calls[1]), /Writer: R1：日志里缺环境变量 FOO。/)
  assert.match(text(host.agentOf('ga').calls[1]), /Tester: R2：测试全过。/)
  host.begin('ga')
  host.finish('ga', '')
  await settle(() => wake() !== undefined)
  assert.equal(host.agentOf('gc').calls.length, 1, 'Tester is not woken for Chief\'s call')

  // The turn that answers Tester's call is Writer's second, and wakes Tester.
  await settle(() => inbox.nextTurn.length === 1)
  const deferred = host.begin('gb')
  assert.equal(deferred.source.askedBy, 'c')
  workStep(host, 'gb', 'k3')
  host.finish('gb', 'R3：磁盘还剩 40G。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const own = host.takePost()
  assert.deepEqual([own.source.askedBy, own.source.quiet], ['c', undefined])
  const third = host.round('c5', own)
  await settle(() => host.agentOf('gc').calls.length === 2)
  assert.equal(wakeNote(host.agentOf('gc').calls[1]), 'Writer finished the work you asked for')
  assert.match(text(host.agentOf('gc').calls[1]), /Writer: R3：磁盘还剩 40G。/)
  assert.equal(host.agentOf('ga').calls.length, 2, 'Chief is not woken for Tester\'s call')
  host.begin('gc')
  host.finish('gc', '')
  await settle(() => third() !== undefined)
  assert.equal(rt.roomBatchPending('r1'), false)
})

// A batch wakes its caller once, and the wake carries the result of every member of the
// batch, whatever the windows of earlier lines hold.
const count = (haystack, needle) => haystack.split(needle).length - 1
const RESULTS = 'Results of the work you asked for that the lines here leave out'

// Chief calls Writer and Tester together and both go on in the background.
async function batchInBackground(t, services) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t, undefined, services)
  const first = host.round('c1', host.say('排查一下构建'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 读构建日志 @Tester 跑全量测试')
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: '{}' })
  host.begin('gc')
  host.emit('gc', 'tool/call', { callId: 'k2', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  let n = 1
  // The group Session takes up the post a member made and relays it as a round.
  const relay = async () => {
    await settle(() => host.agentOf('r1').calls.length > 0)
    n += 1
    const read = host.round(`c${n}`, host.takePost())
    await settle(() => read() !== undefined || host.agentOf('ga').calls.length === 2)
    return read
  }
  return { host, relay }
}

// Codex on the change line: inside a parallel batch, a change-only completion line must not
// wake the caller early. It carries `quiet`, the same as an early text result; the batch
// end still wakes the caller exactly once.
test('a late pass inside a parallel batch posts its change line quietly', async (t) => {
  const { host, relay } = await batchInBackground(t)
  const changes = { sessionId: 'gb', seq: 21, turn: 5, total: 1, added: 4, deleted: 1, files: [{ path: 'batch.md', added: 4, deleted: 1 }] }
  rt.turnChanges = async sessionId => (sessionId === 'gb' ? changes : undefined)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '')
  await settle(() => host.agentOf('r1').calls.length > 0)
  const post = host.takePost()
  assert.equal(post.source.done, true)
  assert.equal(post.source.quiet, true)
  assert.deepEqual(post.source.changes, changes)
  const read = host.round('late-pass-batch', post)
  await settle(() => read() !== undefined)
  assert.equal(host.agentOf('ga').calls.length, 1, 'the caller is not woken early')
  // Tester finishes: the batch closes and the caller is woken once, not twice.
  host.emit('gc', 'tool/result', { callId: 'k2' })
  host.finish('gc', '测试全过。')
  await relay()
  await settle(() => host.agentOf('ga').calls.length === 2)
  assert.equal(host.agentOf('ga').calls.length, 2)
})

test('a batch wake names who finished and carries a result that rolled out of the lines before the round', async (t) => {
  const { host, relay } = await batchInBackground(t)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', 'R1-WRITER：日志结论是缺环境变量 FOO。')
  await relay()
  assert.equal(host.agentOf('ga').calls.length, 1, 'Tester is still at work')
  // Tester narrates nine steps, each more than ROOM_STEP_GAP_MS apart.
  for (let i = 1; i <= 9; i += 1) {
    host.emit('gc', 'tool/result', { callId: i === 1 ? 'k2' : `p${i - 1}` })
    step(host, 'gc', `测试进度 ${i}/9`, `p${i}`)
    t.mock.timers.tick(ROOM_STEP_GAP_MS)
    await relay()
  }
  assert.equal(host.agentOf('ga').calls.length, 1)
  host.emit('gc', 'tool/result', { callId: 'p9' })
  host.finish('gc', 'R2-TESTER：测试全过。')
  await relay()
  await settle(() => host.agentOf('ga').calls.length === 2)
  const wake = host.agentOf('ga').calls[1]
  const prompt = text(wake)
  assert.equal(wakeNote(wake), 'Writer and Tester finished the work you asked for')
  assert.equal(count(prompt, 'R1-WRITER'), 1)
  assert.equal(count(prompt, 'R2-TESTER'), 1)
  assert.ok(prompt.indexOf(RESULTS) < prompt.indexOf('R1-WRITER'))
  assert.ok(prompt.indexOf('R1-WRITER') < prompt.indexOf('R2-TESTER'))
  host.begin('ga')
  host.finish('ga', '缺 FOO，补上。')
})

test('a batch wake does not repeat a result that its prompt shows anyway', async (t) => {
  const { host, relay } = await batchInBackground(t)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', 'R1-WRITER：日志结论是缺环境变量 FOO。')
  await relay()
  host.emit('gc', 'tool/result', { callId: 'k2' })
  host.finish('gc', 'R2-TESTER：测试全过。')
  await relay()
  await settle(() => host.agentOf('ga').calls.length === 2)
  const wake = host.agentOf('ga').calls[1]
  assert.equal(wakeNote(wake), 'Writer and Tester finished the work you asked for')
  assert.equal(count(text(wake), 'R1-WRITER'), 1)
  assert.equal(count(text(wake), 'R2-TESTER'), 1)
  assert.ok(!text(wake).includes(RESULTS))
  host.begin('ga')
  host.finish('ga', '')
})

// An answer that came inside the round is a result too, and a long wait lets it leave the
// room's log (60 lines), which the group's own log still holds.
async function resultBeforeLongWait(t, filler = 70, result = 'R2-TESTER：测试全过。') {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('排查一下构建'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 读构建日志 @Tester 跑全量测试')
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: '{}' })
  host.begin('gc')
  host.emit('gc', 'tool/call', { callId: 'k2', name: 'pwsh', arguments: '{}' })
  host.emit('gc', 'tool/result', { callId: 'k2' })
  host.finish('gc', result)
  await settle(() => host.agentOf('ga').calls.length === 1 && rt.roomOf('r1').log.some(line => line.who === 'Tester'))
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  const room = rt.roomOf('r1')
  const seq = room.log.find(line => line.who === 'Tester').seq
  for (let i = 0; i < filler; i += 1) rt.logRoom(room, { who: 'Tester', botId: 'c', text: `闲聊 ${i}` })
  assert.equal(room.log.some(line => line.seq === seq), filler < 60)
  await settle(() => true)
  return { host, seq }
}
const writerFinishes = async (host) => {
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', 'R1-WRITER：日志结论是缺环境变量 FOO。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  host.round('c2', host.takePost())
  await settle(() => host.agentOf('ga').calls.length === 2)
}

test('a batch wake reads a result that left the room\'s log from the group\'s own log', async (t) => {
  const { host } = await resultBeforeLongWait(t)
  await writerFinishes(host)
  const wake = host.agentOf('ga').calls[1]
  assert.equal(wakeNote(wake), 'Tester and Writer finished the work you asked for')
  assert.equal(count(text(wake), 'Tester: R2-TESTER：测试全过。'), 1)
  assert.equal(count(text(wake), 'R1-WRITER'), 1)
  host.begin('ga')
  host.finish('ga', '')
})

test('a batch wake names the message of a result it cannot read', async (t) => {
  const { host, seq } = await resultBeforeLongWait(t)
  // Lose the group's book: only the room's own log is left to start it again from.
  await rt.ledger.flush()
  rt.ledger.drop('group-r1')
  await rt.ledger.flush('group-r1')
  await writerFinishes(host)
  const prompt = text(host.agentOf('ga').calls[1])
  assert.match(prompt, new RegExp(`\\[Tester's result, message #${seq}, is not available here; read_group_chat with seq ${seq} reads it\\]`))
  assert.equal(count(prompt, 'R1-WRITER'), 1)
  host.begin('ga')
  host.finish('ga', '')
})

test('a batch wake brings the images and files of a result line along', async (t) => {
  const { host, seq } = await resultBeforeLongWait(t, 12)
  const attachment = { attachmentId: 'f1', name: 'build.log', mediaType: 'text/plain', bytes: 12 }
  const image = { attachmentId: 'i1', name: 'shot.png', mediaType: 'image/png', bytes: 34 }
  const line = rt.roomOf('r1').log.find(entry => entry.seq === seq)
  line.files = [attachment]
  line.images = [image]
  await writerFinishes(host)
  const wake = host.agentOf('ga').calls[1]
  assert.ok(text(wake).includes(RESULTS))
  assert.deepEqual(wake.content.filter(block => block.type === 'file').map(block => block.attachment), [attachment])
  assert.deepEqual(wake.content.filter(block => block.type === 'image').map(block => block.attachment), [image])
  host.begin('ga')
  host.finish('ga', '')
})

// Three Bots call one member: a call of another Bot stays a call of its own, answered by
// its own turn, and wakes only the Bot that made it.
test('a member three Bots called answers each call in a turn of its own and wakes each caller once', async (t) => {
  const host = await start(t, { members: ['a', 'b', 'c', 'd'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } }, undefined, undefined, { d: {} })
  const first = host.round('c1', host.say('@Chief @Tester @Reviewer 各自给 Writer 安排一件事'))
  await settle(() => ['ga', 'gc', 'gd'].every(id => host.agentOf(id).calls.length === 1))
  host.begin('ga')
  host.finish('ga', '@Writer 做甲')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '@Writer 做乙')
  host.begin('gd')
  host.finish('gd', '@Writer 做丙')
  await settle(() => rt.roomBatchPending('r1'))

  const turns = [['ga', '甲', 'Chief'], ['gc', '乙', 'Tester'], ['gd', '丙', 'Reviewer']]
  for (const [index, [caller, work]] of turns.entries()) {
    await settle(() => host.agentOf('gb').calls.length === index + 1)
    assert.equal(host.agentOf('gb').calls[index].source.askedBy, { ga: 'a', gc: 'c', gd: 'd' }[caller])
    host.begin('gb')
    workStep(host, 'gb', `k${index}`)
    host.finish('gb', `${work}做完了。`)
    await settle(() => host.agentOf(caller).calls.length === 2)
    assert.equal(wakeNote(host.agentOf(caller).calls[1]), 'Writer finished the work you asked for')
    assert.match(text(host.agentOf(caller).calls[1]), new RegExp(`Writer: ${work}做完了。`))
    for (const [other] of turns.slice(index + 1)) assert.equal(host.agentOf(other).calls.length, 1, `${other} is not woken for another call`)
    host.begin(caller)
    host.finish(caller, '')
  }
  await settle(() => first() !== undefined)
  assert.equal(rt.roomBatchPending('r1'), false)
})

// Chief calls Writer and Tester. Tester finishes tool work in the round; Chief calls Writer
// again, which takes Writer into a batch of its own, and Writer answers with no tool.
test('a batch that takes over from an emptied one keeps its finished work', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('排查一下构建'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 读构建日志 @Tester 跑全量测试')
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.begin('gc')
  workStep(host, 'gc', 'k2')
  host.finish('gc', 'R2-TESTER：测试全过。')
  await settle(() => first() === undefined && rt.roomOf('r1').log.some(line => line.who === 'Tester'))
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 日志里也看看 FOO' }, 'a')
  host.finish('gb', '没有 FOO。')
  await settle(() => host.agentOf('ga').calls.length === 2)
  const wake = host.agentOf('ga').calls[1]
  assert.equal(wakeNote(wake), 'Tester and Writer finished the work you asked for')
  assert.match(text(wake), /Tester: R2-TESTER：测试全过。/)
  host.begin('ga')
  host.finish('ga', '')
  // The second call still gets its turn.
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', '')
  await settle(() => first() !== undefined)
})

test('a batch whose last member fails wakes the caller with the results of the others', async (t) => {
  const { host, relay } = await batchInBackground(t)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', 'R1-WRITER：日志结论是缺环境变量 FOO。')
  await relay()
  const room = rt.roomOf('r1')
  for (let i = 0; i < 12; i += 1) rt.logRoom(room, { who: 'Tester', botId: 'c', text: `闲聊 ${i}` })
  host.emit('gc', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', status: 429, message: 'Too many requests' } } })
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.askedBy, post.source.failed?.code], ['a', 'RATE_LIMIT'])
  host.round('c9', post)
  await settle(() => host.agentOf('ga').calls.length === 2)
  const wake = host.agentOf('ga').calls[1]
  assert.equal(wakeNote(wake), 'Writer finished the work you asked for')
  assert.equal(count(text(wake), 'R1-WRITER'), 1)
  assert.ok(text(wake).includes(RESULTS))
  host.begin('ga')
  host.finish('ga', '')
})

test('a result posted early is taken in after its batch finished, and the wake still carries it', async (t) => {
  const { host } = await batchInBackground(t)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', 'R1-WRITER：日志结论是缺环境变量 FOO。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const early = host.takePost()
  host.emit('gc', 'tool/result', { callId: 'k2' })
  host.finish('gc', 'R2-TESTER：测试全过。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const last = host.takePost()
  // The group Session takes up the early post first, after the batch is already done.
  const quietRound = host.round('c8', early)
  await settle(() => quietRound() !== undefined)
  assert.equal(host.agentOf('ga').calls.length, 1)
  host.round('c9', last)
  await settle(() => host.agentOf('ga').calls.length === 2)
  const wake = host.agentOf('ga').calls[1]
  assert.equal(wakeNote(wake), 'Writer and Tester finished the work you asked for')
  assert.equal(count(text(wake), 'R1-WRITER'), 1)
  assert.equal(count(text(wake), 'R2-TESTER'), 1)
  host.begin('ga')
  host.finish('ga', '')
})

test('a wake reads a long result that left the room\'s log whole', async (t) => {
  const { host } = await resultBeforeLongWait(t, 70, '长'.repeat(5000))
  await writerFinishes(host)
  const prompt = text(host.agentOf('ga').calls[1])
  assert.ok(prompt.includes(`Tester: ${'长'.repeat(5000)}`))
  assert.ok(!prompt.includes('was not kept'))
  host.begin('ga')
  host.finish('ga', '')
})

// A member that gave up its place in the round (it waits for an approval) works for the
// call it answers once it goes on, though no round waits for it any more.
test('work a member does after it gave up its place in the round still counts for its batch', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('检查文档和测试'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer @Tester 分别检查文档和测试')
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.begin('gc')
  rt.yieldRoomTurn('gb')
  await settle(() => [...rt.roomProgress.values()].some(round => round.slots.some(slot => slot.id === 'b' && slot.status === 'waiting-approval')))
  workStep(host, 'gb', 'k1')
  host.finish('gb', '文档已改完。')
  await settle(() => rt.roomOf('r1').log.some(line => line.who === 'Writer'))
  assert.equal(host.agentOf('ga').calls.length, 1, 'Chief waits for Tester')
  host.finish('gc', '测试没有问题。')
  await settle(() => host.agentOf('ga').calls.length === 2)
  const wake = host.agentOf('ga').calls[1]
  assert.equal(wakeNote(wake), 'Writer and Tester finished the work you asked for')
  assert.match(text(wake), /Writer: 文档已改完。/)
  host.begin('ga')
  host.finish('ga', '')
  await settle(() => first() !== undefined)
})

test('tool work done for one Bot\'s call does not count as work for another Bot\'s call to the same member', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief @Tester 各自给 Writer 安排一件事'))
  await settle(() => host.agentOf('ga').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 做甲')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '@Writer 说说你的想法')
  await settle(() => [...rt.roomProgress.values()].some(round => round.slots.filter(slot => slot.id === 'b').length === 2))
  host.begin('gb')
  workStep(host, 'gb', 'k1')
  host.finish('gb', '甲做完了。')
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.finish('ga', '')
  // Tester's call is answered in words alone.
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', '我觉得可以。')
  await settle(() => first() !== undefined)
  assert.equal(host.agentOf('gc').calls.length, 1, 'Tester is not woken for an answer in words')
  assert.equal(rt.roomBatchPending('r1'), false)
})

test('a batch wake says which member finished with no closing message of its own', async (t) => {
  const { host, relay } = await batchInBackground(t)
  // Writer reports in a step line and ends with nothing more to say.
  host.emit('gb', 'tool/result', { callId: 'k1' })
  step(host, 'gb', 'R1-WRITER：日志结论是缺环境变量 FOO。', 'p1')
  await relay()
  host.emit('gb', 'tool/result', { callId: 'p1' })
  host.finish('gb', '')
  for (let i = 0; i < 30; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('ga').calls.length, 1, 'Tester is still at work')
  host.emit('gc', 'tool/result', { callId: 'k2' })
  host.finish('gc', 'R2-TESTER：测试全过。')
  await relay()
  await settle(() => host.agentOf('ga').calls.length === 2)
  const wake = host.agentOf('ga').calls[1]
  assert.equal(wakeNote(wake), 'Writer and Tester finished the work you asked for')
  assert.ok(text(wake).includes('Finished without a closing message: Writer.'))
  assert.ok(!text(wake).includes('Finished without a closing message: Writer and'))
  host.begin('ga')
  host.finish('ga', '')
})

// #977: a final reply that announces work while no tool, job or subagent runs is marked
// for the reader, and a local file it links to is checked. Nothing is retried or reworded.
test('a reply announcing work with nothing running is marked, with its missing linked file (#977)', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer 导出报告'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  const missing = join(tmpdir(), `ds-bot-977-${process.pid}-${Date.now()}`, 'report.pptx')
  const long = `正在导出报告到 [report.pptx](<${missing}>)，稍后汇报。${'背景：这一页要沿用上一版的样式和图表。'.repeat(12)}`
  host.finish('gb', long)
  await settle(() => first() !== undefined)
  const reply = first().replies.find(row => row.name === 'Writer')
  assert.deepEqual(reply.claims, { missingFiles: [missing], inProgress: true })
  assert.equal(host.agentOf('gb').calls.length, 1, 'nothing is retried')
})

// A member that started real work or handed work to a peer is not marked, and an existing file in a spaced folder passes.
test('work that did run, a peer handoff and an existing file in a spaced folder carry no marker (#977)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-977-file-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const spaced = join(root, 'DS Bot')
  mkdirSync(spaced, { recursive: true })
  const done = join(spaced, 'report.pptx')
  writeFileSync(done, 'x')
  const host = await start(t, { workDir: spaced })
  const first = host.round('c1', host.say('@Chief 导出报告'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 请先导出初稿，我稍后汇报。')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '正在导出报告到 [report.pptx](report.pptx)，稍后汇报。')
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.finish('ga', '')
  await settle(() => first() !== undefined)
  for (const reply of first().replies) assert.equal(reply.claims, undefined)
})

// #977 review: the check must use the Session's own folder, the one its header reports
// or DS Bot gave it. A group's folder outranks the member's own, and neither is the team
// folder the old code fell back to.
test('a relative file link is checked in the group folder (#977)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-977-room-'))
  const group = join(root, 'group')
  const member = join(root, 'member')
  mkdirSync(join(group, 'out'), { recursive: true })
  mkdirSync(member, { recursive: true })
  writeFileSync(join(group, 'out', 'report.pptx'), 'x')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const host = await start(t, { workDir: group }, {}, {}, { b: { workDir: member } })
  const first = host.round('c1', host.say('@Writer 导出报告'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '报告已导出到 [report.pptx](./out/report.pptx)。')
  await settle(() => first() !== undefined)
  const reply = first().replies.find(row => row.name === 'Writer')
  assert.equal(reply.claims, undefined)
})

test('a relative file link is checked in the member\'s own folder (#977)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-977-member-'))
  const member = join(root, 'member')
  mkdirSync(join(member, 'out'), { recursive: true })
  writeFileSync(join(member, 'out', 'report.pptx'), 'x')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const host = await start(t, {}, {}, {}, { b: { workDir: member } })
  const first = host.round('c1', host.say('@Writer 导出报告'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '报告已导出到 [report.pptx](./out/report.pptx)。')
  await settle(() => first() !== undefined)
  const reply = first().replies.find(row => row.name === 'Writer')
  assert.equal(reply.claims, undefined)
})

test('a late reply and post_to_group keep missing-file claims when opening a group round', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-977-post-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const host = await start(t, {}, {}, {}, { a: { workDir: root } })
  const missing = join(host.home, 'missing-report.md')
  await rt.lateRoomReply('gb', {}, `Report is at [missing-report.md](<${missing}>).`)
  const post = host.takePost()
  assert.deepEqual(post.source.claims, { missingFiles: [missing] })
  const relay = host.round('claims-late', post)
  await settle(() => relay() !== undefined)
  const record = logLines(host).find(line => line.text?.includes('missing-report.md'))
  assert.deepEqual(record.claims, { missingFiles: [missing] })
  assert.equal(record.session, true)

  const postedMissing = join(root, 'gone.md').replace(/\\/g, '/')
  await host.tool('post_to_group', { group: 'Ops', message: '请看 [gone.md](./gone.md)' }, 'a', { agent: { id: 'a', session: { header: { cwd: root } } } })
  const fromTool = host.takePost()
  assert.deepEqual(fromTool.source.claims, { missingFiles: [postedMissing] })
})

// Codex on the change line: a late turn that changed files and ended with [PASS] used to
// read the summary and then post nothing on either return path. Its completion line now
// carries the change card; a late pass that changed nothing still posts nothing.
test('a late pass that changed files posts its completion line', async (t) => {
  const host = await start(t)
  const changes = { sessionId: 'gb', seq: 12, turn: 3, total: 1, added: 2, deleted: 0, files: [{ path: 'late.md', added: 2, deleted: 0 }] }
  rt.turnChanges = async () => changes
  await rt.lateRoomReply('gb', {}, '', { toolCount: 1 })
  const post = host.takePost()
  assert.equal(post.source.done, true)
  assert.deepEqual(post.source.changes, changes)
  const relay = host.round('late-pass', post)
  await settle(() => relay() !== undefined)
  const rows = rt.groupRows('r1', 1, Number.MAX_SAFE_INTEGER)
  assert.deepEqual(rows.find(row => row.kind === 'done')?.changes, changes)
})

test('a late pass that changed nothing posts nothing', async (t) => {
  const host = await start(t)
  rt.turnChanges = async () => undefined
  await rt.lateRoomReply('gb', {}, '', { toolCount: 1 })
  assert.equal(host.agentOf('r1').calls.length, 0)
})

test('the first completed member of a parallel batch keeps its file claim', async (t) => {
  const { host } = await batchInBackground(t)
  const missing = join(host.home, 'missing-report.md')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', `Report is at [missing-report.md](<${missing}>).`)
  await settle(() => host.agentOf('r1').calls.length > 0)
  const post = host.takePost()
  assert.equal(post.source.quiet, true)
  assert.deepEqual(post.source.claims, { missingFiles: [missing] })
})

// A batch is saved with the team, so who still owes whom survives a restart.
test('a call batch is saved with the team while its member works', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 安排一下'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 整理文档')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  await rt.save()
  const saved = Object.values(savedTeam(host.home).roomBatches)
  assert.deepEqual(saved.map(batch => [batch.roomId, batch.by, batch.pending, batch.worked]), [['r1', 'a', ['b'], true]])
  host.finish('gb', '文档好了')
})

// After a restart, a member that does not pick its work up again never answers: the batch
// settles without it, and the Bot that asked is woken once with the result that came.
test('after a restart a batch whose last member is gone wakes the caller with the results it has', async (t) => {
  const log = [{ seq: 1, who: 'User', text: '@Chief 安排' }, { seq: 2, who: 'Chief', botId: 'a', text: '@Writer @Tester 各做一半' }, { seq: 3, who: 'Tester', botId: 'c', text: 'TESTER-RESULT：测试全过。' }]
  const batch = { key: 'k-batch', roomId: 'r1', by: 'a', pending: ['b'], done: ['Tester'], results: [{ name: 'Tester', seq: 3 }], worked: true, answered: false, at: 1 }
  const host = await start(t, { log, seq: 3, shown: 3 }, undefined, undefined, undefined, undefined, { roomBatches: { 'k-batch': batch } })
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.role, post.source.done, post.source.askedBy, post.source.batch], ['post', true, 'a', 'k-batch'])
  host.round('c1', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  const wake = text(host.agentOf('ga').calls[0])
  assert.match(wake, /Tester finished the work you asked for/)
  assert.match(wake, /TESTER-RESULT/)
  assert.equal(host.agentOf('gb').calls.length, 0)
  host.begin('ga')
  host.finish('ga', '')
  await settle(() => Object.keys(rt.state.roomBatches).length === 0)
})

test('after a restart a batch nobody finished is dropped without waking anyone', async (t) => {
  const batch = { key: 'k-none', roomId: 'r1', by: 'a', pending: ['b', 'c'], done: [], results: [], worked: false, answered: false, at: 1 }
  const host = await start(t, undefined, undefined, undefined, undefined, undefined, { roomBatches: { 'k-none': batch } })
  await settle(() => Object.keys(rt.state.roomBatches).length === 0)
  assert.equal(host.agentOf('r1').calls.length, 0)
})

// The round runs in DS Bot, not inside the group_relay call: the call returns at once, so
// the group's Session is free and DSH cuts nothing short.
test('the relay call returns at once and the round goes on without it', async (t) => {
  const host = await start(t)
  host.emit('r1', 'user/message', host.say('@Writer 整理文档'))
  const value = await host.tool('group_relay', {}, 'r1', { callId: 'c1', signal: new AbortController().signal })
  assert.deepEqual(Object.keys(JSON.parse(value)), ['from', 'anchor'])
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.equal([...rt.roomProgress.values()].filter(round => round.roomId === 'r1').length, 1)
  host.begin('gb')
  host.finish('gb', '整理好了。')
  await settle(() => rt.roomRounds('r1').length === 0)
  const { from } = JSON.parse(value)
  assert.deepEqual(rt.groupRows('r1', from).map(row => row.text), ['整理好了。'])
})

// A message the user sends while a round runs joins that round; what is said after it
// shows under it.
test('a message sent while a round runs joins it, and the rows after it show under it', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 安排一下'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  const second = host.round('c2', host.say('@Writer 你也看看'))
  // One round in the group: the second message called Writer in it.
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.equal([...rt.roomProgress.values()].filter(round => round.roomId === 'r1').length, 1)
  host.begin('gb')
  host.finish('gb', '我看过了。')
  host.finish('ga', '安排好了。')
  await settle(() => first() !== undefined && second() !== undefined)
  assert.deepEqual(first().replies, [])
  assert.deepEqual(second().replies.map(row => [row.name, row.text]), [['Writer', '我看过了。'], ['Chief', '安排好了。']])
  assert.deepEqual(logLines(host).map(line => line.who), ['User', 'User', 'Writer', 'Chief'])
})

// A post that waits for the next round (a goal post, an image, the greeting) does not
// start one after the user stopped the group: it goes with the group's next message.
test('a post waiting for the next round does not start one after the user stops the group', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer 整理一下'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  assert.equal((await host.call('goal-draft', { roomId: 'r1', text: 'Ship v1' })).ok, true)
  const at = host.agentOf('r1').calls.findIndex(call => call.source?.role === 'goal')
  const [draft] = host.agentOf('r1').calls.splice(at, 1)
  host.round('c2', { content: draft.content, source: draft.source })
  await settle(() => true)
  rt.stopRoomRound('r1')
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await settle(() => first() !== undefined)
  assert.equal(host.agentOf('ga').calls.length, 0, 'nothing started after the stop')
  assert.equal(rt.roomActive('r1'), false)
  // The group's next message takes the draft with it: the admin is called for the goal.
  host.round('c3', host.say('继续'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  assert.match(text(host.agentOf('ga').calls[0]), /the user wants to set a goal/)
  host.begin('ga')
  host.finish('ga', '')
})

// While a round finishes (goal check, save), the group is still taken: a message that comes
// in then opens the next round once this one is done, never a second round beside it.
test('a message that comes in while a round finishes waits for it, and no two rounds run', async (t) => {
  const host = await start(t)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const drive = rt.goalDrive
  rt.goalDrive = async (...args) => { await gate; return drive?.(...args) }
  const first = host.round('c1', host.say('@Writer 写一句'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '写好了。')
  await settle(() => rt.roomActive('r1') && [...rt.roomProgress.values()].every(round => round.roomId !== 'r1'))
  const second = host.round('c2', host.say('@Tester 看一下'))
  await settle(() => true)
  assert.equal(host.agentOf('gc').calls.length, 0, 'the finishing round still holds the group')
  release()
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.ok([...rt.roomProgress.values()].filter(round => round.roomId === 'r1').length <= 1)
  host.begin('gc')
  host.finish('gc', '看过了。')
  await settle(() => first() !== undefined && second() !== undefined)
  assert.deepEqual(second().replies.map(row => row.text), ['看过了。'])
})

// Two calls with nothing said between them start at the same seq: each shows only its own rows.
test('two calls that start at the same seq each show only their own rows', async (t) => {
  await start(t)
  rt.ledger.append('group-r1', { event: 'anchor', id: 'one', from: 1, time: 1 })
  rt.ledger.append('group-r1', { event: 'anchor', id: 'two', from: 1, time: 2 })
  rt.logRoom(rt.roomOf('r1'), { who: 'Writer', botId: 'b', text: '回答第二次' })
  assert.deepEqual(rt.groupRows('r1', 1, undefined, 'one'), [])
  assert.deepEqual(rt.groupRows('r1', 1, undefined, 'two').map(row => row.text), ['回答第二次'])
})

// The newest cell is read every second only while the group works.
test('the rows of the newest call say whether the group is still at work', async (t) => {
  const host = await start(t)
  host.emit('r1', 'user/message', host.say('@Writer 写一句'))
  const { from, anchor } = JSON.parse(await host.tool('group_relay', {}, 'r1', { callId: 'c1', signal: new AbortController().signal }))
  await settle(() => host.agentOf('gb').calls.length === 1)
  const busy = (await host.call('group-rows', { roomId: 'r1', from, anchor })).value
  assert.deepEqual([busy.open, busy.active], [true, true])
  host.begin('gb')
  host.finish('gb', '写好了。')
  await settle(() => rt.roomRounds('r1').length === 0)
  const quiet = (await host.call('group-rows', { roomId: 'r1', from, anchor })).value
  assert.deepEqual([quiet.open, quiet.active, quiet.rows.map(row => row.text)], [true, false, ['写好了。']])
})

// The member that finished was renamed before the restart: its result still wakes the
// Bot that asked, carried by that member.
test('after a restart a batch whose finished member was renamed still wakes the caller', async (t) => {
  const log = [{ seq: 1, who: 'User', text: '@Chief 安排' }, { seq: 2, who: 'Chief', botId: 'a', text: '@Writer @Tester 各做一半' }, { seq: 3, who: 'Tester', botId: 'c', text: 'TESTER-RESULT：测试全过。' }]
  const batch = { key: 'k-renamed', roomId: 'r1', by: 'a', pending: ['b'], done: ['Tester'], doneIds: ['c'], results: [{ name: 'Tester', seq: 3 }], worked: true, answered: false, at: 1 }
  const host = await start(t, { log, seq: 3 }, undefined, undefined, { c: { name: 'QA' } }, undefined, { roomBatches: { 'k-renamed': batch } })
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.senderSessionId, post.source.done, post.source.askedBy], ['c', true, 'a'])
})

// A member whose work a restart left is picked up again with a message its turn has not
// taken yet: it still works for the batch, so the batch keeps waiting for it.
test('after a restart a member whose pick-up is still queued keeps its batch waiting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const batch = { key: 'k-queued', roomId: 'r1', by: 'a', pending: ['b'], done: ['Tester'], doneIds: ['c'], results: [], worked: true, answered: false, at: 1 }
  const note = { at: 1, args: { toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', note: 'your turn', text: '整理文档', exchangeId: 'x-queued', askedBy: 'a' } }
  const host = await start(t, undefined, undefined, undefined, undefined, undefined, { roomBatches: { 'k-queued': batch } }, { 'inflight.json': { turns: {}, queued: { gb: [note] } } })
  t.mock.timers.tick(3000)
  await settle(() => host.agentOf('gb').calls.length === 1)
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(rt.state.roomBatches['k-queued']?.pending, ['b'])
  assert.equal(host.agentOf('r1').calls.length, 0, 'the caller is not woken before the member answers')
})

// Stop all while a round finishes: what waited on it does not start once it is done.
test('stopping a group while its round finishes starts nothing afterwards', async (t) => {
  const host = await start(t)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const drive = rt.goalDrive
  rt.goalDrive = async (...args) => { await gate; return drive?.(...args) }
  const first = host.round('c1', host.say('@Writer 写一句'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '写好了。')
  await settle(() => rt.roomActive('r1') && [...rt.roomProgress.values()].every(round => round.roomId !== 'r1'))
  host.round('c2', host.say('@Tester 看一下'))
  await settle(() => true)
  assert.equal((await host.call('stop-room-work', { roomId: 'r1' })).value, true)
  release()
  await settle(() => first() !== undefined && !rt.roomActive('r1'))
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('gc').calls.length, 0, 'nothing started after the stop')
})

const cardA = '11111111-1111-4111-8111-111111111111'
const cardB = '22222222-2222-4222-8222-222222222222'
const taskNotice = { taskManagementEnabled: true, notice: '' }

test('a late group member network failure is visible under its own task', async t => {
  const host = await start(t, taskNotice)
  const room = rt.roomOf('r1')
  rt.ledger.append('group-r1', { event: 'anchor', id: 'task', from: 1, scopeKeys: [cardA] })
  rt.ledger.append('group-r1', { event: 'anchor', id: 'other', from: 1, scopeKeys: [cardB] })
  await rt.lateRoomFailure('gc', { roomId: room.id, taskId: cardA }, { code: 'TRANSPORT', message: 'socket hang up' })
  const rows = anchor => rt.groupRowsView(room.id, 1, undefined, anchor).rows
  assert.deepEqual(rows('task').map(row => [row.name, row.code, row.text]), [['Tester', 'TRANSPORT', 'socket hang up']])
  assert.deepEqual(rows('other'), [])
  assert.equal(host.agentOf('r1').calls.at(-1).source.taskId, cardA)
})

test('a timeout from each assigned Bot is reported on its own card in the group', async t => {
  const host = await start(t, taskNotice)
  const room = rt.roomOf('r1')
  room.projectCards = {}
  for (const [taskId, ownerId] of [[cardA, 'b'], [cardB, 'c']]) {
    const dispatchId = 'dispatch-' + ownerId
    rt.ledger.append('group-r1', { event: 'anchor', id: taskId, from: 1, scopeKeys: [taskId] })
    room.projectCards[taskId] = { id: taskId, title: 'Review', acceptance: 'Verify', intakes: [],
      rounds: [{ ownerId, dispatchId, assignedAt: 1, sentAt: 2, plan: 'Check' }] }
    await rt.deliver({ fromId: 'a', toId: ownerId, taskId, exchangeId: dispatchId, role: 'request', audience: 'user', text: 'Review' })
    host.begin(ownerId)
    host.emit(ownerId, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'TIMEOUT', message: 'request timed out' } } })
  }
  for (const [taskId, name] of [[cardA, 'Writer'], [cardB, 'Tester']]) {
    const rows = rt.groupRowsView(room.id, 1, undefined, taskId).rows
    assert.deepEqual(rows.map(row => [row.name, row.code, row.text]), [[name, 'TIMEOUT', 'request timed out']])
  }
})

test('a group manager failure exposes its sanitized cause once on the original group request', async t => {
  const host = await start(t, taskNotice)
  const first = host.round('first', host.say('Inspect the annotated page'))
  await until(() => first() !== undefined)
  host.begin('ga')
  const other = host.round('other', host.say('Unrelated request'))
  await until(() => other() !== undefined)
  const end = { turn: 1, reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'fetch failed at https://model.example/?token=example-secret' } } }
  host.emit('ga', 'turn/end', end)
  host.emit('ga', 'turn/end', end)
  const rows = call => rt.groupRowsView('r1', call().from, undefined, call().anchor).rows
  assert.deepEqual(rows(first).map(row => [row.kind, row.name, row.code]), [['failed', 'Chief', 'TRANSPORT']])
  assert.match(rows(first)[0].text, /fetch failed/)
  assert.doesNotMatch(rows(first)[0].text, /example-secret/)
  assert.deepEqual(rows(other), [])
  assert.equal(rt.ledger.records('group-r1').filter(row => row.who === 'User').length, 2)
})

test('only the dispatched owner turn exposes its failure on a card with no public reply yet', async t => {
  const host = await start(t, taskNotice)
  const first = host.round('intake', host.say('Review the page'))
  await until(() => first() !== undefined)
  const intake = host.begin('ga').source.intakeId
  const taskId = cardA
  rt.roomOf('r1').projectCards = { [taskId]: { id: taskId, title: 'Review page', acceptance: 'Find issue', intakes: [intake],
    rounds: [{ ownerId: 'b', dispatchId: 'inspect-page', assignedAt: 1, sentAt: 2, plan: 'Inspect page' }] } }
  await rt.deliver({ fromId: 'a', toId: 'b', taskId, exchangeId: 'inspect-page', role: 'request', audience: 'user', text: 'Inspect page' })
  const dispatched = host.begin('b')
  await host.tool('project_task', { action: 'start', taskId, round: 1 }, 'b')
  const failure = { code: 'UNKNOWN', message: 'Model stream closed unexpectedly' }
  let publishing = true
  const updates = []
  host.agentOf('b').session.append = (type, data) => { assert.equal(publishing, false); updates.push([type, data]) }
  host.emit('b', 'todo/write', { todos: [{ content: 'test patch', status: 'in_progress' }] })
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'error', error: failure } })
  publishing = false
  await Promise.resolve()
  assert.deepEqual(updates, [['todo/write', { todos: [{ content: 'test patch', status: 'pending' }] }]])
  const unrelated = { role: 'request', audience: 'user', taskId, senderSessionId: 'a', exchangeId: 'unrelated-private-message' }
  rt.projectRequestFailed('b', unrelated, { code: 'UNKNOWN', message: 'Private conversation' })
  const rows = rt.groupRowsView('r1', first().from, undefined, first().anchor).rows
  assert.deepEqual(rows.map(row => [row.kind, row.name, row.code, row.text]), [['failed', 'Writer', 'UNKNOWN', failure.message]])
  const card = () => host.tool('project_task', { action: 'read', roomId: 'r1', taskId }, 'ga').then(JSON.parse)
  assert.equal((await card()).status, 'failed')
  host.ctx.sessionController.inspect = async () => ({ events: [
    { type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: dispatched },
    { type: 'tool/call', data: { name: 'edit', arguments: { path: '/existing/change.js' } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: failure } } },
  ] })
  const earlier = (await host.ctx.sessionController.inspect()).events
  host.ctx.sessionController.inspect = async () => ({ events: [...earlier,
    { type: 'turn/start', data: { turn: 2 } }, { type: 'user/message', data: { source: { kind: 'user' } } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted' } } },
  ] })
  delete rt.botOf('b').failures.b
  const firstStart = (await card()).startedAt
  const target = { taskId, roomId: 'r1', round: 1, failedAt: (await card()).rounds[0].failedAt }
  const retry = target => host.call('resume', { botId: 'b', target })
  for (const wrong of [{ roomId: 'wrong' }, { taskId: 'wrong' }, { round: 2 }, { failedAt: 0 }]) {
    assert.equal((await retry({ ...target, ...wrong })).error.code, 'bot/stale')
  }
  const receipts = await Promise.all([retry(target), retry(target)])
  assert.ok(receipts.every(r => r.ok))
  assert.equal(host.agentOf('b').calls.length, 2)
  const retried = host.begin('b')
  const history = savedTeam(rt.home).rooms.r1.projectCards[taskId].rounds[0].retries
  assert.equal(history.length, 1)
  assert.equal(history[0].failedAt, target.failedAt)
  assert.equal(history[0].previousOutput, failure.message)
  assert.match(history[0].input, /existing\/change.js/)
  assert.equal((await card()).startedAt, firstStart)
  assert.equal(retried.source.taskId, taskId)
  assert.equal(retried.source.exchangeId, 'inspect-page')
  assert.match(text(retried), /existing\/change.js/)
  assert.equal((await card()).status, 'active')
  await host.tool('project_task', { action: 'submit', taskId, round: 1, result: 'Checked current file' }, 'b')
  assert.equal((await card()).status, 'review')
})

test('Z site clarification creates one durable card and an explicit supplement reuses it', async t => {
  const host = await start(t, { taskManagementEnabled: undefined, sessionId: 'group-part-2', parts: [{ sessionId: 'r1', endedAt: 1 }] })
  const room = rt.roomOf('r1')
  const first = host.round('first', host.say('Investigate Z site'), 'group-part-2')
  await until(() => first() !== undefined)
  host.begin('ga')
  await host.tool('project_task', { action: 'reply', acceptWork: true, classificationReason: 'Deliver a site investigation', message: 'I will investigate Z site.' }, 'ga')
  const clarify = () => host.tool('project_task', { action: 'clarify', reason: 'Which site URL?', title: 'Z site' }, 'ga').then(JSON.parse)
  const [card, replay] = await Promise.all([clarify(), clarify()])
  assert.equal(card.status, 'clarify')
  assert.equal(replay.taskId, card.taskId)
  host.finish('ga', 'Which site URL?')
  const input = { roomId: room.id, taskId: card.taskId, text: 'Use the staging Z site.', requestId: 'one-supplement' }
  const results = await Promise.all([host.call('continue-project-task', input), host.call('continue-project-task', input)])
  assert.ok(results.every(r => r.ok), JSON.stringify(results))
  assert.equal(host.agentOf('r1').calls.length, 0)
  assert.equal(host.agentOf('group-part-2').calls.length, 1)
  const post = host.agentOf('group-part-2').calls[0]
  assert.equal(post.source.taskId, card.taskId)
  const next = host.round('supplement', post, 'group-part-2')
  await until(() => next() !== undefined)
  assert.equal(host.begin('ga').source.taskId, card.taskId)
  assert.deepEqual(Object.keys(savedTeam(rt.home).rooms.r1.projectCards), [card.taskId])
  assert.equal(room.projectCards[card.taskId].clarification, undefined)
  const change = value => host.call('update-room', { id: room.id, ...value })
  await change({ taskManagementEnabled: false })
  await change({ notice: '[taskId]\n[taskAssistant:Tester]' })
  assert.equal(room.taskManagementEnabled, false)
  assert.equal(room.projectAssistantId, undefined)
  assert.equal((await host.call('continue-project-task', input)).error.code, 'TASK_MANAGEMENT_DISABLED')
  assert.equal((await host.call('project-task-detail', input)).value.taskId, card.taskId)
})

test('an in-flight phase-one manager assignment retains its original handoff, attachments and callbacks after upgrade', async t => {
  const attachments = fakeAttachments()
  const receipt = await attachments.saveImage({ mediaType: 'image/jpeg', width: 1, height: 1, data: new Uint8Array([1]) })
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-result-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const markdown = '# Report\n' + '测试结果\n'.repeat(20000) + 'END'
  writeFileSync(join(dir, 'result.md'), markdown)
  writeFileSync(join(dir, 'screen.png'), Buffer.from([2]))
  const host = await start(t, { ...taskNotice, workDir: dir }, { attachments })
  const original = host.say('Inspect the unmarked request source')
  original.content.push({ type: 'image', attachment: receipt })
  const ended = host.round('intake', original)
  await until(() => ended() !== undefined)
  const manager = host.begin('ga')
  assert.match(text(manager), /Inspect the unmarked request source/)
  assert.deepEqual(manager.content.find(block => block.type === 'image').attachment, receipt)
  assert.equal(host.agentOf('a').calls.length, 0)
  const room = rt.roomOf('r1')
  const line = rt.ledger.records('group-r1').find(row => row.who === 'User')
  await forwardProjectIntake(rt, room, line.intakeId, line.seq)
  assert.equal(host.agentOf('ga').calls.length, 1)
  assert.deepEqual(rt.ledger.records('group-r1').filter(row => row.intakeId === line.intakeId), [line])
  const project = (args, session = 'ga') => host.tool('project_task', args, session).then(JSON.parse)
  // A manager turn admitted on v1 has a ledger entry but no v2 routing receipt.
  delete room.projectInbox
  const assignment = { action: 'assign', title: 'Inspect request source', ownerId: 'b', plan: 'Investigate then return evidence', acceptance: 'Source is identified' }
  await assert.rejects(project({ ...assignment, ownerId: 'outside' }), /group/)
  await assert.rejects(project({ ...assignment, roomId: 'r1' }, 'b'), /manager chat/)
  const [first, repeat] = await Promise.all([project(assignment), project(assignment)])
  assert.deepEqual(first, repeat)
  const id = first.taskId
  assert.equal(first.status, 'dispatching')
  assert.equal((await project({ action: 'list' })).cards.length, 1)
  await assert.rejects(project({ ...assignment, title: 'Conflicting replay' }), /different details/)
  const saved = await project({ action: 'read', taskId: id })
  assert.deepEqual(saved.requirements[0].images, [receipt])
  const args = { to: 'Writer', taskId: id, card_round: 1, message: 'Confirm start only', reply_to: 'user', request_id: 'work-1' }
  await assert.rejects(host.tool('message_bot', { ...args, card_round: 2 }, 'ga'), /current round/)
  await assert.rejects(host.tool('message_bot', { ...args, to: 'Tester' }, 'ga'), /assigned owner/)
  const sent = await host.tool('message_bot', args, 'ga')
  assert.equal(await host.tool('message_bot', { ...args, request_id: 'duplicate' }, 'ga'), sent)
  assert.equal(host.agentOf('gb').calls.length, 1)
  assert.ok(Object.values(rt.state.requests).every(record => !record.receipt?.includes('Inspect the unmarked request source')))
  assert.equal((await project({ action: 'read', taskId: id })).status, 'dispatching')
  const work = host.begin('gb')
  assert.equal(work.source.taskId, id)
  assert.deepEqual(work.content.find(block => block.type === 'image').attachment, receipt)
  const packet = JSON.parse(sent.split('\nCard handoff: ')[1])
  assert.equal(packet.exchangeId, work.source.exchangeId)
  assert.ok(text(work).includes(packet.text))
  assert.match(packet.text, /Inspect the unmarked request source/)
  assert.match(packet.text, /Source is identified/)
  assert.equal((await project({ action: 'start', taskId: id, round: 1 }, 'gb')).status, 'active')
  const submit = { action: 'submit', taskId: id, round: 1, result: 'Verified the source in the record', resultFiles: ['result.md', 'screen.png'] }
  assert.equal((await project(submit, 'gb')).status, 'review')
  rmSync(join(dir, 'result.md'))
  assert.equal((await project(submit, 'gb')).status, 'review')
  const [doc, screen] = savedTeam(rt.home).rooms.r1.projectCards[id].rounds[0].resultFiles
  const readResult = extra => host.call('project-task-detail', { roomId: 'r1', taskId: id, ...extra })
  assert.equal((await readResult({ documentId: doc.ref.attachmentId })).value, markdown)
  assert.equal((await readResult({ imageId: screen.ref.attachmentId })).value, 'data:image/png;base64,Ag==')
  assert.equal((await readResult({ documentId: screen.ref.attachmentId })).error.code, 'bot/not-found')
  assert.equal(savedTeam(rt.home).rooms.r1.projectCards[id].rounds[0].dispatchId, work.source.exchangeId)
  host.finish('ga', 'Waiting for confirmation')
  await host.tool('message_bot', { to: 'Chief', taskId: id, message: 'Worktree verified. Started.', reply_to: 'user', request_id: 'start-1' }, 'gb')
  assert.equal(host.begin('ga').source.taskId, id)
  assert.match(text(host.agentOf('ga').calls.at(-1)), /Worktree verified/)
  const handoff = await project({ action: 'handoff', taskId: id, round: 1, ownerId: 'c', plan: 'Independently verify the source' })
  assert.equal(handoff.round, 2)
  await assert.rejects(project({ action: 'submit', taskId: id, round: 1, result: 'Late result' }, 'gb'), /current card round/)
  await assert.rejects(host.tool('message_bot', { ...args, to: 'Tester', card_round: 2 }, 'ga'), /different request/)
  await host.tool('message_bot', { ...args, to: 'Tester', card_round: 2, request_id: 'work-2' }, 'ga')
  const review = host.begin('gc')
  assert.match(text(review), /Previous delivery: Verified the source in the record/)
  assert.deepEqual(review.content.find(block => block.type === 'image').attachment, receipt)
  const view = (await host.call('state')).value.rooms.find(r => r.id === 'r1')
  assert.equal(view.projectCards.length, 1)
  assert.equal(view.projectCards[0].ownerId, 'c')
  assert.equal(view.projectCards[0].round, 2)
  assert.equal(view.projectCards[0].rounds, undefined, 'whole assignment histories stay out of the roster payload')
  assert.equal(view.projectCards[0].startedAt, savedTeam(rt.home).rooms.r1.projectCards[id].rounds[0].startedAt)
  assert.equal(view.projectCards[0].submittedAt, undefined)
  assert.equal(view.projectCards[0].result, undefined)
  const detail = (await host.call('project-task-detail', { roomId: 'r1', taskId: id })).value
  assert.deepEqual(detail.requirements[0].images, [receipt])
  assert.equal(detail.acceptance, assignment.acceptance)
  assert.equal(detail.rounds.length, 2)
  const timeline = (await host.call('project-task-detail', { roomId: 'r1', taskId: id, interactionsOnly: true })).value
  const sends = timeline.messages.filter(row => detail.rounds.some(round => round.dispatchId === row.exchangeId))
  assert.deepEqual(sends.map(row => [row.from, row.to]), [['a', 'b'], ['a', 'c']])
  assert.equal(sends[0].text, 'Confirm start only')
  assert.ok(timeline.messages.every(row => row.from && row.to && row.from !== row.to))
  assert.match(detail.rounds[0].dispatchInput, /Confirm start only/)
  assert.match(detail.rounds[1].dispatchInput, /Verified the source in the record/)
  assert.ok(detail.rounds[0].submittedAt >= detail.rounds[0].startedAt)
  assert.equal(detail.rounds[0].result, 'Verified the source in the record')
  assert.equal((await host.call('project-task-detail', { roomId: 'missing', taskId: id })).error.code, 'GROUP_CONTEXT_REQUIRED')
  assert.equal((await host.call('project-task-detail', { roomId: 'r1', taskId: 'missing' })).error.code, 'bot/not-found')
})

test('the same worker receives each project dispatch in the assigning group', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'two-projects-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const folders = { r1: join(root, 'ds-bot'), r2: join(root, 'engineering-memory') }
  for (const folder of Object.values(folders)) {
    mkdirSync(folder)
    execFileSync('git', ['init', '-q', '-b', 'dev', folder])
    execFileSync('git', ['-C', folder, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture',
      '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Initial'])
  }
  const design = { id: 'r2', name: 'Design', workDir: folders.r2, ...taskNotice, members: ['a', 'b'], mode: 'admin',
    admin: 'a', sessions: { a: 'da', b: 'db' }, log: [], seq: 0, seen: {} }
  const host = await start(t, { ...taskNotice, workDir: folders.r1 }, undefined, { r2: design }, { b: { workDir: folders.r2 } })
  for (const [roomId, manager, worker] of [['r1', 'ga', 'gb'], ['r2', 'da', 'db']]) {
    const goal = 'Inspect the architecture of ' + roomId
    const intake = host.round(roomId, host.say(goal), roomId)
    await until(() => intake() !== undefined)
    host.begin(manager)
    const project = (session, args) => host.tool('project_task', args, session).then(JSON.parse)
    await project(manager, { action: 'branches' })
    const { taskId } = await project(manager, { action: 'plan', version: 1, title: goal, acceptance: 'Verified',
      workspaceMode: 'current', workRef: 'dev', workspaceReason: 'Inspect the project on dev',
      nodes: [{ ownerId: 'b', title: goal, writePaths: [], instructions: 'Read sources', deliverable: 'Report', acceptance: 'Verified' }] })
    await project(manager, { action: 'dispatch', taskId, version: 1, node: 1 })
    const send = { taskId, card_round: 1, to: 'Writer', reply_to: 'user', request_id: taskId, message: goal }
    const receipt = await host.tool('message_bot', send, manager)
    assert.equal(await host.tool('message_bot', send, manager), receipt)
    assert.equal(host.agentOf(worker).calls.length, 1)
    assert.equal(host.agentOf('b').calls.length, 0)
    assert.equal(savedTeam(rt.home).rooms[roomId].projectCards[taskId].rounds[0].executionSession, worker)
    assert.equal(host.begin(worker).source.roomId, roomId)
    await project(worker, { action: 'start', taskId, round: 1 })
    const round = savedTeam(rt.home).rooms[roomId].projectCards[taskId].rounds[0]
    assert.equal(round.workspace.workRef, 'dev')
    assert.equal(round.workspace.workDir, folders[roomId])
    await project(worker, { action: 'submit', taskId, round: 1, result: goal })
  }
})

test('a user-appointed assistant handles one intake, dispatch and review while the admin stays available', async t => {
  const host = await start(t, taskNotice)
  const room = rt.roomOf('r1')
  const notice = room.notice + '\n[taskAssistant:Tester]'
  await assert.rejects(rt.updateRoom(room.id, { projectAssistantId: 'c' }, 'a'), /Only the user/)
  await assert.rejects(rt.updateRoom(room.id, { projectAssistantId: 'a' }), { code: 'TASK_ASSISTANT_INVALID' })
  await rt.updateRoom(room.id, { notice })
  assert.equal(room.projectAssistantId, undefined)
  await rt.updateRoom(room.id, { projectAssistantId: 'c' })
  assert.equal(room.projectAssistantId, 'c')
  const sent = host.round('from-user', host.say('Change the empty label into a dash.'))
  await until(() => sent() !== undefined)
  const intake = host.begin('ga')
  assert.match(text(intake), /project_task delegate/)
  const project = (bot, args) => host.tool('project_task', args, bot).then(JSON.parse)
  const handoff = { action: 'delegate', plan: 'Change the empty label.', acceptance: 'Display a dash.' }
  await assert.rejects(project('b', { ...handoff, roomId: room.id }), { code: 'TASK_ROLE_REQUIRED' })
  await project('ga', handoff)
  const [accepted] = Object.values(room.projectCards)
  assert.equal(accepted.classificationReason, handoff.plan)
  assert.equal(accepted.goal, handoff.plan)
  assert.equal(accepted.acceptance, handoff.acceptance)
  assert.match(text(intake), /two separate, concise Markdown numbered lists/)
  const delegated = host.begin('gc')
  assert.equal(delegated.source.intakeId, intake.source.intakeId)
  assert.match(text(delegated), /Change the empty label into a dash/)
  assert.match(text(delegated), /keep the candidate on the feature branch/)
  const plan = { action: 'plan', version: 1, title: 'Empty label', acceptance: handoff.acceptance,
    nodes: [{ ownerId: 'b', title: 'Fix label', instructions: 'Implement and test', deliverable: 'Verified display', acceptance: handoff.acceptance }] }
  await assert.rejects(project('ga', plan), { code: 'TASK_ROLE_REQUIRED' })
  const { taskId } = await project('gc', plan)
  assert.equal(taskId, accepted.id)
  await project('ga', handoff)
  assert.equal(host.agentOf('gc').calls.length, 1)
  const key = { taskId, version: 1, node: 1 }
  await project('gc', { action: 'dispatch', ...key })
  const send = { taskId, to: 'Writer', card_round: 1, reply_to: 'user', request_id: 'one', message: 'Check the label' }
  await assert.rejects(host.tool('message_bot', send, 'ga'), { code: 'TASK_ROLE_REQUIRED' })
  await host.tool('message_bot', send, 'gc')
  host.finish('gc', 'Dispatched')
  host.begin('gb')
  await project('gb', { action: 'start', taskId, round: 1 })
  const submit = { action: 'submit', taskId, round: 1, result: 'Empty label verified.' }
  room.projectCards[cardB] = { id: cardB, parentTaskId: taskId, plans: [], rounds: [], intakes: [] }
  assert.equal((await project('gb', submit)).status, 'done')
  assert.equal((await project('gb', submit)).status, 'done')
  assert.equal((await project('gc', { action: 'read', taskId: cardB })).status, 'done')
  assert.equal(host.agentOf('ga').calls.length, 2)
  assert.match(text(host.begin('ga')), /Final delivery completed/)
  const feedback = { action: 'report', message: 'The empty label now displays a dash.' }
  await project('ga', feedback)
  await project('ga', feedback)
  assert.equal(host.agentOf('r1').calls.length, 1)
  const broadcast = host.agentOf('r1').calls[0]
  assert.equal(broadcast.source.quiet, true)
  assert.equal(broadcast.source.taskId, taskId)
  await rt.updateRoom(room.id, { remove: ['c'] })
  assert.equal(room.projectAssistantId, 'c')
  await assert.rejects(project('ga', { action: 'plan' }), { code: 'TASK_ASSISTANT_INVALID' })
})

test('the planner can relate existing cards without moving their history or execution', async t => {
  const host = await start(t, { ...taskNotice, projectAssistantId: 'c' })
  const room = rt.roomOf('r1')
  const card = (id, title) => ({ id, title, plans: [], rounds: [], intakes: ['intake-' + id] })
  room.projectCards = { [cardA]: card(cardA, 'Collapse list'), [cardB]: card(cardB, 'Correct arrow') }
  const relation = { action: 'relate', taskId: cardB, parentTaskId: cardA }
  const act = (args, who = 'gc') => host.tool('project_task', args, who).then(JSON.parse)
  await assert.rejects(act(relation, 'ga'), { code: 'TASK_ROLE_REQUIRED' })
  await assert.rejects(act({ ...relation, parentTaskId: 'missing' }), /two existing/)
  rt.live.set('gc', { info: { role: 'request', roomId: room.id, taskId: cardA } })
  assert.equal((await act({ action: 'read', taskId: cardB })).taskId, cardB)
  await Promise.all([act(relation), act(relation)])
  assert.equal(savedTeam(host.home).rooms.r1.projectCards[cardB].parentTaskId, cardA)
  const { value } = await host.call('project-task-detail', { roomId: 'r1', taskId: cardB })
  assert.deepEqual([value.taskId, value.title, value.parentTaskId], [cardB, 'Correct arrow', cardA])
  assert.deepEqual(room.projectCards[cardB].intakes, ['intake-' + cardB])
  await assert.rejects(act({ action: 'relate', taskId: cardA, parentTaskId: cardB }), /cycle/)
  await assert.rejects(act({ ...relation, parentTaskId: cardB }), /different card/)
  const list = await act({ action: 'list' })
  assert.equal(list.cards.find(c => c.taskId === cardB).parentTaskId, cardA)
})

test('the admin can link two selected cards from the user message with an assistant appointed', async t => {
  const host = await start(t, { ...taskNotice, projectAssistantId: 'c' })
  const room = rt.roomOf('r1')
  const quote = id => '\n\n> Task details · Label\n> Ops · Planning · [task:' + id + ']\n\n'
  for (const id of [cardA, cardB]) {
    const intakeId = 'intake-' + id
    rt.logRoom(room, { who: 'User', intakeId, text: 'Original ' + id, session: true })
    ;(room.projectCards ??= {})[id] = { id, title: 'Label', intakes: [intakeId], rounds: [], plans: [] }
  }
  const group = host.round('pair', host.say('以' + quote(cardB) + '为主，把' + quote(cardA) + '关联过来'))
  await until(() => group() !== undefined)
  const delivery = host.begin('ga')
  assert.equal(delivery.source.taskId, cardB)
  assert.ok(text(delivery).includes('[task:' + cardA + ']'))
  await host.tool('project_task', { action: 'relate', taskId: cardA, parentTaskId: cardB }, 'ga')
  assert.equal(savedTeam(host.home).rooms.r1.projectCards[cardA].parentTaskId, cardB)
  assert.equal(Object.keys(room.projectCards).length, 2)
  assert.equal(host.agentOf('gc').calls.length, 0)
})

test('an unquoted instruction to associate two named cards consumes its receipt on the child', async t => {
  const host = await start(t, { ...taskNotice, projectAssistantId: 'c' })
  const room = rt.roomOf('r1')
  room.projectCards = { [cardA]: { id: cardA, title: 'Arrow', intakes: [], rounds: [] },
    [cardB]: { id: cardB, title: 'Members', intakes: [], rounds: [] } }
  const group = host.round('named-link', host.say('把 Arrow 关联到 Members'))
  await until(() => group() !== undefined)
  const { intakeId } = host.begin('ga').source
  const relate = () => host.tool('project_task', { action: 'relate', taskId: cardA, parentTaskId: cardB }, 'ga')
  await relate()
  await relate()
  assert.deepEqual(room.projectCards[cardA].intakes, [intakeId])
  assert.equal(room.projectInbox[0].status, 'attached')
  assert.equal(room.projectCards[cardA].parentTaskId, cardB)
  assert.equal(Object.keys(room.projectCards).length, 2)
})

test('mentioning a blocked project card continues its intake and delegates only to its assistant', async t => {
  const host = await start(t, { ...taskNotice, projectAssistantId: 'c' })
  const room = rt.roomOf('r1')
  const intakeId = 'intake-' + cardA
  const original = rt.logRoom(room, { who: 'User', intakeId, text: 'Implement the label', session: true })
  room.projectInbox = [{ id: intakeId, seq: original.seq, title: 'Label', receivedAt: 1, status: 'accepted' }]
  room.projectCards = { [cardA]: { id: cardA, title: 'Label', intakes: [intakeId], acceptance: 'Verified label',
    rounds: [{ ownerId: 'b', plan: 'Implement', planNode: { version: 1, node: 1, inputs: [], block: { at: 1, cause: 'dependency', by: 'b', reason: 'Branch conflict', decisions: [] } } }],
    plans: [{ version: 1, by: 'c', at: 1, nodes: [{ no: 1, title: 'Implement', ownerId: 'b', instructions: 'Implement', deliverable: 'Label', acceptance: 'Verified label', dependsOn: [] }] }] } }
  const message = '> Task details · Label\n> Ops · Blocked · Writer · [task:' + cardA + ']\n> Requirement: @all implement the label\n\n  推进任务'
  const group = host.round('continue-mention', host.say(message))
  await until(() => group() !== undefined)
  assert.equal(host.begin('ga').source.taskId, cardA)
  await host.tool('project_task', { action: 'reply', acceptWork: true, message: 'Checking the original task.' }, 'ga')
  assert.equal(host.agentOf('gc').calls.length, 0)
  await host.tool('project_task', { action: 'delegate', taskId: cardA, plan: 'Continue the label', acceptance: 'Verified label' }, 'ga')
  assert.equal(host.begin('gc').source.taskId, cardA)
  assert.equal(host.agentOf('gb').calls.length, 0)
  assert.deepEqual(Object.keys(room.projectCards), [cardA])
  assert.deepEqual(room.projectInbox.map(item => item.id), [intakeId])
  const update = { group: 'Ops', taskId: cardA, message: '@Chief I will check this.' }
  assert.match(await host.tool('post_to_group', { ...update, report_back: true }, 'ga'), /Nobody would answer/)
  await host.tool('post_to_group', update, 'ga')
  const status = host.round('status-without-assignment', host.takePost())
  await until(() => status() !== undefined)
  assert.equal(host.agentOf('gc').calls.length, 1)
  assert.equal(host.agentOf('gb').calls.length, 0)

  const coordinate = { action: 'clarify', taskId: cardA, reason: 'Coordinate independent validation before integration.' }
  const response = JSON.parse(await host.tool('project_task', coordinate, 'gc'))
  assert.equal(response.status, 'blocked')
  assert.equal(response.coordination.toId, 'a')
  await host.tool('project_task', coordinate, 'gc')
  assert.equal(host.agentOf('ga').calls.length, 2)
  assert.equal(host.begin('ga').source.taskId, cardA)
  const decision = JSON.parse(await host.tool('project_task', { ...coordinate, reason: 'Verify the saved candidate in isolation.' }, 'ga'))
  assert.equal(decision.coordination.toId, 'c')
  assert.equal(host.begin('gc').source.taskId, cardA)
  assert.equal(room.projectCards[cardA].clarification, undefined)
  const human = await host.tool('project_task', { ...coordinate, humanInput: 'requirement', reason: 'Which edition did you purchase?' }, 'ga')
  assert.equal(JSON.parse(human).status, 'clarify')
  host.finish('ga', 'Delegated')
  room.projectCards[cardA].clarification = 'Which branch should be reviewed?'
  const question = host.round('question-about-card', host.say(message.replace('推进任务', '为什么受阻？')))
  await until(() => question() !== undefined)
  const request = host.begin('ga')
  assert.equal(request.source.taskId, cardA)
  assert.match(text(request), /Latest message:\n为什么受阻？/)
  await host.tool('project_task', { action: 'reply', message: 'There is a branch conflict.' }, 'ga')
  assert.equal(room.projectCards[cardA].clarification, 'Which branch should be reviewed?')
  assert.equal(room.projectCards[cardA].rounds.length, 1)
  assert.deepEqual(Object.keys(room.projectCards), [cardA])
  assert.equal(host.agentOf('gc').calls.length, 2)
})

test('a project manager answers the original group input once before planning, without waking the workers', async t => {
  const host = await start(t, taskNotice)
  const room = rt.roomOf('r1')
  const group = host.round('early', host.say('Make unmarked values display as a dash.'))
  await until(() => group() !== undefined)
  const input = host.begin('ga')
  const owners = JSON.parse(text(input).match(/^Eligible node owners \(id, name, role\): (.+)$/m)[1])
  assert.deepEqual(owners.map(owner => owner.id), room.members.filter(id => id !== 'a'))
  const first = { action: 'reply', message: 'I will check how the unmarked value is rendered and where the dash belongs.' }
  const project = (args, session = 'ga') => host.tool('project_task', args, session)
  await assert.rejects(project({ ...first, roomId: room.id }, 'b'), { code: 'TASK_ROLE_REQUIRED' })
  await assert.rejects(project({ ...first, taskId: cardA }), /manager chat/)
  await Promise.all([project(first), project(first)])
  await project({ ...first, message: 'A rephrased retry.' })
  const rows = (await host.call('group-rows', { roomId: room.id, from: group().from, anchor: group().anchor })).value.rows
  assert.deepEqual(rows.map(row => [row.botId, row.text]), [['a', '[' + input.source.intakeId + '] ' + first.message]])
  assert.equal(room.projectInbox[0].status, 'planning')
  assert.deepEqual(Object.keys(room.projectCards ?? {}), [])
  for (const id of ['r1', 'a', 'gb', 'b']) assert.equal(host.agentOf(id).calls.length, 0)
  // A rejected plan cannot retract the public answer or start a worker.
  const node = { ownerId: 'a', title: 'Check display', instructions: 'Inspect values', deliverable: 'Result', acceptance: 'Shows a dash' }
  const plan = { action: 'plan', version: 1, title: 'Empty display', acceptance: 'Shows a dash', nodes: [node] }
  await assert.rejects(project(plan), /other than the dispatching manager/)
  const saved = JSON.parse(await project({ ...plan, nodes: [{ ...node, ownerId: 'b' }] }))
  assert.equal(saved.status, 'dispatching')
  host.finish('ga', 'Private planning notes')
  const next = host.round('continued', { ...host.say('继续'), source: { kind: 'user', taskId: saved.taskId, continueTask: true } })
  await until(() => next() !== undefined)
  assert.equal(host.begin('ga').source.taskId, saved.taskId)
  await project({ action: 'reply', message: 'I will continue checking the display on the saved task.' })
  const follow = (await host.call('group-rows', { roomId: room.id, from: next().from, anchor: next().anchor })).value
  assert.equal(follow.rows.length, 1)
  assert.match(follow.rows[0].text, /continue checking the display/)
})

test('a first answer to a drained intake reaches the group session without starting work or duplicating on retry', async t => {
  const host = await start(t, taskNotice)
  const room = rt.roomOf('r1')
  const intakeId = 'intake-11111111-1111-4111-8111-111111111111'
  const original = rt.logRoom(room, { who: 'User', intakeId, text: 'Who checks the result?', session: true })
  await forwardProjectIntake(rt, room, intakeId, original.seq)
  host.begin('ga')
  const args = { action: 'chat', reason: 'A question about roles.', message: 'The project manager checks the result.' }
  await host.tool('project_task', args, 'ga')
  const [post] = host.agentOf('r1').calls
  assert.equal(post.source.quiet, true)
  assert.equal(post.source.intakeId, intakeId)
  const delivery = host.round('quiet', post)
  await until(() => delivery() !== undefined)
  await host.tool('project_task', args, 'ga')
  assert.equal(host.agentOf('r1').calls.length, 1)
  assert.equal(rt.groupSearch(room.id, args.message).results.length, 1)
  for (const id of ['a', 'gb', 'gc']) assert.equal(host.agentOf(id).calls.length, 0)
})

test('a manager can explain why a group question was answered as chat without attaching it to an unrelated card', async t => {
  const host = await start(t, taskNotice)
  const room = rt.roomOf('r1')
  room.projectCards = { [cardA]: { id: cardA, title: 'Change the request source label', intakes: [], rounds: [] } }
  const request = '给我群里的 Bot 职能说明'
  const reason = 'The user asked for information that can be answered directly.'
  const first = host.round('roles', host.say(request))
  await until(() => first() !== undefined)
  host.begin('ga')
  const answer = 'The manager coordinates work and the engineer develops it.'
  await host.tool('project_task', { action: 'chat', reason, message: answer }, 'ga')
  assert.match((await host.call('group-rows', { roomId: room.id, from: first().from, anchor: first().anchor })).value.rows[0].text, /engineer develops it/)
  host.finish('ga', 'The manager coordinates work and the engineer develops it.')

  const follow = host.round('why', host.say('为什么这个没有建 task 呢？'))
  await until(() => follow() !== undefined)
  const question = host.begin('ga')
  assert.match(text(question), /给我群里的 Bot 职能说明/)
  assert.ok(text(question).includes(reason))
  assert.equal(question.source.taskId, undefined)
  assert.doesNotMatch(text(question), /Change the request source label/)

  // A queued later post and an internal notice are not part of the exchange
  // the user could see when they asked. No adjacent files become task inputs.
  rt.logRoom(room, { who: 'User', text: 'Future message', images: [{ id: 'other' }] })
  const context = JSON.parse(await host.tool('project_task', { action: 'context' }, 'ga'))
  assert.ok(context.some(line => line.text === request && line.status === 'chat' && line.reason === reason))
  assert.ok(context.every(line => line.seq < question.source.intakeSeq && !line.images && !line.files))
  const matches = JSON.parse(await host.tool('project_task', { action: 'context', query: '职能说明' }, 'ga'))
  assert.deepEqual(matches.map(line => line.text), [request])
  await assert.rejects(host.tool('project_task', { action: 'context', roomId: room.id }, 'b'), /manager chat/)
  await host.tool('project_task', { action: 'chat', reason: 'Explained the classification of the roles question.' }, 'ga')
  assert.deepEqual(room.projectCards[cardA].intakes, [])
  assert.deepEqual(Object.keys(room.projectCards), [cardA])
  host.finish('ga', 'The roles question could be answered in chat.')

  const original = room.projectInbox.find(item => item.reason === reason)
  const quoted = host.round('quoted roles', host.say(`> [${original.id}] User:\n> ${request}\n\n请解释当时的判断`))
  await until(() => quoted() !== undefined)
  const reply = host.begin('ga')
  assert.notEqual(reply.source.intakeId, original.id)
  assert.equal(original.status, 'chat')
  assert.equal(original.reason, reason)
  const earlier = JSON.parse(await host.tool('project_task', { action: 'context', query: '职能说明' }, 'ga'))
  assert.ok(earlier.some(line => line.text === request && line.reason === reason))
})

test('a bare manager mention asks for the preceding user question without opening or changing a task', async t => {
  const host = await start(t, taskNotice, undefined, undefined, { a: { name: '小圈' } })
  const room = rt.roomOf('r1')
  room.projectCards = { [cardA]: { id: cardA, title: 'Unrelated blocked card', intakes: [], rounds: [], clarification: 'Which checkout?' } }
  const question = '介绍下群里 bot 的能力。这句话为什么没有建立 task？'
  // The host may receive both user messages before running the group relay.
  host.emit('r1', 'user/message', host.say(question))
  const first = host.round('question and call', host.say('@小圈'))
  await until(() => first() !== undefined)
  const [input, nudge] = host.agentOf('ga').calls
  assert.equal(room.projectInbox.length, 1)
  assert.equal(room.projectInbox[0].id, input.source.intakeId)
  assert.equal(room.projectInbox[0].status, 'pending')
  assert.equal(rt.ledger.record('group-r1', nudge.source.intakeSeq).reminderFor, input.source.intakeSeq)
  assert.ok(text(host.begin('ga')).includes(question))
  assert.doesNotMatch(text(nudge), /Unrelated blocked card|Which checkout/)
  const project = args => host.tool('project_task', args, 'ga')
  await assert.rejects(project({ action: 'clarify', reason: 'What do you need?' }), /group answer/)
  await assert.rejects(project({ action: 'attach', taskId: cardA }), /group answer/)
  await assert.rejects(project({ action: 'plan' }), /group answer/)
  await project({ action: 'reply', message: '职能说明可以直接在群里回答。' })
  assert.ok(rt.groupSearch(room.id, '职能说明可以直接在群里回答').results.length)
  host.finish('ga', 'Answered in the group.')

  const again = host.round('second call', host.say('@小圈 '))
  await until(() => again() !== undefined)
  const repeated = host.begin('ga')
  assert.equal(rt.ledger.record('group-r1', repeated.source.intakeSeq).reminderFor, input.source.intakeSeq)
  assert.equal(JSON.parse(await project({ action: 'context' })).filter(line => line.speaker === 'User').length, 1)
  await project({ action: 'chat', message: '可以当场说明，无需派工。', reason: 'Answer the reminder.' })
  await forwardProjectIntake(rt, room, repeated.source.intakeId, repeated.source.intakeSeq)
  assert.equal(host.agentOf('ga').calls.length, 3, 'replaying the same reminder does not deliver another request')
  assert.equal(room.projectInbox.length, 1)
  assert.equal(room.projectInbox[0].status, 'pending')
  assert.equal(room.projectCards[cardA].clarification, 'Which checkout?')
  assert.equal(host.agentOf('b').calls.length, 0)
  host.finish('ga', 'Answered again.')

  const next = host.round('new request', host.say('@小圈 帮我改一下显示名称'))
  await until(() => next() !== undefined)
  assert.equal(room.projectInbox.length, 2)
  const nextInput = host.begin('ga')
  assert.equal(room.projectInbox.find(item => item.id === nextInput.source.intakeId).title, '@小圈 帮我改一下显示名称')
})

test('a manager mention with no previous question is a greeting, while an attachment is a new intake', async t => {
  const attachments = fakeAttachments()
  const host = await start(t, taskNotice, { attachments })
  const room = rt.roomOf('r1')
  const ping = host.round('bare', host.say('@Chief'))
  await until(() => ping() !== undefined)
  assert.match(text(host.begin('ga')), /no preceding user request/i)
  await host.tool('project_task', { action: 'reply', message: 'I’m here.' }, 'ga')
  assert.deepEqual(room.projectInbox ?? [], [])
  host.finish('ga', 'Here.')
  const post = host.say('@Chief')
  const attachment = await attachments.saveImage({ name: 'example.png', mediaType: 'image/png', width: 1, height: 1, data: new Uint8Array([1]) })
  post.content.push({ type: 'image', attachment })
  const request = host.round('attachment', post)
  await until(() => request() !== undefined)
  const input = host.begin('ga')
  assert.equal(room.projectInbox.length, 1)
  assert.equal(room.projectInbox[0].id, input.source.intakeId)
  assert.deepEqual(input.content.find(block => block.type === 'image').attachment, attachment)
})

test('a reminder after upgrading skips an older bare mention and preserves the original chat decision', async t => {
  const host = await start(t, taskNotice)
  const room = rt.roomOf('r1')
  const ask = host.round('roles', host.say('Which bot handles reports?'))
  await until(() => ask() !== undefined)
  const source = host.begin('ga').source
  await host.tool('project_task', { action: 'chat', reason: 'A question about team roles.', message: 'The report engineer.' }, 'ga')
  host.finish('ga', 'Answered.')
  const priorId = 'intake-' + cardA
  const legacy = rt.logRoom(room, { who: 'User', intakeId: priorId, text: '@Chief', session: true })
  room.projectInbox.push({ id: priorId, title: '@Chief', status: 'clarify', seq: legacy.seq, receivedAt: legacy.time, reason: 'Which task?' })
  for (let i = 0; i < 9; i++) rt.logRoom(room, { who: 'Writer', botId: 'b', text: 'Another task update' })
  const before = structuredClone(room.projectInbox)
  const call = host.round('nudge', host.say('@Chief'))
  await until(() => call() !== undefined)
  const nudge = host.begin('ga')
  assert.equal(rt.ledger.record('group-r1', nudge.source.intakeSeq).reminderFor, source.intakeSeq)
  assert.match(text(nudge), /Which bot handles reports\?/)
  const context = JSON.parse(await host.tool('project_task', { action: 'context' }, 'ga'))
  assert.equal(context.at(-1).seq, source.intakeSeq)
  assert.equal(context.at(-1).reason, 'A question about team roles.')
  await host.tool('project_task', { action: 'reply', message: 'The report engineer handles reports.' }, 'ga')
  assert.deepEqual(room.projectInbox, before)
})

test('a card-addressed question and a bare mention in one relay reach the admin in the same group round', async t => {
  const host = await start(t, { ...taskNotice, projectCards: Object.fromEntries([cardA, cardB].map(id => [id, { id, title: id, rounds: [], intakes: [] }])) })
  host.emit('r1', 'user/message', host.say(`Why is this waiting?`, cardA))
  const call = host.round('call on card', host.say('@Chief'))
  await until(() => host.agentOf('ga').calls.length === 1)
  const input = host.begin('ga')
  assert.equal(input.source.taskId, cardA)
  assert.match(text(input), /Why is this waiting\?/)
  host.finish('ga', 'The review is pending.')
  await until(() => call() !== undefined)
  const [asked, ping] = rt.ledger.records('group-r1').filter(row => row.who === 'User')
  assert.equal(ping.reminderFor, asked.seq)
  assert.deepEqual(rt.roomOf('r1').projectInbox ?? [], [])
})

test('three bound image intakes reach the group manager while unrelated group work is still running', async t => {
  const attachments = fakeAttachments()
  const host = await start(t, { ...taskNotice, projectCards: Object.fromEntries([cardA, cardB].map(id => [id, { id, title: id, rounds: [], intakes: [] }])) }, { attachments })
  const busyRound = host.round('busy', host.say(`Unrelated group work`, cardA))
  await until(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  const images = await Promise.all([1, 2, 3].map(i => attachments.saveImage({
    name: `annotation-${i}.jpg`, mediaType: 'image/jpeg', width: 1, height: 1, data: new Uint8Array([i]),
  })))
  const read = rt.imagesForGroup
  let reads = 0
  rt.imagesForGroup = async (...args) => {
    reads++
    await new Promise(resolve => setTimeout(resolve, 120))
    return read(...args)
  }
  t.after(() => { rt.imagesForGroup = read })
  for (let i = 0; i < images.length; i++) {
    const post = host.say(`selection-${i + 1}`)
    post.content.push({ type: 'image', attachment: images[i] })
    host.round('intake-' + i, post)
  }
  // All intakes must finish forwarding before the unrelated turn ends.
  try {
    await until(() => host.agentOf('ga').calls.length === images.length + 1)
    assert.equal(busyRound(), undefined, 'the unrelated group round must still be running')
    assert.equal(reads, 0)
    const messages = host.agentOf('ga').calls.filter(m => m.source.intakeId)
    assert.equal(new Set(messages.map(message => message.source.intakeId)).size, 3)
    assert.deepEqual(rt.ledger.records('group-r1').filter(row => row.intakeId).map(row => row.who), ['User', 'User', 'User'])
    for (const [i, img] of images.entries()) {
      const matching = messages.filter(message => text(message).trimEnd().endsWith('selection-' + (i + 1)))
      assert.equal(matching.length, 1)
      assert.deepEqual(matching[0].content.filter(b => b.type === 'image').map(b => b.attachment), [img])
    }
  } finally {
    host.finish('ga', 'Done')
  }
})

test('card A gets its quoted image while card B waits and a fresh intake reaches the group manager', async t => {
  const host = await start(t, { ...taskNotice, projectCards: Object.fromEntries([cardA, cardB].map(id => [id, { id, title: id, rounds: [], intakes: [] }])) })
  const runs = [host.round('A', host.say(`Accept the A candidate`, cardA))]
  await until(() => host.agentOf('ga').calls.length === 1)
  const opening = host.begin('ga')
  assert.equal(opening.source.taskId, cardA)
  host.emit('ga', 'tool/call', { callId: 'accept-a', name: 'verify' })
  runs.push(host.round('B', host.say(`Change pagination B`, cardB)))
  runs.push(host.round('intake', host.say('New independent export request')))
  await until(() => rt.roomOf('r1').taskQueue?.length === 1 && host.agentOf('ga').calls.length === 2)
  assert.deepEqual(host.agentOf('gb').calls, [])
  const attachment = { id: 'A-image', name: 'page.png', mimeType: 'image/png' }
  const addendum = host.say(`> Accept the A candidate\n\nUse the corrected screenshot.`, cardA)
  addendum.content.push({ type: 'image', attachment })
  runs.push(host.round('A2', addendum))
  await until(() => host.agentOf('ga').calls.length === 3)
  const more = host.agentOf('ga').inbox.nextStep.at(-1)
  assert.equal(more.source.taskId, cardA)
  assert.equal(more.source.exchangeId, opening.source.exchangeId)
  assert.deepEqual(more.content.find(block => block.type === 'image').attachment, attachment)
  assert.doesNotMatch(text(more), /pagination B|export request/)
  host.emit('ga', 'user/message', { content: more.content, source: more.source })
  await assert.rejects(host.tool('message_bot', { to: 'Writer', message: 'please verify', taskId: cardB }, 'ga'), /different task/)
  assert.deepEqual(host.agentOf('gb').calls, [])
  host.emit('ga', 'tool/result', { callId: 'accept-a' })
  host.finish('ga', 'A accepted')
  await until(() => host.agentOf('ga').calls.length === 4)
  const b = host.begin('ga')
  assert.equal(b.source.taskId, cardB)
  assert.match(text(b), /pagination B/)
  assert.doesNotMatch(text(b), /A accepted|Accept the A|corrected screenshot|export request/)
  host.finish('ga', 'B received')
  const intake = host.begin('ga', host.agentOf('ga').calls.find(m => m.source.intakeId))
  assert.ok(intake.source.intakeId)
  assert.equal(intake.source.taskId, undefined)
  assert.doesNotMatch(text(intake), /pagination B|A accepted/)
  assert.match(text(intake), /export request/)
  host.finish('ga', 'Which page needs exporting?')
  await until(() => runs.every(result => result() !== undefined))
  const log = rt.ledger.records('group-r1')
  assert.ok(log.some(row => row.taskId === cardA && row.text === `[${cardA}] A accepted`))
  assert.ok(log.some(row => row.taskId === cardB && row.text === `[${cardB}] B received`))
  assert.ok(log.filter(row => row.taskId === cardA).every(row => !/pagination B|export request/.test(row.text)))
  const bRows = rt.groupRowsView('r1', runs[1]().from, undefined, runs[1]().anchor)
  assert.ok(bRows.rows.some(row => row.text?.includes('B received')))
  assert.ok(bRows.rows.every(row => !row.text?.includes('A accepted')))
})

test('project dispatch validates the card before sending and never merges unread different cards', async t => {
  const host = await start(t, taskNotice)
  await assert.rejects(host.tool('message_bot', { to: 'Writer', card_round: 1, message: 'unbound' }, 'a'), /needs.*taskId/)
  assert.deepEqual(host.agentOf('b').calls, [])
  for (const taskId of [cardA, cardB]) {
    await host.tool('message_bot', { to: 'Writer', taskId, message: 'Develop', reply_to: 'user' }, 'a')
  }
  assert.deepEqual(host.agentOf('b').calls.map(msg => msg.source.taskId), [cardA, cardB])
  assert.ok(host.agentOf('b').calls.every(msg => text(msg).startsWith(`[${msg.source.taskId}]`)))
  host.begin('b')
  await assert.rejects(host.tool('post_to_group', { group: 'Ops', taskId: cardA, message: 'Wrong reply' }, 'b'), /different task/)
  await host.tool('post_to_group', { group: 'Ops', message: 'My result' }, 'b')
  const posted = host.takePost()
  assert.equal(posted.source.taskId, cardB)
  assert.match(text(posted), new RegExp('\\[' + cardB + '\\] My result'))
})

test('a saved task queue resumes without mixing pending cards on startup', async t => {
  const queue = [cardA, cardB].map(taskId => ({ taskId, text: `[${taskId}] check` }))
  const host = await start(t, { ...taskNotice, taskQueue: queue })
  await until(() => host.agentOf('ga').calls.length === 1)
  assert.equal(host.begin('ga').source.taskId, cardA)
  host.finish('ga', 'accepted first')
  await until(() => host.agentOf('ga').calls.length === 2)
  assert.equal(host.begin('ga').source.taskId, cardB)
  host.finish('ga', 'accepted second')
  await until(() => rt.roomRounds('r1').length === 0)
  assert.equal(rt.roomOf('r1').taskQueue?.length ?? 0, 0)
})

test('a card supplement can pass an unrelated buffered user message', async t => {
  const host = await start(t, { ...taskNotice, projectCards: Object.fromEntries([cardA, cardB].map(id => [id, { id, title: id, rounds: [], intakes: [] }])) })
  const running = host.round('A', host.say(`Inspect`, cardA))
  await until(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  const inbox = host.agentOf('r1').inbox
  inbox.nextTurn.push({ ...host.say('Different requirement'), id: 'unassigned' })
  inbox.nextStep.push({ ...host.say(`> Inspect\n\nCorrected acceptance steps`, cardA), id: 'supplement' })
  rt.nudgeRoom('r1')
  const supplement = () => host.agentOf('ga').inbox.nextStep.find(m => m.source.taskId === cardA)
  await until(supplement)
  assert.match(text(supplement()), /Corrected acceptance steps/)
  assert.doesNotMatch(text(supplement()), /Different requirement/)
  host.finish('ga', 'verified')
  await until(() => host.agentOf('ga').calls.length === 3)
  const receipt = host.agentOf('ga').inbox.nextTurn.find(m => m.source.intakeId)
  assert.ok(receipt)
  host.begin('ga', receipt)
  host.finish('ga', 'Needs a new card')
  await until(() => running() !== undefined)
})

test('a picture intake releases two independent node rounds only after approval of their shared input', async t => {
  const attachments = fakeAttachments()
  const picture = await attachments.saveImage({ mediaType: 'image/png', width: 1, height: 1, data: new Uint8Array([1]) })
  const host = await start(t, { ...taskNotice, members: ['a','b','c','d'], sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } }, { attachments }, undefined, { d: {} })
  const request = host.say('Use a dash when the source is empty')
  request.content.push({ type: 'image', attachment: picture })
  const ended = host.round('picture', request)
  await until(() => ended() !== undefined)
  const manager = host.begin('ga'), intakeId = manager.source.intakeId
  const project = (args, session = 'ga') => host.tool('project_task', args, session).then(JSON.parse)
  const list = () => project({ action: 'list' })
  await until(() => rt.roomOf('r1').projectInbox[0]?.status === 'planning')
  assert.equal((await list()).inbox[0].status, 'planning')
  const nodes = ['b','d','c'].map((ownerId, i) => ({
    title: ['Develop','Review','Test'][i], ownerId, instructions: 'Inspect the source', deliverable: 'Evidence', acceptance: 'Compare the image', dependsOn: i ? [1] : [],
  }))
  const spec = { action: 'plan', version: 1, title: 'Empty source', acceptance: 'Shows a dash', nodes }
  await assert.rejects(project({ ...spec, nodes: [{...nodes[0],dependsOn:[2]}, nodes[1]] }), /earlier node/)
  assert.equal((await project({action:'clarify', reason:'Which source?'})).status, 'clarify')
  assert.equal((await list()).cards.length, 0)
  const writer = new DatabaseSync(join(rt.home, 'state', 'rooms', 'id-r1', 'room.sqlite'))
  try {
    writer.exec('BEGIN IMMEDIATE')
    await assert.rejects(project(spec), /locked|busy/i)
    assert.equal((await list()).cards.length, 0)
    assert.equal((await list()).inbox[0].status, 'clarify')
    assert.equal(Object.keys(savedTeam(rt.home).rooms.r1.projectCards ?? {}).length, 0)
  } finally { writer.close() }
  const [card, replay] = await Promise.all([project(spec), project(spec)])
  const taskId = card.taskId
  assert.equal(replay.taskId, taskId)
  assert.equal(card.round, 0)
  assert.equal((await list()).inbox.length, 0)
  const detail = () => project({action:'read',taskId})
  assert.deepEqual((await detail()).requirements[0].images, [picture])
  const dispatch = node => project({action:'dispatch',taskId,version:1,node})
  const approve = (node, round, artifact) => project({action:'approve',taskId,version:1,node,round,artifact})
  await assert.rejects(dispatch(2), /predecessor/)
  assert.equal((await dispatch(1)).dispatchRound,1)
  assert.equal((await dispatch(1)).dispatchRound,1)
  const send = (to,round) => host.tool('message_bot',{to,taskId,card_round:round,reply_to:'user',request_id:taskId+'-'+round,message:'Execute the saved node'},'ga')
  await send('Writer',1)
  host.begin('gb')
  const startRound = (round, session) => project({action:'start',round,taskId}, session)
  const submit = (round, session) => project({action:'submit',round,taskId,result:'Verified delivery'}, session)
  await startRound(1,'gb')
  await submit(1,'gb')
  await assert.rejects(dispatch(3), /predecessor/)
  await approve(1,1,'candidate-v1')
  await assert.rejects(approve(1,1,'other'), /different approved artifact/)
  const [review,tester] = await Promise.all([dispatch(2),dispatch(3)])
  assert.notEqual(review.dispatchRound,tester.dispatchRound)
  await send('Reviewer',review.dispatchRound)
  await send('Tester',tester.dispatchRound)
  assert.match(text(host.begin('gd')), /Approved input from node 1, round 1: candidate-v1/)
  assert.match(text(host.begin('gc')), /Approved input from node 1, round 1: candidate-v1/)
  const starts = await Promise.all([startRound(review.dispatchRound,'gd'),startRound(tester.dispatchRound,'gc')])
  assert.deepEqual(starts.map(s => s.execution), [
    { round:review.dispatchRound, version:1, node:2, status:'active' },
    { round:tester.dispatchRound, version:1, node:3, status:'active' },
  ])
  const running = await detail()
  assert.deepEqual(running.plans[0].nodes.map(n=>n.status),['verified','active','active'])
  assert.deepEqual(new Set(running.owners),new Set(['d','c']))
  assert.equal(savedTeam(rt.home).rooms.r1.projectInbox.find(r=>r.id===intakeId).status, 'accepted')
  await assert.rejects(submit(review.dispatchRound,'gc'),/owner/)
  const next = { ...spec, taskId, version:2, reason:'Add mobile verification', nodes:[{...nodes[0],reuseRound:1},nodes[1],{...nodes[2],contextGap:'Need mobile environment'}] }
  await project(next)
  await submit(tester.dispatchRound,'gc')
  await assert.rejects(approve(3,tester.dispatchRound,'old-test'),/current plan/)
  await assert.rejects(dispatch(2),/current plan version/)
  await assert.rejects(project({action:'dispatch', taskId, version:2,node:3}),/context gap/)
  const revised = await detail()
  assert.equal(revised.plans.length,2)
  assert.deepEqual(revised.plans[1].nodes.map(n=>n.status),['verified','ready','blocked'])
  assert.deepEqual((await project({action:'dispatch',taskId,version:2,node:2})).dispatchRound,4)
  host.finish('ga', 'Plan revision saved')
  const extra = host.round('supplement', host.say('Also preserve existing sources'))
  await until(() => extra() !== undefined)
  const supplement = host.begin('ga').source.intakeId
  await project({action:'attach', taskId})
  await project({action:'attach', taskId})
  const afterAttach = savedTeam(rt.home).rooms.r1
  assert.deepEqual(afterAttach.projectCards[taskId].intakes, [intakeId, supplement])
  assert.equal(afterAttach.projectInbox.find(r => r.id === supplement).status, 'attached')
  host.finish('ga', 'Supplement attached')
  const question = host.round('question', host.say('What does a dash mean?'))
  await until(() => question() !== undefined)
  host.begin('ga')
  await project({action:'chat', reason:'A question about the display'})
  assert.equal((await list()).inbox.length, 0)
  assert.equal((await list()).cards.length, 1)
})

test('the Main Bot prepares Git assignments and reserves disjoint files across cards', async t => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'project-branches-')))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (dir, ...args) => execFileSync('git', ['-c','core.hooksPath=/dev/null', '-c','user.name=Fixture',
    '-c','user.email=test@example.invalid','-C',dir,...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim()
  git(repo, 'init', '-b', 'main')
  git(repo, 'commit', '--allow-empty', '-m', 'Initial')
  git(repo, 'branch', 'old')
  const host = await start(t, { ...taskNotice, workDir: repo }, {}, {}, { b: { workDir: repo }, c: { workDir: repo } })
  const project = (args, actor = 'ga') => host.tool('project_task', { roomId: 'r1', ...args }, actor).then(JSON.parse)
  const first = await project({ action: 'branches' })
  assert.equal(first.count, 2)
  await rt.updateRoom('r1', { projectAssistantId: 'c' })
  await assert.rejects(project({ action: 'branches' }), /appointed task assistant/)
  await assert.rejects(project({ action: 'prepare_worktree', workRef: 'unwanted', reason: 'Test' }), /appointed task assistant/)
  assert.equal((await project({ action: 'branches' }, 'gc')).count, 2)
  await rt.updateRoom('r1', { projectAssistantId: null })
  const described = await project({ action: 'describe_branch', workRef: 'old', reason: 'Previous release' })
  assert.equal(described.branches.find(b => b.branch === 'old').purpose, 'Previous release')
  assert.equal(described.branches.find(b => b.branch === 'old').workDir, undefined)
  const prepare = { action: 'prepare_worktree', workRef: 'fix/source', baseRef: 'main', reason: 'Fix source labels' }
  await assert.rejects(project(prepare, 'c'), /Main Bot/)
  await assert.rejects(project({ ...prepare, workRef: '../escape' }), /literal local Git branch/)
  const busy = new DatabaseSync(join(rt.home, 'state', 'rooms', 'id-r1', 'room.sqlite'))
  try {
    busy.exec('BEGIN IMMEDIATE')
    await assert.rejects(project(prepare), /locked|busy/i)
  } finally { busy.close() }
  assert.equal(git(repo, 'branch', '--list', prepare.workRef).includes(prepare.workRef), true)
  assert.equal(savedTeam(rt.home).rooms.r1.projectBranches.some(b => b.branch === prepare.workRef), false)
  const reports = await Promise.all([project(prepare), project(prepare)])
  const feature = reports[0].branches.find(b => b.branch === 'fix/source')
  assert.equal(feature.relation, 'same_tip')
  assert.equal(feature.workDir, reports[1].branches.find(b => b.branch === feature.branch).workDir)
  assert.ok(feature.refAt > 0)
  assert.equal(git(feature.workDir, 'symbolic-ref', '--short', 'HEAD'), feature.branch)
  const intake = async title => {
    const done = host.round(title, host.say(title))
    await until(() => done() !== undefined)
    host.begin('ga')
  }
  await intake('Split work by path')
  const node = (ownerId, paths, mode = 'current') => ({ ownerId, title: 'Edit files', instructions: 'Use your assigned paths',
    acceptance: 'Files verified', deliverable: 'Commit', workspaceReason: mode === 'current' ? 'Files are disjoint.' : 'Independent delivery.', workspaceMode: mode, workRef: mode === 'current' ? 'main' : feature.branch, writePaths: paths })
  const plan = { action: 'plan', title: 'Split work by path', version: 1, acceptance: 'Deliver scoped changes' }
  const unspecified = node('b', ['src'])
  delete unspecified.workspaceMode
  await assert.rejects(project({ ...plan, nodes: [unspecified] }), /Choose workspaceMode/)
  await assert.rejects(project({ ...plan, nodes: [node('b', ['../oops'])] }), /relative files/)
  await assert.rejects(project({ ...plan, nodes: [node('b', ['src']), node('c', ['src/a'])] }), /overlapping write paths/)
  await assert.rejects(project({ ...plan, nodes: [node('b', ['src/a']), node('c', ['src/b'], 'worktree')] }), /same task worktree/)
  const nodes = [node('b', ['src/a'], 'worktree'), node('c', ['src/b'], 'worktree'), node('b', ['src/c'], 'worktree'), node('c', [], 'worktree')]
  const setPolicy = policy => host.call('set-project-workspace-policy', { roomId: 'r1', policy })
  assert.equal((await setPolicy('other')).ok, false)
  const unexplained = { ...nodes[0] }
  delete unexplained.workspaceReason
  await assert.rejects(project({ ...plan, nodes: [unexplained] }), /workspaceReason/)
  assert.equal((await setPolicy('worktree')).ok, true)
  await assert.rejects(project({ ...plan, nodes: [node('b', ['src/a'])] }), /requires workspaceMode=worktree/)
  assert.equal((await setPolicy('auto')).ok, true)
  const { taskId } = await project({ ...plan, nodes })
  assert.equal((await setPolicy('current')).ok, true)
  await assert.rejects(project({ ...prepare, workRef: 'not-created' }), /uses the current branch/)
  assert.equal(git(repo, 'branch', '--list', 'not-created'), '')
  assert.equal((await project({ action: 'list' })).workspacePolicy, 'current')
  assert.equal(savedTeam(rt.home).rooms.r1.projectWorkspacePolicy, 'current')
  const choices = (await host.call('project-task-detail', { roomId: 'r1', taskId, workspaceOnly: true })).value
  assert.equal(choices.policy, 'auto')
  assert.equal(choices.reason, 'Independent delivery.')
  assert.equal(choices.directory, feature.workDir)
  assert.equal(savedTeam(rt.home).rooms.r1.projectCards[taskId].plans[0].workspacePolicy, 'auto')
  assert.equal((await project({ ...plan, nodes })).taskId, taskId)
  const dispatch = (id, n) => project({ action: 'dispatch', version: 1, taskId: id, node: n })
  const rounds = await Promise.all([dispatch(taskId, 1), dispatch(taskId, 2)])
  assert.notEqual(rounds[0].dispatchRound, rounds[1].dispatchRound)
  renameSync(feature.workDir, feature.workDir + '.moved')
  try { await assert.rejects(dispatch(taskId, 3), /working tree is missing/) }
  finally { renameSync(feature.workDir + '.moved', feature.workDir) }
  const isolated = await dispatch(taskId, 3)
  const saved = savedTeam(rt.home).rooms.r1
  assert.equal(saved.projectBranches.find(b => b.branch === feature.branch).purpose, prepare.reason)
  assert.deepEqual(saved.projectCards[taskId].plans[0].nodes.map(n => n.workDir), Array(4).fill(feature.workDir))
  const send = (id, round, to) => host.tool('message_bot', { taskId: id, card_round: round, to, reply_to: 'user',
    request_id: id + '-' + round, message: 'Carry out the assigned node.' }, 'ga')
  await send(taskId, isolated.dispatchRound, 'Writer')
  assert.match(text(host.begin('gb')), /Edit only these files or subtrees/)
  await assert.rejects(project({ action: 'start', taskId, round: isolated.dispatchRound }, 'gb'), /assigned repository and branch/)
  assert.equal(savedTeam(rt.home).rooms.r1.projectCards[taskId].rounds[isolated.dispatchRound - 1].startedAt, undefined)
  host.finish('gb', 'Wrong checkout, waiting for the manager')
  host.agentOf('gb').session.header = { cwd: feature.workDir }
  host.agentOf('gc').session.header = { cwd: feature.workDir }
  await send(taskId, rounds[0].dispatchRound, 'Writer')
  host.begin('gb')
  await project({ action: 'start', taskId, round: rounds[0].dispatchRound }, 'gb')
  await send(taskId, rounds[1].dispatchRound, 'Tester')
  host.begin('gc')
  await project({ action: 'start', taskId, round: rounds[1].dispatchRound }, 'gc')
  const active = await project({ action: 'read', taskId })
  assert.deepEqual(active.plans[0].nodes.slice(0, 2).map(n => n.status), ['active', 'active'])
  const secondDelivery = { action: 'submit', taskId, round: rounds[1].dispatchRound, result: 'Second file ready' }
  await assert.rejects(project(secondDelivery, 'gc'), /full commit ID/)
  const base = git(repo, 'rev-parse', 'main')
  await assert.rejects(project({ ...secondDelivery, commit: base }, 'gc'), /after the start/)
  mkdirSync(join(feature.workDir, 'src'))
  writeFileSync(join(feature.workDir, 'src/b'), 'second file')
  git(feature.workDir, 'add', 'src/b')
  git(feature.workDir, 'commit', '-m', 'Change second file')
  const secondCommit = git(feature.workDir, 'rev-parse', 'HEAD')
  assert.equal(git(repo, 'rev-parse', 'main'), base)
  await project({ ...secondDelivery, commit: secondCommit }, 'gc')
  const receipt = savedTeam(rt.home).rooms.r1.projectCards[taskId].rounds[rounds[1].dispatchRound - 1].mainReview
  assert.deepEqual(receipt, { repository: repo, branch: feature.branch, commit: secondCommit, tip: secondCommit })
  await project({ ...secondDelivery, commit: secondCommit }, 'gc')
  await assert.rejects(project({ ...secondDelivery, commit: base }, 'gc'), /different verified delivery/)
  host.finish('gc', 'Second file ready')
  const readOnly = await dispatch(taskId, 4)
  await send(taskId, readOnly.dispatchRound, 'Tester')
  host.agentOf('gc').session.header = { cwd: feature.workDir }
  host.begin('gc')
  await project({ action: 'start', taskId, round: readOnly.dispatchRound }, 'gc')
  await project({ action: 'submit', taskId, round: readOnly.dispatchRound, result: 'Checked in assigned worktree' }, 'gc')
  host.finish('gc', 'Read completed')
  host.finish('ga', 'Initial plan assigned')
  await intake('Change another label')
  await setPolicy('worktree')
  const next = await project({ ...plan, title: 'Change another label', nodes: [node('c', ['src/a'], 'worktree')] })
  await assert.rejects(dispatch(next.taskId, 1), /overlapping files/)
  const firstDelivery = { action: 'submit', taskId, round: rounds[0].dispatchRound, result: 'Owned file ready' }
  await assert.rejects(project({ ...firstDelivery, commit: secondCommit }, 'gb'), /assigned files/)
  writeFileSync(join(feature.workDir, 'src/a'), 'first file')
  git(feature.workDir, 'add', 'src/a')
  git(feature.workDir, 'commit', '-m', 'Change first file')
  const firstCommit = git(feature.workDir, 'rev-parse', 'HEAD')
  git(repo, 'merge', '--ff-only', feature.branch)
  await project({ ...firstDelivery, commit: firstCommit }, 'gb')
  assert.equal((await dispatch(next.taskId, 1)).dispatchRound, 1)
  git(feature.workDir, 'commit', '--allow-empty', '-m', 'Fix')
  assert.equal((await project({ action: 'branches' })).branches.find(b => b.branch === feature.branch).relation, 'unmerged')
  git(repo, 'merge', '--no-ff', '--no-edit', feature.branch)
  const report = await project({ action: 'branches' })
  assert.equal(report.branches.find(b => b.branch === feature.branch).relation, 'contained')
  assert.ok(report.branches.find(b => b.branch === feature.branch).tasks.some(n => n.taskId === next.taskId && n.ownerId === 'c'))
  const api = (await host.call('project-branches', { roomId: 'r1', repository: repo })).value
  assert.equal(api.count, 3)
  assert.equal(api.branches.find(b => b.branch === feature.branch).lastActivityAt, report.branches.find(b => b.branch === feature.branch).lastActivityAt)
  git(repo, 'branch', '-d', 'old')
  const refreshed = await project({ action: 'branches' })
  assert.equal(refreshed.count, 2)
  assert.equal(refreshed.branches.find(b => b.branch === 'old').removed, true)
})

test('interrupted picture task hands its checkpoint to one successor; a delayed receipt stays with the retired round', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'project-node-recovery-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-C', folder, ...args], { encoding:'utf8',stdio:['ignore','pipe','pipe'] }).trim()
  git('init', '-b', 'main')
  writeFileSync(join(folder,'candidate.txt'),'source verified')
  git('add','candidate.txt')
  git('-c','user.name=Test Fixture','-c','user.email=fixture@example.invalid','commit','-m','Candidate')
  const head = git('rev-parse','HEAD')
  git('tag','candidate-v1')
  const attachments = fakeAttachments()
  const image = await attachments.saveImage({ mediaType:'image/png', width:1, height:1, data:new Uint8Array([1]) })
  const host = await start(t, taskNotice, {attachments}, undefined, { b:{workDir:folder}, c:{workDir:folder} })
  const req = host.say('Check empty and existing request sources')
  req.content.push({type:'image',attachment:image})
  const ended = host.round('intake',req)
  await until(() => ended() !== undefined)
  host.begin('ga')
  const project = (args, actor='ga') => host.tool('project_task', args, actor).then(JSON.parse)
  const {taskId} = await project({action:'plan',version:1,title:'Check source',acceptance:'Both cases pass',nodes:[
    {title:'Check source',ownerId:'b',workDir:folder,workRef:'candidate-v1',instructions:'Run both checks',deliverable:'Test report',acceptance:'Both pass'},
  ]})
  const key={taskId,version:1,node:1}
  const target={...key,round:1,ownerId:'c'}
  await project({...key,action:'dispatch'})
  const send=(to,round)=>host.tool('message_bot',{taskId,to,card_round:round,reply_to:'user',request_id:'dispatch-'+round,message:'Execute the node.'},'ga')
  await send('Writer',1)
  const original=host.begin('gb')
  await project({...key,action:'start',round:1},'gb')
  await project({...key,action:'checkpoint',round:1,artifact:'candidate-v1',completed:'Empty source passed',remaining:'Check an existing source'},'gb')
  host.emit('gb','turn/end',{turn:1,reason:{kind:'aborted',reason:{kind:'user'}}})
  const stored=()=>savedTeam(rt.home).rooms.r1.projectCards[taskId]
  await until(()=>stored().rounds[0].planNode.block?.cause==='interrupted')
  await project({...target,action:'wait',reason:'Environment under repair',waitingFor:'Lab is online'})
  const inspect=()=>project({...target,action:'inspect_recovery'})
  host.agentOf('gb').status='running'
  const busy=await inspect()
  assert.equal(busy.writerStopped,false)
  const recover={...target,action:'takeover',reason:'Lab restored; alternate tester available',eligibility:'Same lab access',worktreeReview:'Changes reviewed with the original owner',artifact:'candidate-v1',expectedCommit:head}
  await assert.rejects(project({...recover,inspection:busy.inspection}),/stopped execution|execution or candidate/)
  host.agentOf('gb').status='idle'
  const initial=await inspect()
  writeFileSync(join(folder,'notes.txt'),'Keep this handoff note')
  await assert.rejects(project({...recover,inspection:initial.inspection}),/worktrees/)
  const dirty = await inspect()
  writeFileSync(join(folder, 'notes.txt'), 'The same dirty file now has different handoff notes')
  await assert.rejects(project({...recover, inspection:dirty.inspection}), /worktrees/)
  const inspected=await inspect()
  assert.match(inspected.sourceTree.changes,/notes.txt/)
  await assert.rejects(project({...recover,inspection:inspected.inspection,expectedCommit:'bad'}),/commit/)
  const decision={...recover,inspection:inspected.inspection}
  const [first,replay]=await Promise.all([project(decision),project(decision)])
  assert.equal(first.dispatchRound,2)
  assert.equal(replay.dispatchRound,2)
  await assert.rejects(project({...decision,artifact:'another artifact'}),/different recovery/)
  await assert.rejects(send('Writer',1),/current round/)
  await send('Tester',2)
  const packet=host.begin('gc')
  assert.deepEqual(packet.content.find(b=>b.type==='image').attachment,image)
  assert.match(text(packet),/Remaining checks: Check an existing source/)
  assert.match(text(packet),/Completed checks: Empty source passed/)
  assert.match(text(packet),new RegExp(head))
  assert.doesNotMatch(text(packet), /\nworkDir:|\nworkRef:/)
  await project({...key,action:'start',round:2},'gc')
  // Deliver the old executor's exact original exchange, after the new owner started.
  assert.equal(host.begin('gb').source.exchangeId,original.source.exchangeId)
  const late=await project({...key,action:'submit',round:1,result:'Old delayed report'},'gb')
  assert.equal(late.advanced,false)
  await assert.rejects(project({...key,action:'submit',round:2,result:'Wrong exchange'},'gb'),/owner/)
  await assert.rejects(project({...key,action:'approve',round:1,artifact:'stale'}),/current plan/)
  assert.equal(stored().rounds[0].planNode.lateResult,'Old delayed report')
  assert.equal(stored().rounds[1].result,undefined)
  await project({...key,action:'submit',round:2,result:'Existing source passed'},'gc')
  assert.equal((await project({action:'read',taskId})).status,'done')
  const card=stored()
  assert.deepEqual(card.rounds[0].planNode.block.decisions.map(d=>d.action),['wait','takeover'])
  assert.equal(card.rounds[1].planNode.previousRound,1)
  assert.equal(card.rounds[1].planNode.artifact,'Existing source passed')
})

test('same-owner recovery keeps its checkpoint through another interruption and enforces the designated tester', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'node-resume-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const host = await start(t, taskNotice, {}, undefined, { b: { workDir: dir } })
  const received = host.round('intake', host.say('Only Writer may verify this report'))
  await until(() => received() !== undefined)
  host.begin('ga')
  const project = (args, actor = 'ga') => host.tool('project_task', args, actor).then(JSON.parse)
  const { taskId } = await project({ action: 'plan', title: 'Check report', version: 1, acceptance: 'Both steps', nodes: [
    { title: 'Check report', ownerId: 'b', fixedOwner: true, instructions: 'Check two items', deliverable: 'Report', acceptance: 'Both pass' },
  ] })
  const key = { taskId, version: 1, node: 1 }
  await project({ ...key, action: 'dispatch' })
  await host.tool('message_bot', { to: 'Writer', taskId, card_round: 1, reply_to: 'user', request_id: 'first', message: 'Check' }, 'ga')
  host.begin('gb')
  await project({ ...key, round: 1, action: 'start' }, 'gb')
  await project({ ...key, round: 1, action: 'checkpoint', artifact: 'report-v1', completed: 'Item one passed', remaining: 'Check item two' }, 'gb')
  await project({ ...key, round: 1, action: 'block', reason: 'Test service unavailable', waitingFor: 'Service online', evidence: 'Service health returned 503' }, 'gb')
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  await assert.rejects(project({ ...key, round: 1, action: 'inspect_recovery', ownerId: 'c' }), /designated owner/)
  const inspect = round => project({ ...key, round, ownerId: 'b', action: 'inspect_recovery' })
  host.agentOf('gb').status = 'idle'
  const first = await inspect(1)
  assert.equal(first.writerStopped, true)
  const resumed = await project({ ...key, round: 1, ownerId: 'b', action: 'resume', artifact: 'report-v1',
    eligibility: 'Designated tester', reason: 'Service is online', worktreeReview: 'Verified report directory', inspection: first.inspection })
  assert.equal(resumed.dispatchRound, 2)
  await host.tool('message_bot', { to: 'Writer', taskId, card_round: 2, reply_to: 'user', request_id: 'second', message: 'Continue' }, 'ga')
  host.begin('gb')
  await project({ ...key, round: 2, action: 'start' }, 'gb')
  await project({ ...key, round: 2, action: 'block', reason: 'Test service stopped again', waitingFor: 'Recovery', evidence: 'Health probe timed out' }, 'gb')
  const next = await inspect(2)
  assert.equal(next.completed, 'Item one passed')
  assert.equal(next.remaining, 'Check item two')
  assert.equal(next.checkpointArtifact, 'report-v1')
})

test('an intake has one phase through pickup, scoped clarification, dispatch and optional final acceptance', async t => {
  const host = await start(t, taskNotice)
  const project = (args, session = 'ga') => host.tool('project_task', args, session).then(JSON.parse)
  const room = () => rt.roomOf('r1')
  const opened = host.round('request', host.say('Review the task lifecycle'))
  await until(() => opened() !== undefined)
  assert.equal(room().projectInbox[0].status, 'pending')
  host.begin('ga')
  await until(() => room().projectInbox[0].status === 'planning')
  assert.ok(room().projectInbox[0].planningAt >= room().projectInbox[0].receivedAt)
  const spec = { action: 'plan', version: 1, title: 'Lifecycle', humanAcceptanceRequired: true, acceptance: 'Verified', nodes: [
    { title: 'Prepare', ownerId: 'b', instructions: 'Inspect', deliverable: 'Receipt', acceptance: 'Checked' },
  ] }
  await assert.rejects(project({ ...spec, nodes: [{ ...spec.nodes[0], ownerId: 'a' }] }), /other than/)
  assert.equal(room().projectInbox[0].status, 'planning')
  const card = await project(spec), taskId = card.taskId
  const detail = () => project({ action: 'read', taskId })
  assert.equal(card.status, 'dispatching')
  assert.equal(card.humanAcceptanceRequired, false)
  await host.call('set-task-human-acceptance', { roomId: 'r1', taskId, required: true })
  assert.equal((await project({ action: 'dispatch', taskId, version: 1, node: 1 })).status, 'dispatching')
  await host.tool('message_bot', { to: 'Writer', taskId, card_round: 1, request_id: 'lifecycle', message: 'Inspect', reply_to: 'user' }, 'ga')
  host.begin('gb')
  assert.equal((await detail()).status, 'dispatching')
  assert.equal((await project({ action: 'start', taskId, round: 1 }, 'gb')).status, 'active')
  const guidance = await host.tool('ask_user', { question: 'Which edition?', options: [{ label: 'First' }] }, 'gb')
  assert.match(guidance, /project_task clarify/)
  await project({ action: 'clarify', taskId, reason: 'Which edition?' }, 'gb')
  assert.equal((await detail()).status, 'clarify')
  const edition = host.round('edition', host.say('First edition', taskId))
  await until(() => edition() !== undefined)
  assert.equal((await detail()).status, 'active')
  assert.equal((await project({ action: 'submit', taskId, round: 1, result: 'First edition verified' }, 'gb')).status, 'human_review')
  assert.equal((await project({ action: 'clarify', taskId, reason: 'Which final environment?' })).status, 'clarify')
  const response = host.round('clarification', host.say('Staging', taskId))
  await until(() => response() !== undefined)
  assert.equal((await detail()).status, 'human_review')
  room().projectCards[cardB] = { id: cardB, parentTaskId: taskId, plans: [], rounds: [], intakes: [] }
  const approval = { taskId, version: 1, node: 1, round: 1, artifact: 'First edition verified' }
  assert.equal((await project({ ...approval, action: 'request_acceptance' })).status, 'human_review')
  await assert.rejects(project({ ...approval, action: 'approve' }), /human decision/)
  assert.equal((await host.call('project-task-detail', { roomId: 'r1', taskId: cardB })).value.status, 'planning')
  const reviewId = (await detail()).humanReview.id
  const decide = (payload) => host.call('project-acceptance', { roomId: 'r1', taskId, reviewId, ...payload })
  assert.equal((await decide({ decision: 'approve', reviewId: 'stale' })).ok, false)
  assert.equal((await decide({ decision: 'approve' })).ok, true)
  assert.equal((await decide({ decision: 'approve' })).ok, true)
  assert.equal((await decide({ decision: 'return', feedback: 'obsolete' })).ok, false)
  assert.equal((await detail()).status, 'done')
  const db = new DatabaseSync(join(rt.home, 'state', 'rooms', 'id-r1', 'room.sqlite'), { readOnly: true })
  try {
    assert.equal(db.prepare('SELECT status FROM tasks WHERE task_id=?').get(taskId).status, 'done')
    assert.equal(db.prepare('SELECT status FROM tasks WHERE task_id=?').get(cardB).status, 'done')
    const intake = db.prepare('SELECT received_at, planning_at FROM project_inbox').get()
    assert.equal(intake.planning_at, room().projectInbox[0].planningAt)
  } finally { db.close() }
})

test('loading a submitted plan finishes ordinary work and opens one decision for explicit sign-off', async t => {
  const nodes = [{ no: 1, ownerId: 'b', title: 'Plan', instructions: 'Prepare', acceptance: 'Checked', deliverable: 'Plan', dependsOn: [] }]
  const card = { id: cardA, title: 'Plan', intakes: [], humanAcceptanceRequired: true, plans: [{ version: 1, by: 'a', at: 1, nodes }],
    rounds: [{ ownerId: 'b', startedAt: 1, submittedAt: 2, result: 'Planning document', planNode: { version: 1, node: 1, inputs: [] } }] }
  const host = await start(t, { ...taskNotice, projectCards: { [cardA]: card, [cardB]: { ...structuredClone(card), id: cardB, humanAcceptanceRequired: false } } })
  const read = async taskId => (await host.call('project-task-detail', { roomId: 'r1', taskId })).value
  const planning = await read(cardA)
  assert.equal(planning.status, 'human_review')
  assert.equal(planning.acceptanceRequest.artifact, 'Planning document')
  assert.equal((await read(cardB)).status, 'done')
  assert.equal((await host.call('project-acceptance', { roomId: 'r1', taskId: cardA, reviewId: planning.acceptanceRequest.id, decision: 'approve' })).ok, true)
  assert.equal((await read(cardA)).status, 'done')
})

test('withdrawing final sign-off completes the plan independently of its follow-up', async t => {
  const node = { no: 1, ownerId: 'b', title: 'Plan', instructions: 'Prepare', acceptance: 'Checked', deliverable: 'Plan', dependsOn: [] }
  const card = { id: cardA, title: 'Plan', intakes: [], humanAcceptanceRequired: true, plans: [{ version: 1, by: 'a', at: 1, nodes: [node] }],
    rounds: [{ ownerId: 'b', startedAt: 1, submittedAt: 2, result: 'Planning document', planNode: { version: 1, node: 1, inputs: [] } }] }
  const host = await start(t, { ...taskNotice, projectCards: { [cardA]: card, [cardB]: { id: cardB, plans: [], rounds: [], intakes: [] } } })
  const call = (name, args) => host.call(name, { roomId: 'r1', ...args })
  assert.equal((await call('set-task-predecessor', { taskId: cardB, followsTaskId: cardA })).ok, true)
  assert.equal((await call('set-task-predecessor', { taskId: cardA, followsTaskId: cardB })).ok, false)
  assert.equal((await call('set-task-human-acceptance', { taskId: cardA, required: false })).ok, true)
  const { tasks } = (await call('project-task-list', {})).value
  assert.equal(tasks.find(t => t.taskId === cardA).status, 'done')
  const next = tasks.find(t => t.taskId === cardB)
  assert.equal(next.followsTaskId, cardA)
  assert.equal(next.status, 'planning')
})

test('loading a completed primary task closes existing descendants and preserves completion after deleting it', async t => {
  const node = { no: 1, ownerId: 'b', title: 'Fix arrow', instructions: 'Update arrow', deliverable: 'Arrow', acceptance: 'Verified', dependsOn: [] }
  const parent = { id: cardA, plans: [{ version: 1, by: 'a', at: 1, nodes: [node] }],
    rounds: [{ ownerId: 'b', result: 'verified', planNode: { version: 1, node: 1, acceptedAt: 2, acceptedBy: 'a', artifact: 'Arrow', inputs: [] } }] }
  const child = { id: cardB, parentTaskId: cardA, plans: [], rounds: [] }
  const host = await start(t, { ...taskNotice, projectCards: { grandchild: { ...child, id: 'grandchild', parentTaskId: cardB },
    [cardB]: child, [cardA]: parent, other: { id: 'other', plans: [], rounds: [], intakes: [] } } })
  const read = async taskId => (await host.call('project-task-detail', { roomId: 'r1', taskId })).value
  assert.equal((await read('grandchild')).status, 'done')
  assert.equal((await read('other')).status, 'planning')
  const related = JSON.parse(await host.tool('project_task', { action: 'relate', roomId: 'r1', taskId: 'other', parentTaskId: cardA }, 'ga'))
  assert.equal(related.status, 'done')
  assert.equal((await host.call('task-delete', { roomId: 'r1', items: [{ kind: 'project', id: cardA }] })).ok, true)
  const remaining = await read(cardB)
  assert.equal(remaining.parentTaskId, undefined)
  assert.equal(remaining.status, 'done')
  assert.deepEqual(remaining.rounds, [])
})

test('returned acceptance goes to the manager and an old request cannot approve the revision', async t => {
  const node = { no: 1, ownerId: 'b', title: 'Build', instructions: 'Build', acceptance: 'Checked', deliverable: 'Product', dependsOn: [] }
  const planned = { id: cardA, title: 'Card', acceptance: 'Checked', intakes: [], plans: [{ version: 1, by: 'a', at: 1, nodes: [node] }],
    rounds: [{ ownerId: 'b', startedAt: 1, result: 'candidate', submittedAt: 2, planNode: { version: 1, node: 1, inputs: [] } }] }
  const host = await start(t, { ...taskNotice, projectCards: { [cardA]: planned, [cardB]: { ...structuredClone(planned), id: cardB } } })
  rt.ledger.append('group-r1', { who: 'User', seq: 1, time: 1, taskId: cardA, text: 'Build and submit the product for final acceptance.' })
  const project = args => host.tool('project_task', { taskId: cardA, ...args }, 'ga').then(JSON.parse)
  const read = () => project({ action: 'read' })
  const approve = { version: 1, node: 1, round: 1, artifact: 'candidate' }
  assert.equal((await project({ action: 'approve', ...approve, taskId: cardB })).status, 'done')
  await host.call('set-task-human-acceptance', { roomId: 'r1', taskId: cardA, required: true })
  await project({ action: 'request_acceptance', ...approve })
  const reviewId = (await read()).humanReview.id
  const decision = { roomId: 'r1', taskId: cardA, reviewId, decision: 'return', feedback: 'Cover the empty case' }
  assert.equal((await host.call('project-acceptance', decision)).ok, true)
  assert.equal((await host.call('project-acceptance', decision)).ok, true)
  assert.equal(host.agentOf('ga').calls.filter(m => m.source.taskId === cardA).length, 1)
  assert.equal((await read()).status, 'planning')
  await assert.rejects(project({ action: 'approve', ...approve }), /returned work/)
  const { no, ...revisionNode } = node
  assert.equal(no, 1)
  assert.equal((await project({ action: 'plan', version: 2, nodes: [revisionNode], reason: 'Handle feedback' })).status, 'dispatching')
  assert.equal((await host.call('project-acceptance', { ...decision, decision: 'approve' })).ok, false)
  await project({ action: 'dispatch', version: 2, node: 1 })
  await host.tool('message_bot', { to: 'Writer', taskId: cardA, card_round: 2, request_id: 'fix-review', message: 'Cover the empty case', reply_to: 'user' }, 'ga')
  host.begin('gb')
  await host.tool('project_task', { action: 'start', taskId: cardA, round: 2 }, 'gb')
  await host.tool('project_task', { action: 'submit', taskId: cardA, round: 2, result: 'Empty case passes' }, 'gb')
  const revised = { version: 2, node: 1, round: 2, artifact: 'fixed candidate' }
  await assert.rejects(project({ action: 'approve', ...revised }), /human decision/)
  const request = await read()
  assert.notEqual(request.acceptanceRequest.id, reviewId)
  assert.equal((await host.call('project-acceptance', { ...decision, decision: 'approve', reviewId: request.acceptanceRequest.id })).ok, true)
  assert.equal((await read()).status, 'done')
})

test('a task checkout selection binds future dispatches and preserves already dispatched work', async t => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'task-checkout-')))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c',
    'user.email=test@example.invalid', '-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main')
  git('commit', '--allow-empty', '-m', 'Base')
  git('branch', 'topic')
  const host = await start(t, { ...taskNotice, workDir: repo }, {}, {}, { b: { workDir: repo }, c: { workDir: repo } })
  const project = (args, actor = 'ga') => host.tool('project_task', { roomId: 'r1', ...args }, actor).then(JSON.parse)
  await project({ action: 'branches' })
  const intake = host.round('start', host.say('Implement a feature in three steps'))
  await until(() => intake() !== undefined)
  host.begin('ga')
  const nodes = ['one', 'two', 'three'].map((name, i) => ({ ownerId: i === 1 ? 'c' : 'b', title: name, deliverable: 'Commit',
    instructions: 'Edit ' + name, acceptance: 'Tests pass', workspaceMode: 'current', workspaceReason: 'Use the project checkout',
    workRef: 'main', writePaths: [name] }))
  const { taskId } = await project({ action: 'plan', version: 1, title: 'Feature', acceptance: 'Verified', workspaceMode: 'current', workRef: 'main', workspaceReason: 'Use the project checkout',
    nodes: nodes.map(({ workspaceMode, workRef, workspaceReason, ...step }) => step) })
  const target = { roomId: 'r1', taskId }
  const pick = (previous, selection) => host.call('select-task-workspace', { ...target, previous, selection })
  const view = () => host.call('project-task-detail', { ...target, workspaceChoices: true }).then(r => r.value)
  const dispatch = node => project({ action: 'dispatch', taskId, version: 1, node })
  await dispatch(1)
  const before = await view()
  const main = before.choices.find(row => row.workRef === 'main')
  const topic = before.choices.find(row => row.workRef === 'topic')
  assert.equal(topic.workDir, null)
  assert.equal(before.effective.workRef, 'main')
  assert.match((await pick(null, topic)).error.message, /Finish the dispatched work/)
  await host.tool('message_bot', { taskId, card_round: 1, to: 'Writer', reply_to: 'user', request_id: 'first-tree', message: 'Do step one.' }, 'ga')
  host.begin('gb')
  await project({ action: 'start', taskId, round: 1 }, 'gb')
  writeFileSync(join(repo, 'one'), 'first')
  git('add', 'one')
  git('commit', '-m', 'Complete step one')
  await project({ action: 'submit', taskId, round: 1, result: 'First step ready', commit: git('rev-parse', 'HEAD') }, 'gb')
  const selected = await pick(null, topic)
  assert.equal(selected.ok, true, selected.error?.message)
  const tree = selected.value
  assert.deepEqual((await pick(null, topic)).value, tree)
  assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main')
  assert.equal(git('-C', tree.workDir, 'symbolic-ref', '--short', 'HEAD'), 'topic')
  assert.equal((await pick(null, main)).ok, false)
  assert.equal((await view()).selected.workDir, tree.workDir)
  const second = await dispatch(2)
  assert.equal((await pick(tree, main)).ok, false)
  const decisions = (await host.call('project-task-detail', { ...target, workspaceOnly: true })).value
  assert.equal(decisions.policy, 'auto')
  assert.equal(decisions.userSelected, true)
  assert.equal(decisions.directory, tree.workDir)
  const read = await project({ action: 'read', taskId })
  assert.deepEqual(read.plans[0].nodes.map(n => n.workRef), ['main', 'topic', 'topic'])
  assert.deepEqual(savedTeam(rt.home).rooms.r1.projectCards[taskId].rounds[second.dispatchRound - 1].workspace, tree)
  await host.tool('message_bot', { taskId, card_round: second.dispatchRound, to: 'Tester', reply_to: 'user',
    request_id: 'selected-tree', message: 'Continue the assigned work.' }, 'ga')
  assert.ok(text(host.begin('gc')).includes('workDir: ' + tree.workDir))
  host.agentOf('gc').session.header = { cwd: tree.workDir }
  await project({ action: 'start', taskId, round: second.dispatchRound }, 'gc')
  writeFileSync(join(tree.workDir, 'two'), 'second')
  git('-C', tree.workDir, 'add', 'two')
  git('-C', tree.workDir, 'commit', '-m', 'Complete step two')
  git('merge', '--no-edit', 'topic')
  await project({ action: 'submit', taskId, round: second.dispatchRound, result: 'Second step ready', commit: git('rev-parse', 'topic') }, 'gc')
  const clear = await pick(tree, null)
  assert.equal(clear.ok, true)
  assert.equal((await view()).selected, null)
  git('worktree', 'remove', tree.workDir)
  assert.equal((await pick(null, tree)).ok, false)
  assert.equal((await host.call('set-project-workspace-policy', { roomId: 'r1', policy: 'current' })).ok, true)
  assert.deepEqual((await view()).choices.map(row => row.workRef), ['main'])
  assert.equal((await pick(null, topic)).ok, false)
})

test('a legacy task uses one dispatched checkout for pending steps, even if the plan omitted its branch', async t => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-task-tree-')))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', '-C', repo, ...args], { stdio: 'pipe' })
  const workDir = join(repo, '.worktrees', 'topic')
  git('init', '-b', 'main')
  git('commit', '--allow-empty', '-m', 'Base')
  git('worktree', 'add', '-b', 'topic', workDir)
  const taskId = '40acd6d2-a4b4-4751-90ca-38bde788c871'
  const step = (no, dir, branch) => ({ no, ownerId: 'b', title: 'Step ' + no, instructions: 'Check', dependsOn: [],
    acceptance: 'Pass', deliverable: 'Result', workDir: dir, ...(branch && { workRef: branch }) })
  const card = { id: taskId, title: 'Legacy card', acceptance: 'Verified', intakes: [], plans: [{ version: 1, by: 'a', at: 1,
    nodes: [step(1, workDir), step(2, workDir), step(3, repo, 'main')] }],
    rounds: [{ assignedAt: 2, ownerId: 'b', plan: 'Check', dispatchId: 'legacy-first', planNode: { version: 1, node: 1, inputs: [], workDir } }] }
  const host = await start(t, { ...taskNotice, workDir: repo, projectCards: { [taskId]: card } })
  const target = { roomId: 'r1', taskId }
  const view = () => host.call('project-task-detail', { ...target, workspaceChoices: true }).then(r => r.value)
  const restored = await view()
  assert.equal(restored.effective.workRef, 'topic')
  assert.equal(restored.effective.workDir, workDir)
  assert.equal(restored.available, true)
  assert.equal(restored.assigned, undefined)
  const detail = JSON.parse(await host.tool('project_task', { ...target, action: 'read' }, 'ga'))
  assert.equal(detail.taskWorkspace.workRef, 'topic')
  assert.equal(detail.plans[0].nodes[2].workDir, workDir)
  renameSync(workDir, workDir + '.moved')
  try {
    const unavailable = await view()
    assert.equal(unavailable.effective.workDir, workDir)
    assert.equal(unavailable.available, false)
    await assert.rejects(host.tool('project_task', { ...target, action: 'dispatch', version: 1, node: 3 }, 'ga'), /task worktree is unavailable/)
  } finally { renameSync(workDir + '.moved', workDir) }
  await host.tool('project_task', { ...target, action: 'dispatch', version: 1, node: 3 }, 'ga')
  const saved = savedTeam(rt.home).rooms.r1.projectCards[taskId]
  assert.deepEqual(saved.plannedWorkspace, restored.effective)
  assert.deepEqual(saved.rounds[1].workspace, restored.effective)
  assert.equal(saved.plans[0].nodes[2].workRef, 'main')
})

test('accepted work, plan controls and group task diagnostics share the durable card', async t => {
  const host = await start(t, { taskManagementEnabled: true }, undefined, undefined, { d: {} })
  const project = (args, session = 'ga') => host.tool('project_task', args, session).then(JSON.parse)
  await assert.rejects(project({ action: 'list' }, 'b'), { code: 'GROUP_CONTEXT_REQUIRED' })
  await assert.rejects(project({ action: 'list', roomId: 'r1' }, 'd'), { code: 'NOT_GROUP_MEMBER' })
  await assert.rejects(project({ action: 'list', roomId: 'other' }), { code: 'GROUP_CONTEXT_MISMATCH' })
  const sent = host.round('work', host.say('Inspect the site without changing it'))
  await until(() => sent() !== undefined)
  host.begin('ga')
  await assert.rejects(project({ action: 'reply', acceptWork: true, message: 'OK' }), /verifiable outcome/)
  assert.equal(Object.keys(rt.roomOf('r1').projectCards ?? {}).length, 0)
  await project({ action: 'reply', message: 'I will check the site.', acceptWork: true, classificationReason: 'Read-only investigation' })
  const [card] = Object.values(rt.roomOf('r1').projectCards)
  assert.equal(card.classificationReason, 'Read-only investigation')
  const key = { roomId: 'r1', taskId: card.id }
  const edit = { ...key, node: 1, version: 1, field: 'fixedOwner', value: true }
  const plan = await project({ action: 'plan', version: 1, title: 'Inspect site', acceptance: 'Record evidence',
    nodes: [{ ownerId: 'b', title: 'Inspect', instructions: 'Read the page', deliverable: 'Notes', acceptance: 'Evidence' }] })
  assert.equal(plan.taskId, card.id)
  assert.equal((await host.call('set-task-node-constraint', edit)).ok, true)
  assert.equal((await host.call('set-task-node-constraint', edit)).ok, false)
  assert.equal((await host.call('set-task-human-acceptance', { ...key, required: true })).ok, true)
  const durable = savedTeam(rt.home).rooms.r1.projectCards[card.id]
  assert.equal(durable.plans.at(-1).nodes[0].fixedOwner, 1)
  assert.equal(durable.humanAcceptanceRequired, true)
  await project({ action: 'dispatch', taskId: card.id, version: 2, node: 1 })
  assert.equal((await host.call('set-task-node-constraint', { ...edit, version: 2, value: false })).ok, false)
  await assert.rejects(project({ action: 'dispatch', ...key }, 'gb'), { code: 'TASK_ROLE_REQUIRED' })
  await rt.updateRoom('r1', { projectAssistantId: 'c' })
  await rt.updateRoom('r1', { remove: ['c'] })
  await assert.rejects(project({ action: 'dispatch', ...key }), { code: 'TASK_ASSISTANT_INVALID' })
  await rt.updateRoom('r1', { taskManagementEnabled: false })
  await assert.rejects(project({ action: 'dispatch', ...key }), { code: 'TASK_MANAGEMENT_DISABLED' })
  assert.equal((await project({ action: 'read', ...key })).taskId, card.id)
})

test('an explicit group skip is distinguishable from a literal PASS message and records the called member', async t => {
  const host = await start(t, { taskManagementEnabled: true })
  for (const [index, skip] of [true, false].entries()) {
    const round = host.round('turn-' + index, host.say('@Writer Check this'))
    await settle(() => host.agentOf('gb').calls.length === index + 1)
    host.begin('gb')
    if (skip) await host.tool('skip_group_turn', {}, 'gb')
    host.finish('gb', skip ? '' : '[PASS]')
    await settle(() => round() !== undefined)
    assert.deepEqual(round().replies.map(row => row.kind ?? row.text), [skip ? 'skipped' : '[PASS]'])
    assert.deepEqual(rt.ledger.records('group-r1').findLast(row => row.event === 'round').calledIds, ['b'])
    assert.equal(Object.keys(rt.roomOf('r1').projectCards ?? {}).length, 0)
  }
})

test('legacy assistant migration respects explicit settings and never reinterprets later notices', async t => {
  const legacy = { taskManagementEnabled: undefined, notice: 'Project goals\n[taskAssistant:Tester]' }
  const host = await start(t, legacy)
  const room = rt.roomOf('r1')
  assert.equal(room.projectAssistantId, 'c')
  assert.equal(room.notice, legacy.notice)
  await rt.updateRoom(room.id, { notice: '', taskManagementEnabled: false })
  await rt.updateRoom(room.id, { notice: '[taskId]\n[taskAssistant:Writer]' })
  const stored = savedTeam(host.home).rooms.r1
  assert.equal(stored.projectAssistantId, 'c')
  assert.equal(stored.taskManagementEnabled, false)
  assert.equal(Object.keys(stored.projectCards ?? {}).length, 0)
})

test('a delegated feature candidate returns with feedback then integrates the retested commit into dev', async t => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'project-tested-dev-')))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (dir, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture',
    '-c', 'user.email=test@example.invalid', '-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(repo, 'init', '-b', 'dev')
  git(repo, 'commit', '--allow-empty', '-m', 'Initial')
  const host = await start(t, { ...taskNotice, workDir: repo, projectAssistantId: 'd', members: ['a', 'b', 'c', 'd'],
    sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } }, {}, {}, { b: { workDir: repo }, c: { workDir: repo }, d: { workDir: repo } })
  const request = host.round('arrow', host.say('Add a collapse arrow to the members section'))
  await until(() => request() !== undefined)
  host.begin('ga')
  const act = (who, args) => host.tool('project_task', args, who).then(JSON.parse)
  const response = await act('ga', { action: 'reply', acceptWork: true, message: 'We will check the members toggle.',
    plan: 'Add the members arrow', acceptance: 'Click and keyboard toggle; integrate into dev.' })
  assert.equal(response.delegated, true)
  host.begin('gd')
  const manager = args => act('gd', args)
  const branch = 'feat/members-arrow'
  const inventory = await manager({ action: 'prepare_worktree', workRef: branch, baseRef: 'dev', reason: 'Feature candidate' })
  const dir = inventory.branches.find(b => b.branch === branch).workDir
  const nodes = [
    { ownerId: 'b', title: 'Develop', instructions: 'Implement the toggle', acceptance: 'Build passes', deliverable: 'Candidate', writePaths: ['toggle.js'] },
    { ownerId: 'c', title: 'Test and integrate', instructions: 'Test click and keyboard', acceptance: 'Tested commit on dev',
      deliverable: 'Report and dev receipt', independentReview: true, writePaths: [], dependsOn: [1], mergeToDev: true },
  ]
  const plan = { action: 'plan', workspaceMode: 'worktree', workRef: branch, workspaceReason: 'Test one candidate', title: 'Members arrow',
    acceptance: 'Toggle works on dev', version: 1, nodes }
  await assert.rejects(manager(plan), /Keep feature validation on the feature branch/)
  const { taskId } = await manager({ ...plan, nodes: [nodes[0], { ...nodes[1], mergeToDev: false }] })
  const dispatch = async (version, node, name, session) => {
    const { dispatchRound: round } = await manager({ action: 'dispatch', taskId, version, node })
    await host.tool('message_bot', { taskId, card_round: round, to: name, request_id: 'arrow-' + round, reply_to: 'user', message: 'Execute node.' }, 'gd')
    host.agentOf(session).session.header = { cwd: dir }
    host.begin(session)
    await act(session, { action: 'start', taskId, round })
    return round
  }
  const approve = (version, node, round, artifact) => manager({ action: 'approve', taskId, version, node, round, artifact })
  const baseline = git(repo, 'rev-parse', 'dev')
  for (const version of [1, 2]) {
    const round = await dispatch(version, 1, 'Writer', 'gb')
    writeFileSync(join(dir, 'toggle.js'), version === 1 ? 'click' : 'click and keyboard')
    git(dir, 'add', 'toggle.js')
    git(dir, 'commit', '-m', 'Members arrow ' + version)
    const commit = git(dir, 'rev-parse', 'HEAD')
    await act('gb', { action: 'submit', taskId, round, commit, result: 'Self-tested feature candidate' })
    host.finish('gb', 'Candidate ready')
    host.begin('gd')
    await approve(version, 1, round, commit)
    const testRound = await dispatch(version, 2, 'Tester', 'gc')
    if (version === 1) {
      const reject = { action: 'return_for_changes', taskId, round: testRound, evidence: 'Space does not toggle the list' }
      await assert.rejects(act('gc', reject), /corrective feedback/)
      const feedback = 'Handle Space on the focused toggle.'
      await act('gc', { ...reject, feedback })
      assert.equal(git(repo, 'rev-parse', 'dev'), baseline)
      assert.match(text(host.begin('gd')), /Handle Space/)
      assert.equal(savedTeam(rt.home).rooms.r1.projectCards[taskId].rounds[testRound - 1].planNode.feedback, feedback)
      host.finish('gc', feedback)
      // An already persisted integration plan from the previous version can finish its receipt workflow.
      await assert.rejects(manager({ ...plan, taskId, version: 2, reason: feedback }), /arrange integration separately/)
      rt.roomOf('r1').projectCards[taskId].plans[0].nodes[1].mergeToDev = 1
      await manager({ ...plan, taskId, version: 2, reason: feedback, nodes: [{ ...nodes[0], instructions: feedback }, nodes[1], { ...nodes[0], title: 'Archive report', writePaths: ['report'], dependsOn: [2] }] })
    } else {
      const submit = { action: 'submit', taskId, round: testRound, commit, result: 'Click and keyboard pass' }
      await assert.rejects(act('gc', { ...submit, commit: baseline }), /exact independently tested/)
      const receipt = { action: 'record_merge', taskId, round: testRound, commit, mergeCommit: commit }
      await assert.rejects(act('gc', receipt), /outside local branch dev/)
      assert.equal((await host.call('set-task-integration-finish', { roomId: 'r1', taskId, version, node: 2 })).ok, true)
      assert.equal((await manager({ action: 'read', taskId })).plans.at(-1).nodes[2].status, 'omitted')
      git(repo, 'merge', '--ff-only', commit)
      await assert.rejects(act('gc', submit), /record_merge/)
      await act('gc', receipt)
      const calls = host.agentOf('gd').calls.length
      await act('gc', receipt)
      assert.equal(host.agentOf('gd').calls.length, calls)
      assert.match(text(host.begin('gd')), /Merged into dev, validating/)
      assert.equal((await manager({ action: 'read', taskId })).validatingMerge.mergeCommit, commit)
      await assert.rejects(act('gc', { ...submit, testedCommit: baseline }), /must contain the candidate/)
      git(repo, 'commit', '--allow-empty', '-m', 'Unrelated follow-up on dev')
      await act('gc', { ...submit, testedCommit: commit })
      host.begin('gd')
      assert.equal((await manager({ action: 'read', taskId })).status, 'done')
      const integrated = savedTeam(rt.home).rooms.r1.projectCards[taskId].rounds[testRound - 1].integration
      assert.equal(integrated.testedCommit, commit)
      assert.equal(integrated.tip, git(repo, 'rev-parse', 'dev'))
      // A historical writer keeps its files until its exact clean candidate has
      // been integrated, the test accepted and its own execution stopped.
      const card = structuredClone(rt.roomOf('r1').projectCards[taskId])
      const feature = card.rounds[round - 1]
      const history = { ...feature, result: undefined, dispatchId: 'old-writer', planNode: { ...feature.planNode,
        version: 1, node: 1, block: { resolvedAt: 1 }, session: 'historical' } }
      card.rounds.unshift(history)
      const archive = { ...card.plans.at(-1).nodes[0], no: 3, dependsOn: [2] }
      const writer = { status: 'busy' }
      const runtime = { live: new Map(), resolveAgent: async () => writer, inData: async () => false }
      assert.equal(await inspectReplannedWriter(runtime, card, archive), undefined)
      writer.status = 'idle'
      writeFileSync(join(dir, 'untracked'), 'work')
      assert.equal(await inspectReplannedWriter(runtime, card, archive), undefined)
      rmSync(join(dir, 'untracked'))
      const transfer = await inspectReplannedWriter(runtime, card, archive)
      writer.status = 'busy'
      assert.throws(() => transfer.apply(card), /writer or plan changed/)
      writer.status = 'idle'
      transfer.apply(card)
      assert.equal(history.ownershipTransfer.commit, commit)
      delete history.ownershipTransfer
      const revised = { ...archive, dependsOn: [] }
      assert.equal(await inspectReplannedWriter(runtime, card, revised), undefined)
      history.reviewBase = commit
      writer.inbox = { nextTurn: [{ source: { exchangeId: history.dispatchId } }] }
      assert.equal(await inspectReplannedWriter(runtime, card, revised), undefined)
      writer.inbox.nextTurn = []
      const unchanged = await inspectReplannedWriter(runtime, card, revised)
      unchanged.apply(card)
      assert.deepEqual(history.ownershipTransfer, { version: card.plans.at(-1).version, node: revised.no, commit })
    }
  }
})

test('editing an active project card wakes its coordinator and reclaims the stopped writer in the revised plan', async t => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'project-tested-dev-')))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (dir, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture',
    '-c', 'user.email=test@example.invalid', '-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(repo, 'init', '-b', 'dev')
  git(repo, 'commit', '--allow-empty', '-m', 'Initial')
  const host = await start(t, { ...taskNotice, workDir: repo, projectAssistantId: 'd', members: ['a', 'b', 'c', 'd'],
    sessions: { a: 'ga', b: 'gb', c: 'gc', d: 'gd' } }, {}, {}, { b: { workDir: repo }, c: { workDir: repo }, d: { workDir: repo } })
  const request = host.round('arrow', host.say('Add a collapse arrow to the members section'))
  await until(() => request() !== undefined)
  host.begin('ga')
  const act = (who, args) => host.tool('project_task', args, who).then(JSON.parse)
  const response = await act('ga', { action: 'reply', acceptWork: true, message: 'We will check the members toggle.',
    plan: 'Add the members arrow', acceptance: 'Click and keyboard toggle on the feature branch.' })
  assert.equal(response.delegated, true)
  host.begin('gd')
  const manager = args => act('gd', args)
  const branch = 'feat/members-arrow'
  const inventory = await manager({ action: 'prepare_worktree', workRef: branch, baseRef: 'dev', reason: 'Feature candidate' })
  const dir = inventory.branches.find(b => b.branch === branch).workDir
  const nodes = [
    { ownerId: 'b', title: 'Develop', instructions: 'Implement the toggle', acceptance: 'Build passes', deliverable: 'Candidate', writePaths: ['toggle.js'] },
    { ownerId: 'c', title: 'Validate the feature', instructions: 'Test click and keyboard', acceptance: 'Tested candidate',
      deliverable: 'Candidate test report', independentReview: true, writePaths: [], dependsOn: [1] },
  ]
  const plan = { action: 'plan', workspaceMode: 'worktree', workRef: branch, workspaceReason: 'Test one candidate', title: 'Members arrow',
    acceptance: 'Toggle works on the feature branch', version: 1, nodes }
  const { taskId } = await manager(plan)
  const dispatch = async (version, node, name, session) => {
    const { dispatchRound: round } = await manager({ action: 'dispatch', taskId, version, node })
    await host.tool('message_bot', { taskId, card_round: round, to: name, request_id: 'arrow-' + round, reply_to: 'user', message: 'Execute node.' }, 'gd')
    host.agentOf(session).session.header = { cwd: dir }
    host.begin(session)
    await act(session, { action: 'start', taskId, round })
    return round
  }

  const first = await dispatch(1, 1, 'Writer', 'gb')
  writeFileSync(join(dir, 'toggle.js'), 'in progress')
  await act('gb', { action: 'block', taskId, round: first, reason: 'Need updated inputs', waitingFor: 'Revised scope', evidence: 'Partial toggle in checkout' })
  host.finish('gb', 'Stopped before editing')
  host.agentOf('gb').status = 'idle'
  const edit = { roomId: 'r1', taskId, field: 'acceptance', previous: plan.acceptance, value: 'New acceptance' }
  const calls = host.agentOf('gd').calls.length
  assert.equal((await host.call('update-project-task-text', edit)).ok, true)
  assert.equal((await host.call('update-project-task-text', edit)).ok, true)
  assert.equal(host.agentOf('gd').calls.length, calls + 1)
  host.begin('gd')
  await manager({ ...plan, taskId, version: 2, reason: 'Revised inputs', acceptance: edit.value })
  await manager({ ...plan, taskId, version: 3, reason: 'Clarified verification', acceptance: edit.value })
  writeFileSync(join(dir, 'unrelated'), 'other work')
  await assert.rejects(manager({ action: 'dispatch', taskId, version: 3, node: 1 }), /overlapping files/)
  rmSync(join(dir, 'unrelated'))
  const second = await dispatch(3, 1, 'Writer', 'gb')
  const saved = savedTeam(rt.home).rooms.r1.projectCards[taskId]
  assert.equal(saved.rounds.length, 2)
  assert.equal(saved.rounds[first - 1].ownershipTransfer.retainedChanges, true)
  assert.equal(readFileSync(join(dir, 'toggle.js'), 'utf8'), 'in progress')
  assert.equal(saved.rounds[first - 1].ownershipTransfer.version, 3)
  assert.ok(saved.rounds[second - 1].startedAt)
  assert.equal(saved.rounds[second - 1].ownerId, 'b')
  const base = git(repo, 'rev-parse', 'dev')
  git(dir, 'add', 'toggle.js')
  git(dir, 'commit', '-m', 'Implement revised toggle')
  const commit = git(dir, 'rev-parse', 'HEAD')
  await act('gb', { action: 'submit', taskId, round: second, commit, result: 'Implemented toggle' })
  host.finish('gb', 'Candidate ready')
  host.begin('gd')
  await manager({ action: 'approve', taskId, version: 3, node: 1, round: second, artifact: commit })
  const validation = await dispatch(3, 2, 'Tester', 'gc')
  const update = args => act('gc', { taskId, round: validation, ...args })
  await update({ action: 'checkpoint', checking: 'Keyboard toggle' })
  const detail = () => manager({ action: 'read', taskId })
  assert.equal((await detail()).validationProgress[0].checking, 'Keyboard toggle')
  await assert.rejects(update({ action: 'submit', cleanupEvidence: 'Browser closed' }), /Record the completed checks/)
  const checked = { action: 'checkpoint', passedCheck: 'Keyboard toggle', checksComplete: true, evidence: 'Space toggled the panel in the isolated browser.' }
  await update(checked)
  await update(checked)
  assert.equal((await detail()).validationProgress[0].passedCount, 1)
  await assert.rejects(update({ action: 'submit' }), /verified cleanup/)
  assert.equal((await detail()).validationProgress[0].checksComplete, true)
  await update({ action: 'checkpoint', cleanupEvidence: 'Browser and test process exited.' })
  assert.equal((await detail()).validationProgress[0].cleaned, true)
  await assert.rejects(update({ action: 'submit', commit }), /candidate is already bound/)
  await assert.rejects(update({ action: 'submit', cleanupEvidence: 'Different cleanup' }), /different cleanup/)
  await update({ action: 'submit' })
  await update({ action: 'submit' })
  const receipt = savedTeam(rt.home).rooms.r1.projectCards[taskId].rounds[validation - 1]
  assert.deepEqual(receipt.validation.candidates, [commit])
  assert.ok(receipt.result.includes(checked.evidence))
  assert.ok(receipt.result.includes(receipt.validation.cleanup))
  assert.equal(receipt.mergeReceipt, undefined)
  host.finish('gc', 'Verified candidate')
  host.begin('gd')
  assert.equal((await manager({ action: 'read', taskId })).status, 'done')
  assert.equal(git(repo, 'rev-parse', 'dev'), base)
})

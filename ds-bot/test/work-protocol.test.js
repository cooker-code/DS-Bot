import { SOURCE_KIND } from '../src/host/constants.js'
// Waits a Bot gave up: one hand-off that will not come back is closed with an explicit
// result, so the work above it goes on instead of waiting forever.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { savedTeam } from './team-state.js'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { scopeTarget } from '@deepseek-ai/dsh-scope'

let rt

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    c: { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 },
    d: { id: 'd', name: 'Editor', role: 'Edit', sessionId: 'd', createdAt: 4 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

// A host over the plugin's own folder. Starting the same folder again is a restart:
// the first host is closed before the second one starts.
async function startHost(home, team, options = {}) {
  if (team !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined },
        id: sessionId,
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel(cause) { calls.push(['cancel', cause]) },
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep: [],
          nextTurn: [],
          remove(id) {
            for (const list of [this.nextStep, this.nextTurn]) {
              const at = list.findIndex(message => message.id === id)
              if (at !== -1) return list.splice(at, 1).length === 1
            }
            return false
          },
        },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
      ...(options.inspect === undefined ? {} : { inspect: options.inspect }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  // Scoped Cordis events (subagent lifecycle, tool results) reach the plugin
  // through a dispatch carrier DSH keys by the agent the event is for — that
  // carrier is what `this` is in a real listener call.
  const emitScoped = (parentId, name, ...args) => {
    const carrier = scopeTarget({}, agentOf(parentId))
    for (const listener of ctx.listeners.get(name) ?? []) listener.call(carrier, ...args)
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  // Loading once fills the Session-owner indexes turns.js filters events by.
  await tool('list_bots', {}, 'a')
  return { ctx, agents, agentOf, emit, emitScoped, tool, call, home, stop: () => ctx.dispose() }
}

// The plugin folder of a test, and the hosts over it. A second host over the same
// folder is a restart. Everything is closed and removed when the test ends.
function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-handoff-results-'))
  const hosts = []
  t.after(async () => {
    for (const host of hosts.reverse()) await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { home, start: async (team, options) => { const host = await startHost(home, team, options); hosts.push(host); return host } }
}

const textBlock = content => [{ type: 'text', text: content }]
const assistantText = text => ({ message: { content: textBlock(text) } })
const textOf = content => content.map(block => block.text ?? '').join('\n')
const callsOf = (agents, id) => agents.get(id)?.calls ?? []
const settled = async (check) => {
  for (let count = 0; count < 200 && !check(); count += 1) await delay(5)
}

// Each Session takes up the newest message it was sent as its next turn.
function turnTaker(agents, emit) {
  const turns = new Map()
  const open = (id, message) => {
    turns.set(id, (turns.get(id) ?? 0) + 1)
    emit(id, 'turn/start', { turn: turns.get(id) })
    emit(id, 'user/message', { content: message.content, source: message.source })
    return message
  }
  const take = id => open(id, agents.get(id).calls.at(-1)[1])
  const end = (id, text) => {
    if (text !== undefined) emit(id, 'assistant/message', assistantText(text))
    emit(id, 'turn/end', { turn: turns.get(id), reason: { kind: 'completed' } })
  }
  const userTurn = (id, text) => {
    turns.set(id, (turns.get(id) ?? 0) + 1)
    emit(id, 'turn/start', { turn: turns.get(id) })
    emit(id, 'user/message', { content: textBlock(text), source: { kind: 'user' } })
  }
  return { take, open, end, userTurn }
}

// The works the team file holds, once the saves made so far are done.
const worksIn = async ({ call, home }) => {
  await call('set-prefs', {})
  return savedTeam(home).works ?? {}
}

const delegatedId = value => /work_id: ([\w-]+)/.exec(value)[1]

test('delegate, ask and answer keep one work open and return its final reply once', async t => {
  const host = await bench(t).start(seed())
  const turn = turnTaker(host.agents, host.emit)
  turn.userTurn('a', 'Ask Writer for a draft')
  const id = delegatedId(await host.tool('delegate_work', { to: 'Writer', goal: 'Draft the release notes' }, 'a'))
  turn.end('a', 'Delegated')
  turn.take('b')
  await host.tool('ask_back', { question: 'Which release?' }, 'b')
  turn.end('b', 'Waiting for the release number')
  assert.equal((await worksIn(host))[id].question, 'Which release?')
  assert.equal(rt.waitsWork(id), true)
  turn.take('a')
  const answers = await Promise.allSettled([
    host.tool('answer_work', { work_id: id, answer: 'The current local release' }, 'a'),
    host.tool('answer_work', { work_id: id, answer: 'Duplicate answer' }, 'a'),
  ])
  assert.equal(answers.filter(x => x.status === 'fulfilled').length, 1)
  turn.end('a', 'Answered')
  turn.take('b')
  turn.end('b', 'Release notes are ready')
  await settled(() => callsOf(host.agents, 'a').some(([, message]) => textOf(message.content).includes('Release notes are ready')))
  assert.equal(callsOf(host.agents, 'a').filter(([, m]) => textOf(m.content).includes('Release notes are ready')).length, 1)
  const saved = await worksIn(host)
  assert.equal(saved[id], undefined)
  assert.equal(saved['closed:' + id].protocolReceipt.status, 'completed')
})

test('a named delegation replays its receipt without another delivery', async t => {
  const host = await bench(t).start(seed())
  const args = { to: 'Writer', goal: 'One draft', request_id: 'draft-1' }
  const result = await Promise.all([host.tool('delegate_work', args, 'a'), host.tool('delegate_work', args, 'a')])
  assert.equal(result[0], result[1])
  assert.equal(callsOf(host.agents, 'b').filter(([kind]) => kind === 'followup').length, 1)
  await assert.rejects(host.tool('delegate_work', { ...args, goal: 'Different draft' }, 'a'), /not sent again/)
})

test('a silent note injects a durable message without a work or a new turn', async t => {
  const host = await bench(t).start(seed())
  await host.tool('note_bot', { to: 'Writer', message: 'The reference document was updated.' }, 'a')
  assert.deepEqual(callsOf(host.agents, 'b').map(([kind]) => kind), ['inject'])
  assert.deepEqual(await worksIn(host), {})
  assert.equal(rt.ledger.records('pair-a-b').at(-1).event, 'delivered')
})

test('cancelling one child releases only that wait and suppresses its late result', async t => {
  const host = await bench(t).start(seed())
  const turn = turnTaker(host.agents, host.emit)
  const parent = delegatedId(await host.tool('delegate_work', { to: 'Writer', goal: 'Collect two reviews' }, 'a'))
  turn.take('b')
  const child = delegatedId(await host.tool('delegate_work', { to: 'Tester', goal: 'First review' }, 'b'))
  const other = delegatedId(await host.tool('delegate_work', { to: 'Editor', goal: 'Second review' }, 'b'))
  turn.end('b', 'Waiting for reviews')
  turn.take('c')
  await assert.rejects(host.tool('cancel_work', { work_id: child }, 'd'), /belongs/)
  await host.tool('cancel_work', { work_id: child, reason: 'Not needed' }, 'b')
  assert.ok(callsOf(host.agents, 'c').some(([kind]) => kind === 'cancel'))
  const saved = await worksIn(host)
  assert.deepEqual(saved[parent].open, [other])
  assert.equal(saved['closed:' + child].protocolReceipt.status, 'cancelled')
  const count = callsOf(host.agents, 'b').length
  turn.end('c', 'Late first review')
  await host.call('set-prefs', {})
  assert.equal(callsOf(host.agents, 'b').length, count)
})

test('questions survive a reload and answers return to the worker original thread', async t => {
  const fixture = bench(t)
  const first = await fixture.start(seed())
  const turn = turnTaker(first.agents, first.emit)
  const id = delegatedId(await first.tool('delegate_work', { to: 'Writer', goal: 'Draft' }, 'a'))
  turn.take('b')
  await first.tool('ask_back', { question: 'What tone?' }, 'b')
  turn.end('b')
  await first.call('set-prefs', {})
  await first.stop()
  const second = await fixture.start()
  await second.call('state', {})
  rt.state.bots.b.openParts = [{ sessionId: 'b', segments: [] }]
  rt.state.bots.b.sessionId = 'b-new'
  rt.indexSessions()
  await second.tool('answer_work', { work_id: id, answer: 'Concise' }, 'a')
  assert.ok(callsOf(second.agents, 'b').some(([, m]) => textOf(m.content).includes('Concise')))
  assert.equal(callsOf(second.agents, 'b-new').length, 0)
})

test('work controls reject another project scope and never change card acceptance', async t => {
  const host = await bench(t).start(seed())
  const card = { rounds: [{ dispatchId: 'dispatch-A', planNode: { version: 1, acceptedAt: 4 } }] }
  const original = structuredClone(card)
  rt.state.rooms.r = { id: 'r', name: 'Project', named: true, members: ['a', 'b'], sessions: {}, projectCards: { A: card } }
  host.emit('a', 'turn/start', { turn: 1 })
  host.emit('a', 'user/message', { content: textBlock('A'), source: { kind: SOURCE_KIND, taskId: 'A', exchangeId: 'dispatch-A' } })
  const id = delegatedId(await host.tool('delegate_work', { to: 'Writer', goal: 'Check one fact' }, 'a'))
  const work = (await worksIn(host))[id]
  assert.equal(work.taskId, 'A')
  assert.equal(work.dispatchId, 'dispatch-A')
  rt.live.get('a').info = { ...rt.live.get('a').info, taskId: 'B' }
  await assert.rejects(host.tool('cancel_work', { work_id: id }, 'a'), /another project card/)
  assert.deepEqual(rt.state.rooms.r.projectCards.A, original)
})


test('project delegation questions and answers carry their original dispatch round', async t => {
  const host = await bench(t).start(seed())
  const turn = turnTaker(host.agents, host.emit)
  turn.open('a', { content: textBlock('Work on card A'), source: { kind: SOURCE_KIND, role: 'request', exchangeId: 'dispatch-A', taskId: 'card-A', senderSessionId: 'd' } })
  const id = delegatedId(await host.tool('delegate_work', { to: 'Writer', goal: 'Check card A' }, 'a'))
  turn.end('a', 'Delegated')
  turn.take('b')
  await host.tool('ask_back', { question: 'Which sample?' }, 'b')
  turn.end('b', 'Waiting')
  const question = turn.take('a')
  assert.equal(question.source.parentExchangeId, 'dispatch-A')
  assert.equal(question.source.taskId, 'card-A')
  await host.tool('answer_work', { work_id: id, answer: 'The first sample' }, 'a')
  turn.end('a', 'Answered')
  const answer = turn.take('b')
  assert.equal(answer.source.parentExchangeId, 'dispatch-A')
  turn.end('b', 'Checked the sample')
  await settled(() => callsOf(host.agents, 'a').some(([, m]) => m.source.role === 'reply'))
  const reply = callsOf(host.agents, 'a').findLast(([, m]) => m.source.role === 'reply')[1]
  assert.equal(reply.source.parentExchangeId, 'dispatch-A')
})

test('definitive delivery failures roll back delegation, question and answer so each can retry', async t => {
  const host = await bench(t).start(seed())
  const turn = turnTaker(host.agents, host.emit)
  const deliver = rt.deliver
  rt.deliver = async () => { throw new Error('Not enqueued') }
  await assert.rejects(host.tool('delegate_work', { to: 'Writer', goal: 'Draft', request_id: 'retry-1' }, 'a'), /Not enqueued/)
  assert.equal(Object.values((await worksIn(host))).filter(w => w.protocol).length, 0)
  rt.deliver = deliver
  const id = delegatedId(await host.tool('delegate_work', { to: 'Writer', goal: 'Draft', request_id: 'retry-1' }, 'a'))
  turn.take('b')
  rt.deliver = async () => { throw new Error('Question not enqueued') }
  await assert.rejects(host.tool('ask_back', { question: 'Which release?' }, 'b'), /not enqueued/)
  assert.equal((await worksIn(host))[id].question, undefined)
  rt.deliver = deliver
  await host.tool('ask_back', { question: 'Which release?' }, 'b')
  turn.end('b', 'Waiting')
  turn.take('a')
  rt.deliver = async () => { throw new Error('Answer not enqueued') }
  await assert.rejects(host.tool('answer_work', { work_id: id, answer: 'Current' }, 'a'), /not enqueued/)
  assert.equal((await worksIn(host))[id].question, 'Which release?')
  rt.deliver = deliver
  await host.tool('answer_work', { work_id: id, answer: 'Current' }, 'a')
  assert.equal((await worksIn(host))[id].question, undefined)
})

test('uncertain flush after enqueue keeps one delegation and replays its receipt', async t => {
  const host = await bench(t).start(seed())
  host.ctx.sessions.flush = async () => { throw new Error('Session flush unavailable') }
  const args = { to: 'Writer', goal: 'Draft', request_id: 'uncertain-1' }
  const first = await host.tool('delegate_work', args, 'a')
  assert.match(first, /persistence is uncertain/)
  const id = delegatedId(first)
  assert.equal((await worksIn(host))[id].protocol, true)
  assert.equal(await host.tool('delegate_work', args, 'a'), first)
  assert.equal(callsOf(host.agents, 'b').filter(([kind]) => kind === 'followup').length, 1)
})

test('cancel closes unavailable worker sessions and never reopens on a late result', async t => {
  const host = await bench(t).start(seed())
  const turn = turnTaker(host.agents, host.emit)
  const id = delegatedId(await host.tool('delegate_work', { to: 'Writer', goal: 'Draft' }, 'a'))
  turn.take('b')
  const resolve = rt.resolveAgent
  rt.resolveAgent = async () => { throw new Error('Session no longer exists') }
  assert.match(await host.tool('cancel_work', { work_id: id }, 'a'), /Cancelled work/)
  rt.resolveAgent = resolve
  turn.end('b', 'Late result')
  await delay(10)
  const works = await worksIn(host)
  assert.equal(works[id], undefined)
  assert.equal(works['closed:' + id].protocolReceipt.status, 'cancelled')
  assert.equal(callsOf(host.agents, 'a').length, 0)
})

test('answer, cancel and completion serialize to one terminal work', async t => {
  const host = await bench(t).start(seed())
  const turn = turnTaker(host.agents, host.emit)
  const id = delegatedId(await host.tool('delegate_work', { to: 'Writer', goal: 'Draft' }, 'a'))
  turn.take('b')
  await host.tool('ask_back', { question: 'Which version?' }, 'b')
  turn.end('b', 'Waiting')
  turn.take('a')
  const result = await Promise.allSettled([
    host.tool('cancel_work', { work_id: id }, 'a'),
    host.tool('answer_work', { work_id: id, answer: 'Current' }, 'a'),
  ])
  assert.equal(result.filter(x => x.status === 'fulfilled').length, 1)
  const works = await worksIn(host)
  assert.equal(works[id], undefined)
  assert.equal(works['closed:' + id].protocolReceipt.status, 'cancelled')
})

test('named delegation keeps its identity after the caller thread advances', async t => {
  const fixture = bench(t)
  const first = await fixture.start(seed())
  const args = { to: 'Writer', goal: 'One draft', request_id: 'stable-thread' }
  const receipt = await first.tool('delegate_work', args, 'a')
  rt.state.bots.a.sessionId = 'a-new'
  rt.state.bots.a.segments = [{ sessionId: 'a', endedAt: 2 }]
  await rt.save({ required: true })
  await first.stop()
  const resumed = await fixture.start()
  assert.equal(await resumed.tool('delegate_work', args, 'a-new'), receipt)
  assert.equal(callsOf(resumed.agents, 'b').length, 0)
})

test('read-only hosts cannot use any work control or silent note', async t => {
  const host = await bench(t).start(seed())
  rt.readOnly = () => 'another owner holds the team'
  for (const name of ['delegate_work', 'ask_back', 'answer_work', 'cancel_work', 'note_bot']) {
    await assert.rejects(host.tool(name, { to: 'Writer', goal: 'Draft', question: 'Why?', work_id: 'closed-test', answer: 'Yes', message: 'Note' }, 'a'), /cannot save/)
  }
})

test('leaving a group does not prevent its original caller from closing the delegated wait', async t => {
  const team = seed()
  team.rooms.r1 = { id: 'r1', name: 'Ops', members: ['a','b'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb' } }
  const host = await bench(t).start(team)
  const id = delegatedId(await host.tool('delegate_work', { to: 'Writer', goal: 'Group draft' }, 'ga'))
  rt.state.rooms.r1.members = ['a']
  delete rt.state.rooms.r1.sessions.b
  assert.match(await host.tool('cancel_work', { work_id: id }, 'ga'), /Cancelled work/)
  assert.equal((await worksIn(host))['closed:' + id].protocolReceipt.status, 'cancelled')
})

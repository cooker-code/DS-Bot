import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install, handoffState, scanProjectHandoffs } from '../src/host/project-handoffs.js'
import { install as installTasks } from '../src/host/project-tasks.js'

function fixture(t, snapshot, events = []) {
  const room = snapshot ?? { id: 'r', name: 'Data', admin: 'a', members: ['a', 'b', 'c'], taskManagementEnabled: true,
    projectAssistantId: 'b', sessions: { a: 'ga', b: 'gb', c: 'gc' },
    projectInbox: [{ id: 'intake-one', seq: 1, title: 'Raw request', status: 'accepted' }],
    projectCards: { one: { id: 'one', title: 'Raw request', plans: [], rounds: [], intakes: ['intake-one'] } } }
  const messages = [{ seq: 1, who: 'User', text: 'Create the daily chat detail table.', intakeId: 'intake-one' }]
  const agents = new Map(Object.values(room.sessions).map(id => [id, { inbox: { nextTurn: [], nextStep: [] } }]))
  const disposers = []
  const deliveries = []
  let failure, persisted
  const rt = {
    state: { rooms: { r: room } }, teamTools: [], live: new Map(), groupOwners: new Map([['ga', { roomId: 'r', botId: 'a' }]]),
    ctx: { effect(fn) { disposers.push(fn()) } }, onSaved: () => () => {}, load: async () => {}, readOnly: () => undefined,
    selfOf: id => ({ ga: 'a', gb: 'b', gc: 'c' })[id], roomOf: id => id === 'r' ? room : undefined,
    botOf: id => ({ id, name: id }), isAdminOf: (r, id) => r.admin === id, isMain: id => id === 'a',
    ledger: { records: () => messages, record: (book, seq) => messages.find(m => m.seq === seq) },
    save: async ({ mutate } = {}) => { mutate?.(); persisted = structuredClone(room) },
    warn() {}, redactSecrets: text => text, memberSession: async (r, id) => r.sessions[id],
    resolveAgent: async id => agents.get(id), async* eventsBackwards(id) { yield* events.filter(e => e.sessionId === id) },
    async deliver(input) {
      if (failure === 'before') throw new Error('Recipient unavailable')
      const message = { source: { exchangeId: input.exchangeId, taskId: input.taskId, role: input.role }, content: [{ type: 'text', text: input.text }] }
      agents.get(input.sessionId).inbox.nextTurn.push(message)
      events.push({ sessionId: input.sessionId, type: 'user/message', data: message })
      deliveries.push(input)
      if (failure === 'after') throw new Error('Receipt save interrupted')
      return input.exchangeId
    },
  }
  installTasks(rt)
  install(rt)
  const dispose = async () => { for (const fn of [...disposers].reverse()) await fn() }
  t.after(dispose)
  const call = args => rt.teamTools.find(tool => tool.name === 'project_task').execute(args, { agent: { id: 'ga' } }).then(JSON.parse)
  return { rt, room, agents, events, deliveries, call, dispose, fail: value => { failure = value }, saved: () => persisted }
}

const document = { title: 'Daily chat details', plan: '1. Create a daily chat detail table.', acceptance: '1. Verify the source, grain and daily update.' }

test('scan explains why accepted work is unassigned and the admin retries the original card', async t => {
  const f = fixture(t)
  assert.equal(scanProjectHandoffs(f.rt, f.room)[0].status, 'needs_document')
  f.rt.live.set('ga', { info: { role: 'room', roomId: 'r', taskId: 'one' } })
  const scan = await f.call({ action: 'scan' })
  assert.equal(scan.unassigned[0].retryable, true)
  const result = await f.call({ action: 'retry_handoff', taskId: 'one', ...document })
  assert.equal(result.delegated, true)
  assert.equal(Object.keys(f.room.projectCards).length, 1)
  assert.equal(f.room.projectCards.one.title, document.title)
  assert.equal(f.room.projectCards.one.goal, document.plan)
  assert.equal(f.room.projectCards.one.acceptance, document.acceptance)
  assert.deepEqual(f.room.projectCards.one.requirementHistory.map(entry => entry.text), ['Create the daily chat detail table.'])
  assert.equal(f.deliveries[0].toId, 'b')
  assert.match(f.deliveries[0].text, /Create the daily chat detail table/)
  assert.equal(f.deliveries[0].taskId, 'one')
  assert.equal(f.room.projectCards.one.rounds.length, 0)
})

test('a failed delivery preserves normalized content and can be safely retried', async t => {
  const f = fixture(t)
  f.fail('before')
  const result = await f.call({ action: 'retry_handoff', taskId: 'one', ...document })
  assert.equal(result.delegated, false)
  assert.equal(result.status, 'uncertain')
  assert.match(result.reason, /Recipient unavailable/)
  assert.equal(f.saved().projectCards.one.goal, document.plan)
  const id = f.room.projectCards.one.managementHandoff.id
  f.fail(undefined)
  assert.equal((await f.call({ action: 'retry_handoff', taskId: 'one' })).delegated, true)
  assert.equal(f.deliveries.length, 1)
  assert.equal(f.deliveries[0].exchangeId, id)
})

test('restart reconciles an interrupted receipt with durable delivery instead of sending twice', async t => {
  const first = fixture(t)
  first.fail('after')
  assert.equal((await first.call({ action: 'retry_handoff', taskId: 'one', ...document })).delegated, false)
  const resumed = fixture(t, structuredClone(first.saved()), first.events)
  assert.equal((await resumed.call({ action: 'retry_handoff', taskId: 'one' })).delegated, true)
  assert.equal(resumed.deliveries.length, 0)
  assert.equal(first.deliveries.length, 1)
})

test('repeated and concurrent retries deliver once', async t => {
  const f = fixture(t)
  Object.assign(f.room.projectCards.one, { goal: document.plan, acceptance: document.acceptance })
  const results = await Promise.all([f.rt.retryProjectHandoff(f.room, f.room.projectCards.one), f.rt.retryProjectHandoff(f.room, f.room.projectCards.one)])
  assert.ok(results.every(r => r.delegated))
  await f.rt.retryProjectHandoff(f.room, f.room.projectCards.one)
  assert.equal(f.deliveries.length, 1)
})

test('appointment after acceptance wakes the admin on the original card and preserves active work', async t => {
  const f = fixture(t)
  delete f.room.projectAssistantId
  f.room.projectCards.active = { id: 'active', title: 'In progress', intakes: [], plans: [{ version: 1, nodes: [] }], rounds: [{ ownerId: 'c', startedAt: 1 }] }
  assert.equal(handoffState(f.rt, f.room, f.room.projectCards.one).status, 'no_assistant')
  f.room.projectAssistantId = 'b'
  const active = structuredClone(f.room.projectCards.active)
  await f.rt.recoverProjectHandoffs()
  assert.equal(f.deliveries.length, 1)
  assert.equal(f.deliveries[0].toId, 'a')
  assert.match(f.deliveries[0].text, /one/)
  assert.match(f.deliveries[0].text, /retry_handoff/)
  await f.rt.recoverProjectHandoffs()
  assert.equal(f.deliveries.length, 1)
  assert.deepEqual(f.room.projectCards.active, active)
})

test('a busy admin is not interrupted, and receives the recovery after becoming idle', async t => {
  const f = fixture(t)
  f.rt.live.set('ga', { turn: 1 })
  await f.rt.recoverProjectHandoffs()
  assert.equal(f.deliveries.length, 0)
  f.rt.live.delete('ga')
  await f.rt.recoverProjectHandoffs()
  assert.equal(f.deliveries.length, 1)
})

test('changing the appointed assistant delivers to the new target without creating execution rounds', async t => {
  const f = fixture(t)
  await f.call({ action: 'retry_handoff', taskId: 'one', ...document })
  f.room.projectAssistantId = 'c'
  assert.equal(handoffState(f.rt, f.room, f.room.projectCards.one).retryable, true)
  await f.call({ action: 'retry_handoff', taskId: 'one' })
  assert.deepEqual(f.deliveries.map(d => d.toId), ['b', 'c'])
  assert.equal(f.room.projectCards.one.rounds.length, 0)
})

test('waiting for user input and finished cards do not get retry notifications', async t => {
  const f = fixture(t)
  f.room.projectCards.one.clarification = 'Which business scope?'
  f.room.projectCards.done = { id: 'done', title: 'Done', completedWithTaskId: 'parent', intakes: [], rounds: [], plans: [] }
  await f.rt.recoverProjectHandoffs()
  assert.equal(f.deliveries.length, 0)
})

test('a worker and a different card execution cannot use admin recovery', async t => {
  const f = fixture(t)
  const tool = f.rt.teamTools.find(t => t.name === 'project_task')
  f.rt.groupOwners.set('gc', { roomId: 'r', botId: 'c' })
  await assert.rejects(tool.execute({ action: 'retry_handoff', taskId: 'one', ...document }, { agent: { id: 'gc' } }), /TASK_ROLE_REQUIRED/)
  f.rt.live.set('ga', { info: { roomId: 'r', taskId: 'another' } })
  await assert.rejects(f.call({ action: 'retry_handoff', taskId: 'one', ...document }), /different card/)
  assert.equal(f.deliveries.length, 0)
})

test('saved requirements can be handed off when the original history is unavailable', async t => {
  const f = fixture(t)
  Object.assign(f.room.projectCards.one, { goal: document.plan, acceptance: document.acceptance })
  f.rt.ledger.records = () => []
  assert.equal((await f.call({ action: 'retry_handoff', taskId: 'one' })).delegated, true)
  await f.call({ action: 'retry_handoff', taskId: 'one' })
  assert.equal(f.deliveries.length, 1)
  assert.match(f.deliveries[0].handoffText, /Create a daily chat detail table/)
})

test('replacing the admin wakes the new admin even if the old notification was delivered', async t => {
  const f = fixture(t)
  await f.rt.recoverProjectHandoffs()
  f.room.admin = 'c'
  await f.rt.recoverProjectHandoffs()
  assert.deepEqual(f.deliveries.map(d => d.toId), ['a', 'c'])
})

test('one scan notification covers several unassigned cards without queuing duplicate admin turns', async t => {
  const f = fixture(t)
  f.room.projectCards.two = { ...structuredClone(f.room.projectCards.one), id: 'two', title: 'Another table', intakes: ['intake-two'] }
  const original = f.rt.ledger.records()
  f.rt.ledger.records = () => [...original, { seq: 2, who: 'User', intakeId: 'intake-two', text: 'Create another independent table.' }]
  await f.rt.recoverProjectHandoffs()
  await f.rt.recoverProjectHandoffs()
  assert.equal(f.deliveries.length, 1)
  assert.match(f.deliveries[0].text, /one/)
  assert.match(f.deliveries[0].text, /two/)
  assert.equal(scanProjectHandoffs(f.rt, f.room).length, 2)
})

test('an in-flight delivery does not produce a false unsent notification', async t => {
  const f = fixture(t)
  Object.assign(f.room.projectCards.one, { goal: document.plan, acceptance: document.acceptance })
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { entered = resolve })
  const deliver = f.rt.deliver
  f.rt.deliver = async args => { entered(); await gate; return deliver(args) }
  const pending = f.rt.retryProjectHandoff(f.room, f.room.projectCards.one)
  await ready
  await f.rt.recoverProjectHandoffs()
  assert.equal(f.deliveries.length, 0)
  release()
  assert.equal((await pending).delegated, true)
  assert.equal(f.deliveries.length, 1)
})

test('missing original sources notify the admin with a non-retryable reason instead of being silently skipped', async t => {
  const f = fixture(t)
  f.rt.ledger.records = () => []
  await f.rt.recoverProjectHandoffs()
  assert.equal(f.deliveries.length, 1)
  assert.match(f.deliveries[0].text, /missing_source/)
  assert.equal((await f.call({ action: 'scan' })).unassigned[0].retryable, false)
  await assert.rejects(f.call({ action: 'retry_handoff', taskId: 'one' }), /Neither a complete requirement/)
  await f.rt.recoverProjectHandoffs()
  assert.equal(f.deliveries.length, 1)
})

test('an invalid assistant binding remains diagnosable but cannot receive a retry', async t => {
  const f = fixture(t)
  f.room.projectAssistantId = 'not-a-member'
  const { unassigned } = await f.call({ action: 'scan' })
  assert.equal(unassigned[0].status, 'invalid_assistant')
  assert.equal(unassigned[0].retryable, false)
  await assert.rejects(f.call({ action: 'retry_handoff', taskId: 'one', ...document }), /TASK_ASSISTANT_INVALID/)
  assert.equal(f.deliveries.length, 0)
})

test('revised card content gets a new delivery while an identical retry reuses its receipt', async t => {
  const f = fixture(t)
  await f.call({ action: 'retry_handoff', taskId: 'one', ...document })
  const first = f.deliveries[0].exchangeId
  f.room.projectCards.one.goal = '1. Create the revised daily chat table.'
  assert.equal(handoffState(f.rt, f.room, f.room.projectCards.one).status, 'not_sent')
  await f.call({ action: 'retry_handoff', taskId: 'one' })
  await f.call({ action: 'retry_handoff', taskId: 'one' })
  assert.equal(f.deliveries.length, 2)
  assert.notEqual(f.deliveries[1].exchangeId, first)
  assert.match(f.deliveries[1].text, /revised daily chat table/)
})

test('normalizing and revising the original card preserves requirement versions through retries', async t => {
  const f = fixture(t)
  await f.call({ action: 'retry_handoff', taskId: 'one', ...document })
  const revised = { ...document, plan: '1. Inspect the revised daily source.' }
  await f.call({ action: 'retry_handoff', taskId: 'one', ...revised })
  await f.call({ action: 'retry_handoff', taskId: 'one', ...revised })
  assert.deepEqual(f.room.projectCards.one.requirementHistory.map(entry => entry.text), [
    'Create the daily chat detail table.', document.plan,
  ])
  assert.equal(f.room.projectCards.one.goal, revised.plan)
  assert.equal(f.deliveries.length, 2)
})

for (const changedText of [false, true]) test('new source images preserve their previous version with changed text: ' + changedText, async t => {
  const f = fixture(t)
  const sources = f.rt.ledger.records()
  sources[0].images = [{ id: 'image-a' }]
  await f.call({ action: 'retry_handoff', taskId: 'one', ...document })
  f.room.projectCards.one.plans = [{ version: 1, nodes: [{ no: 1, ownerId: 'c', title: 'Source check',
    instructions: 'Inspect sources', deliverable: 'Evidence', acceptance: 'Verified', dependsOn: [] }] }]
  sources.push({ seq: 2, who: 'User', text: 'Additional source image.', intakeId: 'intake-one', images: [{ id: 'image-b' }] })
  f.rt.live.set('ga', { info: { role: 'request', roomId: 'r', intakeSeq: 2, intakeId: 'intake-one', taskId: 'one' } })
  const revision = { action: 'delegate', taskId: 'one', plan: changedText ? '1. Inspect the revised source.' : document.plan,
    acceptance: document.acceptance }
  await f.call(revision)
  const saved = f.room.projectCards.one
  assert.equal(saved.requirementHistory.length, 2)
  assert.equal(saved.requirementHistory[1].text, document.plan)
  assert.deepEqual(saved.requirementHistory[1].images, [{ id: 'image-a' }])
  assert.deepEqual(saved.requirementSources, [1, 2])
  await f.call(revision)
  assert.equal(f.room.projectCards.one.requirementHistory.length, 2)
  assert.equal(f.deliveries.length, 2)
})

test('an exhausted old delivery does not suppress recovery of revised requirements', async t => {
  const f = fixture(t)
  f.fail('before')
  await f.call({ action: 'retry_handoff', taskId: 'one', ...document })
  const card = f.room.projectCards.one
  card.managementHandoff.attempts = 3
  card.goal = '1. Inspect a different source for the daily table.'
  f.fail(undefined)
  await f.rt.recoverProjectHandoffs()
  assert.equal(f.deliveries.length, 1)
  assert.equal(f.deliveries[0].toId, 'a')
  assert.match(f.deliveries[0].text, /not_sent/)
})

test('cleanup waits for a paused scan and prevents further recovery writes', async t => {
  const f = fixture(t)
  await f.rt.recoverProjectHandoffs()
  f.agents.get('ga').inbox.nextTurn = []
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { entered = resolve })
  const resolveAgent = f.rt.resolveAgent
  f.rt.resolveAgent = async id => { entered(); await gate; return resolveAgent(id) }
  const recovering = f.rt.recoverProjectHandoffs()
  await ready
  let cleaned = false
  const cleaning = f.dispose().then(() => { cleaned = true })
  await Promise.resolve()
  assert.equal(cleaned, false)
  const saved = f.saved()
  release()
  await Promise.all([recovering, cleaning])
  assert.deepEqual(f.saved(), saved)
  assert.equal(f.deliveries.length, 1)
})

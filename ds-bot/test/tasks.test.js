import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { savedTeam } from './team-state.js'
import { createRuntime } from '../index.js'
import { deleteBoardTasks, install } from '../src/host/tasks.js'
import { forwardProjectIntake } from '../src/host/project-intake.js'
import { developmentHandoff } from '../src/host/project-tasks.js'
import { fakeAttachments, fakeContext } from './fake-ctx.js'

// The task board is room data: these tests start with the queue every new room has,
// and the last one drives the panel's two endpoints through a whole runtime.

function fakeHost(given) {
  const state = given ?? {
    bots: { a: { id: 'a', name: 'Chief' }, b: { id: 'b', name: 'Writer' } },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], admin: 'a', sessions: { a: 'ga', b: 'gb' }, tasks: {} } },
    prefs: {},
  }
  const members = { a: 'a', b: 'b', ga: 'a', gb: 'b' }
  const calls = { save: 0 }
  const rt = {
    state,
    teamTools: [],
    async load() {},
    async save() { calls.save += 1 },
    botOf: id => state.bots[id],
    roomOf: id => state.rooms[id],
    selfOf: id => members[id],
    isMain: id => id === 'a',
    isAdminOf: (room, id) => room.admin === id,
    groupOwners: new Map([['ga', { botId: 'a', roomId: 'r1' }], ['gb', { botId: 'b', roomId: 'r1' }]]),
  }
  install(rt)
  const tool = (args, sessionId = 'gb') => rt.teamTools.find(entry => entry.name === 'group_task').execute(args, { agent: { id: sessionId } })
  const tasks = () => Object.values(state.rooms.r1.tasks ?? {})
  return { state, rt, tool, calls, tasks }
}

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb' }, log: [], seq: 0, seen: {} } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function start(t, team = seed(), services = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-tasks-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext({ services })
  const prompts = []
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, cancel() {}, followup() {}, steer() {} } }),
      selectModel: async () => {},
      prompt: async (request) => { prompts.push(request) },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const tool = (args, sessionId) => rt.teamTools.find(entry => entry.name === 'group_task').execute(args, { agent: { id: sessionId } })
  const saved = () => savedTeam(home)
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  return { home, ctx, rt, call, tool, prompts, saved, emit }
}

test('group_task opens a task and moves it through active, review, blocked and done', async () => {
  const host = fakeHost()
  assert.match(await host.tool({ action: 'open', goal: '  Write   the draft ' }), /^Opened t_[0-9a-f]{8}: Write the draft\n\nTasks in "Ops":/)
  const [task] = host.tasks()
  assert.deepEqual([task.botId, task.status, task.goal, task.progress], ['b', 'active', 'Write the draft', ''])
  assert.equal(host.calls.save, 1)

  assert.match(await host.tool({ action: 'update', status: 'review' }), /Specify deliveryKind/)
  assert.match(await host.tool({ action: 'update', status: 'review', deliveryKind: 'other', progress: 'Draft is ready  for review' }), /^Updated t_/)
  assert.deepEqual([host.tasks()[0].status, host.tasks()[0].progress], ['review', 'Draft is ready for review'])
  assert.match(await host.tool({ action: 'update', status: 'blocked', progress: 'Waiting for the outline' }), /\(blocked\)/)
  assert.match(await host.tool({ action: 'update', status: 'active' }), /\(active\)/)

  assert.equal(await host.tool({ action: 'complete' }), 'A finished task needs a result summary.')
  assert.match(await host.tool({ action: 'complete', result: 'Draft delivered' }), /Finished: "Draft delivered"/)
  assert.deepEqual([host.tasks()[0].status, host.tasks()[0].result], ['done', 'Draft delivered'])
  assert.match(await host.tool({ action: 'show' }), /1 finished or cancelled in the history/)
})

test('a member code task needs its delivery commit on local master, not a remote-tracking ref', async t => {
  const repo = mkdtempSync(join(tmpdir(), 'member-code-review-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null',
    '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'master')
  git('commit', '--allow-empty', '-qm', 'Baseline')
  git('switch', '-qc', 'feature')
  const host = fakeHost()
  host.rt.workFolder = async () => repo
  host.rt.privateClash = async () => false
  host.state.rooms.r1.workDir = repo
  await host.tool({ action: 'open', goal: 'Add a file', deliveryKind: 'code', repository: repo })
  writeFileSync(join(repo, 'feature.txt'), 'delivery')
  git('add', 'feature.txt')
  git('commit', '-qm', 'Delivery')
  const commit = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/master', commit)
  const review = { action: 'update', status: 'review', commit }
  await assert.rejects(host.tool(review), /not on local main or master/)
  assert.equal(host.tasks()[0].status, 'active')
  git('switch', '-q', 'master')
  git('merge', '--ff-only', 'feature')
  git('commit', '--allow-empty', '-qm', 'Later commit')
  await host.tool(review)
  assert.equal(host.tasks()[0].status, 'review')
  assert.equal(host.tasks()[0].mainReview.commit, commit)
  assert.equal(host.tasks()[0].mainReview.branch, 'master')
  assert.equal(host.tasks()[0].mainReview.tip, git('rev-parse', 'master'))
})

test('a task belongs to the Bot that opened it; only the admin or a Main Bot may cancel another one', async () => {
  const host = fakeHost()
  await host.tool({ action: 'open', goal: 'Write the draft' }, 'gb')
  const [task] = host.tasks()
  // The admin may not move another member's task through update; it may cancel it.
  assert.equal(await host.tool({ action: 'update', status: 'review', id: task.id }, 'ga'), `Task ${task.id} belongs to another member.`)
  assert.equal(await host.tool({ action: 'complete', id: task.id, result: 'x' }, 'ga'), `Task ${task.id} belongs to another member.`)
  assert.match(await host.tool({ action: 'cancel', id: task.id, reason: 'scope cut' }, 'ga'), /^Updated t_.* Cancelled\./)
  assert.deepEqual([host.tasks()[0].status, host.tasks()[0].reason], ['cancelled', 'scope cut'])

  // A member who is neither the owner nor the admin is refused.
  await host.tool({ action: 'open', goal: 'Check the draft' }, 'ga')
  const second = host.tasks().find(entry => entry.status === 'active')
  assert.equal(await host.tool({ action: 'cancel', id: second.id }, 'gb'), `Task ${second.id} belongs to another member; only its owner, the admin or a Main Bot cancels it.`)
  assert.equal(host.tasks().find(entry => entry.id === second.id).status, 'active')
})

test('update and complete pick the caller\'s own newest open task when no id is given', async () => {
  const host = fakeHost()
  await host.tool({ action: 'open', goal: 'First' }, 'gb')
  await host.tool({ action: 'open', goal: 'Second' }, 'gb')
  await host.tool({ action: 'open', goal: 'Other' }, 'ga')
  await host.tool({ action: 'update', progress: 'on Second' }, 'gb')
  const mine = host.tasks().filter(task => task.botId === 'b')
  assert.deepEqual(mine.map(task => [task.goal, task.progress]), [['First', ''], ['Second', 'on Second']])
  await host.tool({ action: 'complete', result: 'done' }, 'gb')
  assert.deepEqual(host.tasks().filter(task => task.botId === 'b').map(task => task.status), ['active', 'done'])
})

test('group_task refuses a chat that is not a group chat and a session that is not a Bot', async () => {
  const host = fakeHost()
  assert.equal(await host.tool({ action: 'open', goal: 'x' }, 'a'), 'group_task works inside a group chat, where the work belongs to the group. Call it from your group session.')
  assert.equal(await host.tool({ action: 'open', goal: 'x' }, 'nobody'), 'Only Bots on the team can use group_task.')
  assert.equal(await host.tool({ action: 'open', goal: ' ' }), 'A task needs a one-line goal.')
})

test('the panel adds a note and cancels through the same task, refusing a finished one', async () => {
  const host = fakeHost()
  await host.tool({ action: 'open', goal: 'Write the draft' }, 'gb')
  const [task] = host.tasks()
  await host.tool({ action: 'update', id: task.id, status: 'review', deliveryKind: 'other' }, 'gb')
  await host.tool({ action: 'update', id: task.id, status: 'clarify', progress: 'Which test environment?' }, 'gb')
  const noted = host.rt.taskNote('r1', task.id, '  also add   tests ')
  assert.equal(noted.task.status, 'review')
  assert.deepEqual(noted.task.notes.map(note => [note.by, note.text]), [['user', 'also add tests']])
  assert.equal(host.rt.taskNote('r1', task.id, '  ').error, 'Write a note first.')
  assert.equal(host.rt.taskNote('r1', 'nope', 'x').error, 'No such task.')

  assert.equal(host.rt.taskCancel('r1', task.id).task.status, 'cancelled')
  assert.equal(host.rt.taskNote('r1', task.id, 'late').error, 'That task is already finished.')
  assert.equal(host.rt.taskCancel('r1', task.id).error, 'That task is already finished.')
})

test('tasks live on the room: a reload keeps them, and deleting the group drops them', async () => {
  const host = fakeHost()
  await host.tool({ action: 'open', goal: 'Write the draft' }, 'gb')
  const id = host.tasks()[0].id
  // What a restart reads back is the room itself, tasks included.
  const reloaded = fakeHost(JSON.parse(JSON.stringify(host.state)))
  assert.match(await reloaded.tool({ action: 'show' }, 'gb'), new RegExp(`- ${id} · Writer · active · Write the draft`))
  assert.equal(reloaded.rt.taskNote('r1', id, 'note').task.notes.length, 1)

  delete reloaded.state.rooms.r1
  assert.equal(await reloaded.tool({ action: 'show' }, 'gb'), 'group_task works inside a group chat, where the work belongs to the group. Call it from your group session.')
})

test('a panel note reaches the task owner as a user message, and both panel actions save the board', async (t) => {
  const host = await start(t)
  assert.match(await host.tool({ action: 'open', goal: 'Write the draft' }, 'gb'), /^Opened t_/)
  const id = Object.keys(host.saved().rooms.r1.tasks)[0]

  const noted = await host.call('task-note', { roomId: 'r1', id, text: 'Also add tests' })
  assert.equal(noted.ok, true)
  assert.equal(host.prompts.length, 1)
  assert.equal(host.prompts[0].sessionId, 'r1')
  assert.equal(host.prompts[0].mode, 'queue')
  assert.equal(host.prompts[0].content[0].text, '@Writer Also add tests')
  const after = id => host.saved().rooms.r1.tasks[id]
  assert.equal(after(id).notes.at(-1).text, 'Also add tests')
  assert.ok(noted.value.rooms.find(room => room.id === 'r1').tasks[id].notes.length === 1)

  // A finished task takes no new note and the message is not posted.
  await host.tool({ action: 'complete', id, result: 'Draft delivered' }, 'gb')
  const refused = await host.call('task-note', { roomId: 'r1', id, text: 'Too late' })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.message, 'That task is already finished.')
  assert.equal(host.prompts.length, 1)

  const cancelled = await host.call('task-cancel', { roomId: 'r1', id })
  assert.equal(cancelled.ok, false)
  assert.equal(cancelled.error.message, 'That task is already finished.')

  // A second open task cancels from the panel without the group.
  await host.tool({ action: 'open', goal: 'Check the draft' }, 'ga')
  const second = Object.values(host.saved().rooms.r1.tasks).find(task => task.status === 'active')
  const done = await host.call('task-cancel', { roomId: 'r1', id: second.id })
  assert.equal(done.ok, true)
  assert.equal(after(second.id).status, 'cancelled')
  assert.equal(host.prompts.length, 1)
})


test('bulk deletion is scoped to the room and row type and survives a reload and duplicate request', async (t) => {
  const team = seed()
  const room = team.rooms.r1
  const receipt = (id, status) => ({ id, status, title: id, seq: 1, receivedAt: 1 })
  Object.assign(room, {
    notice: '[taskId]',
    tasks: { both: { id: 'both', botId: 'a', goal: 'Keep', status: 'active' }, old: { id: 'old', goal: 'Finished', status: 'done' } },
    projectCards: { both: { id: 'both', title: 'Remove', intakes: ['original', 'legacy'], rounds: [{ ownerId: 'b', assignedAt: 1 }] } },
    projectInbox: [receipt('keep', 'pending'), receipt('original', 'accepted'), receipt('pending', 'clarify')],
    log: [{ seq: 1, who: 'User', text: 'Original request', intakeId: 'original' }], seq: 1,
  })
  team.rooms.r2 = { ...structuredClone(room), id: 'r2', sessions: {} }
  const host = await start(t, team)
  const items = [{ kind: 'project', id: 'both' }, { kind: 'intake', id: 'pending' }, { kind: 'member', id: 'old' }]
  const del = items => host.call('task-delete', { roomId: 'r1', items })
  assert.equal((await del([...items, { kind: 'intake', id: 'original' }])).ok, false)
  assert.ok(host.saved().rooms.r1.projectCards.both)
  const other = host.saved().rooms.r2
  const [first, retry] = await Promise.all([del(items), del(items)])
  assert.equal(first.ok, true, first.error?.message)
  assert.equal(retry.ok, true, retry.error?.message)
  const saved = host.saved().rooms.r1
  assert.deepEqual(Object.keys(saved.tasks), ['both'])
  assert.deepEqual(saved.projectCards, {})
  assert.deepEqual(saved.projectInbox.map(item => item.id), ['keep'])
  assert.deepEqual(new Set(saved.deletedTaskIntakes), new Set(['original', 'legacy', 'pending']))
  assert.deepEqual(saved.log, room.log)
  assert.deepEqual(host.saved().rooms.r2, other)
  assert.equal((await host.call('project-task-detail', { roomId: 'r1', taskId: 'both' })).ok, false)
  await forwardProjectIntake(host.rt, saved, 'pending', 1)
  assert.equal(host.prompts.length, 0)
  host.rt.live.set('a', { info: { intakeId: 'legacy', roomId: 'r1' } })
  const project = host.rt.teamTools.find(tool => tool.name === 'project_task')
  await assert.rejects(project.execute({ action: 'assign', ownerId: 'b' }, { agent: { id: 'a' } }), /deleted from the task list/)
  assert.deepEqual(host.saved().rooms.r1.projectCards, {})
})

test('undoing a failed bulk delete restores the exact board, including previously absent fields', () => {
  const room = { projectCards: { p: { intakes: ['i'] }, child: { parentTaskId: 'p', title: 'Child' } }, projectInbox: [{ id: 'i', status: 'accepted' }] }
  const before = structuredClone(room)
  const undo = deleteBoardTasks(room, [{ kind: 'project', id: 'p' }])
  assert.deepEqual(room.projectCards, { child: { title: 'Child' } })
  undo()
  assert.deepEqual(room, before)
})

test('a finished task is immutable through every Bot action', async () => {
  for (const terminal of ['complete', 'cancel']) {
    const host = fakeHost()
    await host.tool({ action: 'open', goal: 'Deliver' }, 'gb')
    const id = host.tasks()[0].id
    await host.tool({ action: terminal, id, result: 'delivered', reason: 'stopped' }, 'gb')
    const saved = JSON.stringify(host.tasks())
    for (const action of ['update', 'complete', 'cancel']) {
      assert.equal(await host.tool({ action, id, status: 'active', progress: 'late', result: 'changed' }, 'gb'), 'That task is already finished.')
      assert.equal(JSON.stringify(host.tasks()), saved)
    }
  }
})

test('finished tasks stay in the board history beyond two hundred deliveries', async () => {
  const host = fakeHost()
  for (let i = 0; i < 205; i++) {
    await host.tool({ action: 'open', goal: `Deliver ${i}` }, 'gb')
    await host.tool({ action: 'complete', result: `Result ${i}` }, 'gb')
  }
  assert.equal(host.tasks().length, 205)
  assert.ok(host.tasks().some(task => task.goal === 'Deliver 0'))
})

const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}

test('a member\'s failed turn marks its open tasks failed in the group with the reason; a completed turn lifts it', async (t) => {
  const host = await start(t)
  await host.tool({ action: 'open', goal: 'Write the draft' }, 'gb')
  await host.tool({ action: 'open', goal: 'Review the plan' }, 'ga')
  const task = goal => Object.values(host.saved().rooms.r1.tasks).find(item => item.goal === goal)

  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'QUOTA', status: 402, message: 'Insufficient balance' } } })
  await settle(() => task('Write the draft').status === 'failed')
  const { at, ...blocked } = task('Write the draft').blocked
  assert.ok(at > 0)
  assert.deepEqual(blocked, { by: 'system', cause: 'failed', code: 'QUOTA', status: 402, from: 'active' })
  assert.equal(task('Review the plan').status, 'active')

  host.emit('gb', 'turn/start', { turn: 2 })
  host.emit('gb', 'turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'socket hang up' } } })
  await settle(() => task('Write the draft').blocked.code === 'TRANSPORT')
  assert.equal(task('Write the draft').blocked.status, undefined)
  assert.equal(task('Write the draft').blocked.from, 'active')
  host.emit('gb', 'turn/start', { turn: 3 })
  host.emit('gb', 'turn/end', { turn: 3, reason: { kind: 'error', error: { code: 'QUOTA', status: 402, message: 'Insufficient balance' } } })
  await settle(() => task('Write the draft').blocked.code === 'QUOTA')
  assert.match(await host.tool({ action: 'show' }, 'ga'), /· Writer · failed · Write the draft\n {2}blocked by DS Bot: its model call failed \(QUOTA 402\)/)

  host.emit('gb', 'turn/start', { turn: 4 })
  host.emit('gb', 'turn/end', { turn: 4, reason: { kind: 'completed' } })
  await settle(() => task('Write the draft').status === 'active')
  assert.equal(task('Write the draft').blocked, undefined)
})

test('the user stopping a member blocks its open tasks; a block the Bot set itself stays', async (t) => {
  const host = await start(t)
  await host.tool({ action: 'open', goal: 'Write the draft' }, 'gb')
  await host.tool({ action: 'open', goal: 'Wait for the data' }, 'gb')
  await host.tool({ action: 'update', status: 'blocked', progress: 'No data yet' }, 'gb')
  const task = goal => Object.values(host.saved().rooms.r1.tasks).find(item => item.goal === goal)

  host.emit('gb', 'turn/start', { turn: 1 })
  assert.equal((await host.call('stop-member-work', { roomId: 'r1', botId: 'b' })).value, true)
  await settle(() => task('Write the draft').status === 'blocked')
  assert.equal(task('Write the draft').blocked.cause, 'stopped')
  assert.equal(task('Wait for the data').blocked, undefined)

  // The Bot picks the work up again itself.
  await host.tool({ action: 'update', id: task('Write the draft').id, status: 'active' }, 'gb')
  assert.equal(task('Write the draft').status, 'active')
  assert.equal(task('Write the draft').blocked, undefined)

  // A completed turn lifts only what DS Bot blocked.
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(task('Wait for the data').status, 'blocked')
})

test('a turn picked up after a restart that leaves a task untouched blocks it; one that updates it keeps it running', async (t) => {
  const host = await start(t)
  await host.tool({ action: 'open', goal: 'Write the draft' }, 'gb')
  await host.tool({ action: 'open', goal: 'Check the facts' }, 'gb')
  const task = goal => Object.values(host.saved().rooms.r1.tasks).find(item => item.goal === goal)
  await new Promise(resolve => setTimeout(resolve, 5))

  host.emit('gb', 'user/message', { source: { kind: 'bot', role: 'resume', resumed: true }, content: [{ type: 'text', text: '[DeepSeek Harness restarted while you were working]\nGo on.' }] })
  host.emit('gb', 'turn/start', { turn: 1 })
  await host.tool({ action: 'update', id: task('Check the facts').id, progress: 'Two sources left' }, 'gb')
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => task('Write the draft').status === 'blocked')
  const { at, ...blocked } = task('Write the draft').blocked
  assert.deepEqual(blocked, { by: 'system', cause: 'restarted', from: 'active' })
  assert.equal(task('Check the facts').status, 'active')
  assert.match(await host.tool({ action: 'show' }, 'ga'), /blocked by DS Bot: not updated after DeepSeek Harness restarted/)

  // Finishing a task DS Bot blocked leaves no block behind.
  await host.tool({ action: 'complete', id: task('Write the draft').id, result: 'Draft delivered' }, 'gb')
  assert.equal(task('Write the draft').status, 'done')
  assert.equal(task('Write the draft').blocked, undefined)
})

test('project detail edits persist Markdown per field and keep the original intake and later supplements', async t => {
  const team = seed()
  const first = 'intake-11111111-1111-4111-8111-111111111111'
  const later = 'intake-22222222-2222-4222-8222-222222222222'
  const card = { id: 'card', title: 'Title', acceptance: 'Old criteria', intakes: [first], rounds: [{ ownerId: 'b', plan: 'Work', assignedAt: 1 }] }
  team.rooms.r1.taskManagementEnabled = true
  team.rooms.r1.projectCards = { card }
  const host = await start(t, team)
  await host.rt.load()
  const room = host.rt.roomOf('r1')
  const log = (intakeId, text) => host.rt.logRoom(room, { who: 'User', intakeId, text, session: true })
  log(later, 'Earlier unlinked message')
  log(first, 'Original **request**')
  const target = { roomId: 'r1', taskId: 'card' }
  const read = async () => (await host.call('project-task-detail', { ...target, textOnly: true })).value
  const edit = (field, previous, value) => host.call('update-project-task-text', { ...target, field, previous, value })
  const handoff = () => developmentHandoff(host.rt, 'ga', room, room.projectCards.card, 'b', 1).text
  assert.deepEqual(await read(), { requirement: 'Original **request**', acceptance: 'Old criteria' })
  assert.ok(handoff().includes(`[${first}] Original **request**`))

  const requirement = '## Revised request\n\n- Keep **formatting**'
  const acceptance = '    indented code\n\n1. Check the result  \n   on a new line'
  const writes = await Promise.all([edit('requirement', 'Original **request**', requirement), edit('acceptance', 'Old criteria', acceptance)])
  assert.deepEqual(writes.map(r => r.ok), [true, true])
  assert.deepEqual(await read(), { requirement, acceptance })
  assert.ok(handoff().includes(requirement) && handoff().includes(acceptance))
  assert.ok(!handoff().includes('Original **request**'))
  assert.equal(host.saved().rooms.r1.projectCards.card.acceptance, acceptance)
  assert.equal(host.saved().rooms.r1.projectCards.card.goal, requirement)
  assert.equal((await edit('requirement', 'Original **request**', requirement)).ok, true)
  assert.equal((await edit('requirement', 'Original **request**', 'stale change')).ok, false)
  assert.equal((await edit('status', '', 'done')).ok, false)
  assert.equal((await edit('acceptance', acceptance, '  ')).ok, false)

  log(first, 'Follow-up')
  room.projectCards.card.intakes.push(later)
  assert.deepEqual(await read(), { requirement, acceptance })
  assert.ok(handoff().includes('Earlier unlinked message') && handoff().includes('Follow-up'))
  const full = (await host.call('project-task-detail', target)).value
  assert.deepEqual(full.requirementHistory, [{ text: 'Original **request**', images: [] }])
  assert.deepEqual(host.saved().rooms.r1.projectCards.card.requirementHistory, full.requirementHistory)
  assert.deepEqual(full.requirements.map(line => line.text), [`[${later}] Earlier unlinked message`, `[${first}] Original **request**`, `[${first}] Follow-up`])
  assert.equal((await host.call('update-project-task-text', { ...target, roomId: 'missing', field: 'acceptance', previous: acceptance, value: 'Wrong room' })).error.code, 'GROUP_CONTEXT_REQUIRED')
})

test('a legacy user edit recovers the original intake before the next version is saved', async t => {
  const team = seed()
  const intakeId = 'intake-11111111-1111-4111-8111-111111111111'
  const card = { id: 'card', title: 'Time', intakes: [intakeId], rounds: [], goal: 'MM-dd HH:mm:ss' }
  Object.assign(team.rooms.r1, { taskManagementEnabled: true, projectCards: { card } })
  const host = await start(t, team)
  await host.rt.load()
  const room = host.rt.roomOf('r1')
  const original = host.rt.logRoom(room, { who: 'User', intakeId, text: 'MM:dd HH:mm:ss', session: true })
  const target = { roomId: room.id, taskId: card.id }
  const read = async () => (await host.call('project-task-detail', target)).value
  const stored = room.projectCards.card
  stored.requirementSources = [original.seq]
  assert.deepEqual((await read()).requirementHistory, [])
  stored.fieldEditTimes = { requirement: 10 }
  const v1 = { text: 'MM:dd HH:mm:ss', images: [] }
  assert.deepEqual((await read()).requirementHistory, [v1])
  assert.equal((await read()).requirement, card.goal)
  const edit = { ...target, field: 'requirement', previous: stored.goal, value: 'Show seconds' }
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await host.call('update-project-task-text', edit)).ok, true)
  assert.deepEqual(host.saved().rooms.r1.projectCards.card.requirementHistory, [v1, { text: 'MM-dd HH:mm:ss', images: [] }])
  assert.equal((await read()).requirement, edit.value)
})

test('task fields show original annotation images and save separate pictures for acceptance and requirements', async t => {
  const team = seed()
  const intake = 'intake-11111111-1111-4111-8111-111111111111'
  const card = { id: 'card', title: 'Annotation', acceptance: 'Compare', intakes: [intake], rounds: [{ ownerId: 'b', plan: 'Check', assignedAt: 1 }] }
  Object.assign(team.rooms.r1, { taskManagementEnabled: true, projectCards: { card, other: { ...card, id: 'other', intakes: [] } } })
  const attachments = fakeAttachments()
  const original = await attachments.saveImage({ mediaType: 'image/png', width: 1, height: 1, data: Buffer.from([1]) })
  const host = await start(t, team, { attachments })
  await host.rt.load()
  const room = host.rt.roomOf('r1')
  const text = '【网页批注】1 处\n截图：1 张（编号对应）'
  host.rt.logRoom(room, { who: 'User', intakeId: intake, text, images: [original], session: true })
  const target = { roomId: room.id, taskId: card.id }
  const read = async (extra = {}) => (await host.call('project-task-detail', { ...target, textOnly: true, ...extra })).value
  const edit = (field, previous, value, images) => host.call('update-project-task-text', { ...target, field, previous, value, ...images })
  const stage = async (data) => (await host.call('stage-image', { mediaType: 'image/png', data })).value.id
  assert.deepEqual((await read()).sourceImages, [original])
  assert.equal(await read({ imageId: original.attachmentId }), 'data:image/png;base64,AQ==')
  assert.equal((await host.call('project-task-detail', { ...target, taskId: 'other', imageId: original.attachmentId })).error.code, 'bot/not-found')
  assert.equal((await edit('requirement', text, 'Revised', {})).ok, true)
  assert.equal((await edit('acceptance', 'Compare', 'Compare', { addImages: [await stage('Ag==')] })).ok, true)
  const acceptanceImage = (await read()).fieldImages.acceptance[0]
  assert.equal(await read({ imageId: acceptanceImage.attachmentId }), 'data:image/png;base64,Ag==')
  assert.equal((await edit('requirement', 'Revised', 'Revised', { addImages: [await stage('Aw==')] })).ok, true)
  const detail = await read()
  const requirementImage = detail.fieldImages.requirement[0]
  assert.deepEqual(detail.sourceImages, [original])
  assert.deepEqual(host.saved().rooms.r1.projectCards.card.fieldImages, detail.fieldImages)
  assert.deepEqual(developmentHandoff(host.rt, 'ga', room, room.projectCards.card, 'b', 1).images.map(ref => ref.attachmentId),
    [original, requirementImage, acceptanceImage].map(ref => ref.attachmentId))
  assert.equal((await edit('acceptance', 'Compare', 'Compare', { removeImages: [acceptanceImage.attachmentId] })).ok, true)
  assert.equal((await host.call('project-task-detail', { ...target, imageId: acceptanceImage.attachmentId })).error.code, 'bot/not-found')
  assert.deepEqual((await read()).fieldImages.requirement, [requirementImage])
  await edit('requirement', 'Revised', 'Revised', { removeImages: [requirementImage.attachmentId] })
  const history = (await host.call('project-task-detail', target)).value.requirementHistory
  assert.deepEqual(history.map(entry => entry.text), [text, 'Revised', 'Revised'])
  assert.deepEqual(history.at(-1).images, [original, requirementImage])
  assert.equal(await read({ imageId: requirementImage.attachmentId }), 'data:image/png;base64,Aw==')
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SOURCE_KIND } from '../src/host/constants.js'
import { dispatchedRound, pendingAfterFailure, recoveryInput, scopedModelInput, reconcileProjectRounds, restoreFailedProjects } from '../src/host/project-execution.js'
import { projectSources } from '../src/host/project-tasks.js'
import { inspectRecovery } from '../src/host/project-recovery.js'
import { projectStatus } from '../src/host/project-status.js'

function fixture() {
  const source = { kind: SOURCE_KIND, role: 'request', taskId: 'card', exchangeId: 'dispatch', roomId: 'r' }
  const round = { dispatchId: source.exchangeId, ownerId: 'dev', startedAt: 1 }
  const room = { id: 'r', projectCards: { card: { id: 'card', intakes: ['ticket'], rounds: [round] } } }
  const image = { id: 'original.png' }
  const todos = ['completed', 'in_progress', 'pending'].map(status => ({ status, content: status }))
  const events = [
    { type: 'turn/start', data: { turn: 7 } },
    { type: 'user/message', data: { source, content: [{ type: 'text', text: 'Fix the dates' }] } },
    { type: 'tool/call', data: { name: 'write', arguments: JSON.stringify({ path: '/snapshot/date-format.test.mjs' }) } },
    { type: 'todo/write', data: { todos } },
    { type: 'compaction/start', data: { compactionId: 'cp' } },
  ]
  const bot = { id: 'dev', failures: { chat: { turn: 7, at: 123 } } }
  const session = { seq: 30, append(type, data) { events.push({ type, data }); this.seq++ } }
  const rt = { chatOf: () => 'chat', load: async () => {}, readOnly: () => undefined, save: async () => {},
    resolveAgent: async () => ({ session }), state: { rooms: { r: room }, bots: { dev: bot } }, chatOwners: new Map([['chat', 'dev']]),
    ctx: { sessionController: { inspect: async () => ({ events }) } }, ledger: { records: () => [
      { who: 'User', seq: 1, intakeId: 'ticket', text: 'Fix the dates', images: [image] },
      { who: 'User', seq: 2, intakeId: 'other', text: 'another request', images: [{ id: 'unrelated.png' }] },
    ] } }
  return { source, round, rt, events, image, todos }
}

test('a direct answer in a reused session is included only in the model input for the task that asked', async () => {
  const { rt, source } = fixture()
  rt.roomOf = () => ({ projectReplyScopes: { answer: 'card' } })
  const question = { role: 'user', content: 'Check project details', source }
  const answer = { role: 'user', id: 'answer', source: { kind: 'user' }, content: 'Staging only' }
  const other = { role: 'user', source: { ...source, taskId: 'other' } }
  const input = [question, other, answer]
  const current = await scopedModelInput(rt, 'chat', input, { info: source })
  assert.deepEqual(current.map(m => m.content), [question.content, answer.content])
  assert.equal(current[1].source.taskId, 'card')
  assert.deepEqual(await scopedModelInput(rt, 'chat', input, { info: other.source }), [other])
})

test('a compacted dispatch restores the screenshot and edited paths and retains only its later steps', async () => {
  const { source, rt, image } = fixture()
  const system = { role: 'system', content: 'shared rules' }
  const checkpoint = { role: 'user', content: 'private mixed summary', source: { kind: 'compact-checkpoint', compactionId: 'cp' } }
  const step = { role: 'assistant', content: 'current tool call' }
  const other = { role: 'user', content: 'other card', source: { ...source, taskId: 'other' } }
  const entry = { turn: 7, info: source }
  const result = await scopedModelInput(rt, 'chat', [system, checkpoint, step, other], entry)
  assert.equal(result[0], system)
  assert.equal(result[1].source, source)
  assert.deepEqual(result[1].content.filter(p => p.type === 'image').map(p => p.attachment), [image])
  assert.match(JSON.stringify(result[1]), /date-format.test.mjs/)
  assert.equal(result[2], step)
  assert.doesNotMatch(JSON.stringify(result), /unrelated.png|mixed summary|other card/)
  assert.equal(result.length, 3)
  assert.equal(dispatchedRound(rt, 'otherBot', source), undefined)
  assert.deepEqual(await scopedModelInput(rt, 'chat', [system, { ...checkpoint, source: { ...checkpoint.source, compactionId: 'older' } }], entry), [system])
})

test('reopening the same failed dispatch clears only in-progress todos and corrects its card once', async () => {
  const { rt, source, round, events, image, todos } = fixture()
  events.push({ type: 'turn/end', data: { turn: 7, reason: { kind: 'error' } } })
  await restoreFailedProjects(rt)
  assert.equal(projectStatus(round), 'failed')
  assert.deepEqual(events.at(-1).data.todos.map(t => t.status), ['completed', 'pending', 'pending'])
  const count = events.length
  await restoreFailedProjects(rt)
  assert.equal(events.length, count)
  assert.deepEqual(pendingAfterFailure(todos).map(t => t.content), todos.map(t => t.content))
  const input = recoveryInput(rt, source, events, dispatchedRound(rt, 'chat', source))
  assert.deepEqual(input.content.filter(p => p.type === 'image').map(p => p.attachment), [image])
  assert.match(JSON.stringify(input), /snapshot\/date-format/)
  events.push({ type: 'turn/start', data: { turn: 8 } })
  delete round.failedAt
  await restoreFailedProjects(rt)
  assert.equal(projectStatus(round), 'active')
})

test('a text-only copy of the same annotation recovers its original image without borrowing another card', () => {
  const { rt, image } = fixture()
  const room = rt.state.rooms.r
  const text = '【网页批注】1 处 · 工程记忆\n页面：http://localhost/example\n截图：1 张\n改时间格式'
  rt.ledger.records = () => [
    { seq: 1, who: 'User', intakeId: 'old', text, images: [image] },
    { seq: 2, who: 'User', intakeId: 'other', text: 'Hello' },
    { seq: 3, who: 'User', intakeId: 'ticket', text },
  ]
  assert.deepEqual(projectSources(rt, room, ['ticket'], 'card').map(row => row.seq), [1, 3])
  room.projectCards.other = { id: 'other', intakes: ['old'] }
  assert.deepEqual(projectSources(rt, room, ['ticket'], 'card').map(row => row.seq), [3])
})

test('reconciliation keeps the live dispatch across a plugin reload and blocks only unconfirmed work', async () => {
  const { source, rt, round, events } = fixture()
  const card = rt.state.rooms.r.projectCards.card
  const running = { status: 'running', session: { seq: events.length, snapshotEvents: () => events } }
  const live = { turn: -1 }
  Object.assign(rt, {
    resolveAgent: async id => id === 'chat' ? running : { status: 'idle' },
    chatOf: id => id === 'dev' ? 'chat' : 'other',
    roomOf: id => rt.state.rooms[id], redactSecrets: s => s,
    live: new Map([['chat', live]]), save: async ({ mutate }) => { mutate() },
  })
  card.plans = [{ version: 1 }]
  round.planNode = { version: 1, node: 1, inputs: [] }
  const stopped = { ownerId: 'tester', startedAt: 1, dispatchId: 'other-exchange', planNode: { version: 1, node: 2, inputs: [] } }
  card.rounds.push(stopped)
  await reconcileProjectRounds(rt, 5)
  assert.equal(live.info?.exchangeId, source.exchangeId)
  assert.equal(round.planNode.block, undefined)
  assert.equal(stopped.planNode.block.cause, 'restart')
})

test('a replacement for an independent reviewer cannot have produced the approved input', async () => {
  const room = { members: ['admin', 'dev', 'reviewer'] }
  const card = { id: 'card', plans: [{ version: 1, nodes: [{}, { independentReview: 1 }] }], rounds: [
    { ownerId: 'dev', planNode: { node: 1, version: 1, artifact: 'build' } },
    { ownerId: 'reviewer', planNode: { node: 2, version: 1, inputs: [{ node: 1, round: 1 }], block: { decisions: [] } } },
  ] }
  const target = { version: 1, node: 2, round: 2, ownerId: 'dev' }
  await assert.rejects(inspectRecovery({}, room, card, target, 'admin'), /independent of the upstream producer/)
})

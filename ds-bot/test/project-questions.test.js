import { savePlan } from '../src/host/project-plan.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { setProjectQuestions, publicProjectQuestions, questionBlocksNode } from '../src/host/project-questions.js'
import { readSplitTeam } from '../src/host/team-storage/split.js'

const taskId = '192d54c8-8f7e-4a22-8b3a-6375dffed36b'
const card = () => ({ id: taskId, title: 'Daily chat table', acceptance: 'Real table', intakes: [], rounds: [], plans: [{ version: 1, at: 1, by: 'b', nodes: [1, 2].map(no => ({ no, ownerId: 'c', title: 'Step ' + no, instructions: 'Inspect', deliverable: 'Evidence', acceptance: 'Checked', dependsOn: [] })) }] })
async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-project-questions-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, revision: 0, mainBotIds: ['a'], bots: Object.fromEntries(['a','b','c'].map(id => [id, { id, name: id, role: id, sessionId: id, createdAt: 1 }])), rooms: { r1: { id: 'r1', name: 'Data', members: ['a','b','c'], mode: 'admin', admin: 'a', projectAssistantId: 'b', taskManagementEnabled: true, sessions: { a: 'ga', b: 'gb', c: 'gc' }, seen: {}, log: [], seq: 0, projectCards: { [taskId]: card() } } }, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {} }))
  const received = []
  const contexts = []
  const open = async () => {
    const ctx = fakeContext()
    Object.assign(ctx, { llm: { listProviders: () => [] }, sessions: { flush: async () => {} },
      workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async () => ({ id: 'w' }), archiveSession: async () => {} },
      sessionController: { page: async ({ address }) => ({ records: received.filter(item => item.id === address.sessionId).map((item, seq) => ({ seq: seq + 1, event: { type: 'user/message', data: item.message } })), hasMore: false }), resolveAgent: async id => ({ agent: { id, session: { id }, followup(message) { received.push({ id, message }) }, inbox: { nextTurn: [], nextStep: [] } } }), selectModel: async () => {} }, sessionTitle: { rename: async () => {} } })
    const rt = createRuntime(ctx, { home })
    contexts.push(ctx)
    await rt.load()
    return { rt, ctx, room: rt.roomOf('r1') }
  }
  t.after(async () => { for (const ctx of contexts) await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  return { ...await open(), open, home, received }
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail('Answer did not reach the original task coordinator')
}

test('focused questions persist individually, block only named nodes, and notify admin and assistant on the original card', async t => {
  const { rt, room, home, received } = await start(t)
  const target = room.projectCards[taskId]
  setProjectQuestions(rt, room, target, { questions: [{ question: 'Which chat window?', options: [{ label: 'Course period' }, { label: 'All messages' }], nodes: [1] }, { question: 'History starts on which date?', nodes: [2] }] }, 'a')
  await rt.save({ required: true })
  const [one, two] = target.questions
  assert.equal(questionBlocksNode(target, 1), true)
  assert.equal(questionBlocksNode(target, 2), true)
  await rt.answerProjectQuestion({ roomId: 'r1', taskId, questionId: one.id, answer: { selected: ['Course period'] } })
  assert.equal(questionBlocksNode(target, 1), false)
  assert.equal(questionBlocksNode(target, 2), true)
  assert.ok(target.clarification)
  await until(() => { if (one.answer.error) assert.fail(one.answer.error); return one.answer.deliveredAt })
  assert.deepEqual(received.map(item => item.id).sort(), ['ga', 'gb'])
  assert.ok(received.every(item => item.message.source.taskId === taskId))
  await rt.answerProjectQuestion({ roomId: 'r1', taskId, questionId: two.id, answer: { custom: '2026-01-01' } })
  await until(() => { if (two.answer.error) assert.fail(two.answer.error); return two.answer.deliveredAt })
  assert.equal(target.clarification, undefined)
  const saved = readSplitTeam(join(home, 'state')).rooms.r1.projectCards[taskId]
  assert.equal(saved.questions[1].answer.text, '2026-01-01')
  assert.equal(saved.questions[0].answer.by, 'user')
})

test('duplicate, stale, cross-task and invalid answers cannot replace a saved decision', async t => {
  const { rt, room, received } = await start(t)
  const target = room.projectCards[taskId]
  setProjectQuestions(rt, room, target, { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }, 'a')
  await rt.save({ required: true })
  const args = { roomId: 'r1', taskId, questionId: target.questions[0].id, answer: { selected: ['A'] } }
  await Promise.all([rt.answerProjectQuestion(args), rt.answerProjectQuestion(args)])
  await until(() => target.questions[0].answer.deliveredAt)
  assert.equal(received.length, 2)
  await assert.rejects(rt.answerProjectQuestion({ ...args, answer: { selected: ['B'] } }), /already answered/)
  await assert.rejects(rt.answerProjectQuestion({ ...args, taskId: 'another' }), /enabled task/)
  await assert.rejects(rt.answerProjectQuestion({ ...args, answer: { selected: ['Not offered'] } }), /listed answer/)
  setProjectQuestions(rt, room, target, { questions: [{ question: 'A new decision?' }] }, 'a')
  const old = target.questions.at(-1).id
  setProjectQuestions(rt, room, target, { questions: [{ question: 'A replacement?' }] }, 'a')
  await assert.rejects(rt.answerProjectQuestion({ ...args, questionId: old }), /no longer open/)
})

test('an answer saved before shutdown is delivered after restart and private origin stays out of card projections', async t => {
  const { rt, room, open, ctx, home, received } = await start(t)
  const target = room.projectCards[taskId]
  room.projectIntakeOrigins = { original: { connId: 'private-conn', chatKey: 'private-chat', senderId: 'u1', binding: 'room:r1' } }
  target.intakes = ['original']
  setProjectQuestions(rt, room, target, { questions: [{ question: 'Choose scope', options: [{ label: 'A' }] }] }, 'a')
  const question = target.questions[0]
  question.answer = { text: 'A', selected: ['A'], custom: '', at: 1, by: 'user' }
  await rt.save({ required: true })
  await ctx.dispose()
  assert.ok(!JSON.stringify(publicProjectQuestions(target)).includes('private-chat'))
  const next = await open()
  await until(() => next.room.projectCards[taskId].questions[0].answer.deliveredAt)
  assert.equal(received.length, 2)
  assert.equal(readSplitTeam(join(home, 'state')).rooms.r1.projectCards[taskId].questions[0].answer.text, 'A')
})

test('a pending question follows its work item after a plan reorder', async t => {
  const { rt, room } = await start(t)
  const target = room.projectCards[taskId]
  setProjectQuestions(rt, room, target, { questions: [{ question: 'Which date?', nodes: [2] }] }, 'a')
  const [first, second] = target.plans[0].nodes
  savePlan(target, { version: 2, reason: 'Reorder', nodes: [{ ...second, itemId: '1:2' }, { ...first, itemId: '1:1' }] }, room, 'b')
  assert.equal(questionBlocksNode(target, 1), true)
  assert.equal(questionBlocksNode(target, 2), false)
})

test('legacy question migration serializes two different answers and keeps the first decision', async t => {
  const { rt, room } = await start(t)
  const target = room.projectCards[taskId]
  target.clarification = 'Which date?'
  await rt.save({ required: true })
  const args = { roomId: 'r1', taskId, questionId: 'legacy' }
  const results = await Promise.allSettled([rt.answerProjectQuestion({ ...args, answer: { custom: '2026-01-01' } }), rt.answerProjectQuestion({ ...args, answer: { custom: '2025-01-01' } })])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(target.questions[0].answer.text, '2026-01-01')
})

test('coordinator changes to the card during delivery do not lose recipient receipts or duplicate messages', async t => {
  const { rt, room, received } = await start(t)
  const target = room.projectCards[taskId]
  setProjectQuestions(rt, room, target, { questions: [{ question: 'Which date?' }] }, 'a')
  await rt.save({ required: true })
  const resolve = rt.resolveAgent
  let replaced = false
  rt.resolveAgent = async id => {
    const agent = await resolve(id)
    if (id === 'ga' && !replaced) {
      const followup = agent.followup
      agent.followup = message => { followup(message); room.projectCards[taskId] = structuredClone(room.projectCards[taskId]); replaced = true }
    }
    return agent
  }
  await rt.answerProjectQuestion({ roomId: 'r1', taskId, questionId: target.questions[0].id, answer: { custom: '2026-01-01' } })
  await until(() => room.projectCards[taskId].questions[0].answer.deliveredAt)
  assert.equal(received.length, 2)
  assert.equal(Object.keys(room.projectCards[taskId].questions[0].answer.deliveries).length, 2)
})

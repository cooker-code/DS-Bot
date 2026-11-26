// Isolated mock-model project flow. prepare leaves two real task questions for UI inspection.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { modelsFor } from '../src/client/agent-routes.js'
import { readSplitTeam } from '../src/host/team-storage/split.js'

const [name, port, mode = 'prepare'] = process.argv.slice(2)
if (!/^[a-z0-9-]+$/.test(name ?? '') || !/^\d+$/.test(port ?? '')) throw new Error('Provide an isolated bench name and port.')
const home = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), '.dsh-test-' + name)
const base = 'http://127.0.0.1:' + port
const login = readFileSync(join(home, 'web.log'), 'utf8').match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`))?.[0]
if (!login) throw new Error('No isolated bench login announcement.')
const response = await fetch(login, { redirect: 'manual' })
const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
async function api(endpoint, payload = {}) {
  const response = await fetch(base + '/api/bot', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ endpoint, payload }) })
  const result = await response.json()
  if (!result.ok) throw new Error(endpoint + ': ' + result.error?.message)
  return result.value
}
const state = () => readSplitTeam(join(home, 'bot', 'state'))
async function until(check) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 200)) }
  throw new Error('The project question flow did not reach its expected state.')
}
let group = Object.values(state().rooms).find(room => room.name === 'Project questions acceptance')
if (mode === 'prepare') {
  const initial = await api('state')
  const chief = Object.values(state().bots).find(bot => bot.name === 'Chief')
  const model = modelsFor(initial.models).at(-1).ref
  await api('update-bot', { id: chief.id, model })
  const members = await Promise.all(['Coder', 'Tester', 'Assistant'].map(name => api('create-bot', { name, model })))
  group = await api('create-room', { name: 'Project questions acceptance', members: [chief.id, ...members.map(bot => bot.id)], admin: chief.id })
  await api('update-room', { id: group.id, projectAssistantId: members[2].id })
  await api('send', { sessionId: group.id, text: 'Create the daily chat detail table. native-project-question-smoke' })
}
if (!group) throw new Error('Prepare the isolated scenario first.')
const room = () => state().rooms[group.id]
const card = await until(() => Object.values(room().projectCards ?? {}).find(card => card.plans?.at(-1)?.version === 2 && card.questions?.length === 2))
const detail = await api('project-task-detail', { roomId: group.id, taskId: card.id })
assert.equal(detail.plans[1].nodes[0].status, 'verified')
assert.equal(detail.plans[1].nodes[0].reuseRound, 1)
assert.equal(detail.plans[1].nodes[0].itemId, '1:1')
if (mode === 'answer') {
  await api('answer-project-question', { roomId: group.id, taskId: card.id, questionId: card.questions[0].id, answer: { selected: ['Course service period'] } })
  await api('answer-project-question', { roomId: group.id, taskId: card.id, questionId: card.questions[1].id, answer: { custom: '2026-01-01' } })
}
if (mode !== 'prepare') {
  await until(() => { const current = room().projectCards[card.id]; return current.questions.every(question => question.answer?.deliveredAt) && current.rounds.some(round => round.planNode.version === 2 && round.startedAt) })
  assert.equal(Object.keys(room().projectCards).length, 1)
  assert.equal(room().projectCards[card.id].questions[1].answer.text, '2026-01-01')
}
console.log(JSON.stringify({ result: 'passed', mode, roomId: group.id, taskId: card.id, planVersion: 2, carriedCompletion: true, questions: 2, continuedOnOriginalCard: mode !== 'prepare' }))

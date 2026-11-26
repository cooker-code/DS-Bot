// Run against an isolated mock bench: node dev/project-handoff-smoke.mjs <name> <port>
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { modelsFor } from '../src/client/agent-routes.js'
import { readSplitTeam } from '../src/host/team-storage/split.js'

const [name, port] = process.argv.slice(2)
if (!/^[a-z0-9-]+$/.test(name ?? '') || !/^\d+$/.test(port ?? '')) throw new Error('Provide an isolated bench name and port.')
const home = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), '.dsh-test-' + name)
const base = 'http://127.0.0.1:' + port
const login = readFileSync(join(home, 'web.log'), 'utf8').match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`))?.[0]
if (!login) throw new Error('No login announcement for the isolated bench.')
const response = await fetch(login, { redirect: 'manual' })
const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
if (!cookie) throw new Error('The isolated bench did not issue a session.')
async function api(endpoint, payload = {}) {
  const response = await fetch(base + '/api/bot', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ endpoint, payload }) })
  const result = await response.json()
  if (!result.ok) throw new Error(endpoint + ': ' + result.error?.message)
  return result.value
}
const state = () => readSplitTeam(join(home, 'bot', 'state'))
async function until(check) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('The normal handoff flow did not reach its expected state.')
}

const initial = await api('state')
assert.equal(initial.readOnly ?? null, null)
const chief = Object.values(state().bots).find(bot => bot.name === 'Chief')
const model = modelsFor(initial.models).at(-1).ref
await api('update-bot', { id: chief.id, model })
const coder = await api('create-bot', { name: 'Coder', model })
const assistant = await api('create-bot', { name: 'Assistant', model })
const group = await api('create-room', { name: 'Handoff recovery smoke', members: [chief.id, coder.id, assistant.id], admin: chief.id })
const room = () => state().rooms[group.id]
await api('send', { sessionId: group.id, text: 'Create a daily source inventory. native-project-handoff-smoke' })
const original = await until(() => Object.values(room().projectCards ?? {})[0])
assert.equal(original.plans.length, 0)
assert.equal(original.rounds.length, 0)
assert.equal(original.goal, undefined)

// Appointment is the only recovery trigger; no operator message or retry command is sent.
await api('update-room', { id: group.id, projectAssistantId: assistant.id })
const started = await until(() => room().projectCards[original.id].rounds?.find(round => round.startedAt))
const saved = room()
assert.deepEqual(Object.keys(saved.projectCards), [original.id])
const card = saved.projectCards[original.id]
assert.equal(card.managementHandoff.status, 'delivered')
assert.equal(card.managementHandoff.toId, assistant.id)
assert.match(card.goal, /Inspect the available source assets/)
assert.match(card.acceptance, /intended daily grain/)
assert.equal(card.plans[0].by, assistant.id)
assert.equal(started.ownerId, coder.id)
assert.equal(card.rounds.length, 1)

await new Promise(resolve => setTimeout(resolve, 5500))
assert.equal(room().projectCards[original.id].rounds.length, 1)
const calls = readFileSync(join(home, 'mock.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const actions = calls.flatMap(call => call.out ?? []).filter(block => block.type === 'tool_use' && block.name === 'project_task').map(block => block.input.action)
assert.ok(actions.includes('scan'))
assert.equal(actions.filter(action => action === 'retry_handoff').length, 1)
assert.equal(actions.filter(action => action === 'start').length, 1)
console.log(JSON.stringify({ result: 'passed', taskId: original.id, adminScanned: true, retriedOriginalCard: true,
  assistantPlanned: true, ownerStartedAt: started.startedAt, rounds: card.rounds.length, duplicateRetry: false }))

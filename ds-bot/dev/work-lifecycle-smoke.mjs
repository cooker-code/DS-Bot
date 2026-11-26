// Full explicit-work path on an isolated mock bench. Never use a daily profile.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { readSplitTeam } from '../src/host/team-storage/split.js'
import { modelsFor } from '../src/client/agent-routes.js'

const [name, port, evidence] = process.argv.slice(2)
if (!/^[a-z0-9-]+$/.test(name ?? '') || !/^\d+$/.test(port ?? '') || port === '3080') throw new Error('Use an isolated named mock bench and a test port.')
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const home = join(root, `.dsh-test-${name}`)
const base = `http://127.0.0.1:${port}`
const url = readFileSync(join(home, 'web.log'), 'utf8').match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`))?.[0]
if (!url) throw new Error('The test bench login announcement is missing.')
const login = await fetch(url, { redirect: 'manual' })
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
const api = async (endpoint, payload = {}) => {
  const response = await fetch(`${base}/api/bot`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, payload }) })
  const result = await response.json()
  assert.equal(result.ok, true, result.error?.message)
  return result.value
}
const saved = () => readSplitTeam(join(home, 'bot', 'state'))
const wait = async (condition, message, ms = 60000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await condition()) return; await delay(100) }
  throw new Error(message)
}
const quiet = async () => {
  let since = Date.now()
  await wait(async () => {
    const state = await api('state')
    if (Object.keys(state.activity ?? {}).length || Object.keys(state.partsRunning ?? {}).length || Object.keys(saved().workOutbox ?? {}).length || Object.keys(saved().protocolSends ?? {}).length) since = Date.now()
    return Date.now() - since > 1200
  }, 'Bots did not become idle')
}
const results = {}
const state = await api('state')
const chief = state.bots.find(bot => bot.name === 'Chief')
assert.ok(chief)
if (!chief.model) await api('update-bot', { id: chief.id, model: modelsFor(state.models).at(-1).ref })
await quiet()
const writer = state.bots.find(bot => bot.name === 'Writer') ?? await api('create-bot', { name: 'Writer', role: 'Writer', instructions: 'Follow the lifecycle test commands.' })
await quiet()
const send = (bot, text) => api('send', { sessionId: saved().bots[bot.id].sessionId ?? bot.id, text })
const liveWorks = () => Object.entries(saved().works ?? {}).filter(([, work]) => work.protocol)
const closed = () => Object.values(saved().works ?? {}).filter(work => work.protocolReceipt).length
const before = closed()
await send(chief, '验证协作 Writer')
await wait(() => closed() > before, 'The real DSH delegate/question/answer flow did not complete')
await quiet()
assert.ok((await api('exchange', { a: chief.id, b: writer.id })).some(entry => entry.role === 'reply' && entry.text.includes('FLOW2130:verified result')), 'the worker must return its real evidence, not a PASS')
assert.equal(liveWorks().length, 0)
assert.equal(Object.keys(saved().workOutbox ?? {}).length, 0)
results.callReturn = true
console.log('ok real DSH delegate → ask_back → answer_work → automatic result')

await send(writer, 'FLOW2130:foreground')
await wait(async () => Object.keys((await api('state')).activity ?? {}).length > 0, 'Foreground did not start')
const foreground = saved().bots[writer.id].sessionId ?? writer.id
const count = closed()
await send(chief, '验证协作 Writer now')
await wait(() => (saved().bots[writer.id].openParts ?? []).length > 0, 'Busy now did not create an independent thread')
assert.equal(saved().bots[writer.id].sessionId ?? writer.id, foreground)
await wait(() => closed() > count, 'Background work did not complete')
await quiet()
results.backgroundKeepsForeground = true
console.log('ok busy recipient uses an independent thread and keeps foreground')

await send(chief, '验证协作 Writer pause')
await wait(() => liveWorks().some(([, work]) => work.state === 'paused'), 'Repeated questions did not pause')
const [pausedId] = liveWorks().find(([, work]) => work.state === 'paused')
const snapshot = await api('state')
assert.equal(snapshot.work.delegated.find(work => work.id === pausedId).status, 'paused')
results.pauseId = pausedId
results.pauseVisibleState = true
console.log('ok repeated clarification pauses and appears in the UI state')
// Leave this paused work for browser Continue/Cancel verification. A later run
// can cancel it through the authenticated channel without opening another turn.
if (evidence) writeFileSync(evidence, JSON.stringify(results, null, 2))

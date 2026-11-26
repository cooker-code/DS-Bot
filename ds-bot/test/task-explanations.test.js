import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { explainTaskMessage, EXPLANATION_SYSTEM } from '../src/host/task-explanations.js'

async function setup(t) {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-explanation-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const bots = [{ id: 'lead', name: 'Lead' }, { id: 'dev', name: 'Developer' }]
  const card = { id: 'card', title: 'Verify the data', rounds: [] }
  const room = { id: 'group', members: bots.map(bot => bot.id), projectCards: { card }, sessions: {}, admin: 'lead' }
  const records = [{ id: 'm1', time: 1, roomId: 'group', taskId: 'card', from: 'lead', to: 'dev',
    text: '**节点3已 dispatch round4**；口径待确认，未授权生产写入。' }]
  const requests = []
  const rt = { home, state: { prefs: {} }, roomOf: id => id === room.id ? room : undefined, botOf: id => bots.find(bot => bot.id === id),
    readOnly: () => false, uiLanguage: () => 'Chinese (简体中文)', chatOf: id => id + '-session',
    ledger: { records: () => [] }, taskPairMessages: () => records,
    async botShot(...args) { requests.push(args); return '第 3 步已分配给开发，业务口径仍待确认，尚未获准写入生产。' } }
  const body = { roomId: 'group', taskId: 'card', messageKey: 'exchange-m1' }
  return { rt, records, card, room, requests, body }
}

test('concurrent clicks generate once, preserve the original and reuse a saved explanation after restart', async t => {
  const { rt, records, card, requests, body } = await setup(t)
  const original = JSON.stringify({ records, card })
  const [first, second] = await Promise.all([explainTaskMessage(rt, body), explainTaskMessage(rt, body)])
  assert.equal(requests.length, 1)
  assert.equal(first.text, second.text)
  assert.equal(first.cached, false)
  assert.equal(JSON.stringify({ records, card }), original)
  const restarted = { ...rt, readOnly: () => true, botShot() { throw new Error('must not call a model') } }
  const saved = await explainTaskMessage(restarted, body)
  assert.equal(saved.text, first.text)
  assert.equal(saved.generatedAt, first.generatedAt)
  assert.equal(saved.cached, true)
  assert.equal(requests[0][1], EXPLANATION_SYSTEM)
  const request = JSON.parse(requests[0][2])
  assert.equal(request.source.text, records[0].text)
  assert.equal(request.source.from, 'Lead')
  assert.equal(request.language, 'Chinese (简体中文)')
  assert.equal(requests[0][3].kind, 'task-explanation')
})

test('source changes invalidate saved text and languages retain separate explanations', async t => {
  const { rt, records, requests, body } = await setup(t)
  await explainTaskMessage(rt, body)
  await explainTaskMessage(rt, { ...body, language: 'English' })
  assert.equal((await explainTaskMessage(rt, body)).cached, true)
  assert.equal(requests.length, 2)
  records[0].text = '第 3 步尚未派工。'
  assert.equal((await explainTaskMessage(rt, body)).cached, false)
  assert.equal(requests.length, 3)
  assert.equal(JSON.parse(requests[2][2]).source.text, records[0].text)
})

test('a failed or empty model answer is not saved and the next click can retry', async t => {
  const { rt, body } = await setup(t)
  rt.botShot = async () => { throw new Error('provider unavailable') }
  await assert.rejects(explainTaskMessage(rt, body), /provider unavailable/)
  rt.botShot = async () => ''
  await assert.rejects(explainTaskMessage(rt, body), /wrote no explanation/)
  rt.botShot = async () => 'Still awaiting confirmation.'
  assert.equal((await explainTaskMessage(rt, body)).cached, false)
})

test('unknown cards, unrelated messages, partial sources and read-only generation cannot call a model', async t => {
  const { rt, records, requests, body } = await setup(t)
  await assert.rejects(explainTaskMessage(rt, { ...body, taskId: 'other-card' }), { code: 'bot/not-found' })
  await assert.rejects(explainTaskMessage(rt, { ...body, messageKey: 'other-message' }), /No recorded message/)
  await assert.rejects(explainTaskMessage(rt, { ...body, language: {} }), /Invalid explanation/)
  rt.readOnly = () => true
  await assert.rejects(explainTaskMessage(rt, body), { code: 'bot/read-only' })
  rt.readOnly = () => false
  records[0].length = 1000
  rt.exchangeText = async () => ({ text: records[0].text, whole: false })
  await assert.rejects(explainTaskMessage(rt, body), /full message is unavailable/)
  assert.equal(requests.length, 0)
})

test('losing the team write lock during generation does not save an explanation', async t => {
  const { rt, body } = await setup(t)
  rt.botShot = async () => { rt.readOnly = () => true; return 'Completed explanation' }
  await assert.rejects(explainTaskMessage(rt, body), { code: 'bot/read-only' })
  await assert.rejects(explainTaskMessage(rt, body), { code: 'bot/read-only' })
})

test('custom prompt reaches the model, invalidates previous text and resetting restores the default', async t => {
  const { rt, body, requests } = await setup(t)
  await explainTaskMessage(rt, body)
  rt.state.prefs.taskExplanationPrompt = '先说谁要做什么，再说明没定下来的事情对后续有什么影响。'
  assert.equal((await explainTaskMessage(rt, body)).cached, false)
  assert.ok(requests[1][1].includes(rt.state.prefs.taskExplanationPrompt))
  assert.ok(requests[1][1].endsWith(EXPLANATION_SYSTEM.split('\n\n').at(-1)))
  assert.ok(requests[1][1].indexOf('historical source data') > requests[1][1].indexOf(rt.state.prefs.taskExplanationPrompt))
  assert.equal((await explainTaskMessage(rt, body)).cached, true)
  assert.equal(requests.length, 2)
  delete rt.state.prefs.taskExplanationPrompt
  assert.equal((await explainTaskMessage(rt, body)).cached, false)
  assert.equal(requests[2][1], EXPLANATION_SYSTEM)
})

test('explanations use the sender Bot, then the recipient, then the group admin', async t => {
  const { rt, body, requests, room } = await setup(t)
  await explainTaskMessage(rt, body)
  assert.equal(requests[0][0].id, 'lead')
  rt.botOf = id => id === 'dev' ? { id, name: 'Developer' } : undefined
  await explainTaskMessage(rt, body)
  assert.equal(requests[1][0].id, 'dev')
  room.admin = 'admin'
  rt.botOf = id => id === 'admin' ? { id, name: 'Admin' } : undefined
  await explainTaskMessage(rt, body)
  assert.equal(requests[2][0].id, 'admin')
})

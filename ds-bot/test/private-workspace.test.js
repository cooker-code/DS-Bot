import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bindPrivateWorkspace } from '../src/client/private-workspace.js'
import { createSource } from '../src/client/sources.js'

const workspace = { path: '/project', workspaceId: 'w', sessionIds: [] }
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture(attach = async () => {}) {
  const row = { blank: true }
  const list = createSource({ byId: { private: row, other: row, group: row } })
  const bot = { id: 'bot', sessionId: 'private', openParts: [{ sessionId: 'other' }] }
  const roster = createSource({ byId: { private: bot, other: bot } })
  const registry = createSource({ phase: 'pending', items: [] })
  const attempts = [], errors = []
  let main = 'private'
  const stop = bindPrivateWorkspace({
    roster, mainView: () => main, reportError: error => errors.push(error),
    sessions: { list }, workspaces: { list: registry },
    attach: async (botId, id) => { attempts.push([botId, id]); await attach() },
  })
  const open = (id) => { main = id; list.set({ ...list.getSnapshot() }) }
  const ready = (items = []) => registry.set({ phase: 'ready', items })
  return { list, roster, ready, open, stop, attempts, errors }
}

test('an open blank private session is attached once after the workspace list loads', () => {
  const f = fixture()
  assert.deepEqual(f.attempts, [])
  f.ready([workspace])
  f.ready([workspace])
  assert.deepEqual(f.attempts, [['bot', 'private']])
  f.open('other')
  assert.deepEqual(f.attempts.at(-1), ['bot', 'other'])
  f.stop()
})

test('existing membership, started chats, group sessions and read-only teams need no attachment', () => {
  const f = fixture()
  f.ready([{ ...workspace, sessionIds: ['private'] }])
  f.open('group')
  f.ready()
  f.list.set({ byId: { private: { blank: false }, other: { blank: true } } })
  f.open('private')
  f.roster.set({ ...f.roster.getSnapshot(), readOnly: 'locked' })
  f.open('other')
  assert.deepEqual(f.attempts, [])
  f.stop()
})

test('a failed attachment is reported once and retried when the private chat reopens', async () => {
  const error = new Error('directory unavailable')
  const f = fixture(async () => { throw error })
  f.ready()
  await tick()
  f.ready()
  assert.deepEqual(f.errors, [error])
  assert.equal(f.attempts.length, 1)
  f.open('group')
  f.open('private')
  f.stop()
  await tick()
  assert.equal(f.attempts.length, 2)
  assert.deepEqual(f.errors, [error])
})

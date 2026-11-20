// Run on a fresh isolated bench, restart for --restart, then restart for --overrides.
// The mock session header and the request's model identify the actual route.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readSplitTeam, storageKey } from '../src/host/team-storage/split.js'

const [bench, port, mode] = process.argv.slice(2)
assert.match(bench, /^[a-z0-9-]+$/)
assert.match(port, /^[0-9]+$/)
const home = resolve(import.meta.dirname, '../../.dsh-test-' + bench)
const base = 'http://127.0.0.1:' + port
const login = readFileSync(join(home, 'web.log'), 'utf8').match(new RegExp(base + '/\\?token=[^\\s]+'))[0]
const cookie = (await fetch(login, { redirect: 'manual' })).headers
  .getSetCookie()
  .map((c) => c.split(';')[0])
  .join('; ')
async function api(endpoint, payload = {}) {
  const r = await fetch(base + '/api/bot', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  })
  const data = await r.json()
  if (!data.ok) throw new Error(endpoint + ': ' + data.error?.message)
  return data.value
}
const dir = join(home, 'bot/state')
const stored = () => readSplitTeam(dir)
const dbPath = (id) => join(dir, 'rooms', storageKey(id), 'room.sqlite')
const row = (file, sql, ...params) => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare(sql).get(...params)
  } finally {
    db.close()
  }
}
const marker = join(home, 'member-test-folders')
const tag = 'Member'
const state = await api('state')
const refs = state.models.filter((m) => m.ref.startsWith('deepseek-official/') && !m.needsKey).map((m) => m.ref)
assert.ok(refs.length >= 2, 'two available mock provider models')
const [m1, m2] = refs
assert.ok(mode === undefined || ['--restart', '--overrides'].includes(mode))
const workspace = mode ? readFileSync(marker, 'utf8') : realpathSync(mkdtempSync(join(tmpdir(), 'ds-split-web-')))
const folders = Object.fromEntries(['base', 'alpha', 'beta', 'changed'].map((n) => [n, join(workspace, n)]))
let worker, a, b
if (!mode) {
  writeFileSync(marker, workspace)
  for (const p of Object.values(folders)) mkdirSync(p)
  const chief = state.mainBotIds[0]
  await api('update-bot', { id: chief, model: m1 })
  worker = (await api('create-bot', { name: tag, model: m1, workDir: folders.base })).id
  for (const label of ['Alpha', 'Beta']) {
    const r = await api('create-room', { name: label, members: [worker, chief], admin: worker })
    if (label === 'Alpha') a = r.id
    else b = r.id
    assert.ok(existsSync(dbPath(r.id)))
    assert.equal(row(dbPath(r.id), "SELECT count(*) AS n FROM sqlite_schema WHERE type='table'").n, 17)
    assert.equal(row(dbPath(r.id), 'SELECT count(*) AS n FROM tasks').n, 0)
  }
  await api('update-room', { id: a, name: 'Alpha renamed' })
  assert.equal(row(dbPath(a), 'SELECT name FROM rooms').name, 'Alpha renamed')
} else {
  worker = state.bots.find((x) => x.name === tag).id
  a = state.rooms.find((x) => x.name === 'Alpha renamed').id
  b = state.rooms.find((x) => x.name === 'Beta').id
}
const configure = (id, patch) => api('update-room', { id, memberSetting: { botId: worker, ...patch } })
async function verify(label, roomId, folder, model) {
  const start = Date.now()
  const target = roomId ?? stored().bots[worker].sessionId ?? worker
  await api('send', { sessionId: target, text: (roomId ? '@' + tag + ' ' : '') + 'hello ' + label + ' ' + start })
  let last
  while (Date.now() - start < 65000) {
    const team = stored()
    const sid = roomId ? team.rooms[roomId].sessions?.[worker] : (team.bots[worker].sessionId ?? worker)
    if (sid) {
      const wd = readdirSync(join(home, 'sessions')).find((w) => existsSync(join(home, 'sessions', w, sid)))
      const requests = readFileSync(join(home, 'mock.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      last = requests.filter((r) => r.session === sid && Date.parse(r.t) >= start).at(-1)
      if (last && wd?.replace(/^-+|-+$/g, '') === folder.split(/[\\/]+/).filter(Boolean).join('-') && last.model === model.split('/').slice(1).join('/')) {
        console.log(label, 'room', roomId ?? 'private', 'session', sid, 'folder', folder, 'model', model)
        return
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 350))
  }
  throw new Error(label + ' did not receive the expected folder and model; last request model ' + last?.model)
}
if (!mode) {
  await configure(a, { model: m2, workDir: folders.alpha })
  await configure(b, { model: m1, workDir: folders.beta })
  await verify('A override', a, folders.alpha, m2)
  await verify('B override', b, folders.beta, m1)
  await verify('private default', null, folders.base, m1)
  await configure(a, { model: m1, workDir: folders.changed })
  await verify('A changed', a, folders.changed, m1)
  await configure(a, { model: null, workDir: null })
}
if (mode === '--overrides') {
  await verify('A persistent override', a, folders.alpha, m2)
  await verify('B persistent override', b, folders.beta, m1)
  await verify('private persistent default', null, folders.base, m1)
} else {
  assert.equal(row(dbPath(a), 'SELECT count(*) AS n FROM room_member_settings WHERE bot_id=?', worker).n, 0)
  assert.equal(
    row(dbPath(b), 'SELECT work_dir_rule,model_override FROM room_member_settings WHERE bot_id=?', worker).model_override,
    m1,
  )
  await verify('A inherits', a, folders.base, m1)
  await verify('B retains', b, folders.beta, m1)
  await verify('private retains', null, folders.base, m1)
  if (mode === '--restart') await configure(a, { model: m2, workDir: folders.alpha })
}
console.log('verified files', dbPath(a), dbPath(b))
if (mode === '--overrides') rmSync(workspace, { recursive: true, force: true })

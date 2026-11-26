// Backdoor (后门): operation scope, account permissions and resource lifecycle.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { install } from '../src/host/local-operator.js'

const execute = promisify(execFile)
const scripts = resolve(import.meta.dirname, '../../.agents/skills/ds-bot-doc/scripts')
const pause = () => new Promise(resolve => setTimeout(resolve, 20))
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await pause() }
  assert.fail('Local access did not reach the expected state')
}
async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-local-'))
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.pid }))
  const disposers = []
  const calls = []
  const rt = {
    home, load: async () => {}, readOnly: () => undefined,
    ctx: { effect: effect => disposers.push(effect()) },
    channelCall: async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'state') return { ok: true, value: { revision: 1, mainBotIds: ['b1'], readOnly: null,
        bots: [{ id: 'b1', name: 'Chief', instructions: 'Old', privateSession: 'not exported' }],
        rooms: [{ id: 'r1', name: 'Room', notice: 'Old notice' }], providers: ['not exported'], secrets: ['not exported'] } }
      if (endpoint === 'update-bot') return { ok: true, value: { id: payload.id, instructions: payload.instructions, privateSession: 'not exported' } }
      if (endpoint === 'update-room') return { ok: true, value: { room: { id: payload.id, notice: payload.notice }, changes: ['not exported'] } }
      return { ok: true, value: { taskId: payload.taskId, tasks: [], pendingIntakes: [] } }
    },
  }
  install(rt)
  let path
  let disposed
  const dispose = () => disposed ??= Promise.all(disposers.map(cleanup => cleanup()))
  t.after(async () => {
    await dispose()
    if (path) assert.equal(existsSync(path), false, 'owned socket must be removed')
    assert.equal(existsSync(join(home, 'local-access/connection.json')), false)
    rmSync(home, { recursive: true, force: true })
  })
  const control = async action => {
    const result = await execute('python3', [join(scripts, 'local_access.py'), action, '--team-home', home], { cwd: tmpdir() })
    assert.equal(result.stderr, '')
    return JSON.parse(result.stdout).value
  }
  const enable = async () => {
    const status = await control('enable')
    assert.equal(status.active, true)
    const manifest = JSON.parse(readFileSync(join(home, 'local-access/connection.json'), 'utf8'))
    path = manifest.socket
    return path
  }
  const send = (body, { method = 'POST', url = '/api/bot', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request({ socketPath: path, hostname: 'localhost', method, path: url, headers: { 'content-type': 'application/json', ...headers }, agent: false }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }))
    })
    req.on('error', reject)
    req.end(typeof body === 'string' ? body : JSON.stringify(body))
  })
  await until(() => existsSync(join(home, 'local-access')))
  return { home, rt, calls, control, enable, send, dispose, path: () => path }
}

test('local access is off by default and can be enabled and revoked without a DSH login', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.control('status'), { enabled: false, active: false })
  assert.equal(existsSync(join(f.home, 'local-access/connection.json')), false)
  await f.enable()
  assert.equal(lstatSync(f.path()).mode & 0o777, 0o600)
  assert.equal(lstatSync(dirname(f.path())).mode & 0o777, 0o700)
  assert.equal(lstatSync(join(f.home, 'local-access/access.json')).mode & 0o777, 0o600)
  assert.equal(lstatSync(join(f.home, 'local-access/connection.json')).mode & 0o777, 0o600)
  const result = await f.send({ endpoint: 'state', payload: {} })
  assert.equal(result.status, 200)
  assert.equal(result.body.value.bots[0].instructions, 'Old')
  assert.equal(result.body.value.secrets, undefined)
  assert.equal(result.body.value.providers, undefined)
  assert.equal(result.body.value.bots[0].privateSession, undefined)
  const disabled = await f.control('disable')
  assert.deepEqual(disabled, { enabled: false, active: false })
  await until(() => !existsSync(f.path()))
  assert.equal(f.calls.length, 1)
  await assert.rejects(f.send({ endpoint: 'state', payload: {} }))
  await f.enable()
  assert.equal((await f.send({ endpoint: 'state' })).status, 200)
})

test('only documented DS Bot operations and fields reach the existing dispatcher', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t)
  await f.enable()
  for (const endpoint of ['provider-key', 'set-main', 'set-prefs', 'create-bot', 'delete-bot', 'computer-click', 'dsh-update-install', '__proto__']) {
    const result = await f.send({ endpoint, payload: {} })
    assert.equal(result.status, 403, endpoint)
  }
  for (const payload of [{ id: 'b1', instructions: 'X', model: 'other' }, { id: 'b1', instructions: 'X', permission: 'full' }, { id: 'b1' }, { id: '', instructions: 'X' }])
    assert.equal((await f.send({ endpoint: 'update-bot', payload })).status, 400)
  assert.equal((await f.send({ endpoint: ['state'] })).status, 403)
  assert.equal((await f.send({ endpoint: 'state', payload: { locale: 'en' } })).status, 400)
  assert.equal((await f.send({ endpoint: 'state' }, { url: '/api/remote.mux' })).status, 404)
  assert.equal((await f.send({ endpoint: 'state' }, { headers: { cookie: 'not-a-real-cookie' } })).status, 403)
  assert.equal((await f.send('{bad json')).status, 400)
  assert.equal(f.calls.length, 0)
  const intro = '中文简介\nSecond line\n'
  const updated = await f.send({ endpoint: 'update-bot', payload: { id: 'b1', instructions: intro } })
  assert.deepEqual(updated.body.value, { id: 'b1', instructions: intro })
  assert.deepEqual(f.calls[0], { endpoint: 'update-bot', payload: { id: 'b1', instructions: intro } })
  assert.equal((await f.send({ endpoint: 'project-task-list', payload: { roomId: 'r1' } })).status, 200)
  assert.equal((await f.send({ endpoint: 'project-task-detail', payload: { roomId: 'r1', taskId: 't1' } })).status, 200)
})

test('read-only ownership and unsafe grant files refuse local access', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t)
  await f.enable()
  f.rt.readOnly = () => 'Another writer'
  assert.equal((await f.send({ endpoint: 'update-room', payload: { id: 'r1', notice: 'X' } })).status, 403)
  assert.equal(f.calls.length, 0)
  f.rt.readOnly = () => undefined
  const grant = join(f.home, 'local-access/access.json')
  chmodSync(grant, 0o644)
  await until(() => !existsSync(f.path()))
  assert.equal(f.calls.length, 0)
  chmodSync(grant, 0o600)
  await f.enable()
  unlinkSync(grant)
  const other = join(f.home, 'target.json')
  writeFileSync(other, '{"version":1,"enabled":true}', { mode: 0o600 })
  symlinkSync(other, grant)
  await until(() => !existsSync(f.path()))
  assert.equal(f.calls.length, 0)
})

test('Python local calls ignore HTTP login environment and verify the writer PID', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t)
  await f.enable()
  const args = [join(scripts, 'request.py'), 'state', '--local', '--team-home', f.home, '--jq', '.bots[0]']
  const result = await execute('python3', args, { cwd: tmpdir(), env: { ...process.env, DS_BOT_LOGIN_FILE: '/does-not-exist', DS_BOT_BASE_URL: 'http://127.0.0.1:1' } })
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), { id: 'b1', name: 'Chief', instructions: 'Old' })
  writeFileSync(join(f.home, 'state.lock'), JSON.stringify({ pid: process.pid + 1 }))
  await assert.rejects(execute('python3', args), error => {
    assert.equal(error.code, 1)
    assert.equal(error.stdout, '')
    assert.equal(JSON.parse(error.stderr).error, 'local_access_writer_mismatch')
    return true
  })
})

function captureWatcher(t) {
  const original = fs.watch
  const watchers = []
  t.mock.method(fs, 'watch', (...args) => {
    const watcher = original(...args)
    watchers.push(watcher)
    return watcher
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  return watchers
}

test('watcher failure closes queued listeners and reports restart instead of reopening access', { skip: process.platform !== 'darwin' }, async t => {
  const watchers = captureWatcher(t)
  const f = await fixture(t)
  await f.enable()
  watchers[0].emit('change', 'rename', 'access.json')
  watchers[0].emit('error', new Error('simulated watcher failure'))
  await until(() => !existsSync(f.path()))
  await f.control('disable')
  const enabled = await f.control('enable')
  assert.deepEqual(enabled, { enabled: true, active: false, restartRequired: true })
  assert.equal(existsSync(join(f.home, 'local-access/connection.json')), false)
  assert.equal(f.calls.length, 0)
})

test('shutdown awaits watcher-failure cleanup with a partially received request', { skip: process.platform !== 'darwin' }, async t => {
  const watchers = captureWatcher(t)
  const f = await fixture(t)
  await f.enable()
  let req
  const response = new Promise((resolve, reject) => {
    req = request({ socketPath: f.path(), hostname: 'localhost', method: 'POST', path: '/api/bot', agent: false }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.write('{"endpoint":"state","payload":')
  })
  await pause()
  watchers[0].emit('error', new Error('simulated watcher failure'))
  let finished = false
  const closing = f.dispose().then(() => { finished = true })
  await pause()
  assert.equal(finished, false, 'shutdown must wait for admitted connection cleanup')
  req.end('{}}')
  assert.equal(await response, 403)
  await closing
  assert.equal(f.calls.length, 0)
  assert.equal(existsSync(f.path()), false)
  assert.equal(existsSync(join(f.home, 'local-access/connection.json')), false)
})

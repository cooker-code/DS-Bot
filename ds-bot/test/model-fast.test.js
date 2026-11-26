import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitTeamStorage } from '../src/host/team-storage/split.js'
import { createFastRelay, install, isGptModel } from '../src/host/model-fast.js'

async function server(t, handler) {
  const srv = createServer(handler)
  srv.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  t.after(async () => {
    const done = new Promise(resolve => srv.close(resolve))
    srv.closeAllConnections()
    await done
  })
  return `http://127.0.0.1:${srv.address().port}/v1`
}
async function gateway(t) {
  const calls = []
  const url = await server(t, async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    calls.push({ path: req.url, headers: req.headers, body: text ? JSON.parse(text) : undefined })
    if (req.url.endsWith('/error')) { res.writeHead(429); res.end('rate limited'); return }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-request' })
    res.write('data: {"delta":"first"}\n\n')
    res.end('data: [DONE]\n\n')
  })
  return { url, calls }
}
function fixture(t, url, { saved = {}, inherited = false, api = 'openai-responses' } = {}) {
  const user = { providers: { relay: { api, ...(inherited ? {} : { baseURL: url }) } } }
  const base = { providers: { relay: { baseURL: url } } }
  let revision = 0
  const writes = []
  const effects = []
  const faults = { save: false, settings: false, readOnly: false }
  const models = [{ id: 'gpt-fixture', name: 'GPT Fixture' }, { id: 'openai/gpt-other', name: 'Other GPT' }, { id: 'claude-fixture', name: 'Claude' }]
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', revision, user: structuredClone(user), base: structuredClone(base), value: { providers: { relay: { ...base.providers.relay, ...user.providers.relay } } } }],
    async mutate(ns, ops, expected) {
      if (faults.settings) throw new Error('settings write failed')
      assert.equal(ns, 'llm-pi-ai')
      assert.equal(expected, revision)
      for (const op of ops) {
        const parent = op.path.slice(0, -1).reduce((value, key) => value[key] ??= {}, user)
        if (op.op === 'unset') delete parent[op.path.at(-1)]
        else parent[op.path.at(-1)] = op.value
      }
      writes.push(ops)
      revision += 1
    },
  }
  let durable = structuredClone(saved)
  const rt = {
    state: structuredClone(saved),
    load: async () => {},
    readOnly: () => faults.readOnly ? 'another writer' : undefined,
    dropCatalog() {},
    warn() {},
    async save({ mutate }) {
      const undo = mutate()
      if (faults.save) { undo(); throw new Error('save failed') }
      durable = structuredClone(rt.state)
    },
    ctx: {
      get: name => name === 'settings' ? settings : undefined,
      llm: {
        listConfigurableProviders: () => [{ provider: 'relay', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'relay'] }],
        listModels: async () => models,
      },
      effect(fn) { const cleanup = fn(); effects.push(cleanup) },
    },
  }
  install(rt)
  let disposed = false
  const close = async () => { if (!disposed) { disposed = true; for (const fn of effects) await fn() } }
  t.after(close)
  return { rt, models, faults, user, settings, writes, close, durable: () => durable }
}
const select = (rt, enabled, model = 'gpt-fixture') => rt.setModelFast({ provider: 'relay', model, enabled })
const send = (url, body) => fetch(url + '/responses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-key' }, body: JSON.stringify(body) })

test('GPT IDs include namespaced models without matching unrelated names', () => {
  assert.ok(isGptModel('gpt-fixture'))
  assert.ok(isGptModel('openai/gpt-fixture'))
  for (const id of ['my-gpt-fixture', 'claude-gpt-fixture', 'gpt-', undefined]) assert.equal(isGptModel(id), false)
})

test('relay writes Fast only for selected models and preserves request content and SSE', async (t) => {
  const { url, calls } = await gateway(t)
  const f = fixture(t, url)
  await select(f.rt, true)
  const relayURL = f.user.providers.relay.baseURL
  assert.notEqual(relayURL, url)
  const body = { model: 'gpt-fixture', reasoning: { effort: 'high' }, input: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }], tools: [{ type: 'function', name: 'check' }] }
  const response = await send(relayURL, body)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-request-id'), 'fixture-request')
  assert.equal(await response.text(), 'data: {"delta":"first"}\n\ndata: [DONE]\n\n')
  assert.deepEqual(calls[0].body, { ...body, service_tier: 'fast' })
  assert.equal(calls[0].headers.authorization, 'Bearer fixture-key')
  await (await send(relayURL, { model: 'openai/gpt-other', service_tier: 'flex' })).text()
  assert.equal(calls.at(-1).body.service_tier, 'flex')
  await select(f.rt, false)
  assert.equal(f.user.providers.relay.baseURL, url)
  // Calls prepared before the switch may still reach the relay; they pass through.
  await (await send(relayURL, { model: 'gpt-fixture' })).text()
  assert.equal(Object.hasOwn(calls.at(-1).body, 'service_tier'), false)
})

test('model switches are serialized and remain independent', async (t) => {
  const { url, calls } = await gateway(t)
  const f = fixture(t, url)
  await Promise.all([select(f.rt, true), select(f.rt, true, 'openai/gpt-other')])
  await select(f.rt, false)
  const view = await f.rt.modelFastView('relay', f.models)
  assert.deepEqual(view.models.map(model => [model.id, model.enabled]), [['gpt-fixture', false], ['openai/gpt-other', true]])
  await (await send(f.user.providers.relay.baseURL, { model: 'openai/gpt-other' })).text()
  assert.equal(calls[0].body.service_tier, 'fast')
})

test('saved choices reconnect on restart and shutdown restores an inherited endpoint', async (t) => {
  const { url } = await gateway(t)
  const first = fixture(t, url, { inherited: true })
  await select(first.rt, true)
  const oldURL = first.user.providers.relay.baseURL
  const saved = first.durable()
  await first.close()
  assert.equal(Object.hasOwn(first.user.providers.relay, 'baseURL'), false)
  await assert.rejects(send(oldURL, { model: 'gpt-fixture' }))
  const second = fixture(t, url, { inherited: true, saved })
  assert.equal((await second.rt.modelFastView('relay', second.models)).models[0].enabled, true)
  assert.notEqual(second.user.providers.relay.baseURL, oldURL)
  assert.equal((await send(second.user.providers.relay.baseURL, { model: 'gpt-fixture' })).status, 200)
  await second.close()
  assert.equal(Object.hasOwn(second.user.providers.relay, 'baseURL'), false)
})

test('recovery accepts the previous mount after interruption between saving and settings update', async (t) => {
  const { url } = await gateway(t)
  const saved = { modelFast: { relay: { upstream: url, originalBaseURL: url, relayURL: 'http://127.0.0.1:1/new', previousRelayURL: 'http://127.0.0.1:1/old', models: ['gpt-fixture'] } } }
  const f = fixture(t, url, { saved })
  f.user.providers.relay.baseURL = saved.modelFast.relay.previousRelayURL
  assert.equal((await f.rt.modelFastView('relay', f.models)).error, undefined)
  assert.notEqual(f.user.providers.relay.baseURL, saved.modelFast.relay.previousRelayURL)
})

test('save and settings failures do not enable Fast or lose the original endpoint', async (t) => {
  const { url } = await gateway(t)
  const f = fixture(t, url)
  await f.rt.modelFastView('relay', f.models)
  f.faults.save = true
  await assert.rejects(select(f.rt, true), /save failed/)
  assert.equal(f.user.providers.relay.baseURL, url)
  assert.equal(f.rt.state.modelFast, undefined)
  f.faults.save = false
  f.faults.settings = true
  await assert.rejects(select(f.rt, true), /settings write failed/)
  assert.deepEqual(f.rt.state.modelFast, {})
  assert.equal(f.user.providers.relay.baseURL, url)
  f.faults.settings = false
  await select(f.rt, true)
  const enabledURL = f.user.providers.relay.baseURL
  f.faults.save = true
  await assert.rejects(select(f.rt, false), /save failed/)
  assert.equal(f.user.providers.relay.baseURL, enabledURL)
  assert.ok(f.rt.state.modelFast.relay.models.includes('gpt-fixture'))
  f.faults.save = false
})

test('read-only, unsupported protocols and non-GPT selections are refused', async (t) => {
  const { url } = await gateway(t)
  const f = fixture(t, url, { api: 'anthropic-messages' })
  assert.equal(await f.rt.modelFastView('relay', f.models), undefined)
  await assert.rejects(select(f.rt, true), /OpenAI API/)
  await assert.rejects(select(f.rt, true, 'claude-fixture'), /GPT model/)
  f.faults.readOnly = true
  await assert.rejects(select(f.rt, true), /owns this team/)
  assert.equal(f.writes.length, 0)
})

test('changing the upstream externally is preserved when Fast is disabled or the plugin stops', async (t) => {
  const { url } = await gateway(t)
  const f = fixture(t, url)
  await select(f.rt, true)
  f.user.providers.relay.baseURL = 'https://new.example/v1'
  await assert.rejects(select(f.rt, true, 'openai/gpt-other'), /endpoint changed/)
  await select(f.rt, false)
  assert.equal(f.user.providers.relay.baseURL, 'https://new.example/v1')
  await f.close()
  assert.equal(f.user.providers.relay.baseURL, 'https://new.example/v1')
})

test('relay preserves Chat Completions errors and model discovery, rejects unknown mounts and redirects', async (t) => {
  const seen = []
  const url = await server(t, async (req, res) => {
    seen.push(req.url)
    if (req.method === 'GET') { res.end('{"data":[]}'); return }
    let body = ''
    for await (const chunk of req) body += chunk
    assert.equal(JSON.parse(body).service_tier, 'fast')
    if (JSON.parse(body).redirect) { res.writeHead(302, { location: 'https://never.example' }); res.end(); return }
    res.writeHead(429, { 'retry-after': '2' }); res.end('{"error":{"message":"rate limited"}}')
  })
  const relay = await createFastRelay()
  t.after(() => relay.close())
  const mount = relay.mount(url, ['gpt-fixture'])
  const response = await fetch(mount.url + '/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-fixture' }) })
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '2')
  assert.match(await response.text(), /rate limited/)
  assert.deepEqual(await (await fetch(mount.url + '/models')).json(), { data: [] })
  assert.equal((await fetch(mount.url + '/files')).status, 404)
  assert.equal((await fetch(mount.url + '/models', { headers: { origin: 'https://other.example' } })).status, 404)
  assert.equal((await send(mount.url, { model: 'gpt-fixture', redirect: true })).status, 502)
  assert.deepEqual(seen, ['/v1/chat/completions', '/v1/models', '/v1/responses'])
})

test('aborting a stream disconnects the upstream and closing the relay releases its listener', async (t) => {
  let ended
  const disconnected = new Promise(resolve => { ended = resolve })
  const url = await server(t, (req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: first\n\n')
    res.on('close', ended)
  })
  const relay = await createFastRelay()
  t.after(() => relay.close())
  const mount = relay.mount(url, ['gpt-fixture'])
  const controller = new AbortController()
  const response = await fetch(mount.url + '/responses', { method: 'POST', body: JSON.stringify({ model: 'gpt-fixture' }), signal: controller.signal })
  await response.body.getReader().read()
  controller.abort()
  await disconnected
  await relay.close()
  await assert.rejects(send(mount.url, { model: 'gpt-fixture' }))
})


test('Fast routing records survive the real SQLite team storage boundary', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-fast-storage-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const storage = splitTeamStorage(home)
  const modelFast = { relay: { upstream: 'https://gateway.example/v1', originalBaseURL: 'https://gateway.example/v1', relayURL: 'http://127.0.0.1:1/fixture', models: ['gpt-fixture'] } }
  await storage.write({ version: 1, bots: {}, rooms: {}, modelFast }, () => {})
  assert.deepEqual(storage.read().modelFast, modelFast)
})

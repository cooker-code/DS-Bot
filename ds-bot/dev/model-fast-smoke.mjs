// Exercise the installed plugin through a real isolated DSH host and a keyless
// OpenAI-compatible gateway. Optional screenshots use an isolated Chromium context.
// node dev/model-fast-smoke.mjs <bench> <web-port> [screenshot-directory]
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { chromium } from 'playwright-core'

const [bench, port, output] = process.argv.slice(2)
assert.match(bench ?? '', /^[a-z0-9-]+$/)
assert.match(port ?? '', /^[0-9]+$/)
const home = resolve(import.meta.dirname, '../../.dsh-test-' + bench)
const base = 'http://127.0.0.1:' + port
const login = readFileSync(join(home, 'web.log'), 'utf8').match(new RegExp(base + '/\\?token=[^\\s]+'))?.[0]
assert.ok(login, 'the isolated bench must be running')
const auth = await fetch(login, { redirect: 'manual' })
const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
assert.ok(cookie, 'the bench must issue a login session')
async function api(endpoint, payload = {}) {
  const response = await fetch(base + '/api/bot', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ endpoint, payload }) })
  const result = await response.json()
  assert.ok(result.ok, `${endpoint}: ${result.error?.message ?? 'request failed'}`)
  return result.value
}
async function until(check, label) {
  const end = Date.now() + 30_000
  while (Date.now() < end) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out: ' + label)
}
const calls = []
const gateway = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ id: 'gpt-fast-fixture' }, { id: 'gpt-other-fixture' }, { id: 'claude-fixture' }] }))
    return
  }
  let text = ''
  for await (const chunk of req) text += chunk
  const body = JSON.parse(text)
  calls.push(body)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const part = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
  part({ role: 'assistant', content: 'FAST_FIXTURE_OK' })
  part({}, 'stop')
  res.end('data: [DONE]\n\n')
})
let browser, context, bot
let browserPids = []
try {
  gateway.listen(0, '127.0.0.1')
  await once(gateway, 'listening')
  await api('provider-add', { custom: true, provider: 'fast-fixture', name: 'Fast test', api: 'openai-completions', baseURL: `http://127.0.0.1:${gateway.address().port}/v1`, key: 'fixture-key', models: [{ id: 'gpt-fast-fixture', name: 'GPT Fast fixture', contextWindow: 100000 }, { id: 'gpt-other-fixture', name: 'Other GPT fixture', contextWindow: 100000 }, { id: 'claude-fixture', contextWindow: 100000 }] })
  const row = async () => (await api('providers')).providers.find(provider => provider.id === 'fast-fixture')
  assert.equal((await row()).fast.models.length, 2)
  let toggle
  if (output) {
    mkdirSync(output, { recursive: true })
    browser = await chromium.launch({ headless: true })
    browserPids = execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean).map(Number)
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await page.addLocatorHandler(page.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true }), async locator => locator.click())
    await page.goto(login)
    await page.locator('.bt-row, .bt-tile').first().waitFor({ timeout: 60_000 })
    await page.locator('.bt-leftcol').getByRole('button', { name: 'Account', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await page.locator('.bt-settings-nav .bt-settings-item').filter({ hasText: /^Models$/ }).click()
    await page.locator('.bt-secret-summary').filter({ hasText: 'Fast test' }).click()
    toggle = page.getByRole('switch', { name: 'Fast mode for GPT Fast fixture', exact: true })
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    await toggle.click()
    await until(async () => await toggle.getAttribute('aria-checked') === 'true', 'Fast switch enabled')
    await page.locator('.bt-provider[data-open]').filter({ hasText: 'Fast test' }).locator('.bt-secret-edit-block').filter({ hasText: 'GPT Fast mode' }).screenshot({ path: resolve(output, 'fast-on.png') })
    assert.equal(await page.locator('.bt-provider[data-open]').filter({ hasText: 'Fast test' }).getByRole('switch').count(), 2)
    console.log('ok: real Models page enables only the selected GPT switch')
  } else await api('provider-model-fast', { provider: 'fast-fixture', model: 'gpt-fast-fixture', enabled: true })
  assert.deepEqual((await row()).fast.models.map(model => model.enabled), [true, false])
  bot = await api('create-bot', { name: 'Fast Probe', model: 'fast-fixture/gpt-fast-fixture', instructions: 'Reply briefly.' })
  await until(() => calls.length > 0, 'DSH gateway request')
  await until(async () => Object.keys((await api('state')).activity ?? {}).length === 0, 'first turn finished')
  assert.equal(calls[0].service_tier, 'fast')
  assert.ok(calls[0].messages.length > 0)
  console.log('ok: real DSH-hosted Bot turn reaches gateway with service_tier=fast')
  if (toggle) {
    await toggle.click()
    await until(async () => await toggle.getAttribute('aria-checked') === 'false', 'Fast switch disabled')
    await toggle.page().locator('.bt-provider[data-open]').filter({ hasText: 'Fast test' }).locator('.bt-secret-edit-block').filter({ hasText: 'GPT Fast mode' }).screenshot({ path: resolve(output, 'fast-off.png') })
    await toggle.page().reload()
    await toggle.page().locator('.bt-row, .bt-tile').first().waitFor()
  } else await api('provider-model-fast', { provider: 'fast-fixture', model: 'gpt-fast-fixture', enabled: false })
  assert.equal((await row()).fast.models[0].enabled, false)
  const before = calls.length
  await api('send', { sessionId: bot.sessionId ?? bot.id, text: 'Check the disabled Fast setting.' })
  await until(() => calls.length > before, 'second DSH gateway request')
  await until(async () => Object.keys((await api('state')).activity ?? {}).length === 0, 'second turn finished')
  assert.equal(Object.hasOwn(calls.at(-1), 'service_tier'), false)
  console.log('ok: disabling Fast restores the original request behavior')
  const refreshed = await api('provider-models', { provider: 'fast-fixture' })
  assert.ok(refreshed.some(model => model.id === 'gpt-fast-fixture'))
  console.log('ok: model discovery still uses the original gateway')
} catch (error) {
  if (output && context?.pages()[0]) await context.pages()[0].screenshot({ path: resolve(output, 'diagnostic.png') }).catch(() => {})
  throw error
} finally {
  try {
    try { await context?.close() } finally {
      await browser?.close()
      for (const pid of browserPids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the test browser must exit')
      if (browser) console.log('ok: isolated browser processes exited')
    }
  } finally {
    try {
      if (bot) await api('delete-bot', { id: bot.id })
      await api('provider-remove', { provider: 'fast-fixture' })
    } finally {
      const closed = new Promise(resolve => gateway.close(resolve))
      gateway.closeAllConnections()
      await closed
    }
  }
}

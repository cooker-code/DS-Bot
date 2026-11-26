// Keep service-tier selection in the plugin. DSH still owns request conversion,
// credentials and response parsing; the loopback relay changes only service_tier.
import { randomBytes } from 'node:crypto'
import { Agent as HttpAgent, createServer, request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { pipeline } from 'node:stream'
import { serviceOf } from './services.js'

const PI_AI = 'llm-pi-ai'
const OPENAI_APIS = new Set(['openai-completions', 'openai-responses'])
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length'])
// Image requests can be larger than their raw attachments after base64 encoding.
const MAX_BODY = 64 * 1024 * 1024
export const isGptModel = id => typeof id === 'string' && /(?:^|\/)gpt-[a-z0-9]/i.test(id)
const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const own = (obj, key) => obj && Object.hasOwn(obj, key) ? obj[key] : undefined
const managedURL = (record, url) => typeof url === 'string' && [record?.relayURL, record?.previousRelayURL].includes(url)
const headersOf = headers => {
  const blocked = new Set([...HOP_HEADERS, ...(headers.connection ?? '').split(',').map(name => name.trim().toLowerCase())])
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())))
}

function endpoint(value) {
  let url
  try { url = new URL(value) } catch { throw invalid('Fast mode requires an HTTP API endpoint.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw invalid('Fast mode requires an HTTP API endpoint without credentials, query or fragment.')
  return url.href.replace(/\/$/, '')
}

// Each unguessable mount has one fixed upstream, never one supplied by a caller.
export async function createFastRelay() {
  const routes = new Map()
  const upstreams = new Set()
  const sockets = new Set()
  const httpAgent = new HttpAgent({ keepAlive: true })
  const httpsAgent = new HttpsAgent({ keepAlive: true })
  const fail = (res, status, message) => {
    if (res.destroyed) return
    if (res.headersSent) { res.destroy(); return }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message, type: 'ds_bot_fast_relay' } }))
  }
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost')
    const match = /^\/([a-f0-9]{48})(\/.*)$/.exec(path.pathname)
    const route = match && routes.get(match[1])
    const suffix = match?.[2]
    if (!route || req.headers.origin || !((req.method === 'POST' && ['/responses', '/chat/completions'].includes(suffix)) || (req.method === 'GET' && suffix === '/models'))) {
      fail(res, 404, 'Unknown Fast mode relay request.')
      return
    }
    const fastModels = route.models
    let body
    let fast = false
    try {
      if (req.method === 'POST') {
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > MAX_BODY) { fail(res, 413, 'The model request exceeds the Fast mode relay limit (64 MiB).'); return }
          chunks.push(chunk)
        }
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid body')
        fast = fastModels.includes(parsed.model)
        if (fast) parsed.service_tier = 'fast'
        body = JSON.stringify(parsed)
      }
    } catch {
      fail(res, 400, 'Invalid model request JSON.')
      return
    }
    if (res.destroyed) return
    const target = new URL(route.upstream + suffix + path.search)
    const headers = headersOf(req.headers)
    if (fast && Object.hasOwn(headers, 'openai-service-tier')) headers['openai-service-tier'] = 'fast'
    if (body !== undefined) headers['content-length'] = Buffer.byteLength(body)
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const upstream = send(target, { method: req.method, headers, agent: target.protocol === 'https:' ? httpsAgent : httpAgent }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.resume()
        fail(res, 502, 'The model provider redirected the request. Configure its final API endpoint.')
        return
      }
      res.writeHead(response.statusCode, headersOf(response.headers))
      pipeline(response, res, () => {})
    })
    upstream.on('socket', (socket) => {
      if (sockets.has(socket)) return
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    upstreams.add(upstream)
    upstream.on('close', () => upstreams.delete(upstream))
    upstream.on('error', () => fail(res, 502, 'Could not reach the model provider through the Fast mode relay.'))
    upstream.setTimeout(route.idleTimeoutMs, () => upstream.destroy())
    res.on('close', () => upstream.destroy())
    upstream.end(body)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  let drained
  const drain = () => {
    drained ??= new Promise(resolve => server.close(() => {
      const closed = [...sockets].map(socket => new Promise(resolve => socket.once('close', resolve)))
      httpAgent.destroy()
      httpsAgent.destroy()
      void Promise.all(closed).then(resolve)
    }))
    server.closeIdleConnections()
    return drained
  }
  return {
    mount(upstream, models, idleTimeoutMs = 300_000) {
      const token = randomBytes(24).toString('hex')
      const route = { upstream: endpoint(upstream), models: [...models], idleTimeoutMs }
      routes.set(token, route)
      return { url: `${origin}/${token}`, route }
    },
    unmount(url) { routes.delete(new URL(url).pathname.slice(1)) },
    drain,
    async close() {
      for (const upstream of upstreams) upstream.destroy()
      const closed = drain()
      server.closeAllConnections()
      await closed
    },
  }
}

export function install(rt) {
  const { ctx, state } = rt
  let relay
  let closing = false
  let changing = Promise.resolve()
  let startupError
  const reconnectErrors = new Map()
  const active = new Map()
  const retiring = new Set()
  let lastSync
  const records = () => state.modelFast ?? {}
  const settings = () => serviceOf(ctx, 'settings')
  function source(provider) {
    const section = settings()?.describe({ redactSecrets: true }).find(entry => entry.ns === PI_AI)
    const entry = ctx.llm?.listConfigurableProviders?.().find(entry => entry.provider === provider && entry.settingsNs === PI_AI)
    if (!entry || !section) return undefined
    const at = root => entry.settingsPath.reduce((value, key) => value?.[key], root)
    return { section, entry, profile: at(section.value), user: at(section.user) }
  }
  const protocol = (provider, profile) => profile?.api ?? (provider === 'openai' ? 'openai-responses' : provider === 'openrouter' ? 'openai-completions' : undefined)
  function eligible(provider, src) {
    return src?.profile && OPENAI_APIS.has(protocol(provider, src.profile)) && src.profile.transport !== 'websocket'
      && typeof (own(records(), provider)?.upstream ?? src.profile.baseURL ?? src.entry.defaultBaseURL) === 'string'
  }
  async function persist(next) {
    const before = state.modelFast
    await rt.save({ required: true, mutate: () => {
      state.modelFast = next
      return () => { if (before === undefined) delete state.modelFast; else state.modelFast = before }
    } })
  }
  const writeURL = async (src, value) => {
    await settings().mutate(PI_AI, [{ op: value === undefined ? 'unset' : 'set', path: [...src.entry.settingsPath, 'baseURL'], ...(value === undefined ? {} : { value }) }], src.section.revision)
    rt.dropCatalog?.()
  }
  const queue = fn => {
    const next = changing.then(fn)
    changing = next.catch(() => {})
    return next
  }
  function retireUnused() {
    if (!relay || active.size > 0) return
    const previous = relay
    relay = undefined
    retiring.add(previous)
    void previous.drain().then(() => retiring.delete(previous))
  }
  async function connect(provider, record) {
    const src = source(provider)
    if (!eligible(provider, src)) throw invalid('Fast mode is only available for GPT models on OpenAI API routes.')
    // A change in the host's Models settings wins; never overwrite a new endpoint.
    if (!managedURL(record, src.profile.baseURL) && src.profile.baseURL !== record.originalBaseURL && src.profile.baseURL !== record.upstream)
      throw invalid('The provider endpoint changed. Turn Fast mode off before enabling it again.')
    relay ??= await createFastRelay()
    const mounted = relay.mount(record.upstream, record.models, src.profile.streamIdleTimeoutMs)
    const next = { ...record, ...(record.relayURL ? { previousRelayURL: record.relayURL } : {}), relayURL: mounted.url }
    const before = records()
    // Save the recovery information before pointing DSH at a process-local port.
    try {
      await persist({ ...before, [provider]: next })
      try { await writeURL(src, mounted.url) }
      catch (error) { await persist(before); throw error }
    } catch (error) {
      relay.unmount(mounted.url)
      retireUnused()
      throw error
    }
    active.set(provider, { ...mounted, originalBaseURL: record.originalBaseURL })
  }
  async function release(provider, mounted) {
    const src = source(provider)
    if (src?.profile?.baseURL === mounted.url) await writeURL(src, mounted.originalBaseURL)
    relay.unmount(mounted.url)
    active.delete(provider)
  }
  const syncSignature = () => JSON.stringify([
    Boolean(rt.readOnly?.()), records(),
    [...new Set([...active.keys(), ...Object.keys(records())])].map((provider) => {
      const profile = source(provider)?.profile
      return [provider, profile?.baseURL, profile?.api, profile?.transport, profile?.streamIdleTimeoutMs]
    }),
  ])
  async function reconcile() {
    if (closing || syncSignature() === lastSync) return
    const writer = !rt.readOnly?.()
    for (const provider of reconnectErrors.keys()) if (!own(records(), provider)) reconnectErrors.delete(provider)
    for (const [provider, mounted] of active) {
      const record = own(records(), provider)
      const src = source(provider)
      if (!writer || !record || record.relayURL !== mounted.url || src?.profile?.baseURL !== mounted.url || !eligible(provider, src)) {
        try { await release(provider, mounted) }
        catch { reconnectErrors.set(provider, 'Fast mode could not reconnect. Turn it off and enable it again in Models.') }
      }
    }
    if (writer) for (const [provider, record] of Object.entries(records())) {
      const mounted = active.get(provider)
      if (mounted) {
        mounted.route.models = [...record.models]
        mounted.route.idleTimeoutMs = source(provider)?.profile?.streamIdleTimeoutMs ?? 300_000
        continue
      }
      try { await connect(provider, record); reconnectErrors.delete(provider) }
      catch { reconnectErrors.set(provider, 'Fast mode could not reconnect. Turn it off and enable it again in Models.') }
    }
    retireUnused()
    lastSync = syncSignature()
  }
  const ready = queue(async () => {
    await rt.load?.()
    await rt.providerRoutesReady?.()
    await reconcile()
  })
  // Install is synchronous; startup failures are reported by the Models page.
  ready.catch(() => { startupError = 'Fast mode could not reconnect. Turn it off and enable it again in Models.' })
  ctx.effect(() => rt.onStoreSynced?.(() => {
    if (closing || syncSignature() === lastSync) return
    return queue(reconcile)
  }), 'ds-bot: Fast ownership changes')

  rt.modelFastView = async (provider, models) => {
    await ready.catch(() => {})
    const record = own(records(), provider)
    if (!eligible(provider, source(provider)) && !record) return undefined
    const candidates = models.filter(model => isGptModel(model.id))
    for (const id of record?.models ?? []) if (!candidates.some(model => model.id === id)) candidates.push({ id, name: id })
    if (!candidates.length && !record) return undefined
    const error = reconnectErrors.get(provider) ?? startupError
    return { models: candidates.map(model => ({ id: model.id, name: model.name, enabled: record?.models.includes(model.id) === true })), ...(error ? { error } : {}) }
  }
  rt.setModelFast = body => queue(async () => {
    await rt.load?.()
    if (closing || rt.readOnly?.()) throw invalid('Change Fast mode in the host that owns this team.')
    const { provider, model, enabled } = body
    if (typeof provider !== 'string' || typeof model !== 'string' || !isGptModel(model) || typeof enabled !== 'boolean') throw invalid('Choose a GPT model and a Fast mode switch value.')
    const src = source(provider)
    const old = own(records(), provider)
    if (!enabled && !old) return
    if (enabled) {
      if (!eligible(provider, src)) throw invalid('Fast mode is only available for GPT models on OpenAI API routes.')
      const catalog = await ctx.llm.listModels(provider)
      if (!catalog.some(entry => entry.id === model)) throw invalid('The GPT model is no longer available.')
    }
    const models = new Set(old?.models ?? [])
    if (enabled) models.add(model); else models.delete(model)
    if (models.size === 0) {
      if (managedURL(old, src?.profile?.baseURL)) await writeURL(src, old.originalBaseURL)
      const next = { ...records() }
      delete next[provider]
      try { await persist(next) }
      catch (error) {
        const current = source(provider)
        if (current?.profile?.baseURL === old.originalBaseURL || current?.profile?.baseURL === old.upstream) await writeURL(current, old.relayURL)
        throw error
      }
      const mounted = active.get(provider)
      if (mounted) relay.unmount(mounted.url)
      active.delete(provider)
      retireUnused()
    } else if (old && (active.has(provider) || !enabled)) {
      if (enabled && src.profile.baseURL !== old.relayURL) throw invalid('The provider endpoint changed. Turn Fast mode off before enabling it again.')
      await persist({ ...records(), [provider]: { ...old, models: [...models] } })
      const mounted = active.get(provider)
      if (mounted) mounted.route.models = [...models]
    } else {
      const record = old ? { ...old, models: [...models] } : {
        upstream: endpoint(src.profile.baseURL ?? src.entry.defaultBaseURL),
        ...(src.user?.baseURL === undefined ? {} : { originalBaseURL: src.user.baseURL }),
        models: [...models],
      }
      await connect(provider, record)
    }
    startupError = undefined
    if (active.has(provider) || models.size === 0) reconnectErrors.delete(provider)
    lastSync = syncSignature()
  })
  rt.forgetModelFast = async provider => {
    const record = own(records(), provider)
    if (!record) return
    for (const model of record.models) await rt.setModelFast({ provider, model, enabled: false })
  }
  ctx.effect(() => async () => {
    closing = true
    await changing
    try {
      // Releasing this runtime's own endpoint is still necessary after losing
      // the team lock. A read-only startup never adds anything to active.
      for (const [provider, mounted] of active) {
        const src = source(provider)
        if (src?.profile?.baseURL === mounted.url) {
          try { await writeURL(src, mounted.originalBaseURL) }
          catch { rt.warn?.('ds-bot: restore the provider endpoint in Models before disabling the plugin') }
        }
      }
    } finally { await Promise.all([relay, ...retiring].filter(Boolean).map(server => server.close())) }
  }, 'ds-bot: GPT Fast relay')
}

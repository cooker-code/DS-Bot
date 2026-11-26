// Backdoor (后门): local administration; contract in docs/plans/2026-11-26-backdoor.md.
import { randomUUID } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, watch, writeFileSync, chmodSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const MAX_BODY = 1024 * 1024
const INPUTS = {
  state: [],
  'update-bot': ['id', 'instructions'],
  'update-room': ['id', 'notice'],
  'project-task-list': ['roomId'],
  'project-task-detail': ['roomId', 'taskId'],
}
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
const botView = bot => pick(bot, ['id', 'name', 'role', 'instructions'])
const roomView = room => pick(room, ['id', 'name', 'notice', 'members', 'admin'])
const denied = (code, message) => ({ ok: false, error: { code, message, details: {} } })

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700)
    throw new Error('Unsafe local operator directory')
}

function privateJson(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096)
      throw new Error('Unsafe local operator file')
    return JSON.parse(readFileSync(fd, 'utf8'))
  } finally { closeSync(fd) }
}

function writePrivateJson(path, value) {
  const temp = `${path}.${randomUUID()}`
  try {
    writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function projection(endpoint, value) {
  if (endpoint === 'state') return {
    ...pick(value, ['revision', 'workspaceId', 'mainBotIds', 'readOnly']),
    bots: value.bots.map(botView), rooms: value.rooms.map(roomView),
  }
  if (endpoint === 'update-bot') return botView(value)
  if (endpoint === 'update-room') return { room: roomView(value.room) }
  return value
}

// This is an opt-in, same-account administration channel, not a DSH login export.
// The fixed operations and fields below are the entire authority of this socket.
export function install(rt) {
  if (process.platform !== 'darwin') return
  rt.ctx.effect(() => {
    const directory = join(rt.home, 'local-access')
    const grantPath = join(directory, 'access.json')
    const manifestPath = join(directory, 'connection.json')
    let stopped = false
    let unavailable = false
    let watcher, current
    let syncing = Promise.resolve()

    const enabled = () => {
      try {
        const grant = privateJson(grantPath)
        return grant.version === 1 && grant.enabled === true
      } catch { return false }
    }
    const reply = (res, status, value) => {
      if (res.destroyed) return
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    const close = async () => {
      const owned = current
      if (!owned) return
      current = undefined
      // Removing discovery prevents new clients; admitted writes may finish.
      try {
        if (privateJson(manifestPath).socket === owned.path) unlinkSync(manifestPath)
      } catch (error) { if (error.code !== 'ENOENT') rt.warn?.('ds-bot: local operator discovery could not be removed') }
      await new Promise(resolve => {
        owned.server.close(resolve)
        owned.server.closeIdleConnections()
      })
      try { unlinkSync(owned.path) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const serve = async (req, res) => {
      if (stopped || unavailable || !enabled()) { reply(res, 403, denied('bot/local-disabled', 'Local access is disabled.')); return }
      if (rt.readOnly() !== undefined) { reply(res, 403, denied('bot/read-only', 'This host is not the team writer.')); return }
      if (req.headers.origin || req.headers.cookie || req.headers.authorization) {
        reply(res, 403, denied('bot/local-scope', 'This channel accepts only local account access.')); return
      }
      if (req.method === 'GET' && req.url === '/status') {
        reply(res, 200, { ok: true, value: { pid: process.pid, operations: Object.keys(INPUTS) } }); return
      }
      if (req.method !== 'POST' || req.url !== '/api/bot') {
        reply(res, 404, denied('bot/local-scope', 'Unknown local route.')); return
      }
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_BODY) { reply(res, 413, denied('bot/invalid', 'Local request exceeds 1 MiB.')); return }
        chunks.push(chunk)
      }
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
        reply(res, 400, denied('bot/invalid', 'Invalid JSON.')); return
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some(key => !['endpoint', 'payload'].includes(key))
          || typeof body.endpoint !== 'string'
          || !Object.hasOwn(INPUTS, body.endpoint)) {
        reply(res, 403, denied('bot/local-scope', 'This operation is not granted.')); return
      }
      const payload = body.payload ?? {}
      const fields = INPUTS[body.endpoint]
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
          || Object.keys(payload).some(key => !fields.includes(key))
          || fields.some(key => typeof payload[key] !== 'string')
          || fields.some(key => ['id', 'roomId', 'taskId'].includes(key) && !payload[key])) {
        reply(res, 400, denied('bot/local-scope', 'Only the documented fields are granted.')); return
      }
      // The grant may have been removed while a client was sending its body.
      if (stopped || unavailable || !enabled()) { reply(res, 403, denied('bot/local-disabled', 'Local access is disabled.')); return }
      const result = await rt.channelCall(body.endpoint, payload)
      reply(res, 200, result.ok ? { ok: true, value: projection(body.endpoint, result.value) }
        : denied(result.error.code, 'The DS Bot operation was refused.'))
    }
    const sync = async () => {
      if (stopped || unavailable || !enabled() || rt.readOnly() !== undefined) { await close(); return }
      if (current) return
      // macOS Unix socket paths have a short fixed limit; team homes can be long.
      const socketDirectory = `/tmp/ds-bot-operator-${process.getuid()}`
      privateDirectory(socketDirectory)
      const path = join(socketDirectory, `${process.pid}-${randomUUID()}.sock`)
      const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
        void serve(req, res).catch(() => reply(res, 500, denied('bot/internal', 'Local request failed.')))
      })
      server.requestTimeout = 15_000
      server.headersTimeout = 5_000
      server.setTimeout(20_000, socket => socket.destroy())
      current = { server, path }
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(path, () => { server.off('error', reject); resolve() })
        })
        server.on('error', () => rt.warn?.('ds-bot: local operator socket failed'))
        chmodSync(path, 0o600)
        if (stopped || unavailable || !enabled()) { await close(); return }
        writePrivateJson(manifestPath, { version: 1, pid: process.pid, socket: path })
      } catch {
        await close()
        rt.warn?.('ds-bot: local operator could not start')
      }
    }
    const schedule = () => {
      syncing = syncing.then(sync).catch(() => rt.warn?.('ds-bot: local operator access could not be refreshed'))
    }
    const ready = rt.load().then(() => {
      if (stopped) return
      privateDirectory(directory)
      watcher = watch(directory, (_event, name) => { if (!name || name === 'access.json') schedule() })
      watcher.on('error', () => {
        unavailable = true
        watcher.close()
        schedule()
        rt.warn?.('ds-bot: local operator monitoring failed; restart the host to restore access')
      })
      schedule()
    }).catch(() => rt.warn?.('ds-bot: local operator setup failed'))
    return async () => {
      stopped = true
      watcher?.close()
      await ready
      await syncing
      await close()
    }
  }, 'ds-bot: local operator')
}

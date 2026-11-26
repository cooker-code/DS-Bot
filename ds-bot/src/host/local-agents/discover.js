// Finding agent CLIs and the environment they run in: PATH plus the user's
// login-shell PATH plus the usual install folders, and an environment that
// keeps their own sign-in but leaks nothing of ours.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

// The CLI signs in by itself; an API key or another agent's backend variable in
// our environment would shadow that or leak, so neither reaches the child.
const DROP_EXACT = new Set([
  'ACP_BACKEND', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY', 'ELECTRON_RUN_AS_NODE',
])
const DROP_PREFIX = ['DS_BOT_', 'DSH_', 'ANTIGRAVITY_', 'AGY_', 'DEEPSEEK_']
export const PROBE_FORCE_KILL_AFTER_MS = 1_000
const DEFAULT_FORCE_KILL_AFTER_MS = 5_000
const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024
const POST_KILL_CLOSE_MS = 250

function isFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

function findEnvKey(env, upperName) {
  if (env === undefined || env === null) return undefined
  return Object.keys(env).find(key => key.toUpperCase() === upperName && env[key] !== undefined)
}

function setCaseInsensitiveEnv(env, name, value) {
  const upper = name.toUpperCase()
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === upper && key !== name) delete env[key]
  }
  env[name] = value
}

export function cleanEnv(extra = {}) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase()
    // Git's injected config is one group; dropping only KEY leaves COUNT/VALUE malformed.
    if (/^GIT_CONFIG_(?:COUNT|PARAMETERS|(?:KEY|VALUE)_\d+)$/.test(upper) || DROP_EXACT.has(upper) || DROP_PREFIX.some(prefix => upper.startsWith(prefix))) continue
    env[key] = value
  }
  // A CLI found outside our sparse PATH (a script with `#!/usr/bin/env node`)
  // needs the same folders to find its interpreter.
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = searchDirs().join(delimiter)
  for (const [key, value] of Object.entries(extra)) {
    setCaseInsensitiveEnv(env, key, value)
  }
  return env
}

// Background probes disable mise auto-install/network metadata fetches unless the
// user explicitly configured a non-empty MISE_OFFLINE; live sessions keep plain cleanEnv().
export function withProbeEnv(env = cleanEnv()) {
  const next = { ...env }
  const existingKey = findEnvKey(next, 'MISE_OFFLINE')
  if (existingKey === undefined || String(next[existingKey]).trim() === '') {
    setCaseInsensitiveEnv(next, existingKey ?? 'MISE_OFFLINE', '1')
  }
  return next
}

export function probeEnv(extra = {}) {
  return withProbeEnv(cleanEnv(extra))
}

function probeEnvWithOverride(overrideEnv) {
  const key = findEnvKey(overrideEnv, 'MISE_OFFLINE')
  return probeEnv(key === undefined ? {} : { [key]: String(overrideEnv[key]) })
}

function isChildAlive(child) {
  return child !== undefined && child.exitCode == null && child.signalCode == null
}

function signalChild(child, signal, { processGroup = false } = {}) {
  if (!isChildAlive(child)) return
  const pid = child.pid
  // Negative PID targets the detached child's process group so grandchildren holding
  // stdout/stderr pipes die together; guard pid > 1 to never signal pgid 0 or -1.
  if (processGroup && Number.isSafeInteger(pid) && pid > 1) {
    try {
      process.kill(-pid, signal)
      return
    } catch {}
  }
  try { child.kill(signal) } catch {}
}

// Runs a short-lived probe child with bounded timeout, SIGTERM->SIGKILL escalation
// across its process group/tree, and capped output so a hung or SIGTERM-ignoring CLI
// never stalls discovery or leaks orphan processes.
export function runProbeCommand(file, args, {
  env,
  timeoutMs = 5_000,
  forceKillAfterMs = PROBE_FORCE_KILL_AFTER_MS,
  maxOutputBytes = MAX_PROBE_OUTPUT_BYTES,
  signal,
  spawnOptions = {},
} = {}) {
  if (signal?.aborted) {
    return Promise.resolve({ ok: false, timedOut: false, aborted: true, overflowed: false, stdout: '', stderr: '', code: null, signal: null, error: new Error('probe aborted') })
  }
  if (timeoutMs <= 0) {
    return Promise.resolve({ ok: false, timedOut: true, aborted: false, overflowed: false, stdout: '', stderr: '', code: null, signal: null, error: new Error('probe timed out') })
  }
  return new Promise((resolve) => {
    const processGroup = process.platform !== 'win32'
    let child
    try {
      child = spawn(file, args, {
        ...spawnOptions,
        env: withProbeEnv(env ?? cleanEnv()),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: processGroup,
      })
    } catch (error) {
      resolve({ ok: false, timedOut: false, aborted: false, overflowed: false, stdout: '', stderr: '', code: null, signal: null, error })
      return
    }

    let settled = false
    let timedOut = false
    let aborted = false
    let overflowed = false
    let killing = false
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let timeoutTimer
    let forceKillTimer
    let postKillTimer

    const cleanup = () => {
      clearTimeout(timeoutTimer)
      clearTimeout(forceKillTimer)
      clearTimeout(postKillTimer)
      signal?.removeEventListener('abort', onAbort)
    }

    const finish = ({ code = null, sig = null, spawnError } = {}) => {
      if (settled) return
      settled = true
      cleanup()
      stdout += stdoutDecoder.end()
      stderr += stderrDecoder.end()
      const ok = spawnError === undefined && !timedOut && !aborted && !overflowed && code === 0 && sig === null
      const error = ok ? null : (spawnError ?? new Error(
        timedOut ? 'probe timed out'
          : aborted ? 'probe aborted'
            : overflowed ? 'probe output limit exceeded'
              : `probe exited${sig !== null ? ` on ${sig}` : code !== null ? ` with code ${code}` : ''}`,
      ))
      resolve({ ok, timedOut, aborted, overflowed, stdout, stderr, code, signal: sig, error })
    }

    const schedulePostKillClose = (fallbackSig) => {
      postKillTimer = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish({ code: child.exitCode, sig: child.signalCode ?? fallbackSig })
      }, POST_KILL_CLOSE_MS)
      postKillTimer.unref?.()
    }

    const beginKill = () => {
      if (killing || settled) return
      killing = true
      clearTimeout(timeoutTimer)
      if (process.platform === 'win32') {
        signalChild(child, 'SIGKILL', { processGroup: false })
        schedulePostKillClose('SIGKILL')
        return
      }
      signalChild(child, 'SIGTERM', { processGroup })
      forceKillTimer = setTimeout(() => {
        if (settled) return
        signalChild(child, 'SIGKILL', { processGroup })
        schedulePostKillClose('SIGKILL')
      }, Math.max(0, forceKillAfterMs))
      forceKillTimer.unref?.()
    }

    const onAbort = () => {
      if (killing || settled) return
      aborted = true
      beginKill()
    }

    child.stdout?.on('data', (chunk) => {
      if (overflowed || killing || settled) return
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
      if (stdoutBytes + size > maxOutputBytes) {
        overflowed = true
        beginKill()
        return
      }
      stdoutBytes += size
      stdout += Buffer.isBuffer(chunk) ? stdoutDecoder.write(chunk) : String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      if (overflowed || killing || settled) return
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
      if (stderrBytes + size > maxOutputBytes) {
        overflowed = true
        beginKill()
        return
      }
      stderrBytes += size
      stderr += Buffer.isBuffer(chunk) ? stderrDecoder.write(chunk) : String(chunk)
    })

    child.once('error', spawnError => finish({ spawnError }))
    child.once('close', (code, sig) => finish({ code, sig }))

    timeoutTimer = setTimeout(() => {
      if (killing || settled) return
      timedOut = true
      beginKill()
    }, timeoutMs)
    timeoutTimer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// A command's output, or undefined. Never synchronous: this runs inside the DSH
// host, and a blocking child process there freezes every Session.
const outputOf = async (file, args, options) => {
  const result = await runProbeCommand(file, args, { timeoutMs: 5_000, forceKillAfterMs: PROBE_FORCE_KILL_AFTER_MS, env: probeEnv(), ...options })
  return result.ok ? result.stdout : undefined
}

// macOS apps launched from a dock icon inherit a sparse PATH; the login
// shell knows where the user actually installed things, and so does npm's global
// prefix. Both are looked up in the background and kept for a minute.
let found = { at: 0, dirs: [] }
let looking
export function refreshSearchDirs() {
  if (Date.now() - found.at < 60_000) return Promise.resolve()
  looking ??= Promise.all([
    outputOf(process.env.SHELL ?? '/bin/sh', ['-l', '-c', 'printf %s "$PATH"']),
    outputOf('npm', ['prefix', '-g']),
  ]).then(([loginPath, prefix]) => {
    const npmBin = prefix?.trim() ? join(prefix.trim(), 'bin') : undefined
    found = { at: Date.now(), dirs: [...(loginPath ?? '').split(delimiter).filter(Boolean), ...(npmBin ? [npmBin] : [])] }
  }).finally(() => { looking = undefined })
  return looking
}

// Every folder a CLI may hide in, in lookup order.
function searchDirs() {
  const home = homedir()
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const extra of [
    ...found.dirs,
    join(home, '.local', 'bin'),
    join(home, '.local', 'share', 'devin', 'cli', '_versions', 'current', 'bin'),
    join(home, '.opencode', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, 'Library', 'pnpm'),
    join(home, 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]) {
    if (extra !== '' && !dirs.includes(extra) && existsSync(extra)) dirs.push(extra)
  }
  return dirs
}

// The executable's full path, or undefined when the CLI is not installed. Only
// file checks: the folders from refreshSearchDirs() join once it has run.
export function findExecutable(name) {
  if (name.includes('/')) {
    const path = name.startsWith('~') ? join(homedir(), name.slice(1)) : name
    return isFile(path) ? path : undefined
  }
  for (const dir of searchDirs()) {
    const path = join(dir, name)
    if (isFile(path)) return path
  }
  return undefined
}

export function findEngineExecutable(spec, find = findExecutable) {
  for (const command of spec.commands ?? [spec.command]) {
    const path = find(command)
    if (path !== undefined) return path
  }
  return undefined
}

const launchOf = (executable, args) => ({ file: executable, args })

export function terminateChild(child, { forceKillAfterMs = DEFAULT_FORCE_KILL_AFTER_MS, processGroup = false } = {}) {
  if (!isChildAlive(child) || !Number.isSafeInteger(child.pid) || child.pid <= 0) return
  signalChild(child, 'SIGTERM', { processGroup })
  if (!isChildAlive(child)) return
  const clear = () => {
    clearTimeout(timer)
    child.off?.('exit', clear)
    child.off?.('close', clear)
    child.off?.('error', clear)
  }
  const timer = setTimeout(() => {
    clear()
    if (isChildAlive(child)) signalChild(child, 'SIGKILL', { processGroup })
  }, Math.max(0, forceKillAfterMs))
  timer.unref?.()
  if (typeof child.once === 'function') {
    child.once('exit', clear)
    child.once('close', clear)
    child.once('error', clear)
  }
}

export function spawnAgent(executable, args, options) {
  const launch = launchOf(executable, args)
  return spawn(launch.file, launch.args, { ...options, ...launch.options, env: options?.env ?? process.env })
}

// One `--version` call, bounded; the version line is for display only.
export async function probeVersion(executable, args, env, { timeoutMs = 10_000, forceKillAfterMs = PROBE_FORCE_KILL_AFTER_MS, maxOutputBytes = MAX_PROBE_OUTPUT_BYTES, signal } = {}) {
  try {
    const launch = launchOf(executable, args)
    const result = await runProbeCommand(launch.file, launch.args, {
      timeoutMs,
      forceKillAfterMs,
      maxOutputBytes,
      signal,
      env: withProbeEnv(env ?? cleanEnv()),
      spawnOptions: launch.options,
    })
    if (result.timedOut || result.aborted || result.overflowed) return { ok: false, version: undefined }
    const text = `${result.stdout}${result.stderr}`.split('\n').map(line => line.trim()).find(Boolean)
    return { ok: result.ok, version: text }
  } catch {
    return { ok: false, version: undefined }
  }
}

function parseJsonSignIn(stdout) {
  const trimmed = String(stdout ?? '').trim()
  if (trimmed === '') return null
  const candidate = trimmed.startsWith('{') ? trimmed : trimmed.match(/\{[\s\S]*\}$/u)?.[0]
  if (!candidate) return null
  try {
    const parsed = JSON.parse(candidate)
    if (parsed === null || typeof parsed !== 'object') return null
    for (const key of ['loggedIn', 'logged_in', 'authenticated', 'signedIn', 'signed_in']) {
      if (typeof parsed[key] === 'boolean') return parsed[key]
    }
  } catch {}
  return null
}

function classifySignIn(error, stdout, stderr, check) {
  const fromJson = parseJsonSignIn(stdout)
  if (fromJson !== null) return fromJson
  const text = `${stdout ?? ''}${stderr ?? ''}`
  if (/not (?:logged|signed) in|not authenticated|unauthenticated|partially authenticated|no (?:active )?(?:account|credentials|token)|please (?:log ?in|sign ?in|authenticate)/iu.test(text)) {
    return false
  }
  if (/(?:logged|signed) in/iu.test(text) || /^authenticated(?:\s|$|[:.,])/imu.test(text)) {
    return true
  }
  if (check.nonEmpty === true && error === null && String(stdout ?? '').trim() !== '') return true
  return null
}

// Network-backed status commands (e.g. `devin auth status`, `cursor-agent status`)
// routinely take 2-4s under concurrent startup; 3s killed them before stdout flushed.
const SIGN_IN_TIMEOUT_MS = 6_000
const KEYCHAIN_TIMEOUT_MS = 2_000

function probeMacKeychainItem(service, account, spawnKeychain, timeoutMs, signal) {
  return new Promise((resolve) => {
    try {
      // Without -g or -w this looks up metadata only. A miss proves nothing:
      // the CLI may be using a fallback credential store.
      const child = spawnKeychain('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account], {
        env: probeEnv(), stdio: 'ignore', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), killSignal: 'SIGKILL',
      })
      child.once('error', () => resolve(null))
      child.once('close', (code) => resolve(code === 0 ? true : null))
    } catch { resolve(null) }
  })
}

async function probeMacKeychain({ service, services, account }, spawnKeychain, timeoutMs = KEYCHAIN_TIMEOUT_MS) {
  const cap = Math.min(timeoutMs, KEYCHAIN_TIMEOUT_MS)
  const list = services ?? (service === undefined ? [] : [service])
  if (list.length === 0) return null
  const results = await Promise.all(list.map(name => probeMacKeychainItem(name, account, spawnKeychain, cap)))
  return results.every(result => result === true) ? true : null
}

// The per-user data folder as CodeBuddy resolves it from the home directory
// (it ignores XDG_DATA_HOME and LOCALAPPDATA).
const APP_DATA = { darwin: ['Library', 'Application Support'] }

const pathValue = (data, path) => path.reduce((current, key) => current?.[key], data)
const isNonEmptyString = value => typeof value === 'string' && value.trim() !== ''
function isNonEmptyValue(value) {
  if (typeof value === 'string') return value.trim() !== ''
  if (value !== null && typeof value === 'object') return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0
  return Boolean(value)
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function parseTomlStringValue(raw) {
  const quote = raw[0]
  if (quote !== '"' && quote !== "'") return undefined
  if (quote === "'") {
    const end = raw.indexOf("'", 1)
    if (end === -1) return undefined
    const tail = raw.slice(end + 1).trim()
    return tail === '' || tail.startsWith('#') ? raw.slice(1, end) : undefined
  }
  let out = ''
  for (let i = 1; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '\\') {
      if (i + 1 >= raw.length) return undefined
      out += raw[++i]
      continue
    }
    if (ch === '"') {
      const tail = raw.slice(i + 1).trim()
      return tail === '' || tail.startsWith('#') ? out : undefined
    }
    out += ch
  }
  return undefined
}

// Checks top-level TOML string keys (stops at the first `[table]` header so
// keys nested inside sections cannot spoof top-level credentials).
function hasTomlTopLevelStrings(file, keys) {
  try {
    const found = new Set()
    for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/u)) {
      const trimmed = rawLine.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      if (trimmed.startsWith('[')) break
      const eq = rawLine.indexOf('=')
      if (eq === -1) continue
      const key = rawLine.slice(0, eq).trim()
      if (!keys.includes(key)) continue
      const value = parseTomlStringValue(rawLine.slice(eq + 1).trim())
      if (value !== undefined && value.trim() !== '') found.add(key)
    }
    return keys.every(key => found.has(key))
  } catch {
    return false
  }
}

function probeFile(file, { loggedOut, has = [], stringGroups = [], tomlStrings = [] } = {}) {
  if (!isFile(file) || (loggedOut !== undefined && isFile(`${file}${loggedOut}`))) return null
  if (has.length > 0 || stringGroups.length > 0) {
    const data = readJsonFile(file)
    if (data === undefined) return null
    if (has.length > 0 && !has.every(path => isNonEmptyValue(pathValue(data, path)))) return null
    if (stringGroups.length > 0 && !stringGroups.some(group => group.every(path => isNonEmptyString(pathValue(data, path))))) return null
  }
  if (tomlStrings.length > 0 && !hasTomlTopLevelStrings(file, tomlStrings)) return null
  return true
}

function resolvePlatformFile(spec, home, env) {
  const entry = spec.darwin ?? spec.default
  if (entry === undefined) return undefined
  const envRoot = String(env?.[entry.env] ?? '').trim()
  const base = envRoot !== '' && isAbsolute(envRoot) ? envRoot : join(home, ...(entry.base ?? []))
  return join(base, ...entry.path)
}

function probeOne(executable, check, { home, platform, env, spawnKeychain, timeoutMs, forceKillAfterMs, maxOutputBytes, signal, deadline }) {
  if (signal?.aborted) return Promise.resolve(null)
  if (check.macKeychain !== undefined) {
    return platform === 'darwin' ? probeMacKeychain(check.macKeychain, spawnKeychain, timeoutMs) : Promise.resolve(null)
  }
  if (check.file !== undefined) return Promise.resolve(probeFile(join(home, ...check.file)))
  if (check.appDataFile !== undefined) {
    return Promise.resolve(probeFile(join(home, ...(APP_DATA[platform] ?? ['.local', 'share']), ...check.appDataFile.path), check.appDataFile))
  }
  if (check.platformFile !== undefined) {
    const file = resolvePlatformFile(check.platformFile, home, env)
    return Promise.resolve(file === undefined ? null : probeFile(file, check.platformFile))
  }
  if (check.args === undefined) return Promise.resolve(null)
  const remaining = deadline - Date.now()
  if (remaining <= 0) return Promise.resolve(null)
  try {
    const launch = launchOf(executable, check.args)
    return runProbeCommand(launch.file, launch.args, {
      timeoutMs: remaining,
      forceKillAfterMs,
      maxOutputBytes,
      signal,
      env: probeEnvWithOverride(env),
      spawnOptions: launch.options,
    }).then((result) => {
      if (result.timedOut || result.aborted || result.overflowed) return null
      return classifySignIn(result.ok ? null : result.error, result.stdout, result.stderr, check)
    })
  } catch {
    return Promise.resolve(null)
  }
}

// true, false, or null when the check cannot tell. Only a CLI's status command
// can say false; a missing credential in one store proves nothing.
export async function probeSignIn(executable, check, { home = homedir(), platform = process.platform, env = process.env, spawnKeychain = spawn, timeoutMs = SIGN_IN_TIMEOUT_MS, forceKillAfterMs = PROBE_FORCE_KILL_AFTER_MS, maxOutputBytes = MAX_PROBE_OUTPUT_BYTES, signal } = {}) {
  const deadline = Date.now() + timeoutMs
  for (let current = check; current !== undefined; current = current.fallback) {
    if (signal?.aborted) return null
    const result = await probeOne(executable, current, { home, platform, env, spawnKeychain, timeoutMs, forceKillAfterMs, maxOutputBytes, signal, deadline })
    if (signal?.aborted) return null
    if (result !== null) return result
  }
  return null
}

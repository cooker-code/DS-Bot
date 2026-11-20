import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { cleanEnv, findEngineExecutable, findExecutable, refreshSearchDirs } from '../src/host/local-agents/discover.js'

test('finding a CLI never waits on npm, and npm\'s global folder joins in the background', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsb-discover-'))
  const fakeBin = join(root, 'bin')
  const prefix = join(root, 'npm-global')
  const release = join(root, 'npm-release')
  t.after(() => {
    // Let a held npm exit even when an assertion above failed before releasing it.
    writeFileSync(release, '')
    rmSync(root, { recursive: true, force: true })
  })
  mkdirSync(fakeBin)
  mkdirSync(join(prefix, 'bin'), { recursive: true })
  writeFileSync(join(fakeBin, 'npm'), `#!/bin/sh\nwhile [ ! -e '${release}' ]; do sleep 0.05; done\nprintf '%s\\n' '${prefix}'\n`)
  writeFileSync(join(prefix, 'bin', 'dsb-fake-agent'), '#!/bin/sh\n')
  chmodSync(join(fakeBin, 'npm'), 0o755)
  chmodSync(join(prefix, 'bin', 'dsb-fake-agent'), 0o755)
  const { PATH, SHELL } = process.env
  process.env.PATH = `${fakeBin}${delimiter}${PATH}`
  process.env.SHELL = '/bin/false'
  t.after(() => { process.env.PATH = PATH; process.env.SHELL = SHELL })

  const started = Date.now()
  assert.equal(findExecutable('dsb-fake-agent'), undefined)
  const refresh = refreshSearchDirs()
  assert.ok(Date.now() - started < 1000, 'the lookup waited on npm')
  writeFileSync(release, '')
  await refresh
  assert.equal(findExecutable('dsb-fake-agent'), join(prefix, 'bin', 'dsb-fake-agent'))
})

test('findExecutable skips a directory matching the binary name (#1407) and findEngineExecutable resolves aliases', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsb-dir-'))
  const dirA = join(root, 'a')
  const dirB = join(root, 'b')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(dirA, 'kilocode'), { recursive: true })
  mkdirSync(dirB, { recursive: true })
  writeFileSync(join(dirB, 'kilocode'), '#!/bin/sh\n')
  chmodSync(join(dirB, 'kilocode'), 0o755)
  const { PATH } = process.env
  process.env.PATH = `${dirA}${delimiter}${dirB}${delimiter}${PATH}`
  t.after(() => { process.env.PATH = PATH })

  assert.equal(findExecutable('kilocode'), join(dirB, 'kilocode'))
  assert.equal(findEngineExecutable({ command: 'kilo', commands: ['kilo', 'kilocode'] }), join(dirB, 'kilocode'))
})

test('cleanEnv strips DEEPSEEK_ variables along with agent tokens', () => {
  const prev = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, DSB_KEEP_CHECK: process.env.DSB_KEEP_CHECK }
  process.env.DEEPSEEK_API_KEY = 'secret-deepseek'
  process.env.DSB_KEEP_CHECK = 'kept'
  try {
    const cleaned = cleanEnv({ EXTRA_FLAG: '1' })
    assert.equal(cleaned.DEEPSEEK_API_KEY, undefined)
    assert.equal(cleaned.DSB_KEEP_CHECK, 'kept')
    assert.equal(cleaned.EXTRA_FLAG, '1')
  } finally {
    if (prev.DEEPSEEK_API_KEY === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = prev.DEEPSEEK_API_KEY
    if (prev.DSB_KEEP_CHECK === undefined) delete process.env.DSB_KEEP_CHECK
    else process.env.DSB_KEEP_CHECK = prev.DSB_KEEP_CHECK
  }
})

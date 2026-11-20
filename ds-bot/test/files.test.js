import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { replaceFile } from '../src/host/files.js'

const folder = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-files-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

test('gives up at once on an error that waiting does not fix', async (t) => {
  const dir = folder(t)
  const wait = t.mock.method(globalThis, 'setTimeout')
  await assert.rejects(replaceFile(join(dir, 'missing.tmp'), join(dir, 'state.json')), { code: 'ENOENT' })
  assert.equal(wait.mock.callCount(), 0)
})

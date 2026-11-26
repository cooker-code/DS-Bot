import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

test('repository scanning distinguishes product drafts from unfinished documents and still rejects secrets', t => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-repository-scan-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'ds-bot'))
  for (const file of ['LICENSE', 'README.md', 'README.zh.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'AGENTS.md', '.gitignore', 'ds-bot/LICENSE'])
    writeFileSync(join(root, file), '')
  writeFileSync(join(root, 'ds-bot/package.json'), JSON.stringify({ name: 'ds-bot', files: ['LICENSE'],
    repository: 'https://example.invalid/repo', homepage: 'https://example.invalid', bugs: 'https://example.invalid/issues' }))
  const report = join(root, 'result.json')
  const scan = text => {
    writeFileSync(join(root, 'feature.md'), text)
    const result = spawnSync(process.execPath, [resolve('../scripts/scan.mjs'), root, '--json', report], { encoding: 'utf8' })
    return { status: result.status, findings: JSON.parse(readFileSync(report, 'utf8')).filter(row => row.level === 'must fix') }
  }
  const draft = String.fromCodePoint(0x8349, 0x7a3f)
  assert.equal(scan('The editor preserves ' + draft + ' until saving.').status, 0)
  for (const text of ['# ' + draft + ': incomplete', '状态：' + draft, '# Design（' + draft + '）', ['DRAFT', 'for review'].join(' ')]) {
    const result = scan(text)
    assert.equal(result.status, 1)
    assert.ok(result.findings.some(row => row.id === 'draft-marker'))
  }
  const secret = ['sk', randomBytes(24).toString('hex')].join('-')
  const result = scan('Editor ' + draft + ' contains ' + secret)
  assert.equal(result.status, 1)
  assert.ok(result.findings.some(row => row.id === 'secret-openai-style'))
})

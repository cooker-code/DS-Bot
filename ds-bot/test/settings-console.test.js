import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../src/client/settings-discovery.js', import.meta.url))], bundle: true, format: 'cjs', write: false, external: ['react', '@deepseek-ai/*'] })
const module = { exports: {} }
const react = { createElement: () => ({}), createContext: () => ({}) }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => react })
const { settingsSearchRows, filterSettings, focusSettingsTarget } = module.exports
const pages = [['general', 'General'], ['models', 'Models'], ['bot-models', 'Bot models'], ['prompts', 'Prompts'], ['bots', 'Bots']]
const roster = { bots: [{ id: 'a', name: 'Chief', model: 'test/old' }, { id: 'b', name: 'Local', model: 'codex' }], models: [{ ref: 'test/new', id: 'new', name: 'New Model', provider: 'test' }, { ref: 'locked/model', name: 'Locked', needsKey: true }], prefs: {} }

test('field search ranks a precise width target ahead of broad page keywords', () => {
  const rows = settingsSearchRows(pages, [], roster)
  assert.equal(filterSettings(rows, '气泡 宽度')[0].id, 'setting:width')
  assert.equal(filterSettings(rows, '任务 人话')[0].page, 'prompts')
  assert.equal(filterSettings(rows, '默认 模型')[0].id, 'setting:default-model')
  assert.equal(filterSettings(rows, '正文 宽度')[0].id, 'setting:layout')
  assert.equal(rows.some(row => row.id === 'setting:flat-width'), false)
})

test('model search offers a real provider target and a separate explicit batch action', () => {
  const rows = settingsSearchRows(pages, [], roster)
  const matches = filterSettings(rows, 'New Model')
  assert.ok(matches.some(row => row.page === 'models' && row.id === 'provider:test'))
  assert.ok(matches.some(row => row.page === 'bot-models' && row.id === 'test/new'))
  assert.equal(rows.some(row => row.key === 'switch:locked/model'), false)
  assert.equal(settingsSearchRows([['general', 'General']], [], roster).some(row => row.key.startsWith('model:')), false)
})

test('field targeting focuses the actual input and handles unavailable fields', () => {
  let focused = 0, scrolled = 0
  const input = { focus: () => focused++ }
  const node = { getAttribute: () => 'width', scrollIntoView: () => scrolled++, querySelector: () => input }
  const root = { querySelectorAll: () => [node] }
  assert.equal(focusSettingsTarget(root, 'general', 'setting:width'), true)
  assert.equal(focused, 1);assert.equal(scrolled, 1)
  assert.equal(focusSettingsTarget(root, 'general', 'setting:missing'), false)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/settings-discovery.js', import.meta.url))],
  bundle: true, format: 'cjs', write: false, external: ['react', '@deepseek-ai/*'],
})
const module = { exports: {} }
const react = { createElement: (type, props, ...children) => ({ type, props, children }), createContext: () => ({}) }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => react })
const { settingsSearchRows, filterSettings, installSettingsShortcut, SettingsOverview, AppearancePreview } = module.exports
const pages = [['overview', 'Overview'], ['general', 'General'], ['prompts', 'Prompts'], ['bots', 'Bots'], ['groups', 'Group chats']]
const roster = { bots: [{ id: 'b1', name: 'Writer', role: 'Documentation' }], rooms: [{ id: 'r1', name: 'DSH maintenance' }], prefs: {} }
const find = (node, match) => (!node || typeof node !== 'object' ? [] : [...(match(node) ? [node] : []), ...(node.children ?? []).flat(Infinity).flatMap(child => find(child, match))])

test('settings search retains local prompts and searches only real registered pages, bots and groups', () => {
  const rows = settingsSearchRows(pages, [{ id: 'editor', label: 'Editor' }], roster)
  assert.equal(filterSettings(rows, '任务 人话')[0].page, 'prompts')
  assert.equal(filterSettings(rows, 'ＷＲＩＴＥＲ documentation')[0].id, 'b1')
  assert.equal(filterSettings(rows, 'DSH maintenance')[0].id, 'r1')
  assert.equal(filterSettings(rows, 'editor')[0].page, 'dsh')
  assert.equal(filterSettings(rows, 'docker').length, 0)
  assert.equal(filterSettings(rows, 'models').length, 0)
})

test('settings shortcut is scoped to Bot mode and releases its capture listener', () => {
  const target = new EventTarget()
  let active = false, opened = 0
  const dispose = installSettingsShortcut(target, () => active, () => { opened++ })
  const key = options => {
    const event = new Event('keydown', { cancelable: true })
    Object.assign(event, { key: 'k', metaKey: true, ...options })
    target.dispatchEvent(event)
    return event
  }
  assert.equal(key().defaultPrevented, false)
  active = true
  assert.equal(key().defaultPrevented, true)
  key({ shiftKey: true }); key({ isComposing: true }); key({ altKey: true })
  assert.equal(opened, 1)
  dispose()
  assert.equal(key().defaultPrevented, false)
  assert.equal(opened, 1)
})

test('overview routes to existing Bot/group/local prompt forms without changing their data', () => {
  const calls = []
  const view = { children: SettingsOverview({ roster, pages, actions: { openSettings: (...args) => calls.push(args) }, Section: 'section', Row: 'div' }) }
  const buttons = find(view, node => node.type === 'button')
  for (const button of buttons) button.props.onClick()
  assert.ok(calls.some(([page, id]) => page === 'bots' && id === 'b1'))
  assert.ok(calls.some(([page, id]) => page === 'groups' && id === 'r1'))
  assert.ok(calls.some(([page]) => page === 'prompts'))
  assert.equal(roster.bots[0].name, 'Writer')
})

test('appearance preview immediately uses saved layout, width and thinking preferences', () => {
  const value = { ...roster, prefs: { layout: 'flat', width: 55, flatWidth: 75, thinking: true } }
  const before = JSON.stringify(value)
  const view = AppearancePreview({ roster: value })
  assert.equal(find(view, n => n.props?.className === 'bt-look')[0].props['data-flat'], true)
  assert.equal(find(view, n => n.props?.className === 'bt-look-user')[0].props.style.maxWidth, '55%')
  assert.equal(find(view, n => n.props?.className === 'bt-look-bot')[0].props.style.maxWidth, '75%')
  assert.equal(find(view, n => n.props?.className === 'bt-look-think').length, 1)
  assert.equal(JSON.stringify(value), before)
})

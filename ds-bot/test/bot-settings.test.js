import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { BotSettingsForm, InlineText } from './bot-settings.js'; export { GroupSettingsForm } from './group-settings.js'",
    resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect() {}, useLayoutEffect() {}, useMemo: make => make(), useCallback: fn => fn,
  useRef: current => ({ current }), useId: () => 'id', Fragment: Symbol('Fragment'),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { BotSettingsForm, InlineText } = module.exports

function walk(node, found = []) {
  if (Array.isArray(node)) { for (const child of node) walk(child, found); return found }
  if (node === null || node === undefined || typeof node !== 'object') return found
  found.push(node)
  walk(node.props?.children, found)
  return found
}
function settings(bot, { main = false, rooms = [] } = {}) {
  const roster = { mainBotIds: main ? [bot.id] : [], mainBotId: main ? bot.id : null, rooms, models: [], memory: false }
  return walk(BotSettingsForm({ bot, roster, actions: {}, run: fn => fn }))
}
const bot = { id: 'b', name: 'Writer', role: 'Writer', instructions: '', capabilities: [] }

test('the Private switch is enabled only for a state the host accepts', () => {
  const noFolder = settings(bot).find(node => node.props?.label === 'Private')
  assert.equal(noFolder.props.disabled, true)
  assert.equal(noFolder.props.hint, 'Choose a working folder of its own first.')

  const grouped = settings({ ...bot, workDir: '/work' }, { rooms: [{ id: 'r', members: ['b'] }] }).find(node => node.props?.label === 'Private')
  assert.equal(grouped.props.disabled, true)
  assert.equal(grouped.props.hint, 'Leave its group chats before making it private.')

  const main = settings({ ...bot, workDir: '/work' }, { main: true }).find(node => node.props?.label === 'Private')
  assert.equal(main.props.disabled, true)
  assert.equal(main.props.hint, 'A Main Bot cannot be private.')

  const allowed = settings({ ...bot, workDir: '/work' }).find(node => node.props?.label === 'Private')
  assert.equal(allowed.props.disabled, false)
  assert.equal(allowed.props.on, false)
})

test('a private Bot can always turn privacy off, and cannot become Main or be duplicated', () => {
  const tree = settings({ ...bot, workDir: '/work', private: true })
  const privacy = tree.find(node => node.props?.label === 'Private')
  assert.equal(privacy.props.on, true)
  assert.equal(privacy.props.disabled, false)
  assert.equal(tree.find(node => node.props?.label === 'Main Bot').props.disabled, true)
  assert.equal(tree.some(node => node.props?.onClick && node.props.className === 'bt-set-row bt-bs-row' && JSON.stringify(node).includes('Duplicate')), false)
})

// One InlineText with working state, so a test can type into it, press keys and blur it.
function field(props) {
  const cells = []
  let slot = 0
  const real = { useState: react.useState, useRef: react.useRef }
  react.useState = initial => { const mine = slot++; cells[mine] ??= { value: initial }; return [cells[mine].value, next => { cells[mine].value = next }] }
  react.useRef = initial => { const mine = slot++; cells[mine] ??= { value: { current: initial } }; return cells[mine].value }
  const render = () => { slot = 0; return InlineText(props).props }
  const api = {
    props: render,
    type: text => render().onChange({ target: { value: text } }),
    blur: () => render().onBlur(),
    key: name => render().onKeyDown({ key: name, nativeEvent: {}, stopPropagation() {}, currentTarget: { blur: () => api.blur() } }),
  }
  return { api, restore: () => Object.assign(react, real) }
}
function editing(props, steps) {
  const log = []
  const { api, restore } = field({ ...props, onSave: next => log.push(['save', next]), onDone: () => log.push(['done']) })
  try { steps(api) } finally { restore() }
  return log
}

test('an inline field saves the trimmed text on blur and then reports the edit done', () => {
  assert.deepEqual(editing({ label: 'Label', value: 'Writer' }, (api) => { api.type('  Editor '); api.blur() }), [['save', 'Editor'], ['done']])
})

test('Enter in a single-line field saves; Enter in a multiline one adds a line', () => {
  assert.deepEqual(editing({ label: 'Label', value: 'Writer' }, (api) => { api.type('Editor'); api.key('Enter') }), [['save', 'Editor'], ['done']])
  assert.deepEqual(editing({ label: 'Instructions', value: '', multiline: true }, (api) => { api.type('A'); api.key('Enter') }), [])
})

test('Escape drops the typed text, still reports the edit done, and the saved value stays', () => {
  const log = editing({ label: 'Label', value: 'Writer' }, (api) => { api.type('Editor'); api.key('Escape') })
  assert.deepEqual(log, [['done']])
})

test('Markdown settings have exclusive read and edit modes and retain a refused draft for retry', async () => {
  const setting = settings(bot).find(node => node.type.name === 'MarkdownSetting')
  const original = react.useState
  const cells = []
  let slot = 0
  react.useState = initial => {
    const i = slot++
    if (!(i in cells)) cells[i] = initial
    return [cells[i], next => { cells[i] = next }]
  }
  const writes = []
  const render = () => {
    slot = 0
    const field = setting.type({ ...setting.props, value: 'Original', onSave: text => { writes.push(text); return writes.length > 1 } })
    return walk(field.type(field.props))
  }
  const button = label => render().find(node => node.type === 'button' && node.props.children.includes(label))
  const input = () => render().find(node => node.type === 'textarea')
  try {
    assert.equal(input(), undefined)
    assert.equal(button('Save'), undefined)
    button('Edit').props.onClick()
    assert.equal(button('Edit'), undefined)
    assert.equal(render().some(node => node.props.text === 'Original'), false)
    input().props.onChange({ target: { value: '## New' } })
    assert.equal(input().props.onBlur, undefined)
    await button('Save').props.onClick()
    assert.equal(input().props.value, '## New')
    await button('Save').props.onClick()
    assert.deepEqual(writes, ['## New', '## New'])
    assert.equal(input(), undefined)
    button('Edit').props.onClick()
    button('Cancel').props.onClick()
    assert.ok(button('Edit'))
    assert.equal(writes.length, 2)
  } finally {
    react.useState = original
  }
})

test('an unchanged or untouched field saves nothing but still reports done', () => {
  assert.deepEqual(editing({ label: 'Label', value: 'Writer' }, (api) => { api.type('Writer'); api.blur() }), [['done']])
  assert.deepEqual(editing({ label: 'Label', value: 'Writer' }, (api) => { api.blur() }), [['done']])
})

test('a required field never saves empty', () => {
  assert.deepEqual(editing({ label: 'Name', value: 'Ada', required: true }, (api) => { api.type('  '); api.blur() }), [['done']])
  assert.deepEqual(editing({ label: 'Label', value: 'Writer' }, (api) => { api.type(''); api.blur() }), [['save', ''], ['done']])
})

test('a failed save keeps the typed draft in the field and does not end the edit', async () => {
  const done = []
  const { api, restore } = field({ label: 'Instructions', value: 'Old', onSave: () => Promise.resolve(false), onDone: () => done.push('done') })
  try {
    api.type('Unsaved draft')
    api.blur()
    await Promise.resolve()
    assert.equal(api.props().value, 'Unsaved draft')
    assert.deepEqual(done, [])
  } finally {
    restore()
  }
})

test('a field takes its class from the page it sits in, and defaults to the Settings page look', () => {
  assert.equal(InlineText({ label: 'Label', value: '' }).props.className, 'bt-bs-input')
  assert.equal(InlineText({ label: 'Instructions', value: '', multiline: true }).props.className, 'bt-bs-input bt-bs-area')
  assert.equal(InlineText({ label: 'Label', value: '', className: 'bt-drawer-role-input' }).props.className, 'bt-drawer-role-input')
})

test('member role selectors read and update the group assistant binding', () => {
  const bots = ['a', 'b', 'c'].map(id => ({ id, name: id }))
  const roster = { byId: Object.fromEntries(bots.map(bot => [bot.id, bot])), bots }
  const room = { id: 'room', admin: 'a', members: bots.map(bot => bot.id), projectAssistantId: 'b' }
  const actions = { updateRoom(id, patch) { assert.equal(id, room.id); Object.assign(room, patch) } }
  const tree = () => walk(module.exports.GroupSettingsForm({ room, roster, actions, run: value => value }))
  function role(id) {
    const control = tree().find(node => node.props.member?.id === id && node.props.view === 'role')
    return control.type(control.props)
  }
  const pick = (id, value) => role(id).props.onChange({ target: { value } })
  assert.equal(tree().some(node => node.props.label === 'Task assistant'), false)
  assert.equal(role('b').props.value, 'assistant')
  pick('c', 'assistant')
  assert.equal(role('b').props.value, 'member')
  assert.equal(role('c').props.value, 'assistant')
  pick('c', 'member')
  assert.equal(room.projectAssistantId, null)
  assert.equal(room.admin, 'a')
  pick('b', 'assistant')
  pick('b', 'admin')
  assert.equal(room.projectAssistantId, null)
  assert.equal(role('b').props.value, 'admin')
  assert.equal(role('b').props.children.find(node => node.props.value === 'assistant').props.disabled, true)
  pick('b', 'member')
  assert.equal(role('c').props.children.find(node => node.props.value === 'assistant').props.disabled, true)
  room.unresolvedTaskAssistant = 'old name'
  tree().find(node => node.props['aria-label'] === 'Invalid binding').props.onChange()
  assert.equal(room.projectAssistantId, null)
  roster.readOnly = true
  assert.equal(role('c').props.disabled, true)
})

test('Manage opens this group’s archive and offers its session handoff controls before deletion', () => {
  const room = { id: 'writers', members: [bot.id] }
  const roster = { byId: { [bot.id]: bot }, bots: [bot], readOnly: true }
  const requests = []
  const actions = { openArchive: (...args) => requests.push(args) }
  const tree = walk(module.exports.GroupSettingsForm({ room, roster, actions }))
  const [archive, handoff, remove] = tree.find(node => node.props.title === 'Manage').props.children
  assert.ok(walk(archive).some(node => node.props.children.includes('Archived discussions')))
  archive.props.onClick()
  assert.deepEqual(requests, [[room.id, 'library']])
  const controls = walk(handoff.type(handoff.props))
  assert.ok(controls.some(node => node.type === 'summary' && node.props.children.includes('Session handoff')))
  assert.equal(controls.find(node => node.type === 'input').props.disabled, true)
  assert.ok(walk(remove).some(node => node.props.children.includes('Delete group')))
})

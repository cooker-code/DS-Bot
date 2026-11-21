import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { columnOpened, createSwitchWindow, drawerOpened, rightColumnOpen } from '../src/client/right-panel.js'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

const document = attrs => new JSDOM(`<!doctype html><body><div ${attrs}><div data-rightbar-col></div></div></body>`).window.document

// 公开#456: the Bot drawer and DSH's right column never share the window; whichever
// the user asked for last wins. The column's state lives on the frame's attributes.
test('the frame attributes read as the column state', () => {
  assert.equal(rightColumnOpen(document('')), true)
  assert.equal(rightColumnOpen(document('data-rightbar-collapsed')), false)
  assert.equal(rightColumnOpen(document('data-rightbar-fullscreen')), true)
  // A narrow window presents the panel fullscreen with no track: both marks.
  assert.equal(rightColumnOpen(document('data-rightbar-collapsed data-rightbar-fullscreen')), true)
  // No frame at all reads as closed.
  assert.equal(rightColumnOpen(new JSDOM('<!doctype html><body></body>').window.document), false)
})

test('a drawer opening folds an open column back', () => {
  assert.equal(drawerOpened(true), 'collapse-column')
  assert.equal(drawerOpened(false), null)
})

test('a column the user opens takes the space from an open drawer', () => {
  assert.equal(columnOpened(true, false), 'close-drawer')
})

test('a column a Session switch revealed yields to the open drawer', () => {
  assert.equal(columnOpened(true, true), 'collapse-column')
})

test('with no drawer open the column opens on its own', () => {
  assert.equal(columnOpened(false, false), null)
  assert.equal(columnOpened(false, true), null)
})

// The switch window holds "the Session moved" until `settle` calls back: inside
// it a column opening is the switch revealing that Session's own column, past
// it the user's own. A newer move restarts it and a stale settle is ignored.
test('the switch window steers the verdict while it is open', () => {
  const ends = []
  const window = createSwitchWindow(done => ends.push(done))
  assert.equal(window.pending, false)
  window.moved()
  assert.equal(window.pending, true)
  assert.equal(columnOpened(true, window.pending), 'collapse-column')
  ends[0]()
  assert.equal(window.pending, false)
  assert.equal(columnOpened(true, window.pending), 'close-drawer')
})

test('a newer Session switch restarts the window and the old settle is stale', () => {
  const ends = []
  const window = createSwitchWindow(done => ends.push(done))
  window.moved()
  window.moved()
  ends[0]()
  assert.equal(window.pending, true)
  assert.equal(columnOpened(true, window.pending), 'collapse-column')
  ends[1]()
  assert.equal(window.pending, false)
})

// The drawer's top row, bundled once and run with a minimal React stand-in; the
// row's components are vnodes, so only the drawer's own body runs.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/details-drawer.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, URL, URLSearchParams, setTimeout, clearTimeout,
  require: (name) => {
    const platform = {
      react: { createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx }, useContext: ctx => ctx.value, useId: () => 'dv-id', 
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [initial, () => {}], useEffect: () => {}, useRef: current => ({ current }),
        useLayoutEffect: () => {}, useMemo: make => make(), useCallback: fn => fn,
        useSyncExternalStore: (_subscribe, get) => get(), Fragment: 'fragment',
      },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { DetailsDrawer } = module.exports

const bot = { id: 'a', name: 'Chief', sessionId: 'a' }
const room = { id: 'g', name: 'Writers', named: true, members: ['a'] }
const roster = { byId: { a: bot }, roomsById: { g: room }, bots: [], exchangeTurns: {}, questions: {}, memory: false }
const hook = value => select => select(value)
const drawer = (sessionId, actions, liveRoster = roster) => DetailsDrawer({
  sessionId, roster: liveRoster, actions,
  useSessions: hook({ byId: {} }),
  useSessionStatus: hook(new Map()),
  useActivity: hook({}),
  useWork: hook({ bots: {}, approvals: [] }),
  useBrowserTabs: hook({}),
  useBrowserPages: hook({}),
})
const moreButton = (node) => {
  if (Array.isArray(node)) return node.map(moreButton).find(found => found !== null) ?? null
  if (node === null || typeof node !== 'object') return null
  if (node.props?.['data-info-row'] === 'more') return node
  for (const child of node.children ?? []) {
    const found = moreButton(child)
    if (found) return found
  }
  return null
}
const menuKeys = (node) => {
  const button = moreButton(node)
  const items = button?.children.flat(Infinity).find(child => child?.props?.items)?.props?.items ?? []
  // `items` was built inside the bundle's vm context; a test-context array compares deep-equal.
  return [...items].map(item => (item.sep ? 'sep' : item.key))
}
const menuItem = (node, key) => {
  const button = moreButton(node)
  return [...(button?.children.flat(Infinity).find(child => child?.props?.items)?.props?.items ?? [])].find(item => item.key === key)
}

test('a bot in a window without a browser still gets Side chat in the `···`', () => {
  assert.deepEqual(menuKeys(drawer('a', {})), ['side'])
})

test('the group menu follows the host guide and opens the chosen kind for the room', () => {
  const entries = [
    { providerId: 'files', kind: 'files', id: 'new', title: () => '文件' },
    { providerId: 'extension', kind: 'diagnostics', id: 'new', title: () => '会话数据诊断' },
  ]
  const picks = []
  const actions = {
    sidebarGuide: { getSnapshot: () => entries, subscribe: () => () => {} },
    openConversationTab: (...args) => picks.push(args),
  }
  const group = drawer('g', actions)
  const keys = entries.map(entry => JSON.stringify([entry.providerId, entry.id]))
  assert.deepEqual(menuKeys(group), keys)
  assert.equal(menuItem(group, keys[1]).label, '会话数据诊断')
  menuItem(group, keys[1]).onPick()
  assert.deepEqual(picks, [['diagnostics', 'g']])
  const privateChat = drawer('a', { ...actions, openBrowser() {} }, { ...roster, browser: true })
  assert.deepEqual(menuKeys(privateChat), ['browser', 'side', 'sep', ...keys])
  menuItem(privateChat, keys[1]).onPick()
  assert.deepEqual(picks[1], ['diagnostics', 'a'])
  entries.length = 0
  assert.equal(moreButton(drawer('g', actions)), null)
})

test('a non-team surface shows no `···`', () => {
  assert.equal(moreButton(drawer('plain', { canOpenTerminal: () => true })), null)
})

// The group's Goal buttons act on `room.id`, never on the Session the header shows:
// a folder change moves the group's own Session to a fresh part.
const buttonsOf = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) buttonsOf(child, out); return out }
  if (node === null || typeof node !== 'object') return out
  if (typeof node.type === 'function') return buttonsOf(node.type(node.props), out)
  if (node.type === 'button') out.push(node)
  for (const child of node.children ?? []) buttonsOf(child, out)
  return out
}
const textOf = (node) => {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string') return node
  if (node === null || node === undefined || typeof node !== 'object') return ''
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return (node.children ?? []).map(textOf).join('')
}
const movedRoster = (goal) => {
  const room = { id: 'g', sessionId: 'g-part2', name: 'Writers', named: true, members: ['a'], admin: 'a', goal }
  return { ...roster, roomsById: { g: room, 'g-part2': room } }
}

test('the drawer Set a goal button stores the room id when the Session moved', () => {
  const calls = []
  const moved = movedRoster()
  const tree = drawer('g-part2', { composeGoal: id => calls.push(['compose', id]) }, moved)
  const button = buttonsOf(tree).find(entry => textOf(entry).includes('Set a goal'))
  assert.ok(button)
  button.props.onClick()
  assert.deepEqual(calls, [['compose', 'g']])
})

test('the drawer Show button toggles the goal by the room id when the Session moved', () => {
  const calls = []
  const goal = { status: 'active', title: 'Ship it', stages: [], current: 0 }
  const moved = movedRoster(goal)
  const tree = drawer('g-part2', { toggleGoal: id => calls.push(['toggle', id]) }, moved)
  const button = buttonsOf(tree).find(entry => textOf(entry) === 'Show')
  assert.ok(button)
  button.props.onClick()
  assert.deepEqual(calls, [['toggle', 'g']])
})

// A Bot's label and instructions are edited in the drawer through the Settings page's own
// field. Finds the components the drawer returns by name, without running the others.
const named = (node, name, expand = false, out = []) => {
  if (Array.isArray(node)) { for (const child of node) named(child, name, expand, out); return out }
  if (node === null || typeof node !== 'object') return out
  if (node.type === name) out.push(node)
  if (typeof node.type === 'function') {
    if (node.type.name === name) out.push(node)
    else if (expand) named(node.type(node.props), name, expand, out)
    return out
  }
  for (const child of node.children ?? []) named(child, name, expand, out)
  return out
}
const hostStrings = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) hostStrings(child, out); return out }
  if (typeof node === 'string') { out.push(node); return out }
  if (node === null || typeof node !== 'object' || typeof node.type === 'function') return out
  for (const child of node.children ?? []) hostStrings(child, out)
  return out
}
const editable = (patch, actions = {}) => drawer('a', actions, { ...roster, byId: { a: { ...bot, ...patch } } })
const markdownSetting = tree => named(tree, 'MarkdownSetting')[0] ?? named(tree, 'MarkdownSetting', true)[0]
const readSetting = setting => {
  const field = setting.type(setting.props)
  return field.type(field.props)
}

test('the drawer label is a field that saves the Bot role, like the Settings page', async () => {
  const saved = []
  const tree = editable({ role: 'Writer' }, { updateBot: (id, patch) => { saved.push(JSON.stringify([id, patch])); return Promise.resolve() } })
  const [label] = named(tree, 'BotLabel')
  const field = label.type(label.props)
  assert.equal(field.props.label, 'Label')
  assert.equal(field.props.value, 'Writer')
  assert.equal(field.props.maxLength, 24)
  assert.equal(field.props.placeholder, 'Add a label')
  await field.props.onSave('Editor')
  assert.deepEqual(saved, ['["a",{"role":"Editor"}]'])
})

test('a refused save of the label or the instructions does not throw out of the field', async () => {
  const tree = editable({ role: 'Writer', instructions: '' }, { updateBot: () => Promise.reject(new Error('refused')) })
  const [label] = named(tree, 'BotLabel')
  await label.type(label.props).props.onSave('Editor')
  await markdownSetting(tree).props.onSave('Drafts notes.')
})

test('empty instructions start in reading mode and save to the selected Bot', async () => {
  const saved = []
  const tree = editable({ instructions: undefined }, { updateBot: (id, patch) => { saved.push(JSON.stringify([id, patch])); return Promise.resolve() } })
  assert.equal(hostStrings(tree).some(text => text.includes('Bot settings')), false)
  const field = markdownSetting(tree)
  assert.ok(buttonsOf(readSetting(field)).some(button => textOf(button) === 'Edit'))
  assert.equal(field.props.label, 'Instructions')
  assert.equal(field.props.placeholder, 'What this Bot is responsible for…')
  assert.equal(field.props.value, '')
  const instructions = '## Writing\n\n- Draft **release notes**.'
  await field.props.onSave(instructions)
  assert.deepEqual(saved, [JSON.stringify(['a', { instructions }])])
})

test('a Bot renders its Markdown instructions with a separate edit button for keyboard users', () => {
  const instructions = '## Writing\n\n' + '- Draft **notes** from the [brief](https://example.org/brief).\n'.repeat(12)
  const read = readSetting(markdownSetting(editable({ instructions })))
  const text = read.children.find(child => child?.props?.className === 'bt-project-markdown')
  assert.equal(text.props.role, undefined)
  assert.equal(text.props.onClick, undefined)
  const [markdown] = named(text, 'MarkdownText')
  assert.equal(markdown.props.text, instructions)
  assert.equal(markdown.props.variant, 'compact')
  assert.ok(buttonsOf(read).some(button => textOf(button) === 'Edit'))
})

test('the drawer renders the complete group notice as editable Markdown', () => {
  const notice = '## Release\n\n' + '- **Review** the [plan](https://example.org/plan).\n'.repeat(12)
  const noticeRoster = { ...roster, roomsById: { g: { ...room, notice } } }
  const tree = drawer('g', {}, noticeRoster)
  const about = markdownSetting(tree)
  assert.equal(typeof about.props.onSave, 'function')
  const shown = readSetting(about)
  const text = shown.children.find(child => child?.props?.className === 'bt-project-markdown')
  assert.equal(text.props.role, undefined)
  assert.equal(text.props['data-editable'], undefined)
  const [markdown] = named(text, 'MarkdownText')
  assert.equal(markdown.props.text, notice)
  assert.equal(markdown.props.variant, 'compact')
})

test('the Bot label and instructions are keyed by Bot id and stay read-only when another dsh holds the team', () => {
  const writable = editable({ role: 'Writer', instructions: 'Drafts notes.' })
  assert.equal(named(writable, 'BotLabel')[0].props.key, 'role:a')
  assert.equal(markdownSetting(writable).props.key, 'about:a')

  const locked = drawer('a', {}, { ...roster, readOnly: 'Another dsh holds this team.', byId: { a: { ...bot, role: 'Writer', instructions: 'Drafts notes.' } } })
  assert.equal(named(locked, 'BotLabel').length, 0)
  const about = markdownSetting(locked)
  assert.equal(about.props.onSave, undefined)
  const read = readSetting(about)
  assert.equal(named(read, 'MarkdownText')[0].props.text, 'Drafts notes.')
  assert.equal(buttonsOf(read).length, 0)
})

test('every Bot gets the Sessions section and New session, not only local-agent Bots', () => {
  // A plain cloud-model Bot (no engine badge) has chat parts too.
  const plain = drawer('a', {}, { ...roster, byId: { a: { id: 'a', name: 'Chief', sessionId: 'a' } } })
  assert.match(textOf(plain), /Sessions/)
  const entry = buttonsOf(plain).find(button => textOf(button).includes('New session'))
  assert.ok(entry, 'the New session button is there')
  assert.equal(entry.props.disabled, undefined)
  // A local-agent Bot keeps the same section.
  const engine = drawer('a', {}, { ...roster, byId: { a: { id: 'a', name: 'Writer', sessionId: 'a', engine: 'claude-code', parts: ['a', 'a-old'] } } })
  const engineEntry = buttonsOf(engine).find(button => textOf(button).includes('New session'))
  assert.ok(engineEntry, 'the local-agent Bot still has it')
})

// A second instance of the drawer bundle whose React runs effects at once and keeps
// one state slot, so the status line can resolve its host read and render.
const runStatsBundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/details-drawer.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let runStatsState
const runStatsReact = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ children }) => children; return ctx },
  useContext: ctx => ctx.value, useId: () => 'rv-id',
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: () => [runStatsState, value => { runStatsState = value }],
  useEffect: effect => effect(), useRef: current => ({ current }), useLayoutEffect: () => {},
  useMemo: make => make(), useCallback: fn => fn,
  useSyncExternalStore: (_subscribe, get) => get(), Fragment: 'fragment',
}
const runStatsModule = { exports: {} }
runInNewContext(runStatsBundle.outputFiles[0].text, {
  module: runStatsModule, exports: runStatsModule.exports, URL, URLSearchParams, setTimeout, clearTimeout,
  require: (name) => {
    const platform = {
      react: runStatsReact,
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { RunStats } = runStatsModule.exports

test('the Bot status line needs the runStats action and then draws turns, speed, cache and context', () => {
  runStatsState = undefined
  const bot = { id: 'a', name: 'Chief', sessionId: 'a' }
  // Without the action the line stays away instead of drawing itself empty.
  assert.equal(RunStats({ bot, part: 'a', running: false, actions: {} }), null)
  // The host's figures, as the run-stats endpoint returns them.
  const values = {
    sessionStats: { turns: 12, decodeMs: 4000, decodeTokens: 150 },
    tokenUsage: { uncachedInputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 400 },
    contextPressure: { pressureTokens: 41_000, contextWindow: 100_000 },
  }
  let asked
  const actions = { runStats: (id) => { asked = id; return { then: ok => { ok(values) } } } }
  // The first render starts the read; it has nothing to draw until the read lands.
  assert.equal(RunStats({ bot, part: 'a', running: false, actions }), null)
  const node = RunStats({ bot, part: 'a', running: false, actions })
  assert.equal(asked, 'a')
  const line = textOf(node)
  assert.match(line, /12 turns/)
  assert.match(line, /38 tok\/s/)
  assert.match(line, /Cache hit 90%/)
  assert.match(line, /Context 41%/)
  // Moving to another part clears the previous part's figures until the new read finishes.
  assert.equal(RunStats({ bot, part: 'a-2', running: false, actions: { runStats: () => ({ then() {} }) } }), null)
})

test('sessions sort by last activity across current, background and archived rows', () => {
  const [sessions] = named(editable({ parts: ['older'], partTimes: { older: 20, archived: 45 },
    openParts: [{ sessionId: 'background', parts: ['archived'] }] }), 'BotSessions')
  const view = sessions.type({ ...sessions.props, useSessions: hook({ byId: {
    a: { title: 'Current chat', updatedAt: 30 }, background: { title: 'Background', createdAt: 1, updatedAt: 50 },
  } }) })
  const rows = buttonsOf(view).filter(row => row.props.className?.startsWith('bt-agent-session '))
  assert.equal(rows.find(row => row.props.key === 'a')?.props.disabled, true)
  const order = buttonsOf(view).filter(row => row.props.className?.split(' ').includes('bt-agent-session')).map(row => row.props.key)
  assert.deepEqual(order, ['background', 'archived', 'a', 'older'])
})

test('one activity-sorted list names each private or group part by owner and number', () => {
  const opened = []
  const [sessions] = named(editable({}), 'BotSessions')
  const rooms = [
    { id: 'eng', name: 'Engineering', memberSessions: { a: [{ id: 'g-old', number: 1 }, { id: 'g-now', number: 2, current: true }] } },
    { id: 'data', name: 'Data', memberSessions: { a: [{ id: 'd-now', number: 1, current: true }] } },
  ]
  const rendered = sessions.type({ ...sessions.props, rooms, running: { 'd-now': true },
    actions: { openMemberSession: (...args) => opened.push(args) },
    useSessions: hook({ byId: Object.fromEntries(['a', 'g-old', 'g-now', 'd-now'].map((id, i) =>
      [id, { createdAt: 1000, updatedAt: 2000 + i }])) }) })
  assert.equal(named(rendered, 'section').length, 0)
  assert.equal(named(rendered, 'details').length, 0)
  const rows = buttonsOf(rendered).filter(row => row.props.className?.split(' ').includes('bt-agent-session'))
  assert.deepEqual(rows.map(row => row.props.key), ['d-now', 'g-now', 'g-old', 'a'])
  for (const [i, title] of ['Data-1', 'Engineering-2', 'Engineering-1', 'Chief-1'].entries()) {
    const text = textOf(rows[i])
    assert.ok(text.startsWith(title))
    assert.match(text, /Created /)
    assert.match(text, /Last active /)
  }
  assert.match(textOf(rows[0]), /Running/)
  assert.doesNotMatch(textOf(rows[2]), /Current|Running/)
  for (const row of rows.slice(0, 3)) row.props.onClick()
  assert.deepEqual(opened, [['data', 'a', 'd-now'], ['eng', 'a', 'g-now'], ['eng', 'a', 'g-old']])
  assert.equal(rows[3].props.disabled, true)
})

test('a member in group details opens that group’s current member session', () => {
  const calls = []
  const actions = { openMemberSession: (...args) => calls.push(args) }
  const [overview] = named(drawer('g-part2', actions, movedRoster()), 'GroupOverview')
  const [section] = named(overview.type(overview.props), 'MembersSection')
  const [row] = named(section.children, 'MemberRow')
  const open = buttonsOf(row.type(row.props)).find(button => button.props.className === 'bt-member-open')
  open.props.onClick()
  assert.deepEqual(calls, [['g', 'a']])
})

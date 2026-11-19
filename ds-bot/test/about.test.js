import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/about.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useMemo: make => make(),
  useCallback: fn => fn,
  useId: () => 'dv-id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: 'fragment',
  useState: initial => [initial, () => {}],
  useEffect: () => {},
  useRef: current => ({ current }),
  useLayoutEffect: () => {},
}
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, URL, URLSearchParams, setTimeout, clearTimeout,
  require: (name) => {
    if (name === 'react') return react
    return {}
  },
})
const { AboutPage } = module.exports

// The DS Bot row in Settings → About, with the row's hint and its buttons' text, class
// and clicks. `update` is the value the update source holds.
function page(update) {
  const calls = []
  const actions = new Proxy({ repoStars: async () => null }, {
    get: (target, name) => target[name] ?? (() => calls.push(name)),
  })
  const run = promise => promise
  const tree = AboutPage({ useUpdate: select => select(update), actions, run, Section: 'section', Row: 'row' })
  const find = (node, pick) => (Array.isArray(node) ? node.flatMap(one => find(one, pick))
    : node && typeof node === 'object' ? [...pick(node), ...find(node.children, pick)] : [])
  const [row] = find(tree, node => (node.props?.label === 'DS Bot' ? [node] : []))
  const buttons = find(row?.children ?? [], node => (node.type === 'button' ? [node] : []))
  return {
    hint: row?.props?.hint,
    buttons: buttons.map(node => ({ text: node.children[0], className: node.props.className, click: () => node.props.onClick() })),
    calls,
  }
}

test('the registry install shows its check time and update control', () => {
  const view = page({ source: 'registry', checkedAt: Date.now(), latest: '0.2.1' })
  assert.match(view.hint, /^Up to date · Checked /)
  assert.equal(view.buttons.length, 1)
  assert.equal(view.buttons[0].text, 'Check for updates')
})

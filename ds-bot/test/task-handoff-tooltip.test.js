import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/task-handoffs.js', import.meta.url))],
  bundle: true, format: 'cjs', write: false, external: ['react', 'react-dom', '@deepseek-ai/*'],
})
function find(node, predicate) {
  if (!node || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  return (node.children ?? []).flat(Infinity).map(child => find(child, predicate)).find(Boolean)
}

test('hover creates a real tooltip with the complete dispatch context and preserves the plan action', () => {
  let place = null
  let selected
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    createPortal: node => node, useEffect() {}, useId: () => 'hover',
    useState: initial => [place ?? initial, value => { place = value }],
    useRef: () => ({ current: { getBoundingClientRect: () => ({ left: 340, right: 364, top: 100, bottom: 124 }) } }),
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => react,
    window: { innerWidth: 360, innerHeight: 800 }, document: { body: {} }, clearTimeout() {}, setTimeout() {} })
  const edge = { key: 'dispatch', from: 'lead', to: 'dev', kind: 'Dispatch', requirementVersion: 1,
    planVersion: 2, node: 1, round: 2, text: 'Original handoff' }
  const tree = module.exports.TaskHandoffs({ detail: { plans: [{ version: 2, nodes: [{ no: 1, title: 'Develop fields' }] }] }, history: { messages: [edge] } })
  const info = find(tree, node => node.type?.name === 'HandoffContext')
  const props = { ...info.props, onPlan: version => { selected = version } }
  const render = () => info.type(props)
  assert.equal(find(render(), node => node.props?.role === 'tooltip'), undefined)
  find(render(), node => node.type === 'button').props.onMouseEnter()
  const shown = render()
  const tooltip = find(shown, node => node.props?.role === 'tooltip')
  assert.ok(tooltip, 'hover must create visible content rather than only a title attribute')
  for (const value of ['Requirement v1', 'Plan v2', 'Node 1 Develop fields', 'Round 2']) assert.ok(tooltip.children[0].includes(value), value)
  assert.ok(tooltip.props.style.left >= 0 && tooltip.props.style.left + tooltip.props.style.width <= 360)
  const button = find(shown, node => node.type === 'button')
  assert.equal(button.props['aria-describedby'], tooltip.props.id)
  assert.equal(button.props.title, undefined)
  button.props.onClick({ preventDefault() {}, stopPropagation() {} })
  assert.equal(selected, 2)
  assert.equal(find(render(), node => node.props?.role === 'tooltip'), undefined)
})

test('an unsent-plan info button opens its own plan without requiring a dispatch edge', () => {
  let selected
  const react = { createElement: (type, props, ...children) => ({ type, props, children }),
    useEffect() {}, useId: () => 'note', useRef: () => ({ current: null }), useState: initial => [initial, () => {}] }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => react, clearTimeout() {} })
  const tree = module.exports.TaskHandoffs({ detail: { plans: [{ version: 2, at: 2, nodes: [] }], rounds: [] },
    history: { messages: [{ key: 'reply', at: 1, from: 'dev', to: 'lead', text: 'Result' }],
      planDispatchFailures: [{ version: 2, node: 1, at: 3, error: 'Paths still reserved' }] } })
  const info = find(tree, node => node.props?.note?.version === 2)
  assert.ok(info)
  const button = find(info.type({ ...info.props, onPlan: version => { selected = version } }), node => node.type === 'button')
  assert.equal(button.props['data-plan-note-version'], 2)
  assert.ok(button.props['aria-label'].includes('Paths still reserved'))
  button.props.onClick({ preventDefault() {}, stopPropagation() {} })
  assert.equal(selected, 2)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/task-content.js', import.meta.url))],
  bundle: true, format: 'cjs', write: false, external: ['react', '@deepseek-ai/*'],
})
const module = { exports: {} }
let states, hook
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: initial => {
    const slot = hook++
    return [states[slot] ?? initial, value => { states[slot] = typeof value === 'function' ? value(states[slot]) : value }]
  }, useRef: current => ({ current }), useEffect() {},
}
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => react })

function findAll(node, predicate) {
  if (!node || typeof node !== 'object') return []
  return [...(predicate(node) ? [node] : []), ...(node.children ?? []).flat(Infinity).flatMap(child => findAll(child, predicate))]
}

test('multiple outputs retain separate originals and search indexes span all output sections', () => {
  states = [true, true, 'match', 2]
  hook = 0
  const sections = [{ key: 'a', label: 'Manager → Dev', text: 'match\nmatch' },
    { key: 'b', label: 'Manager → Reviewer', text: '**match**\n\nsecond paragraph' }]
  const view = module.exports.TaskContent({ text: '', sections })
  const outputs = findAll(view, n => n.props?.className === 'bt-task-content-section')
  assert.equal(outputs.length, 2)
  const marks = findAll(view, n => n.type === 'mark')
  assert.deepEqual(marks.map(m => m.props['data-current']), [false, false, true])
  assert.equal(marks[2].props.ref.current, null)
  const copies = findAll(view, n => n.type?.name === 'CopyTaskText')
  assert.deepEqual(copies.map(c => c.props.text), [sections.map(s => s.text).join('\n\n'), ...sections.map(s => s.text)])
})

test('plain language displays its own explanation while Markdown and its copy retain the exact original', () => {
  const text = '**节点3已 dispatch round4**\n\n未授权生产写入。'
  const identity = JSON.stringify(['en', [[undefined, text]]])
  states = [false, false, '', 0, true, { identity, text: { text: '第 3 步已派给开发，尚未获准写入生产。' } }, 0]
  hook = 0
  const props = { selectedId: 'input', text, explain() { throw new Error('render must not generate') } }
  let view = module.exports.TaskContent(props)
  assert.equal(findAll(view, n => n.props?.text === '第 3 步已派给开发，尚未获准写入生产。').length, 2)
  const markdown = findAll(view, n => n.type === 'button' && n.children.includes('Markdown'))[0]
  markdown.props.onClick()
  hook = 0
  view = module.exports.TaskContent(props)
  const copies = findAll(view, n => n.type?.name === 'CopyTaskText')
  assert.equal(copies[0].props.text, text)
  assert.equal(findAll(view, n => n.props?.text === text).length, 2)
  const humanButton = findAll(view, n => n.type === 'button' && n.children.includes('Plain language'))[0]
  assert.equal(humanButton.props['aria-pressed'], false)
})

test('a changed source never displays an older explanation and failed generation offers retry', () => {
  const props = { text: 'new original', explain() {} }
  states = [false, false, '', 0, true, { identity: 'older source', text: { text: 'stale explanation' } }, 0]
  hook = 0
  let view = module.exports.TaskContent(props)
  assert.equal(findAll(view, n => n.props?.text === 'stale explanation').length, 0)
  assert.equal(findAll(view, n => n.props?.role === 'status').length, 1)
  states[5] = { identity: JSON.stringify(['en', [[undefined, props.text]]]), text: { error: 'provider failed' } }
  hook = 0
  view = module.exports.TaskContent(props)
  assert.equal(findAll(view, n => n.props?.role === 'alert').length, 1)
  findAll(view, n => n.type === 'button' && n.children.includes('Retry'))[0].props.onClick()
  assert.equal(states[6], 1)
})

test('copying all explanations waits for every parallel output, including after a failure', () => {
  const sections = [{ key: 'a', text: 'first original' }, { key: 'b', text: 'second original' }]
  const identity = JSON.stringify(['en', sections.map(block => [block.key, block.text])])
  states = [false, false, '', 0, true, { identity, a: { text: 'First explanation' } }, 0]
  const render = () => { hook = 0; return module.exports.TaskContent({ selectedId: 'output', sections, explain() {} }) }
  const copies = () => findAll(render(), n => n.type?.name === 'CopyTaskText').map(n => n.props.text)
  assert.deepEqual(copies(), ['First explanation'])
  states[5].b = { error: 'provider failed' }
  assert.deepEqual(copies(), ['First explanation'])
  states[5].b = { text: 'Second explanation' }
  assert.deepEqual(copies(), ['First explanation\n\nSecond explanation', 'First explanation', 'Second explanation'])
})

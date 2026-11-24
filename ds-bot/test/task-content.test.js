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
  useState: initial => [states[hook++] ?? initial, () => {}], useRef: current => ({ current }), useEffect() {},
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

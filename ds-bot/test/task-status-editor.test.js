import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/task-status-editor.js', import.meta.url))],
  bundle: true, format: 'cjs', write: false, external: ['react'],
})

function editor(props) {
  const state = []
  let hook = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }), useId: () => 'status',
    useState(initial) {
      const index = hook++
      if (!(index in state)) state[index] = initial
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
    },
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => react })
  return () => { hook = 0; return module.exports.TaskStatusEditor(props) }
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return
  if (predicate(node)) return node
  for (const child of node.children.flat(Infinity)) {
    const found = find(child, predicate)
    if (found) return found
  }
}
const button = (view, label) => find(view, node => node.type === 'button' && node.children.includes(label))

test('status editing is limited to blocked and failed cards and read-only hosts hide the action', () => {
  for (const status of ['blocked', 'failed', 'active', 'planning', 'review', 'done', 'human_review']) {
    for (const readOnly of [false, true]) {
      const render = editor({ detail: { status }, readOnly })
      assert.equal(Boolean(button(render(), 'Change status')), !readOnly && ['blocked', 'failed'].includes(status))
    }
  }
})

test('status edits require a changed status and reason, preserve a failed draft, and save only on submit', async () => {
  const calls = []
  let reject = true
  const detail = { status: 'blocked', statusHistory: [] }
  const render = editor({ detail, onSave: async (...args) => {
    calls.push(args)
    if (reject) throw new Error('Save unavailable')
    detail.status = 'done'
    detail.statusHistory = [{ from: 'blocked', status: 'done', reason: args[2], at: 1 }]
  } })
  button(render(), 'Change status').props.onClick()
  assert.equal(button(render(), 'Save').props.disabled, true)
  find(render(), n => n.type === 'select').props.onChange({ target: { value: 'done' } })
  assert.equal(button(render(), 'Save').props.disabled, true)
  const reason = 'Verified delivery by another agent'
  find(render(), n => n.type === 'textarea').props.onChange({ target: { value: reason } })
  assert.equal(button(render(), 'Save').props.disabled, false)
  assert.equal(calls.length, 0)
  await find(render(), n => n.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.equal(find(render(), n => n.props?.role === 'alert').children[0], 'Save unavailable')
  assert.equal(find(render(), n => n.type === 'textarea').props.value, reason)
  reject = false
  await find(render(), n => n.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.deepEqual(calls, [['blocked', 'done', reason], ['blocked', 'done', reason]])
  assert.equal(button(render(), 'Change status'), undefined)
  assert.equal(find(render(), n => n.props?.role === 'status').children[0], 'Status saved')
  assert.ok(find(render(), n => n.children.includes(reason)))
})

test('cancelling a draft leaves the task unchanged and sends no save request', () => {
  let writes = 0
  const detail = { status: 'failed' }
  const render = editor({ detail, onSave: () => { writes++ } })
  button(render(), 'Change status').props.onClick()
  find(render(), n => n.type === 'select').props.onChange({ target: { value: 'done' } })
  button(render(), 'Cancel').props.onClick()
  assert.equal(writes, 0)
  assert.equal(detail.status, 'failed')
  assert.equal(find(render(), n => n.type === 'form'), undefined)
})

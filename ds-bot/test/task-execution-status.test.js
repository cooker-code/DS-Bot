import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/task-execution-status.js', import.meta.url))],
  bundle: true, format: 'cjs', write: false, external: ['react', 'react-dom'],
})
const module = { exports: {} }
const react = { createElement: (type, props, ...children) => ({ type, props, children }) }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => react })
const { TaskExecutionStatus } = module.exports
const words = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(words).join(' ') : node?.children?.map(words).join(' ') ?? ''

test('an ordinary blocked task shows its reason and waiting condition before expanding handoffs', () => {
  const detail = { status: 'blocked', plans: [{ nodes: [{ no: 1, title: 'Prepare and deliver', status: 'blocked', round: 1 }] }],
    rounds: [{ planNode: { block: { reason: 'The document is ready; sending failed.', waitingFor: 'Restore the configured IM connection.' } } }] }
  const view = TaskExecutionStatus({ detail })
  assert.equal(view.props.role, 'status')
  assert.equal(view.props['data-status'], 'blocked')
  assert.match(words(view), /Blocked/)
  assert.match(words(view), /The document is ready; sending failed/)
  assert.match(words(view), /Waiting for.*Restore the configured IM connection/)
})

test('parallel work can show a blocked node while other work stays active, and superseded blockers stay hidden', () => {
  const detail = { status: 'active', plans: [{ nodes: [
    { no: 1, title: 'Current delivery', status: 'active', round: 2 },
    { no: 2, title: 'Blocked sibling', status: 'blocked', round: 3 },
  ] }], rounds: [
    { planNode: { block: { reason: 'Historical interruption' } } },
    { planNode: {} },
    { planNode: { block: { reason: 'Current impediment' } } },
  ] }
  const view = TaskExecutionStatus({ detail })
  assert.match(words(view), /In progress/)
  assert.match(words(view), /Current impediment/)
  assert.doesNotMatch(words(view), /Historical interruption/)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/task-plans.js', import.meta.url))],
  bundle: true, format: 'cjs', write: false, external: ['react', '@deepseek-ai/*'],
})
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => ({}) })
const { fullPlanText, planDifferenceText } = module.exports
const roster = { byId: { a: { name: 'Alice' }, b: { name: 'Bob' } } }
const before = { version: 1, at: 1000, by: 'a', nodes: [
  { no: 1, title: 'Coordinate', ownerId: 'a', instructions: 'Original full instructions\nsecond paragraph',
    deliverable: 'Original artifact', acceptance: 'Original checks', dependsOn: [], writePaths: [], customEvidence: 'Keep future fields' },
  { no: 3, title: 'Removed work', ownerId: 'b', instructions: 'Removed instructions' },
] }
const after = { version: 2, at: 2000, by: 'b', reason: 'Change execution steps', nodes: [
  { ...before.nodes[0], title: 'Implement', ownerId: 'b', instructions: 'Revised full instructions', writePaths: ['src/'] },
  { no: 2, title: 'Review', ownerId: 'a', dependsOn: [1], instructions: 'Read everything', acceptance: 'Check everything' },
] }

test('complete plans retain every stored field and resolve Bot identities', () => {
  const text = fullPlanText(before, roster)
  for (const value of ['Plan v1', '1000', 'Alice (a)', 'Coordinate', 'Original full instructions\nsecond paragraph',
    'Original artifact', 'Original checks', 'customEvidence', 'Keep future fields', 'Removed work', 'Removed instructions']) assert.ok(text.includes(value), value)
})

test('differences include full before and after values, added and removed nodes', () => {
  const text = planDifferenceText(before, after, roster)
  for (const value of ['Changed node 1', 'Added node 2', 'Removed node 3', 'Coordinate', 'Implement', 'Alice (a)', 'Bob (b)',
    'Original full instructions\nsecond paragraph', 'Revised full instructions', 'src/', 'Read everything', 'Check everything',
    'Change execution steps', 'Before change', 'After change']) assert.ok(text.includes(value), value)
  assert.ok(!text.includes('Keep future fields'), 'unchanged values stay in the complete plan')
})

test('reordered object fields and metadata timestamps do not create content changes', () => {
  const same = { by: 'b', at: 9999, version: 2, nodes: before.nodes.map(node => Object.fromEntries(Object.entries(node).reverse())) }
  assert.ok(planDifferenceText(before, same, roster).includes('No plan content changes.'))
})

test('unsent plan notes anchor after the last real handoff with a concise failure explanation', () => {
  const plans = [{ version: 1, at: 2 }, { version: 2, at: 5, by: 'a', reason: 'Add missing product context' },
    { version: 3, at: 8, reason: 'User changed the time format' }]
  const rounds = [{ sentAt: 3, planNode: { version: 1 } }, { sentAt: 10, planNode: { version: 3 } }]
  const entry = (key, at, kind, planVersion) => ({ key, at, incoming: { kind, planVersion } })
  const entries = [entry('user', 1, 'User request'), entry('one', 3, 'Dispatch', 1), entry('reply', 4, 'Bot reply'),
    entry('coordination', 6, 'Bot message'), entry('three', 10, 'Dispatch', 3)]
  const failure = { version: 2, node: 1, at: 5.5, error: 'Paths still reserved' }
  const notes = module.exports.unsentPlanNotes(plans, rounds, entries, [failure], roster)
  assert.equal(notes.length, 1)
  assert.equal(notes[0].version, 2)
  assert.equal(notes[0].after, 'reply')
  for (const value of ['Plan v2', 'Not dispatched', 'Alice', 'Paths still reserved']) assert.ok(notes[0].description.includes(value), value)
  assert.ok(!notes[0].description.includes('Plan v3'))
  assert.ok(!notes[0].description.includes('Next version saved'))
  assert.ok(!notes[0].description.includes('View plan'))
  assert.ok(!notes[0].description.includes('Add missing product context'))
  assert.ok(!notes[0].description.includes('User changed the time format'))
})

test('delivered plans never become unsent notes when handoff history is unavailable', () => {
  assert.equal(module.exports.unsentPlanNotes([{ version: 1, at: 1 }], [{ sentAt: 2, planNode: { version: 1 } }], [], [], roster).length, 0)
})

test('unknown failure stays explicit and plans before the first handoff have no invented anchor', () => {
  const [note] = module.exports.unsentPlanNotes([{ version: 1, at: 1 }], [{ planNode: { version: 1 } }],
    [{ key: 'future', at: 3, incoming: {} }], [], roster)
  assert.equal(note.after, undefined)
  assert.ok(note.description.includes('Dispatch registered; delivery not recorded'))
  assert.ok(note.description.includes('No undispatched reason was recorded.'))
})

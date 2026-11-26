import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../src/client/project-questions.js', import.meta.url))], bundle: true, format: 'cjs', write: false, external: ['react', 'react-dom', '@deepseek-ai/*'] })
const module = { exports: {} }
const react = { createElement: (type, props, ...children) => ({ type, props, children }), useState: value => [typeof value === 'function' ? value() : value, () => {}], useRef: value => ({ current: value }), useEffect: effect => effect(), useSyncExternalStore: (_subscribe, snapshot) => snapshot() }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react' ? react : {} })
const { ProjectQuestionDock } = module.exports
const render = roster => ProjectQuestionDock({ sessionId: 'current', useRoster: select => select(roster) })

test('an unrelated or not-yet-indexed conversation has no question dock and no focus error', () => {
  assert.equal(render({ roomsById: {} }), null)
})

test('the dock reads the canonical room index and presents the next unanswered question', () => {
  const card = { taskId: 'task', title: 'Daily table', questions: [{ id: 'one', question: 'Which date?', options: [] }] }
  const rendered = render({ roomsById: { current: { id: 'room', admin: 'chief', projectCards: [card] } }, byId: { chief: { name: 'Chief' } }, prefs: {} })
  assert.ok(rendered)
  assert.ok(JSON.stringify(rendered).includes('Which date?'))
  assert.ok(JSON.stringify(rendered).includes('Daily table'))
})

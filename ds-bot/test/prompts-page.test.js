import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { DEFAULT_TASK_EXPLANATION_PROMPT } from '../src/shared/task-explanation-prompt.js'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/prompts-page.js', import.meta.url))],
  bundle: true, format: 'cjs', write: false, external: ['react', '@deepseek-ai/*'],
})
const module = { exports: {} }
const react = { createElement: (type, props, ...children) => ({ type, props, children }) }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => react })
function find(node, predicate) {
  if (!node || typeof node !== 'object') return []
  return [...(predicate(node) ? [node] : []), ...(node.children ?? []).flat(Infinity).flatMap(child => find(child, predicate))]
}

test('prompt settings show the effective prompt, save an override and reset it through preferences', async () => {
  const calls = []
  const props = { roster: { prefs: {} }, actions: { setPrefs: value => calls.push(value) }, run: value => value,
    Section: 'section', Row: 'div' }
  let view = module.exports.PromptsPage(props)
  let field = find(view, node => node.type?.name === 'MarkdownSetting')[0]
  assert.equal(field.props.value, DEFAULT_TASK_EXPLANATION_PROMPT)
  const model = find(view, node => node.props?.label === 'Model selection')[0]
  assert.match(model.props.hint, /base model, ignoring group member overrides/)
  assert.match(model.props.hint, /If that Bot is missing/)
  assert.match(model.props.hint, /Standard models may fall back/)
  assert.match(model.props.hint, /local agents stay on their own CLI/)
  await field.props.onSave('用具体工作名称说明当前进展。')
  assert.equal(calls[0].taskExplanationPrompt, '用具体工作名称说明当前进展。')
  props.roster.prefs.taskExplanationPrompt = 'Custom prompt'
  view = module.exports.PromptsPage(props)
  field = find(view, node => node.type?.name === 'MarkdownSetting')[0]
  assert.equal(field.props.value, 'Custom prompt')
  field.props.headerControl.props.onClick()
  assert.equal(calls[1].taskExplanationPrompt, null)
  await field.props.onSave('')
  assert.equal(calls[2].taskExplanationPrompt, null)
})

test('a read-only host can inspect the prompt but cannot edit or restore it', () => {
  const view = module.exports.PromptsPage({ roster: { prefs: { taskExplanationPrompt: 'Custom prompt' }, readOnly: 'another host' },
    actions: {}, run() {}, Section: 'section', Row: 'div' })
  const field = find(view, node => node.type?.name === 'MarkdownSetting')[0]
  assert.equal(field.props.readOnly, true)
  assert.equal(field.props.headerControl, null)
})

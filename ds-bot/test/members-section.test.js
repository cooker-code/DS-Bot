import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/members-section.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false, external: ['react'],
})
function mount() {
  let expanded
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    require: () => ({
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      useId: () => 'members-test',
      useState: initial => {
        expanded ??= initial
        return [expanded, update => { expanded = update(expanded) }]
      },
    }),
  })
  return module.exports.MembersSection
}

test('members default open and repeatedly toggle with matching arrow and accessible state', () => {
  const Section = mount()
  const children = { type: 'member-actions' }, controls = { type: 'stop-room' }
  const render = () => Section({ title: 'Members · 7', controls, children })
  let openArrow
  for (let index = 0; index < 8; index++) {
    const node = render()
    const [head, content] = node.children
    const button = head.children[0]
    const open = index % 2 === 0
    assert.equal(button.type, 'button')
    assert.equal(button.props.type, 'button', 'native keyboard activation without submitting forms')
    assert.equal(button.props['aria-expanded'], open)
    assert.equal(button.props['aria-controls'], content.props.id)
    assert.equal(content.props.hidden, !open)
    assert.equal(content.props.style?.display, open ? undefined : 'none')
    assert.equal(head.children[1], controls, 'stop-all remains outside hidden content')
    assert.equal(content.children[0], children, 'member actions remain mounted and unchanged')
    if (index === 0) openArrow = button.children[1].type
    assert.equal(button.children[1].type === openArrow, open)
    button.props.onClick()
  }
})

test('empty members and independently mounted group sections start expanded', () => {
  const First = mount(), Second = mount()
  const first = First({ title: 'Members · 0', children: [] })
  first.children[0].children[0].props.onClick()
  assert.equal(First({ title: 'Members · 0' }).children[1].props.hidden, true)
  assert.equal(Second({ title: 'Members · 0' }).children[1].props.hidden, false)
})

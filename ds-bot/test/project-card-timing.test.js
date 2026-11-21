import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { projectCardSummary } from '../src/host/project-tasks.js'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/task-board.js', import.meta.url))],
  bundle: true, format: 'cjs', write: false, external: ['react', 'react-dom'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: current => ({ current }), useEffect() {}, useId: () => 'task-help',
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => react })
const { TaskBoard } = module.exports
function find(node, predicate) {
  if (!node || typeof node !== 'object') return
  if (predicate(node)) return node
  for (const child of node.children.flat(Infinity)) {
    const found = find(child, predicate)
    if (found) return found
  }
}
function renderCard(card) {
  const view = TaskBoard({ room: { projectCards: [projectCardSummary(card)] }, roster: {}, actions: {}, onOpen() {} })
  const component = find(view, n => n.props?.card)
  return component.type(component.props)
}
function row(card) {
  const rendered = renderCard(card)
  const labels = find(rendered, n => n.props?.className === 'bt-project-statuses')
  const times = find(rendered, n => n.props?.className === 'bt-project-times')
  assert.ok(find(rendered, n => n.props?.className === 'bt-project-arrow'))
  return { labels: Array.from(labels.children.filter(Boolean), n => n.children[0]), times: times && Array.from(times.children, n => n.children[0]) }
}

test('the project board counts saved cards, hiding unassigned intakes while keeping member entries visible', () => {
  const room = { notice: '[taskId]', pendingIntakes: [{ id: 'q', title: 'Question', status: 'clarify' }] }
  const render = () => TaskBoard({ room, roster: {}, actions: {} })
  const count = view => find(view, n => n.props?.className === 'bt-tasks-count').children[0]
  assert.equal(count(render()), 0)
  assert.equal(find(render(), n => n.props?.['data-status'] === 'clarify'), undefined)
  assert.equal(find(render(), n => n.type === 'button' && n.children[0] === 'Edit'), undefined)
  assert.ok(find(render(), n => n.props?.className?.includes('bt-tasks-empty')))
  room.projectCards = [{ taskId: 'card', title: 'Saved task', status: 'blocked' }]
  room.tasks = { t1: { botId: 'worker', status: 'active', goal: 'Member work', startedAt: 1 } }
  assert.equal(count(render()), 1)
  assert.ok(find(render(), n => n.props?.task?.goal === 'Member work'))
  room.projectCards.push({ taskId: 'done', status: 'done' })
  assert.equal(count(render()), 2)
  assert.equal(count(TaskBoard({ room: { taskManagementEnabled: false, tasks: room.tasks }, roster: {}, actions: {} })), 1)
})

test('a task needing clarification opens its detail without showing the explanation in the list', () => {
  const card = { taskId: 'a', title: 'Start time', status: 'clarify', clarification: 'Confirm the time format.' }
  const opened = []
  const props = { room: { projectCards: [card] }, roster: {}, actions: {}, onOpen: id => opened.push(id) }
  assert.equal(find(TaskBoard(props), n => n.props?.card === card), undefined)
  const board = TaskBoard({ ...props, statuses: new Set(['clarify']) })
  const list = find(board, n => n.props?.className === 'bt-task-list')
  assert.equal(find(list, n => n.children.includes(card.clarification)), undefined)
  const component = find(list, n => n.props?.card === card)
  const row = component.type(component.props)
  assert.equal(find(row, n => n.props?.className === 'bt-task-status').children[0], 'Needs clarification')
  row.props.onClick()
  assert.deepEqual(opened, ['a'])
})

test('a related card is nested under its primary card and still opens its own detail', () => {
  const room = { projectCards: [{ taskId: 'b', parentTaskId: 'a', status: 'planning' }, { taskId: 'a', status: 'active' }] }
  const opened = []
  const render = statuses => TaskBoard({ room, roster: {}, actions: {}, statuses, onOpen: id => opened.push(id) })
  const grouped = render()
  const children = find(grouped, n => n.props?.className === 'bt-related-children')
  const child = find(children, n => n.props?.card?.taskId === 'b')
  child.type(child.props).props.onClick()
  assert.deepEqual(opened, ['b'])
  assert.equal(find(grouped, n => n.props?.className?.includes('bt-related-toggle')).props['aria-expanded'], true)
  const filtered = render(new Set(['planning']))
  assert.ok(find(filtered, n => n.props?.card?.taskId === 'b'))
  assert.equal(find(filtered, n => n.props?.card?.taskId === 'a'), undefined)
})

test('status filtering updates the task list, card count and member history when the room changes', () => {
  const room = { notice: '[taskId]', projectCards: [
    { taskId: 'a', title: 'First', status: 'done' }, { taskId: 'b', title: 'Second', status: 'active' },
  ], pendingIntakes: [{ id: 'q', title: 'Question', status: 'pending' }], tasks: {
    member: { status: 'active', goal: 'Member work' }, past: { status: 'cancelled', goal: 'Past work' },
  } }
  const render = (...statuses) => TaskBoard({ room, roster: {}, actions: {}, statuses: new Set(statuses) })
  const count = view => find(view, n => n.props?.className === 'bt-tasks-count').children[0]
  const history = view => find(view, n => n.props?.className === 'bt-more')
  const empty = view => find(view, n => n.props?.className?.includes('bt-tasks-empty'))
  const active = render('active', 'pending')
  assert.equal(count(active), 1)
  assert.ok(find(active, n => n.props?.card?.taskId === 'b'))
  assert.ok(find(active, n => n.props?.task?.goal === 'Member work'))
  assert.equal(find(active, n => n.props?.['data-status'] === 'pending'), undefined)
  assert.equal(find(active, n => n.props?.card?.taskId === 'a'), undefined)
  assert.equal(history(active), undefined)
  room.projectCards[1].status = 'done'
  assert.equal(count(render('active', 'pending')), 0)
  assert.equal(count(render('done')), 2)
  assert.equal(history(render('cancelled')).children[0], 'History (1)')
  assert.equal(empty(render('cancelled')), undefined)
  assert.equal(count(render()), 0)
  assert.equal(empty(render()).children[0], 'No results')
})

test('the caption shows the branch before the timing fields, including in edit mode and without a branch', () => {
  for (const branch of ['main', 'fix/recall-origin-dash', undefined]) {
    const card = { taskId: 'task', title: 'Check the source', status: 'blocked', startedAt: 10, stoppedAt: 120010, workspace: branch && { branch } }
    const board = TaskBoard({ room: { projectCards: [card] }, roster: {}, actions: {}, onOpen() {} })
    const component = find(board, n => n.props?.card === card)
    for (const onOpen of [component.props.onOpen, undefined]) {
      const row = component.type({ ...component.props, onOpen })
      assert.equal(find(row, n => n.props?.className === 'bt-task-name').children[0], card.title)
      const cells = find(row, n => n.props?.className === 'bt-project-meta').children.filter(Boolean)
      assert.equal(cells.at(-1).props.className, 'bt-project-times')
      assert.equal(cells.at(-1).children[1].children[0], 'Elapsed 2 min')
      const ref = cells.find(n => n.props.className === 'bt-project-branch')
      if (branch) assert.equal(cells[0], ref)
      assert.equal(ref?.children[0], branch)
      assert.equal(ref?.props.title, branch)
    }
  }
})

test('a blocked card has one status and no clock until its round actually started', () => {
  const at = Date.now()
  const round = { ownerId: 'dev', assignedAt: at - 5000, sentAt: at - 4000,
    planNode: { version: 1, node: 1, block: { at, decisions: [{ action: 'wait', at: at + 600000 }] } } }
  const card = { id: 'card', rounds: [round], plans: [{ version: 1, at: at - 8000, nodes: [{ no: 1, ownerId: 'dev', dependsOn: [] }] }] }
  assert.deepEqual(row(card), { labels: ['Blocked'], times: undefined })
  round.startedAt = at - 120000
  const started = row(card)
  assert.deepEqual(started.labels, ['Blocked'])
  assert.match(started.times[0], /^Started /)
  assert.equal(started.times[1], 'Elapsed 2 min')
  card.plans[0].nodes.push({ no: 2, ownerId: 'backup', dependsOn: [] })
  card.rounds.push({ ownerId: 'backup', assignedAt: at, planNode: { version: 1, node: 2,
    block: { at: at + 60000, decisions: [] } } })
  assert.equal(row(card).times[1], 'Elapsed 2 min')
})

test('assigned, delivered and replacement rounds hide timing; old submitted rounds retain their status', () => {
  const first = { ownerId: 'dev', assignedAt: 10 }
  const card = { id: 'old', rounds: [first] }
  assert.deepEqual(row(card), { labels: ['Dispatching'], times: undefined })
  first.sentAt = 11
  assert.deepEqual(row(card), { labels: ['Dispatching'], times: undefined })
  Object.assign(first, { result: 'Done', submittedAt: 25 })
  assert.deepEqual(row(card), { labels: ['Awaiting review'], times: undefined })
  first.startedAt = 12
  assert.equal(row(card).times.length, 2)
  card.rounds.push({ ownerId: 'backup', assignedAt: 30 })
  assert.deepEqual(row(card), { labels: ['In progress'], times: undefined })
})

test('an accepted plan retains its status before dispatch, even if the plan is blocked', () => {
  const node = { no: 1, ownerId: 'dev', dependsOn: [] }
  const card = { id: 'new', rounds: [], plans: [{ version: 1, at: 10, nodes: [node] }] }
  assert.deepEqual(row(card), { labels: ['Dispatching'], times: undefined })
  node.contextGap = 'Missing repository'
  assert.deepEqual(row(card), { labels: ['Blocked'], times: undefined })
})

test('parallel rounds keep their clocks and completed cards hide Bot icons and freeze at the last submission', () => {
  const at = Date.now() - 7200000
  const nodes = [1, 2].map(no => ({ no, ownerId: 'worker' + no, dependsOn: [] }))
  const rounds = nodes.map(n => ({ ownerId: n.ownerId, startedAt: at + (n.no - 1) * 60000, planNode: { version: 1, node: n.no } }))
  const card = { id: 'parallel', rounds, plans: [{ version: 1, at: 10, nodes }] }
  const icons = () => find(renderCard(card), n => n.props?.className === 'bt-project-owner')
  assert.equal(icons().children.flat().length, 2)
  assert.match(row(card).times[0], /^Started /)
  Object.assign(rounds[1], { result: 'Second output', submittedAt: at + 120000 })
  rounds[1].planNode.acceptedAt = at + 180000
  assert.deepEqual(row(card).labels, ['In progress'])
  Object.assign(rounds[0], { result: 'First output', submittedAt: at + 240000 })
  assert.deepEqual(row(card).labels, ['Awaiting review'])
  rounds[0].planNode.acceptedAt = at + 3600000
  assert.deepEqual(row(card).labels, ['Done'])
  assert.equal(icons(), undefined)
  assert.equal(projectCardSummary(card).startedAt, at)
  assert.equal(row(card).times[1], 'Elapsed 4 min')
})

test('the question mark reveals the board statuses on hover or focus and dismisses on Escape or exit', () => {
  const view = TaskBoard({ room: {}, roster: {}, actions: {} })
  const help = find(view, n => n.type?.name === 'TaskStatusHelp')
  let side = null
  const initial = react.useState
  react.useState = () => [side, value => { side = value }]
  try {
    const render = () => help.type()
    const trigger = () => find(render(), n => n.type === 'button')
    const tip = () => find(render(), n => n.props?.role === 'tooltip')
    const event = { currentTarget: { getBoundingClientRect: () => ({ top: 420, bottom: 444 }),
      closest: () => ({ getBoundingClientRect: () => ({ top: 100, bottom: 500 }) }) } }
    assert.equal(trigger().children[0], '?')
    assert.equal(tip(), undefined)
    trigger().props.onMouseEnter(event)
    assert.equal(tip().props['data-side'], 'above')
    assert.equal(trigger().props['aria-describedby'], tip().props.id)
    const names = Array.from(find(tip(), n => n.type === 'dl').children[0], n => n.children[0].children[0])
    assert.deepEqual(names, ['Needs clarification', 'Planning', 'Dispatching', 'In progress', 'Awaiting review',
      'Human acceptance', 'Blocked', 'Failed', 'Done', 'Cancelled'])
    render().props.onMouseLeave()
    assert.equal(tip(), undefined)
    trigger().props.onFocus(event)
    assert.ok(tip())
    render().props.onKeyDown({ key: 'Escape', stopPropagation() {}, currentTarget: { querySelector: () => ({ focus() {} }) } })
    assert.equal(tip(), undefined)
  } finally {
    react.useState = initial
  }
})

test('the card distinguishes a recorded dev merge from completed post-merge checks', () => {
  const task = { id: 'merge', title: 'Members arrow', plans: [{ version: 1, at: 1, nodes: [{ no: 1, dependsOn: [], ownerId: 'tester' }] }],
    rounds: [{ ownerId: 'tester', startedAt: 10, planNode: { version: 1, node: 1 }, mergeReceipt: { mergeCommit: 'snapshot', at: 20 } }] }
  assert.deepEqual(row(task).labels, ['Merged into dev, validating'])
  task.rounds[0].result = 'Targeted checks passed'
  task.rounds[0].submittedAt = 30
  assert.deepEqual(row(task).labels, ['Awaiting review'])
})

test('task detail shows only the three fields and switches to a read-only requirement snapshot', async () => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('../src/client/project-task-detail.js', import.meta.url))],
    bundle: true, format: 'cjs', write: false, external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const history = [{ text: 'Earlier request', images: [] }]
  const detail = { requirement: 'First。Second。', acceptance: '1. Check output', requirementHistory: history }
  const state = [detail]
  let hook = 0
  const runtime = { ...react, useState(initial) {
    const slot = hook++
    if (!(slot in state)) state[slot] = initial
    return [state[slot], value => { state[slot] = value }]
  } }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => runtime })
  const panel = module.exports.ProjectTaskDetail({ room: { id: 'r' }, card: { taskId: 't' } })
  const body = find(panel, n => n.props?.className?.includes('bt-drawer-body'))
  const fields = body.children[0].children[1].children
  assert.deepEqual(Array.from(fields, node => node.props.label ?? node.type.name), ['Requirement', 'Acceptance criteria', 'TaskWorkspace'])
  const show = () => { hook = 3; return fields[0].type(fields[0].props).props }
  const latest = show()
  assert.equal(latest.value, '1. First。\n2. Second。')
  assert.equal(latest.headerControl.props.value, 1)
  latest.headerControl.props.onChange({ target: { value: '0' } })
  assert.equal(show().value, '1. Earlier request')
  assert.equal(show().onEdit, undefined)
  show().headerControl.props.onChange({ target: { value: '1' } })
  assert.equal(typeof show().onEdit, 'function')
})

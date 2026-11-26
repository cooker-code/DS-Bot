import assert from 'node:assert/strict'
import test from 'node:test'
import { savePlan, nodeViews, approveRound, nodeHandoff } from '../src/host/project-plan.js'
import { currentBinding } from '../src/host/project-recovery.js'

const room = { admin: 'manager', members: ['manager', 'writer', 'tester'] }
const work = (title, extra = {}) => ({ title, ownerId: 'writer', instructions: 'Inspect ' + title, deliverable: title + ' evidence', acceptance: 'Evidence checked', dependsOn: [], ...extra })
function fixture() {
  const card = { id: 'card', rounds: [] }
  const nodes = [work('Sources'), work('Build', { dependsOn: [1] }), work('Review', { ownerId: 'tester', dependsOn: [2] })]
  savePlan(card, { version: 1, nodes }, room, 'manager')
  card.rounds.push({ ownerId: 'writer', result: 'Source observations', planNode: { version: 1, node: 1, inputs: [], artifact: 'source-note', acceptedAt: 1 } })
  return { card, nodes }
}

test('a revision automatically carries verified evidence and preserves identity across renaming and reordering', () => {
  const { card, nodes } = fixture()
  savePlan(card, { version: 2, reason: 'Add design', nodes: [work('Design'), { ...nodes[0], title: 'Source evidence', itemId: '1:1' }, { ...nodes[1], dependsOn: [2] }, nodes[2]] }, room, 'manager')
  const views = nodeViews(card, card.plans.at(-1))
  assert.equal(views[1].itemId, '1:1')
  assert.equal(views[1].status, 'verified')
  assert.equal(views[1].reuseRound, 1)
  assert.equal(views[0].status, 'ready')
  assert.equal(card.plans[0].nodes[0].title, 'Sources')
})

test('changed acceptance or instructions reopen work; a title alone cannot carry completion', () => {
  for (const change of [{ acceptance: 'New required sample' }, { instructions: 'Use another source' }]) {
    const { card, nodes } = fixture()
    savePlan(card, { version: 2, reason: 'Changed scope', nodes: [{ ...nodes[0], itemId: '1:1', ...change }, ...nodes.slice(1)] }, room, 'manager')
    assert.equal(nodeViews(card, card.plans.at(-1))[0].status, 'ready')
    assert.equal(card.rounds[0].planNode.acceptedAt, 1)
  }
})

test('an upstream change invalidates downstream evidence while independent verified work survives', () => {
  const { card, nodes } = fixture()
  card.rounds.push({ ownerId: 'writer', result: 'Built', planNode: { version: 1, node: 2, inputs: [{ node: 1, round: 1 }], artifact: 'build', acceptedAt: 2 } })
  savePlan(card, { version: 2, reason: 'Change source', nodes: [{ ...nodes[0], itemId: '1:1', acceptance: 'New source required' }, { ...nodes[1], itemId: '1:2' }, nodes[2]] }, room, 'manager')
  assert.equal(nodeViews(card, card.plans.at(-1))[1].reuseRound, undefined)
})

test('an unchanged running round remains current through a revision and can be reviewed once', () => {
  const { card, nodes } = fixture()
  card.rounds.push({ ownerId: 'writer', startedAt: 2, planNode: { version: 1, node: 2, inputs: [{ node: 1, round: 1 }] } })
  savePlan(card, { version: 2, reason: 'Clarify review', nodes: [nodes[0], work('Added work'), { ...nodes[1], itemId: '1:2' }, { ...nodes[2], dependsOn: [3], acceptance: 'New review sample' }] }, room, 'manager')
  assert.equal(nodeViews(card, card.plans.at(-1))[2].round, 2)
  assert.equal(currentBinding(card, card.rounds[1]), true)
  assert.match(nodeHandoff(card, card.rounds[1]), /Node 3: Build/)
  card.rounds[1].result = 'Build candidate'
  approveRound(card, { version: 2, node: 3, round: 2, artifact: 'build-candidate' }, 'manager')
  assert.equal(nodeViews(card, card.plans.at(-1))[2].status, 'verified')
  assert.equal(card.rounds[1].planNode.version, 1)
})

test('unchanged saves are idempotent and duplicate identities are refused', () => {
  const { card, nodes } = fixture()
  const args = { version: 2, reason: 'Keep verified source', nodes }
  savePlan(card, args, room, 'manager')
  savePlan(card, args, room, 'manager')
  assert.equal(card.plans.length, 2)
  assert.throws(() => savePlan(card, { version: 3, reason: 'Duplicate', nodes: nodes.map(node => ({ ...node, itemId: '1:1' })) }, room, 'manager'), /only once/)
})

test('automatic identity matching preserves fixed-owner constraints through reordering', () => {
  const card = { id: 'constraints', rounds: [] }
  const a = work('A'), b = work('B', { fixedOwner: true })
  savePlan(card, { version: 1, nodes: [a, b] }, room, 'manager')
  const { fixedOwner: _fixed, ...withoutFlag } = b
  savePlan(card, { version: 2, reason: 'Reorder', nodes: [withoutFlag, a] }, room, 'manager')
  assert.equal(card.plans.at(-1).nodes[0].fixedOwner, 1)
  assert.throws(() => savePlan(card, { version: 3, reason: 'Change owner', nodes: [{ ...withoutFlag, ownerId: 'tester' }, a] }, room, 'manager'), /designated owner/)
})

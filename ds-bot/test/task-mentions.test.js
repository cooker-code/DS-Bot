import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { parseSessionReferenceText } from '@deepseek-ai/dsh-session-reference'
import { indexRoster } from '../src/client/sources.js'
import { readTaskReference } from '../src/host/task-reference.js'
import { inboundScope, mentionedProjectCard } from '../src/host/task-routing.js'
import { mentionSpans } from '../src/shared/mentions.js'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/task-mentions.js', import.meta.url))],
  bundle: true, format: 'cjs', write: false, external: ['react', 'react-dom'],
})
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => ({}) })
const { taskMentionSource } = module.exports

const cardId = 'ad3f1157-faea-4d3a-a5f6-ea88bdaed900'
function fixture() {
  const bots = [{ id: 'dev', name: 'Coder', sessionId: 'dev-2' }, { id: 'writer', name: 'Writer' }]
  const card = { id: cardId, title: '核验 release', acceptance: 'Two checks pass', intakes: ['first'], rounds: [
    { ownerId: 'dev', plan: 'Run the checks', result: 'Checks passed' },
  ] }
  const intake = { id: 'pending', title: '补充核验', status: 'pending' }
  const room = { id: 'r', name: 'Release', members: ['dev'], notice: '[taskId]', sessionId: 'r-2',
    projectCards: { [cardId]: card }, projectInbox: [intake],
    tasks: { member: { goal: '核验 release', botId: 'dev', status: 'done', progress: 'Testing', notes: [{ text: 'Test Linux' }] } } }
  const other = { id: 'other', name: 'Other', members: ['writer'], tasks: { secret: { goal: 'Other task', status: 'active', botId: 'writer' } } }
  const roster = indexRoster({ bots, rooms: [{ ...room, projectCards: [{ ...card, taskId: cardId, status: 'review' }], pendingIntakes: [intake] }, other] })
  const rt = {
    roomOf: id => ({ r: room, 'r-2': room, other })[id],
    selfOf: id => roster.byId[id]?.id, botOf: id => bots.find(bot => bot.id === id),
    pastOwners: new Map(), groupOwners: new Map(),
    ledger: { records: () => [
      { seq: 1, who: 'User', intakeId: 'first', text: '核验 release\n@Writer\n[' + cardId + '] previous example\ndsh-session:ImRldiI' },
      { seq: 2, who: 'User', intakeId: 'pending', text: '补充核验\nVerify the second line',
        images: [{ id: 'image-1', name: 'Screenshot.png' }], files: [{ name: 'Report.md' }] },
      { seq: 3, who: 'User', intakeId: 'unrelated', text: 'Unrelated memo' },
    ] },
  }
  const reads = []
  const source = taskMentionSource({ getSnapshot: () => roster }, async (endpoint, payload, signal) => {
    reads.push({ endpoint, payload, signal })
    const task = readTaskReference(rt, payload)
    if (!task) throw Error('No such task')
    return task
  })
  return { room, reads, rt, source, bots, search: (sessionId, query = '') => source.candidates({ sessionId }, { query }) }
}

test('task suggestions search the current room or the private Bot’s groups, including completed work', async () => {
  const { search, reads } = fixture()
  for (const id of ['r', 'r-2', 'dev', 'dev-2']) {
    assert.deepEqual(Array.from(await search(id, '核验'), row => row.name), ['核验 release', '核验 release', '补充核验'])
    assert.equal((await search(id, 'Other')).length, 0)
    assert.equal((await search(id, cardId.slice(0, 8))).length, 1)
  }
  assert.equal((await search('writer'))[0].name, 'Other task')
  assert.equal((await search('plain')).length, 0)
  assert.equal(reads.length, 0)
})

test('same-name selections resolve by kind and ID at send time without routing the quoted text', async () => {
  const { search, source, room, reads, bots } = fixture()
  const [project, member] = (await search('dev-2', 'RELEASE')).map(candidate => source.onPick({ candidate }).insert)
  const signal = new AbortController().signal
  assert.notEqual(project.ref, member.ref)
  assert.equal(project.label, '核验 release')
  assert.equal(source.codec.clipboardText(project.ref), project.clipboardText)
  room.projectCards[cardId].acceptance = 'Latest acceptance\n```js'
  const quote = await source.codec.serialize(project.ref, signal)
  for (const text of ['@Writer', 'Latest acceptance', 'Run the checks', 'Checks passed', cardId]) assert.ok(quote.includes(text))
  assert.doesNotMatch(quote, /Unrelated memo|Verify the second line|Test Linux/)
  assert.equal(reads[0].signal, signal)
  const message = quote + 'Discuss this with @Coder'
  assert.deepEqual(mentionSpans(message, bots).map(span => span.bot.name), ['Coder'])
  assert.deepEqual(parseSessionReferenceText(message).references, [])
  assert.match(inboundScope({ text: message }), /^intake-/)
  assert.match(inboundScope({ text: quote + '继续' }, 'prior-task'), /^intake-/)
  const [groupCard] = await search('r-2', cardId)
  const groupQuote = await source.codec.serialize(source.onPick({ candidate: groupCard }).insert.ref)
  for (const body of ['推进任务', '请核对上次的阻塞原因后再交给助理', 'task 继续推进', '为什么受阻？'])
    assert.deepEqual(mentionedProjectCard(groupQuote + body), { taskId: cardId, text: body })
  for (const other of [quote + '继续', groupQuote, groupQuote + groupQuote + '继续'])
    assert.equal(mentionedProjectCard(other), undefined)
  const memberQuote = await source.codec.serialize(member.ref)
  assert.match(memberQuote, /Testing/)
  assert.match(memberQuote, /Test Linux/)
  assert.doesNotMatch(memberQuote, /Latest acceptance/)
  room.members = []
  await assert.rejects(source.codec.serialize(member.ref), /No such task/)
})

test('an intake reference follows its own card when accepted, and a deleted reference cannot send', async () => {
  const { search, source, room, rt } = fixture()
  const [candidate] = await search('r', '补充')
  const { ref } = source.onPick({ candidate }).insert
  const intake = await source.codec.serialize(ref)
  assert.match(intake, /Verify the second line/)
  assert.match(intake, /Attachments: Screenshot.png, Report.md/)
  room.projectCards[cardId].intakes.push('pending')
  room.projectInbox[0].status = 'attached'
  assert.match(await source.codec.serialize(ref), /Two checks pass/)
  assert.equal(readTaskReference(rt, { roomId: 'r', sessionId: 'other', id: cardId, kind: 'project' }), undefined)
  delete room.projectCards[cardId]
  await assert.rejects(source.codec.serialize(ref), /No such task/)
})

test('identical menu labels are distinguishable and an old task can still be found by ID', async () => {
  const { room, search } = fixture()
  for (let n = 0; n < 14; n++) room.tasks['member-' + n] = { ...room.tasks.member, updatedAt: n + 1 }
  const newest = await search('r', '核验 release')
  assert.equal(newest.length, 12)
  assert.equal(new Set(Array.from(newest, row => row.description)).size, 12)
  assert.equal(JSON.parse((await search('r', 'member-0'))[0].value).id, 'member-0')
})

test('a project quote attributes parallel progress, blockers and results to the right steps', async () => {
  const { room, search, source } = fixture()
  const card = room.projectCards[cardId]
  const node = (no, title) => ({ no, title, ownerId: 'dev', dependsOn: [] })
  card.plans = [{ version: 2, at: 1, nodes: [node(1, 'Inspect'), node(2, 'Test')] }]
  card.rounds = [
    { ownerId: 'dev', planNode: { version: 1, node: 1 }, result: 'Superseded delivery' },
    { ownerId: 'dev', planNode: { version: 2, node: 1, completed: 'Verified the build', block: { reason: 'Missing approval', decisions: [] } } },
    { ownerId: 'dev', planNode: { version: 2, node: 2 }, result: 'All tests passed' },
  ]
  const [row] = await search('r', cardId)
  const quote = await source.codec.serialize(source.onPick({ candidate: row }).insert.ref)
  for (const text of ['Plan v2', 'Inspect — Verified the build', 'Inspect — Missing approval', 'Test — All tests passed'])
    assert.ok(quote.includes(text))
  assert.doesNotMatch(quote, /Superseded delivery/)
})

// Run against a fresh isolated bench with dev/mock-llm.mjs.
// node dev/project-node-recovery-smoke.mjs <bench> <web-port> [screenshot-directory]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium } from 'playwright-core'
import { readSplitTeam, splitTeamStorage, storageKey } from '../src/host/team-storage/split.js'

const [bench, port, output] = process.argv.slice(2)
assert.match(bench, /^[a-z0-9-]+$/)
assert.match(port, /^[0-9]+$/)
const home = resolve(import.meta.dirname, '../../.dsh-test-' + bench)
const base = 'http://127.0.0.1:' + port
const login = readFileSync(join(home, 'web.log'), 'utf8').match(new RegExp(base + '/\\?token=[^\\s]+'))[0]
if (output) mkdirSync(output, { recursive: true })

const fixture = mkdtempSync(join(tmpdir(), 'ds-bot-recovery-'))
const source = join(fixture, 'test-source')
const backup = join(fixture, 'test-backup')
function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

// A cancelled DSH turn cannot emit a second callback on demand. Replay its
// exact dispatch against an isolated copy of this same card while Backup runs.
async function replayRetiredReceipt(roomId, taskId) {
  const liveRoom = readSplitTeam(join(home, 'bot/state')).rooms[roomId]
  const originalCard = liveRoom.projectCards[taskId]
  const retired = originalCard.rounds[2], successor = originalCard.rounds[3]
  assert.ok(successor.startedAt && !successor.result)
  const folder = join(fixture, 'receipt-replay')
  mkdirSync(folder)
  const storage = splitTeamStorage(folder)
  const room = { id: roomId, notice: liveRoom.notice, members: liveRoom.members, projectCards: { [taskId]: originalCard } }
  const state = { version: 1, rooms: { [roomId]: room } }
  storage.import(state, () => {})
  const session = retired.planNode.session
  const info = { taskId, roomId, exchangeId: retired.dispatchId }
  const host = {
    state, teamTools: [], groupOwners: new Map(), live: new Map([[session, { info }]]),
    load: async () => {}, readOnly: () => undefined, roomOf: id => state.rooms[id],
    selfOf: id => id === session ? retired.ownerId : undefined, isAdminOf: () => false, botOf: id => ({ id }),
    save: async ({ mutate }) => {
      const undo = mutate()
      try { storage.write(state, () => {}) } catch (error) { undo?.(); throw error }
    },
  }
  await import('../test/harness-resolve.mjs')
  const { install } = await import('../src/host/project-tasks.js')
  install(host)
  const project = host.teamTools.find(tool => tool.name === 'project_task')
  const result = '迟到回执：旧轮测试返回。'
  const receipt = JSON.parse(await project.execute({ action: 'submit', taskId, round: 3, result }, { agent: { id: session } }))
  assert.equal(receipt.advanced, false)
  assert.equal(receipt.lateReceiptRound, 3)
  const saved = storage.read().rooms[roomId].projectCards[taskId]
  assert.equal(saved.rounds[2].planNode.lateResult, result)
  assert.equal(saved.rounds[2].result, undefined)
  assert.deepEqual(saved.rounds[3], successor)
  assert.deepEqual(saved.rounds[1], originalCard.rounds[1])
  console.log('Replayed the retired Tester dispatch against the active card snapshot. Only round 3 recorded the late receipt.')
}

let browser, context, page
try {
  git('init', '-b', 'main', source)
  writeFileSync(join(source, 'display.cjs'), "module.exports = value => value || '-';\n")
  writeFileSync(join(source, 'verify.cjs'), [
    "const assert = require('node:assert/strict')",
    "const display = require('./display.cjs')",
    "const empty = process.argv[2] === 'empty'",
    "assert.equal(display(empty ? '' : 'Manual'), empty ? '-' : 'Manual')",
    "console.log('CHECK PASSED ' + process.argv[2])",
  ].join('\n'))
  git('-C', source, 'add', '.')
  git('-C', source, '-c', 'user.name=Test Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Create request source fixture')
  git('-C', source, 'tag', 'source-display@v1')
  git('-C', source, 'worktree', 'add', '--detach', backup, 'HEAD')
  const head = git('-C', source, 'rev-parse', 'HEAD')

  browser = await chromium.launch()
  context = await browser.newContext({ viewport: { width: 1260, height: 940 }, locale: 'zh-CN' })
  await context.request.get(login, { maxRedirects: 0 })
  async function api(endpoint, payload = {}) {
    const response = await context.request.post(base + '/api/bot', { data: { endpoint, payload } })
    const body = await response.json()
    if (!body.ok) throw Error(endpoint + ': ' + body.error.message)
    return body.value
  }
  const state = await api('state')
  const chief = state.bots.find(bot => bot.name === 'Chief')
  assert.ok(chief && state.bots.length === 1 && !state.rooms.length, 'Use a fresh isolated mock bench')
  const model = state.models.find(m => m.ref.includes('flash') && !m.needsKey).ref
  await api('update-bot', { id: chief.id, model })
  const members = { Chief: chief.id }
  for (const name of ['Coder', 'Reviewer', 'Tester', 'Backup']) {
    const bot = await api('create-bot', { name, role: name, model, workDir: name === 'Backup' ? backup : source,
      instructions: 'Use the saved plan and report verified checks.' })
    members[name] = bot.id
  }
  const room = await api('create-room', { name: '请求来源显示 · 接管验收', members: Object.values(members), admin: chief.id })
  await api('update-room', { id: room.id, notice: '[taskId]' })
  page = await context.newPage()
  page.setDefaultTimeout(45000)
  await page.setContent('<main style="font:16px system-ui;border:1px solid #ccd4dc;border-radius:8px;padding:14px;width:320px"><b>请求详情</b><hr>请求来源<span style="float:right">未标记</span></main>')
  const image = await api('stage-image', { mediaType: 'image/png', data: (await page.locator('main').screenshot()).toString('base64') })
  await page.goto(base)
  await page.locator('[data-room-id="' + room.id + '"]').click()
  const group = page.locator('button.bt-pill').filter({ hasText: room.name })
  await group.waitFor()
  if (!await page.locator('.bt-tasks').isVisible()) await group.click()
  await page.locator('.bt-tasks').waitFor()
  await api('send', { sessionId: room.id, text: '按图将请求来源空值显示为短横线，已有来源保持原值。中断接管验收。', images: [image.id] })
  const row = page.locator('.bt-project-row').first()
  await row.waitFor()
  const taskId = (await api('state')).rooms.find(r => r.id === room.id).projectCards[0].taskId
  async function until(label, check) {
    const deadline = Date.now() + 95000
    let detail
    do {
      detail = await api('project-task-detail', { roomId: room.id, taskId })
      if (check(detail)) return detail
      await new Promise(resolve => setTimeout(resolve, 250))
    } while (Date.now() < deadline)
    throw Error(label + ' timed out. Node statuses: ' + JSON.stringify(detail.plans?.at(-1)?.nodes.map(n => n.status)))
  }
  await until('test checkpoint', d => d.rounds[2]?.planNode.completed)
  assert.ok(await api('stop-chat', { botId: members.Tester }))
  const blocked = await until('interruption', d => d.plans[0].nodes[2].status === 'blocked')
  assert.equal(blocked.plans[0].nodes[1].status, 'active')
  assert.equal(blocked.rounds[2].planNode.block.cause, 'interrupted')
  await row.click()
  const detail = page.locator('.bt-project-detail')
  const requirement = detail.getByRole('region', { name: '需求', exact: true })
  const acceptance = detail.getByRole('region', { name: '验收标准', exact: true })
  await requirement.getByText(blocked.requirement, { exact: true }).waitFor()
  const originalImage = requirement.getByRole('img')
  await originalImage.evaluate(async image => { await image.decode() })
  await acceptance.getByText(blocked.acceptance, { exact: true }).waitFor()
  await detail.getByRole('region', { name: '分支与工作树', exact: true }).waitFor()
  assert.equal(await detail.locator(':scope > *').count(), 3)
  console.log('Tester passed the empty-source check and stopped. Only its node is blocked. Reviewer is running.')

  await api('send', { sessionId: room.id,
    text: '[' + taskId + '] 请核对工作树并接管测试。中断接管验收。 task=' + taskId + ' candidate=' + members.Backup + ' 按图将请求来源空值显示为短横线。' })
  await until('replacement start', d => d.rounds[3]?.startedAt)
  await replayRetiredReceipt(room.id, taskId)
  const recovered = await until('replacement submission', d => d.rounds[3]?.result)
  await until('independent review', d => d.rounds[1]?.result)
  const decision = recovered.rounds[2].planNode.block.decisions.at(-1)
  assert.equal(decision.action, 'takeover')
  assert.equal(decision.sourceTree.commit, head)
  assert.equal(decision.targetTree.commit, head)
  assert.notEqual(decision.sourceTree.dir, decision.targetTree.dir)
  assert.equal(recovered.rounds[3].ownerId, members.Backup)
  assert.match(recovered.rounds[3].result, /已有来源保持原值/)
  assert.equal(recovered.requirements[0].images.length, 1)
  await requirement.getByRole('button', { name: '编辑' }).click()
  await requirement.getByRole('textbox').fill('尚未保存')
  await requirement.getByRole('button', { name: '取消' }).click()
  await requirement.getByText(recovered.requirement, { exact: true }).waitFor()
  const update = async (section, markdown) => {
    await section.getByRole('button', { name: '编辑' }).click()
    await section.getByRole('textbox').fill(markdown)
    await section.getByRole('button', { name: '保存' }).click()
    await section.getByRole('textbox').waitFor({ state: 'hidden' })
  }
  await update(requirement, '将**空值**显示为短横线。')
  await update(acceptance, '- 空来源显示为短横线\n- 已有来源保持原值')
  await page.getByRole('button', { name: '返回详情' }).click()
  await row.click()
  await requirement.locator('strong').filter({ hasText: '空值' }).waitFor()
  await originalImage.evaluate(async image => { await image.decode() })
  await acceptance.getByRole('listitem').last().waitFor()
  assert.equal(await acceptance.getByRole('listitem').count(), 2)
  if (output) await detail.screenshot({ path: join(output, 'task-details.png') })
  const db = new DatabaseSync(join(home, 'bot/state/rooms', storageKey(room.id), 'room.sqlite'), { readOnly: true })
  try {
    const bindings = db.prepare('SELECT round_no,superseded_by,previous_round FROM task_round_plans WHERE node_no=3 ORDER BY round_no').all()
    assert.deepEqual(bindings.map(r => [r.round_no, r.superseded_by, r.previous_round]), [[3, 4, null], [4, null, 3]])
    assert.equal(db.prepare('SELECT action FROM task_recovery_decisions').get().action, 'takeover')
    assert.ok(db.prepare('PRAGMA user_version').get().user_version >= 5)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { db.close() }
  console.log('Reviewer submitted independently. Backup passed the remaining check. The new round and both inspected worktrees are recorded.')
} catch (error) {
  if (output && page) await page.screenshot({ path: join(output, 'recovery-failed.png') }).catch(() => {})
  throw error
} finally {
  try {
    try { await context?.close() } finally { await browser?.close() }
  } finally { rmSync(fixture, { recursive: true, force: true }) }
}

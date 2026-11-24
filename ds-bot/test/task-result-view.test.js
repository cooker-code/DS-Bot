import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { taskResultView, readReceiptFile } from '../src/host/task-result-view.js'

test('a historical review displays its acceptance table, named sibling screenshots and complete report', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'task-result-view-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const root = join(tmp, 'fix%2Ftime')
  const dir = join(root, '.playwright-mcp', 'round5')
  await mkdir(dir, { recursive: true })
  const report = join(dir, 'test-report.md')
  const markdown = '# 测试报告\n## 验收结果\n|验收项|实际观察|结果|\n|---|---|---|\n|跨时区|跨年正确|通过|\n|窄屏|发生溢出|失败|\n\n## 证据\n' + '正文'.repeat(50000)
  await writeFile(report, markdown)
  await writeFile(join(dir, 'Asia-Taipei-normal.png'), 'image')
  await writeFile(join(dir, 'debug.png'), 'debug')
  const rt = { inData: async () => false, privateClash: async () => false }
  const room = { workDir: root }
  const review = { result: '独立报告通过；报告：' + report + '；同目录截图：Asia-Taipei-normal.png。' }
  const card = { rounds: [{ result: 'development logs' }, review], plans: [{ nodes: [{ round: 1 }, { round: 2, independentReview: true }] }] }
  const [group] = await taskResultView(rt, room, card, card)
  assert.deepEqual(group.items, ['跨时区 · 通过', '窄屏 · 失败'])
  assert.deepEqual(group.files.map(f => f.name), ['test-report.md', 'Asia-Taipei-normal.png'])
  const [doc, img] = group.files
  assert.equal(await readReceiptFile(rt, room, card, doc.receiptFile), markdown)
  assert.equal(await readReceiptFile(rt, room, card, img.receiptFile), 'data:image/png;base64,aW1hZ2U=')
  await assert.rejects(readReceiptFile(rt, room, { rounds: [] }, doc.receiptFile), { code: 'bot/not-found' })
  await rm(report)
  await writeFile(join(tmp, 'private.md'), 'private')
  await symlink(join(tmp, 'private.md'), report)
  await assert.rejects(readReceiptFile(rt, room, card, doc.receiptFile), { code: 'bot/not-found' })
  assert.deepEqual((await taskResultView(rt, room, card, card))[0].items, ['独立报告通过'])
})

test('a blocked delivery exposes its recorded document without claiming acceptance or completion', async t => {
  const root = await mkdtemp(join(tmpdir(), 'blocked-result-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const report = join(root, '讨论整理.md')
  const markdown = '# 讨论整理\n\n## 验收结果\n|项目|结果|\n|---|---|\n|企微发送|尚未发送|\n'
  await writeFile(report, markdown)
  const rt = { inData: async () => false, privateClash: async () => false }
  const room = { workDir: root }
  const round = { planNode: { block: { reason: 'Delivery unavailable', evidence: '文档：' + report + '；未发送。' } } }
  const card = { rounds: [round], plans: [{ nodes: [{ round: 1, status: 'blocked' }] }] }
  const [group] = await taskResultView(rt, room, card, card)
  assert.equal(group.partial, true)
  assert.deepEqual(group.items, [])
  assert.deepEqual(group.files.map(file => file.name), ['讨论整理.md'])
  assert.equal(await readReceiptFile(rt, room, card, group.files[0].receiptFile), markdown)
  assert.equal(round.result, undefined)
  assert.equal(round.submittedAt, undefined)
  round.planNode.block.evidence = join(root, '..', 'unrelated.md')
  assert.deepEqual(await taskResultView(rt, room, card, card), [])
})

test('a checkpoint artifact is available before final submission', async t => {
  const root = await mkdtemp(join(tmpdir(), 'checkpoint-result-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'report.md'), '# Prepared document')
  const rt = { inData: async () => false, privateClash: async () => false }
  const card = { rounds: [{ planNode: { checkpointArtifact: 'report.md' } }] }
  const [group] = await taskResultView(rt, { workDir: root }, card, card)
  assert.equal(group.partial, true)
  assert.equal(group.files[0].name, 'report.md')
})

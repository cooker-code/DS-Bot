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

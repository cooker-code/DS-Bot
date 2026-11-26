import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

const source = readFileSync(new URL('../src/client/task-board.js', import.meta.url), 'utf8')
// Exercise the actual component and its local helpers without loading browser-only imports.
const section = source.slice(source.indexOf('export function projectElapsed'), source.indexOf('function ProjectRetry'))
const t = (label, values = {}) => label.replace(/\{(\w+)\}/g, (_, key) => values[key])
const { ProjectCard, projectStartLabel, projectElapsed } = runInNewContext(
  `${section.replace('export function', 'function')}; ({ ProjectCard, projectStartLabel, projectElapsed })`,
  { Date, Number, String, t, elapsedLabel: duration => `${duration / 1000}s`,
    TASK_STATUS: { done: 'Done' },
    h: (tag, props, ...children) => ({ tag, props, children }),
  },
)
const text = node => typeof node === 'string' ? node : node?.children?.map(text).join(' ') ?? ''

test('ProjectCard start uses fixed month-day and seconds with the existing label', () => {
  const startedAt = new Date(2026, 10, 24, 9, 29, 5).getTime()
  const card = { taskId: 'card', title: 'Task', status: 'done', startedAt, submittedAt: startedAt + 120000 }
  const rendered = text(ProjectCard({ card, roster: {} }))
  assert.match(rendered, /Started 11-24 09:29:05/)
  assert.match(rendered, /Elapsed 2 min/)
  assert.equal(card.startedAt, startedAt)
})

test('all single digit fields and midnight seconds are zero padded', () => {
  assert.equal(projectStartLabel(new Date(2026, 0, 2, 0, 0, 5).getTime()), '01-02 00:00:05')
})

test('start respects client local time including cross-day and cross-year offsets', () => {
  const original = process.env.TZ
  try {
    const instant = Date.parse('2026-01-01T00:00:05Z')
    for (const [zone, expected] of [
      ['UTC', '01-01 00:00:05'],
      ['Asia/Taipei', '01-01 08:00:05'],
      ['America/Los_Angeles', '12-31 16:00:05'],
    ]) {
      process.env.TZ = zone
      assert.equal(projectStartLabel(instant), expected, zone)
    }
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }
})

test('missing or non-finite start keeps both timing labels hidden', () => {
  for (const startedAt of [undefined, null, NaN, Infinity]) {
    const rendered = text(ProjectCard({ card: { title: 'Task', status: 'done', startedAt }, roster: {} }))
    assert.doesNotMatch(rendered, /Started|Elapsed/)
  }
})

test('elapsed behavior and other task time formatting remain unchanged', () => {
  assert.equal(projectElapsed(1000, 6000), '5s')
  assert.equal(projectElapsed(1000, 121000), '2 min')
  assert.equal(projectElapsed(1000, undefined), '—')
  assert.equal(projectElapsed(1000, 0), '—')
  assert.equal((source.match(/projectStartLabel\(start\)/g) ?? []).length, 1)
  assert.doesNotMatch(section, /messageClock\(start\)/)
  assert.match(source.slice(source.indexOf('function TaskRow')), /clockLabel\(task\.startedAt\)/)
})

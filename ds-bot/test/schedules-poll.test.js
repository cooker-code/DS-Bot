import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

test('scheduled-task polling pauses while hidden, avoids overlapping calls, and releases its listener', async () => {
  const { outputFiles } = await build({
    stdin: {
      contents: "export { useSchedules } from './src/client/schedules.js'",
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    },
    bundle: true, format: 'cjs', platform: 'browser', write: false,
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const document = new EventTarget()
  document.hidden = false
  const effects = []
  const timers = new Map()
  let nextTimer = 0
  const react = {
    createElement() {},
    createContext: value => ({ value }),
    useEffect: run => effects.push(run),
    useState: value => [value, () => {}],
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, document,
    setTimeout: run => { const id = ++nextTimer; timers.set(id, run); return id },
    clearTimeout: id => timers.delete(id),
    require: () => react,
  })
  let calls = 0
  module.exports.useSchedules({ schedules: async () => { calls += 1; return { tasks: [] } } })
  const stop = effects[0]()
  const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() }
  try {
    await settle()
    assert.equal(calls, 1)
    assert.equal(timers.size, 1)
    document.hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    assert.equal(timers.size, 0)
    document.hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    assert.equal(calls, 2)
    assert.equal(timers.size, 1)
  } finally {
    stop()
  }
  assert.equal(timers.size, 0)
  document.dispatchEvent(new Event('visibilitychange'))
  await settle()
  assert.equal(calls, 2)
})

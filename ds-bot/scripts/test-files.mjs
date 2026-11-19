// Requiring file names keeps an empty selection from triggering Node's test discovery.
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'

const files = process.argv.slice(2)
if (!files.length || files.some(file => file.startsWith('-') || !file.endsWith('.test.js') || !statSync(file, { throwIfNoEntry: false })?.isFile())) {
  console.error('Usage: npm test -- test/<name>.test.js [test/<name>.test.js ...]\nFull suite: npm run test:all')
  process.exitCode = 2
} else {
  const result = spawnSync(process.execPath, [
    '--import', './test/harness-resolve.mjs', '--test', '--test-concurrency=1',
    '--test-timeout=120000', '--test-force-exit', ...files,
  ], { stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}

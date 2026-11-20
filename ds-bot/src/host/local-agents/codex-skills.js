// Extra skill roots belong to the app-server process. The adapter gives each
// managed session its own driver and keeps the project cwd for every thread.
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export function prepareCodexSkills(skills) {
  const roots = new Set()
  const selected = new Map()
  const rules = []
  for (const skill of skills) {
    // Disable every auto-discovered copy, including one at the shared cwd.
    rules.push(`{name=${JSON.stringify(skill.name)},enabled=false}`)
    if (!skill.root) continue
    const path = join(skill.root, skill.name, 'SKILL.md')
    if (skill.content !== undefined) {
      const text = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n${skill.content}`
      let previous
      try { previous = readFileSync(path, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (previous !== text) {
        mkdirSync(join(skill.root, skill.name), { recursive: true, mode: 0o700 })
        const tmp = path + '.' + randomUUID()
        try {
          writeFileSync(tmp, text, { mode: 0o600 })
          renameSync(tmp, path)
        } finally { rmSync(tmp, { force: true }) }
      }
    }
    const locator = realpathSync(path)
    roots.add(realpathSync(skill.root))
    selected.set(skill.name, locator)
    rules.push(`{path=${JSON.stringify(locator)},enabled=true}`)
  }
  return { args: ['-c', `skills.config=[${rules.join(',')}]`], roots: [...roots], selected }
}

export async function verifyCodexSkills(peer, cwd, skills, selected) {
  const result = await peer.request('skills/list', { cwds: [cwd], forceReload: true }, { timeout: 30_000 })
  const catalog = result?.data?.[0]?.skills
  if (!Array.isArray(catalog)) throw new Error('Codex did not return its skill catalog.')
  const managed = new Set(skills.map(skill => skill.name))
  const enabled = catalog.filter(skill => managed.has(skill.name) && skill.enabled)
  if (enabled.length !== selected.size || new Set(enabled.map(skill => skill.name)).size !== selected.size
    || enabled.some(skill => selected.get(skill.name) !== skill.path)) {
    throw new Error('This Codex could not apply the selected skills. Update the local Codex CLI and retry.')
  }
}

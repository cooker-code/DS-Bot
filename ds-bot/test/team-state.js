import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readSplitTeam, splitTeamStorage } from '../src/host/team-storage/split.js'
import { readTeamDatabase, sqliteTeamStorage } from '../src/host/team-storage/sqlite.js'

// Some fixtures edit a legacy team before its very first load. After import,
// assertions and simulated external edits must use the authoritative database.
export function savedTeam(home) {
  if (existsSync(join(home, 'state'))) return readSplitTeam(join(home, 'state'))
  const path = join(home, 'team.sqlite')
  return existsSync(path) ? readTeamDatabase(path) : JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
}
export function seedTeam(home, team) {
  if (existsSync(join(home, 'state'))) return splitTeamStorage(home).write(team, () => {})
  const path = join(home, 'team.sqlite')
  const legacy = join(home, 'state.json')
  if (existsSync(path)) sqliteTeamStorage(path, legacy).write(team, () => {})
  else writeFileSync(legacy, JSON.stringify(team))
}

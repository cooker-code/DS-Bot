import { randomUUID } from 'node:crypto'
import { closeSync, linkSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { decodeTeam, encodeTeam } from './records.js'

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
export const tables = {
  team_state: ['singleton'], bots: ['bot_id'], rooms: ['room_id'], room_members: ['room_id', 'position'],
  room_todos: ['room_id', 'position'], tasks: ['task_pk'], task_intakes: ['task_pk', 'position'],
  task_rounds: ['task_pk', 'round_no'], task_notes: ['task_pk', 'position'], task_blocks: ['task_pk'],
}
const order = { bots: 'position', rooms: 'position', tasks: 'room_id, source_kind, position' }
const allRows = db => Object.fromEntries(Object.entries(tables).map(([name, keys]) =>
  [name, db.prepare('SELECT * FROM ' + name + ' ORDER BY ' + (order[name] ?? keys.join(','))).all()]))

export function fileStamp(path) {
  const info = statSync(path, { bigint: true, throwIfNoEntry: false })
  // ctime changes on metadata updates even when the database and access mode are unchanged.
  return info ? [info.dev, info.ino, info.size, info.mtimeNs, info.mode].join(':') : ''
}

export function syncRows(db, old, rows, layout = tables, prefix = '') {
  const changes = []
  for (const [name, keys] of Object.entries(layout)) {
    const keyOf = row => JSON.stringify(keys.map(key => row[key]))
    const previous = new Map(old[name].map(row => [keyOf(row), row]))
    const next = rows[name].filter(row => {
      const key = keyOf(row)
      const before = previous.get(key)
      previous.delete(key)
      return !before || Object.keys(row).some(col => row[col] !== before[col])
    })
    changes.push({ name, keys, next, removed: previous.values() })
  }
  // Clear missing children before their parents. Temporarily move positions out
  // of range when siblings are reordered so unique positions never collide.
  for (const { name, keys, next, removed } of [...changes].reverse()) {
    const where = keys.map(k => k + ' = ?').join(' AND ')
    const remove = db.prepare('DELETE FROM ' + prefix + name + ' WHERE ' + where)
    for (const row of removed) remove.run(...keys.map(k => row[k]))
    if (['rooms', 'bots', 'tasks', 'room_catalog'].includes(name) && next.length && 'position' in next[0]) {
      const offset = Math.max(old[name].length, rows[name].length, old[name].reduce((n, row) => Math.max(n, row.position), 0)) + 1
      const move = db.prepare('UPDATE ' + prefix + name + ' SET position = position + ? WHERE ' + where + ' AND position <> ?')
      for (const row of next) move.run(offset, ...keys.map(k => row[k]), row.position)
    }
  }
  for (const { name, keys, next } of changes) {
    if (!next.length) continue
    const cols = Object.keys(next[0])
    const assignments = cols.filter(c => !keys.includes(c)).map(c => c + '=excluded.' + c)
    const save = db.prepare('INSERT INTO ' + prefix + name + '(' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') +
      ') ON CONFLICT (' + keys.join(',') + ') ' + (assignments.length ? 'DO UPDATE SET ' + assignments.join(',') : 'DO NOTHING'))
    // node:sqlite binds JS numbers as REAL. Preserve integer status codes in
    // the ANY column, which deliberately also accepts text such as "503".
    for (const row of next) save.run(...cols.map(c => typeof row[c] === 'number' ? BigInt(row[c]) : row[c]))
  }
}

function open(path, readOnly) {
  const db = new DatabaseSync(path, { readOnly })
  db.exec('PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON')
  return db
}
function checkVersion(db) {
  if (db.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('Unsupported team database version; update DS Bot')
}
export function readTeamDatabase(path) {
  const db = open(path, true)
  try {
    db.exec('BEGIN')
    checkVersion(db)
    return decodeTeam(allRows(db))
  } finally { db.close() }
}

// Publish only complete databases. The candidate is private, on the same
// filesystem, and link() cannot replace another writer's completed import.
export function createTeamDatabase(path, team, guard = () => {}) {
  const candidate = path + '.import-' + randomUUID()
  closeSync(openSync(candidate, 'wx', 0o600))
  try {
    const db = open(candidate, false)
    try {
      db.exec('BEGIN IMMEDIATE')
      db.exec(schema)
      const old = allRows(db)
      syncRows(db, old, encodeTeam(team, []))
      if (db.prepare('PRAGMA foreign_key_check').get() || !isDeepStrictEqual(decodeTeam(allRows(db)), team)) {
        throw new Error('Team migration did not reproduce the complete source')
      }
      db.exec('PRAGMA user_version = 1; COMMIT')
    } finally { db.close() }
    guard()
    linkSync(candidate, path)
  } finally { rmSync(candidate, { force: true }) }
}

export function sqliteTeamStorage(path, legacyPath) {
  const databaseExists = () => Boolean(fileStamp(path))
  const stamp = () => {
    try {
      const db = fileStamp(path)
      return db ? 'db:' + db + ':' + fileStamp(path + '-wal') : fileStamp(legacyPath)
    } catch (error) {
      // Keep refresh available if the user fixes an unreadable directory.
      return 'unreadable:' + error.code
    }
  }
  return {
    path, stamp, databaseExists,
    read: () => readTeamDatabase(path),
    import: (team, guard) => createTeamDatabase(path, team, guard),
    backup: (destination, team) => createTeamDatabase(destination, team),
    write(team, guard) {
      if (!databaseExists()) return createTeamDatabase(path, team, guard)
      const db = open(path, false)
      try {
        db.exec('BEGIN IMMEDIATE')
        checkVersion(db)
        guard()
        const old = allRows(db)
        syncRows(db, old, encodeTeam(team, old.tasks))
        // Our own uncommitted pages can change the file stamp. BEGIN IMMEDIATE
        // already excludes SQL writers. Recheck only host ownership here.
        guard(false)
        db.exec('COMMIT')
      } finally { db.close() }
    },
  }
}

import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { decodeTeam, encodeTeam } from './records.js'
import { fileStamp, readTeamDatabase, syncRows, tables } from './sqlite.js'
import { memberSettings, setMemberSettings } from './member-settings.js'

import { decodePlans, encodePlans, planTables } from './project-plans.js'

const ddl = readFileSync(new URL('./split-schema.sql', import.meta.url), 'utf8')
  .split(/^-- @database \w+\r?$/m)
  .slice(1)
const roomUpgrades = ddl[2].split(/^-- @room-upgrade \d+$/m)
const catalog = { team_state: tables.team_state, room_catalog: ['room_id'] }
const bots = { bots: tables.bots }
const roomTables = {
  rooms: ['room_id'],
  room_members: tables.room_members,
  room_member_settings: ['room_id', 'bot_id'],
  room_todos: tables.room_todos,
  tasks: tables.tasks,
  task_intakes: tables.task_intakes,
  task_rounds: tables.task_rounds,
  task_notes: tables.task_notes,
  task_blocks: tables.task_blocks,
  ...planTables,
}
const ordering = {
  room_catalog: 'position',
  bots: 'position',
  tasks: 'source_kind, position',
  room_member_settings: 'dir_position, bot_id',
}
const empty = (layout) => Object.fromEntries(Object.keys(layout).map((k) => [k, []]))
const ownKey = (obj, key, value) =>
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true })
export const storageKey = (id) =>
  /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) && !id.includes('\n') ? 'id-' + id : 'h-' + createHash('sha256').update(id).digest('hex')
const roomFile = (dir, id) => join(dir, 'rooms', storageKey(id), 'room.sqlite')
const catalogFile = (dir) => join(dir, 'catalog.sqlite')
const check = (condition, message) => {
  if (!condition) throw new Error(message)
}

function openFile(path, readOnly = true) {
  check(existsSync(path), 'Missing team database: ' + path)
  const db = new DatabaseSync(path, { readOnly })
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000')
    return db
  } catch (e) {
    db.close()
    throw e
  }
}
function readRows(db, layout) {
  const version = db.prepare('PRAGMA user_version').get().user_version
  check(version === 1 || (layout === roomTables && (version >= 2 && version <= roomUpgrades.length)), 'Unsupported team database version')
  return Object.fromEntries(
    Object.entries(layout).map(([name, keys]) => [
      name,
      (version < 5 && name === 'project_branches') || (version === 1 && name in planTables) || (version === 2 && ['task_node_blocks', 'task_recovery_decisions'].includes(name)) ? [] : db.prepare('SELECT * FROM ' + name + ' ORDER BY ' + (ordering[name] ?? keys.join(','))).all(),
    ]),
  )
}
function fromFile(path, layout) {
  const db = openFile(path)
  try {
    db.exec('BEGIN')
    return readRows(db, layout)
  } finally {
    db.close()
  }
}
function readRoom(dir, id) {
  const rows = fromFile(roomFile(dir, id), roomTables)
  check(rows.rooms.length === 1 && rows.rooms[0].room_id === id, 'Room database identity mismatch')
  decodePlans(rows)
  const root = rows.rooms[0],
    shape = JSON.parse(root.shape_json),
    dirs = {},
    settings = {}
  for (const row of rows.room_member_settings) {
    if (row.work_dir_rule !== 'inherit') ownKey(dirs, row.bot_id, row.work_dir)
    if (row.model_override !== null || row.work_dir_rule === 'override') {
      ownKey(settings, row.bot_id, {
        ...(row.model_override !== null ? { model: row.model_override } : {}),
        ...(row.work_dir_rule === 'override' ? { override: true } : {}),
      })
    }
  }
  root.member_dirs_json = Object.keys(dirs).length || shape.memberDirs === 'object' ? JSON.stringify(dirs) : null
  const team = decodeTeam({ ...empty(tables), ...rows, team_state: encodeTeam({ version: 1 }, []).team_state })
  const room = team.rooms[id]
  setMemberSettings(room, settings)
  return { room, tasks: rows.tasks }
}

function roomEntries(roomsDir) {
  return readdirSync(roomsDir, { withFileTypes: true })
    .filter((entry) => !(entry.name === '.DS_Store' && entry.isFile()))
    .map((entry) => entry.name)
    .sort()
}

function readDirectory(dir) {
  const db = openFile(catalogFile(dir))
  try {
    db.exec('BEGIN')
    const roots = readRows(db, catalog)
    check(roots.team_state.length === 1, 'Missing team root')
    const team = decodeTeam({ ...empty(tables), team_state: roots.team_state, ...fromFile(join(dir, 'bots.sqlite'), bots) })
    const tasks = new Map()
    const expected = roots.room_catalog.map((r) => r.storage_key).sort()
    check(isDeepStrictEqual(roomEntries(join(dir, 'rooms')), expected), 'Room catalog and room directories disagree')
    for (const { room_id, storage_key } of roots.room_catalog) {
      check(storage_key === storageKey(room_id), 'Invalid room storage key')
      const r = readRoom(dir, room_id)
      ownKey((team.rooms ??= {}), room_id, r.room)
      tasks.set(room_id, r.tasks)
    }
    return { team, tasks }
  } finally {
    db.close()
  }
}
function readSet(dir) {
  // Topology changes publish a different directory generation. If a reader
  // overlaps the rename, discard the mixed read and reopen the published set.
  for (let attempt = 0; attempt < 3; attempt++) {
    const active = existsSync(dir) ? dir : dir + '.previous'
    const identity = statSync(active, { throwIfNoEntry: false })?.ino
    if (identity === undefined) continue
    try {
      const result = readDirectory(active)
      if (statSync(dir, { throwIfNoEntry: false })?.ino === identity || (!existsSync(dir) && existsSync(active))) return result
    } catch (error) {
      if (statSync(active, { throwIfNoEntry: false })?.ino === identity) throw error
    }
  }
  throw new Error('Team directory changed during read; retry')
}
export const readSplitTeam = (dir) => readSet(dir).team

function rootRows(team) {
  const { rooms, ...rest } = team
  const rows = encodeTeam(Object.hasOwn(team, 'rooms') ? { ...rest, rooms: rooms === null ? null : {} } : rest, [])
  return {
    team_state: rows.team_state,
    bots: rows.bots,
    room_catalog: Object.keys(rooms ?? {}).map((room_id, position) => ({ room_id, position, storage_key: storageKey(room_id) })),
  }
}
function roomRows(id, room, previous = []) {
  const rows = encodeTeam({ rooms: { [id]: room } }, previous)
  encodePlans(rows)
  const r = rows.rooms[0],
    shape = JSON.parse(r.shape_json)
  delete r.position
  delete r.member_dirs_json
  const dirs = Object.entries(room.memberDirs ?? {})
  if (room.memberDirs != null) {
    check(typeof room.memberDirs === 'object' && !Array.isArray(room.memberDirs), 'Invalid memberDirs')
    shape.memberDirs = 'object'
  }
  r.shape_json = JSON.stringify(shape)
  const settings = memberSettings(room)
  const map = new Map(
    dirs.map(([bot_id, work_dir], dir_position) => {
      check(work_dir === null || typeof work_dir === 'string', 'Invalid member working directory')
      return [bot_id, { room_id: id, bot_id, work_dir_rule: 'legacy', work_dir, dir_position, model_override: null }]
    }),
  )
  for (const [bot_id, values] of Object.entries(settings)) {
    const row = map.get(bot_id) ?? {
      room_id: id,
      bot_id,
      work_dir_rule: 'inherit',
      work_dir: null,
      dir_position: null,
      model_override: null,
    }
    if (values.override) row.work_dir_rule = 'override'
    row.model_override = values.model ?? null
    map.set(bot_id, row)
  }
  rows.room_member_settings = [...map.values()]
  return rows
}
const sameKeys = (a, b) => isDeepStrictEqual(Object.keys(a ?? {}), Object.keys(b ?? {}))
const sameRoom = (a, b) =>
  isDeepStrictEqual(a, b) &&
  isDeepStrictEqual(memberSettings(a), memberSettings(b)) &&
  ['memberDirs', 'tasks', 'projectCards'].every((k) => sameKeys(a?.[k], b?.[k]))
const equalTeam = (a, b) =>
  isDeepStrictEqual(a, b) &&
  sameKeys(a.bots, b.bots) &&
  sameKeys(a.rooms, b.rooms) &&
  Object.keys(a.rooms ?? {}).every((id) => sameRoom(a.rooms[id], b.rooms[id]))
function fsync(path) {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
function createFile(path, sql, layout, rows) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  closeSync(openSync(path, 'wx', 0o600))
  const db = openFile(path, false)
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
    db.exec(sql)
    syncRows(db, empty(layout), rows, layout)
    check(
      db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok' && !db.prepare('PRAGMA foreign_key_check').get(),
      'Database integrity check failed',
    )
    db.exec('PRAGMA user_version=' + (layout === roomTables ? roomUpgrades.length : 1) + '; COMMIT')
  } finally {
    db.close()
  }
  fsync(dirname(path))
}
const roomDDL = ddl[2].replaceAll('room.', 'main.')
function build(dir, team, taskIds) {
  mkdirSync(dir, { mode: 0o700 })
  mkdirSync(join(dir, 'rooms'), { mode: 0o700 })
  const rows = rootRows(team)
  createFile(catalogFile(dir), ddl[0], catalog, rows)
  createFile(join(dir, 'bots.sqlite'), ddl[1].replaceAll('bot_base.', 'main.'), bots, rows)
  for (const [id, r] of Object.entries(team.rooms ?? {}))
    createFile(roomFile(dir, id), roomDDL, roomTables, roomRows(id, r, taskIds.get(id)))
  const restored = readSplitTeam(dir)
  check(equalTeam(team, restored), 'Split team did not reproduce its complete source')
  fsync(join(dir, 'rooms'))
  fsync(dir)
}

function mark(dir) {
  const cat = catalogFile(dir)
  if (!existsSync(dir)) return ''
  const rooms = join(dir, 'rooms')
  const files = [
    cat,
    join(dir, 'bots.sqlite'),
    ...(existsSync(rooms) ? roomEntries(rooms).map((key) => join(rooms, key, 'room.sqlite')) : []),
  ]
  return 'split:' + files.map((p) => fileStamp(p) + ':' + fileStamp(p + '-wal')).join('|')
}

// The directory rename publishes an entire candidate for imports and topology
// changes of any size. A retained previous directory makes a torn swap recoverable.
function publish(dir, team, taskIds, guard) {
  const next = dir + '.candidate',
    prev = dir + '.previous'
  rmSync(next, { recursive: true, force: true })
  try {
    build(next, team, taskIds)
    guard()
    if (existsSync(dir)) {
      rmSync(prev, { recursive: true, force: true })
      renameSync(dir, prev)
      fsync(dirname(dir))
    }
    try {
      renameSync(next, dir)
      fsync(dirname(dir))
    } catch (e) {
      if (!existsSync(dir) && existsSync(prev)) renameSync(prev, dir)
      throw e
    }
    rmSync(prev, { recursive: true, force: true })
  } finally {
    rmSync(next, { recursive: true, force: true })
  }
}

function edit(dir, team, previous, guard) {
  const ids = Object.keys(team.rooms ?? {})
  const changed = ids.filter((id) => !sameRoom(team.rooms[id], previous.team.rooms?.[id]))
  if (!isDeepStrictEqual(ids, Object.keys(previous.team.rooms ?? {})) || changed.length > 8)
    return publish(dir, team, previous.tasks, guard)
  const db = openFile(catalogFile(dir), false)
  try {
    const attach = (path, alias) => {
      db.prepare('ATTACH DATABASE ? AS ' + alias).run(path)
      check(db.prepare('PRAGMA ' + alias + '.journal_mode').get().journal_mode === 'delete', 'Expected rollback journaling')
      db.exec('PRAGMA ' + alias + '.synchronous=FULL')
    }
    check(db.prepare('PRAGMA journal_mode').get().journal_mode === 'delete', 'Expected catalog rollback journaling')
    db.exec('PRAGMA synchronous=FULL')
    attach(join(dir, 'bots.sqlite'), 'b')
    changed.forEach((id, i) => attach(roomFile(dir, id), 'r' + i))
    db.exec('BEGIN IMMEDIATE')
    guard()
    const rows = rootRows(team)
    function update(alias, layout, rows) {
      if (layout === roomTables) {
        const version = db.prepare('PRAGMA ' + alias + '.user_version').get().user_version
        for (let next = version + 1; next <= roomUpgrades.length; next++) {
          db.exec(roomUpgrades[next - 1].replaceAll('room.', alias + '.'))
          db.exec('PRAGMA ' + alias + '.user_version=' + next)
        }
      }
      const before = Object.fromEntries(Object.keys(layout).map((k) => [k, db.prepare('SELECT * FROM ' + alias + '.' + k).all()]))
      // dir_position is a unique ordered optional key. Release old positions
      // inside this transaction before assigning new ones.
      if (
        layout === roomTables &&
        !isDeepStrictEqual(
          before.room_member_settings.map((r) => [r.bot_id, r.dir_position]),
          rows.room_member_settings.map((r) => [r.bot_id, r.dir_position]),
        )
      ) {
        db.exec('DELETE FROM ' + alias + '.room_member_settings')
        before.room_member_settings = []
      }
      syncRows(db, before, rows, layout, alias + '.')
    }
    update('main', catalog, rows)
    update('b', bots, rows)
    changed.forEach((id, i) => update('r' + i, roomTables, roomRows(id, team.rooms[id], previous.tasks.get(id))))
    guard(false)
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

export function splitTeamStorage(home) {
  const dir = join(home, 'state'),
    prev = dir + '.previous',
    legacy = join(home, 'team.sqlite')
  const active = () => (existsSync(dir) ? dir : prev)
  function taskIds() {
    if (!existsSync(legacy)) return new Map()
    const byRoom = new Map(),
      db = openFile(legacy)
    try {
      for (const t of db.prepare('SELECT room_id,task_id,task_pk,source_kind FROM tasks').all()) {
        if (!byRoom.has(t.room_id)) byRoom.set(t.room_id, [])
        byRoom.get(t.room_id).push(t)
      }
    } finally {
      db.close()
    }
    return byRoom
  }
  return {
    path: catalogFile(dir),
    databaseExists: () => existsSync(active()),
    stamp() {
      try {
        return mark(active()) || [fileStamp(legacy), fileStamp(legacy + '-wal'), fileStamp(join(home, 'state.json'))].join(':')
      } catch (e) {
        return 'unreadable:' + e.code
      }
    },
    read: () => readSplitTeam(dir),
    readLegacy() {
      if (!existsSync(legacy)) return undefined
      const team = readTeamDatabase(legacy)
      const json = join(home, 'state.json')
      if (existsSync(json)) {
        const snapshot = JSON.parse(readFileSync(json, 'utf8'))
        const newer =
          statSync(json).mtimeMs >
          Math.max(statSync(legacy).mtimeMs, statSync(legacy + '-wal', { throwIfNoEntry: false })?.mtimeMs ?? 0)
        if (
          (snapshot.revision ?? 0) > (team.revision ?? 0) ||
          (newer && (snapshot.revision ?? 0) >= (team.revision ?? 0) && !isDeepStrictEqual(snapshot, team))
        ) {
          throw new Error('Conflicting team.sqlite and state.json histories; select the authoritative source before migration')
        }
      }
      return team
    },
    import: (team, guard) => publish(dir, team, taskIds(), guard),
    backup: (destination, team) => build(destination, team, new Map()),
    recover() {
      if (!existsSync(dir) && existsSync(prev)) renameSync(prev, dir)
      if (existsSync(dir) && existsSync(prev)) {
        readSet(dir)
        rmSync(prev, { recursive: true, force: true })
      }
    },
    write(team, guard) {
      if (!existsSync(dir)) return publish(dir, team, new Map(), guard)
      return edit(dir, team, readSet(dir), guard)
    },
  }
}

// Downgrading requires a state the legacy reader will interpret the same way.
export function exportLegacyTeam(dir) {
  const team = readSplitTeam(dir)
  const conflicts = []
  for (const [id, room] of Object.entries(team.rooms ?? {})) {
    if (room.projectInbox?.length || Object.values(room.projectCards ?? {}).some(card => card.plans?.length))
      throw new Error('Legacy storage cannot represent project intake and plan records in room ' + id)
    for (const [botId, setting] of Object.entries(memberSettings(room))) {
      if (setting.model || (setting.override && room.workDir != null && room.workDir !== room.memberDirs?.[botId])) {
        conflicts.push(JSON.stringify([id, botId]))
      }
    }
  }
  if (conflicts.length) throw new Error('Legacy storage cannot represent these group member settings: ' + conflicts.join(', '))
  return JSON.parse(JSON.stringify(team))
}

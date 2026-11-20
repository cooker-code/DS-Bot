import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createTeamDatabase, readTeamDatabase, sqliteTeamStorage } from '../src/host/team-storage/sqlite.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'team-db-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, path: join(dir, 'team.sqlite'), legacy: join(dir, 'state.json') }
}

test('the installed schema and the proposed split schema both cover the legacy records', t => {
  const { dir, path } = fixture(t)
  createTeamDatabase(path, { version: 1 })
  const sql = readFileSync(new URL('../../docs/design/project-task-model.sql', import.meta.url), 'utf8')
  const db = new DatabaseSync(join(dir, 'catalog.sqlite'))
  try {
    const attach = (file, alias) => db.prepare('ATTACH ? AS ' + alias).run(join(dir, file))
    attach('team.sqlite', 'installed')
    attach('bots.sqlite', 'bot_base')
    attach('a.sqlite', 'room')
    db.exec(sql)
    const tables = schema => db.prepare(`SELECT name FROM ${schema}.sqlite_schema WHERE type='table' ORDER BY name`).all().map(r => r.name)
    assert.deepEqual(tables('main'), ['room_catalog', 'team_state'])
    assert.deepEqual(tables('bot_base'), ['bots'])
    const groupTables = ['room_member_settings', 'room_members', 'room_todos', 'rooms', 'task_blocks', 'task_intakes', 'task_notes', 'task_rounds', 'tasks']
    assert.deepEqual(tables('room'), [...groupTables, 'project_branches', 'project_inbox', 'task_plans', 'task_plan_nodes', 'task_plan_dependencies', 'task_round_plans', 'task_round_inputs', 'task_node_blocks', 'task_recovery_decisions'].sort())
    assert.deepEqual(tables('installed'), ['bots', ...groupTables.filter(name => name !== 'room_member_settings'), 'team_state'])

    const knownKeys = schema => db.prepare(`SELECT entity, json_key FROM ${schema}.known_json_keys`).all().map(r => r.entity + '.' + r.json_key)
    assert.deepEqual(['main', 'bot_base', 'room'].flatMap(knownKeys).sort(), knownKeys('installed').sort())

    db.exec("INSERT INTO main.team_state(singleton, version) VALUES (1,1)")
    db.exec("INSERT INTO bot_base.bots(bot_id,position,model,work_dir) VALUES ('b',0,'M1','/base')")
    const seedRoom = (id, position) => {
      db.prepare('INSERT INTO main.room_catalog(room_id, position, storage_key) VALUES (?,?,?)').run(id, position, 'id-' + id)
      db.prepare("INSERT INTO room.rooms(room_id,name) VALUES (?,'Same')").run(id)
      db.prepare("INSERT INTO room.room_members(room_id,position,bot_id) VALUES (?,0,'b')").run(id)
    }
    seedRoom('a', 0)
    db.exec("INSERT INTO room.room_member_settings(room_id,bot_id,work_dir_rule,work_dir,dir_position,model_override) VALUES ('a','b','override','/a',0,'M2')")
    db.exec("UPDATE room.rooms SET name='Renamed' WHERE room_id='a'")
    assert.throws(() => db.exec("INSERT INTO room.rooms(room_id) VALUES ('b')"), /UNIQUE/)
    assert.throws(() => db.exec("UPDATE room.rooms SET extra_json='{\"memberDirs\":null}'"), /mapped rooms key/)
    assert.deepEqual({ ...db.prepare('SELECT work_dir,model_override FROM room.room_member_settings').get() }, { work_dir: '/a', model_override: 'M2' })

    db.exec('DETACH room')
    attach('b.sqlite', 'room')
    db.exec(sql.split(/-- @database room\r?\n/)[1])
    seedRoom('b', 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM room.room_member_settings').get().n, 0)
    assert.deepEqual({ ...db.prepare('SELECT work_dir,model FROM bot_base.bots').get() }, { work_dir: '/base', model: 'M1' })
    assert.deepEqual(db.prepare('SELECT storage_key FROM main.room_catalog ORDER BY position').all().map(r => r.storage_key), ['id-a', 'id-b'])
    db.exec('DETACH room')
    attach('a.sqlite', 'room')
    assert.deepEqual({ ...db.prepare('SELECT room_id,name FROM room.rooms').get() }, { room_id: 'a', name: 'Renamed' })
    assert.deepEqual(db.prepare('PRAGMA room.foreign_key_check').all(), [])
  } finally { db.close() }
})

test('all ten tables preserve historical types, map keys, order, empty containers and unknown fields', t => {
  const { dir, path, legacy } = fixture(t)
  const member = { id: 'inner-id', goal: 'Review', status: 'blocked', notes: [{ by: 'user', text: 'a', ext: null }],
    blocked: { from: 'active', status: 503 } }
  const project = { rounds: [{ ownerId: 'former', sentAt: 1 }, { ownerId: 'current', startedAt: 2, ext: { a: 1 } }],
    intakes: ['i', 'i'], extension: [false, null] }
  const team = { version: 1, workspaceId: null, bots: {}, rooms: {
    r: { admin: null, pinned: false, members: ['current', 'former'], todos: [{ id: 'a', done: false, future: 0 }],
      tasks: { same: member, other: { blocked: {}, notes: [] } }, projectCards: { same: project } },
    s: { hidden: true, members: [], todos: null, tasks: { same: { notes: null } } },
  }, ...JSON.parse('{"__proto__":{"opaque":true}}') }
  createTeamDatabase(path, team)
  assert.deepEqual(readTeamDatabase(path), team)
  assert.deepEqual(readdirSync(dir), ['team.sqlite'])
  const db = new DatabaseSync(path)
  try {
    const id = () => db.prepare("SELECT task_pk FROM tasks WHERE room_id='r' AND source_kind='member' AND task_id='same'").get().task_pk
    const pk = id()
    assert.equal(db.prepare("SELECT status FROM tasks WHERE source_kind='project'").get().status, 'active')
    assert.deepEqual({ ...db.prepare('SELECT pinned,admin_bot_id,extra_json FROM rooms WHERE room_id=?').get('r') },
      { pinned: 0, admin_bot_id: null, extra_json: '{}' })
    db.exec("UPDATE rooms SET notice='SQL update' WHERE room_id='r'")
    team.rooms.r.notice = 'SQL update'
    assert.deepEqual(readTeamDatabase(path), team)
    team.rooms.r.tasks = { other: { notes: [] }, same: { ...member, blocked: { status: '503' } } }
    team.rooms.r.members.reverse()
    team.rooms = { s: team.rooms.s, r: team.rooms.r }
    sqliteTeamStorage(path, legacy).write(team, () => {})
    assert.equal(id(), pk)
    assert.deepEqual(Object.keys(readTeamDatabase(path).rooms), ['s', 'r'])
    assert.deepEqual(readTeamDatabase(path), team)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(existsSync(legacy), false)
  } finally { db.close() }
})

test('an incompatible field or lost ownership never publishes a partial import', t => {
  const { path, dir } = fixture(t)
  assert.throws(() => createTeamDatabase(path, { version: 1, rooms: { r: { notice: [] } } }), /rooms.notice/)
  assert.throws(() => createTeamDatabase(path, { version: 1 }, () => { throw new Error('lock lost') }), /lock lost/)
  assert.deepEqual(readdirSync(dir), [])
  createTeamDatabase(path, { version: 1, rooms: {} })
  assert.throws(() => createTeamDatabase(path, { version: 1, revision: 99 }), { code: 'EEXIST' })
  assert.deepEqual(readTeamDatabase(path), { version: 1, rooms: {} })
})

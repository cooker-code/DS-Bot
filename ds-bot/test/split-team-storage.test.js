import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createTeamDatabase } from '../src/host/team-storage/sqlite.js'
import { exportLegacyTeam, splitTeamStorage, storageKey } from '../src/host/team-storage/split.js'
import { memberSettings, setMemberSettings } from '../src/host/team-storage/member-settings.js'

const guard = () => {}
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(),'team-split-'))
  t.after(() => rmSync(home,{recursive:true,force:true}))
  return { home, storage: splitTeamStorage(home), dir: join(home,'state') }
}
test('the published split schema ships with the plugin', () => {
  assert.deepEqual(readFileSync(new URL('../src/host/team-storage/split-schema.sql',import.meta.url)),
    readFileSync(new URL('../../docs/design/project-task-model.sql',import.meta.url)))
})

test('an old submitted code round loads and the next write requires main-branch evidence for review', t => {
  const { dir, storage } = fixture(t)
  const round = { ownerId: 'dev', startedAt: 1, submittedAt: 2, result: 'Delivered',
    workspace: { repository: '/repo', workRef: 'topic', workDir: '/tree', workspaceMode: 'worktree' } }
  const team = { version: 1, rooms: { r: { id: 'r', projectCards: { c: { id: 'c', title: 'Source', rounds: [round] } } } } }
  storage.import(team, guard)
  const db = new DatabaseSync(join(dir, 'rooms', 'id-r', 'room.sqlite'))
  try {
    const phase = () => db.prepare("SELECT status FROM tasks WHERE task_id='c'").get().status
    assert.equal(phase(), 'active')
    db.exec("UPDATE tasks SET status='review', shape_json=json_set(shape_json, '$.status', 'phase') WHERE task_id='c'")
    assert.deepEqual(storage.read(), team)
    team.rooms.r.name = 'Updated room'
    storage.write(team, guard)
    assert.equal(phase(), 'active')
    round.mainReview = { repository: '/repo', branch: 'master', commit: 'a'.repeat(40), tip: 'b'.repeat(40) }
    storage.write(team, guard)
    assert.equal(phase(), 'review')
    assert.deepEqual(storage.read(), team)
  } finally { db.close() }
})
test('Finder metadata does not change the team stamp or block opening and saving rooms', t => {
  const { dir, storage } = fixture(t)
  const team = { version: 1, rooms: { r: { id: 'r', name: 'Original' } } }
  storage.import(team, guard)
  const stamp = storage.stamp()
  const rooms = join(dir, 'rooms')
  const metadata = join(rooms, '.DS_Store')
  writeFileSync(metadata, 'Finder metadata')

  assert.deepEqual(storage.read(), team)
  assert.equal(storage.stamp(), stamp)
  team.rooms.r.name = 'Renamed'
  storage.write(team, guard)
  assert.deepEqual(storage.read(), team)
  assert.equal(readFileSync(metadata, 'utf8'), 'Finder metadata')

  // Even a hidden directory must match the catalog.
  rmSync(metadata)
  mkdirSync(metadata)
  assert.throws(() => storage.read(), /Room catalog and room directories disagree/)
  rmSync(metadata, { recursive: true })
  renameSync(join(rooms, 'id-r'), join(dir, 'moved-room'))
  assert.throws(() => storage.read(), /Room catalog and room directories disagree/)
})
test('bulk import, stable task keys and settings survive publication and recovery',t=>{
  const {home,dir,storage}=fixture(t)
  const team={version:1,revision:3,bots:{b:{id:'b'}},rooms:{}}
  const ids=['odd/ID','r-42',...Array.from({length:12},(_,i)=>'r'+i)]
  for(const id of ids)team.rooms[id]={id,name:'same',members:['b','b'],memberDirs:{gone:null,b:'/old'},workDir:'/shared',future:null,
    memberSettings:{opaque:true},tasks:{t:{id:'inner',blocked:{status:'504'}}},projectCards:{t:{rounds:[{ownerId:'gone',newKey:0}]}}}
  const legacy=join(home,'team.sqlite')
  createTeamDatabase(legacy,team)
  writeFileSync(join(home,'state.json'),JSON.stringify({version:1,revision:1}))
  const old=new DatabaseSync(legacy)
  const pk=old.prepare("SELECT task_pk FROM tasks WHERE room_id='r-42' AND source_kind='member'").get().task_pk
  old.close()
  assert.deepEqual(storage.readLegacy(),team)
  assert.throws(()=>storage.import(team,()=>{throw new Error('interrupted')}),/interrupted/)
  assert.equal(existsSync(dir),false)
  storage.import(team,guard)
  assert.deepEqual(storage.read(),team)
  assert.deepEqual(exportLegacyTeam(dir),team)
  const physical=join(dir,'rooms','id-r-42','room.sqlite')
  const db=new DatabaseSync(physical,{readOnly:true})
  try {assert.equal(db.prepare("SELECT task_pk FROM tasks WHERE source_kind='member'").get().task_pk,pk)} finally {db.close()}
  for(const id of ids)team.rooms[id].name='renamed'
  setMemberSettings(team.rooms['r-42'],{b:{override:true,model:'new/model'}})
  assert.throws(()=>storage.write(team,()=>{throw new Error('lost lock')}),/lost lock/)
  assert.equal(storage.read().rooms['r-42'].name,'same')
  storage.write(team,guard)
  assert.deepEqual(memberSettings(storage.read().rooms['r-42']),{b:{override:true,model:'new/model'}})
  assert.throws(()=>exportLegacyTeam(dir),/r-42/)
  renameSync(dir,dir+'.previous')
  assert.equal(storage.read().rooms['r-42'].name,'renamed')
  storage.recover()
  assert.equal(existsSync(physical),true)
  renameSync(physical,physical+'.moved')
  assert.throws(()=>storage.read(),/Missing team database/)
  assert.equal(storageKey('r-42'),'id-r-42')
  assert.match(storageKey('odd/ID'),/^h-[0-9a-f]{64}$/)
})

test('a v1 room upgrades transactionally and keeps plan inputs and old keys across a directory rebuild', t => {
  const { dir, storage } = fixture(t)
  const room = { id: 'r', projectCards: { old: { id:'old', rounds:[{ownerId:'worker', plan:'Original'}] } } }
  const team = {version:1,rooms:{r:room}}
  storage.import(team,guard)
  const path = join(dir,'rooms','id-r','room.sqlite')
  const ddl = readFileSync(new URL('../src/host/team-storage/split-schema.sql',import.meta.url),'utf8')
  const v1 = ddl.split('-- @database room\n')[1].split('-- @room-upgrade 2')[0]
  rmSync(path)
  const old = new DatabaseSync(path)
  try {
    old.exec(v1.replaceAll('room.','main.') + '; PRAGMA user_version=1')
    old.prepare("INSERT INTO rooms(room_id,source_id,shape_json) VALUES ('r','r',?)").run('{"projectCards":"object"}')
    old.prepare("INSERT INTO tasks(task_pk,room_id,source_kind,task_id,position,source_id,status,shape_json) VALUES (45,'r','project','old',0,'old','assigned',?)").run('{"rounds":"array","status":"derived"}')
    old.exec("INSERT INTO task_rounds(task_pk,round_no,owner_bot_id,plan) VALUES (45,1,'worker','Original')")
  } finally {old.close()}
  assert.deepEqual(storage.read(),team)
  room.projectInbox=[{id:'in', title:'Request',receivedAt:1,seq:1,status:'accepted'}]
  const node = {no:1,title:'Build',ownerId:'b',acceptance:'Checked',instructions:'Build',deliverable:'Artifact',dependsOn:[]}
  room.projectCards.new = { id:'new',intakes:['in'], plans:[{version:1,by:'admin',at:2,nodes:[node,{...node,no:2,dependsOn:[1]}]}],rounds:[
    {ownerId:'b',result:'Done',planNode:{version:1,node:1,inputs:[],acceptedAt:3,acceptedBy:'admin',artifact:'v1'}},
    {ownerId:'b',planNode:{version:1,node:2,inputs:[{node:1,round:1}]}},
  ]}
  assert.throws(()=>storage.write(team, checkStamp=>{if(checkStamp===false)throw Error('interrupted')}), /interrupted/)
  let db=new DatabaseSync(path,{readOnly:true})
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,1)
    assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='task_plans'").get(),undefined)
  } finally {db.close()}
  storage.write(team,guard)
  assert.deepEqual(storage.read(),team)
  team.rooms.other={id:'other'}
  storage.write(team,guard)
  delete team.rooms.other
  storage.write(team,guard)
  assert.deepEqual(storage.read(),team)
  db=new DatabaseSync(path,{readOnly:true})
  try {
    assert.equal(db.prepare("SELECT task_pk FROM tasks WHERE task_id='old'").get().task_pk,45)
    assert.equal(db.prepare("SELECT source_round FROM task_round_inputs").get().source_round,1)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[])
  } finally {db.close()}
})

test('a populated v2 room upgrades atomically with its original input, retired round and recovery decision intact', t => {
  const { dir, storage } = fixture(t)
  const node = no => ({ no, title: 'Check ' + no, ownerId: 'tester', instructions: 'Check', acceptance: 'Pass', deliverable: 'Report', dependsOn: no === 1 ? [] : [1] })
  const card = {
    id: 'card', plans: [{ version: 1, by: 'admin', at: 1, nodes: [node(1), node(2)] }],
    rounds: [
      { ownerId: 'dev', result: 'Built', planNode: { version: 1, node: 1, inputs: [], acceptedAt: 2, acceptedBy: 'admin', artifact: 'candidate' } },
      { ownerId: 'tester', startedAt: 3, planNode: { version: 1, node: 2, inputs: [{ node: 1, round: 1 }] } },
    ],
  }
  const team = { version: 1, rooms: { r: { id: 'r', projectCards: { card } } } }
  storage.import(team, guard)
  const path = join(dir, 'rooms', 'id-r', 'room.sqlite')
  const source = path + '.fixture'
  renameSync(path, source)
  const ddl = readFileSync(new URL('../src/host/team-storage/split-schema.sql', import.meta.url), 'utf8')
  const v2 = ddl.split('-- @database room\n')[1].split('-- @room-upgrade 3')[0]
  const old = new DatabaseSync(path)
  let pk
  try {
    old.exec(v2.replaceAll('room.', 'main.'))
    old.prepare('ATTACH DATABASE ? AS fixture').run(source)
    for (const { name } of old.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      const cols = old.prepare('SELECT name FROM pragma_table_info(?)').all(name).map(col => col.name).join(',')
      old.exec('INSERT INTO main.' + name + '(' + cols + ') SELECT ' + cols + ' FROM fixture.' + name)
    }
    old.exec('PRAGMA user_version=2')
    pk = old.prepare("SELECT task_pk FROM tasks WHERE task_id='card'").get().task_pk
  } finally { old.close() }
  rmSync(source)
  assert.deepEqual(storage.read(), team)
  const binding = card.rounds[1].planNode
  Object.assign(binding, { supersededBy: 3, completed: 'Empty passed', remaining: 'Existing source', lateAt: 8, lateResult: 'Old reply',
    block: { at: 4, cause: 'interrupted', by: 'system', reason: 'Stopped', resolvedAt: 5, decisions: [
      { at: 5, by: 'admin', action: 'takeover', reason: 'Use backup', nextRound: 3, ownerId: 'backup', artifact: 'candidate', targetTree: {dir: '/backup'} },
    ] } })
  card.rounds.push({ ownerId: 'backup', planNode: { version: 1, node: 2, previousRound: 2, inputs: binding.inputs } })
  assert.throws(() => storage.write(team, check => { if (check === false) throw Error('interrupted') }), /interrupted/)
  const interrupted = new DatabaseSync(path, { readOnly: true })
  try {
    assert.equal(interrupted.prepare('PRAGMA user_version').get().user_version, 2)
    assert.equal(interrupted.prepare('SELECT count(*) AS n FROM task_round_plans').get().n, 2)
  } finally { interrupted.close() }
  storage.write(team, guard)
  assert.deepEqual(storage.read(), team)
  team.rooms.extra = { id: 'extra' }
  storage.write(team, guard)
  assert.deepEqual(storage.read(), team)
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(db.prepare('SELECT task_pk FROM tasks').get().task_pk, pk)
    assert.equal(db.prepare('SELECT round_no FROM task_round_plans WHERE node_no=2 AND superseded_by IS NULL').get().round_no, 3)
    assert.deepEqual(db.prepare('SELECT source_round FROM task_round_inputs ORDER BY round_no').all().map(r => r.source_round), [1, 1])
  } finally { db.close() }
})

test('a v4 room keeps its card and branch inventory through rollback, upgrade and rebuild', t => {
  const { dir, storage } = fixture(t)
  const card = { id: 'c', plans: [{ version: 1, by: 'chief', at: 1, nodes: [
    { no: 1, title: 'Old task', ownerId: 'writer', instructions: 'Read', deliverable: 'Report', acceptance: 'Checked', dependsOn: [] },
  ] }], rounds: [] }
  const room = { id: 'r', projectCards: { c: card } }
  const team = { version: 1, rooms: { r: room } }
  storage.import(team, guard)
  const path = join(dir, 'rooms', 'id-r', 'room.sqlite')
  const fixturePath = path + '.current'
  renameSync(path, fixturePath)
  const old = new DatabaseSync(path)
  try {
    const ddl = readFileSync(new URL('../src/host/team-storage/split-schema.sql', import.meta.url), 'utf8')
    old.exec(ddl.split('-- @database room\n')[1].split('-- @room-upgrade 5')[0].replaceAll('room.', 'main.'))
    old.prepare('ATTACH DATABASE ? AS fixture').run(fixturePath)
    for (const { name } of old.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      const cols = old.prepare('SELECT name FROM pragma_table_info(?)').all(name).map(col => col.name).join(',')
      old.exec('INSERT INTO main.' + name + '(' + cols + ') SELECT ' + cols + ' FROM fixture.' + name)
    }
    old.exec('PRAGMA user_version=4')
  } finally { old.close() }
  rmSync(fixturePath)
  assert.deepEqual(storage.read(), team)
  room.projectBranches = [{ repository: '/project', branch: 'main', target: 'main', commit: 'tip', targetCommit: 'tip',
    relation: 'target', workDir: '/project', purpose: 'Build report', observedAt: 9, refAt: 5, commitAt: 4 }]
  const node = { ...card.plans[0].nodes[0], workspaceMode: 'current', repository: '/project', workRef: 'main', workDir: '/project', writePaths: ['a.txt'] }
  card.plans.push({ version: 2, at: 10, by: 'chief', reason: 'Implement the reviewed change', nodes: [node] })
  assert.throws(() => storage.write(team, check => { if (check === false) throw Error('lost lock') }), /lost lock/)
  assert.equal(storage.read().rooms.r.projectCards.c.plans.length, 1)
  storage.write(team, guard)
  assert.deepEqual(storage.read(), team)
  team.rooms.other = { id: 'other' }
  storage.write(team, guard)
  assert.deepEqual(storage.read(), team)
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    assert.ok(db.prepare('PRAGMA user_version').get().user_version >= 5)
    assert.equal(db.prepare('SELECT ref_at FROM project_branches').get().ref_at, 5)
    assert.equal(db.prepare('SELECT write_paths FROM task_plan_nodes WHERE plan_version=2').get().write_paths, '["a.txt"]')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { db.close() }
})

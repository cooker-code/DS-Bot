// Keep the host's object model at the boundary. Only the SQLite adapter deals
// with row identities, null vs absent keys and ordered child collections.
import { projectStatus, taskPhase } from '../project-status.js'
import { nodeViews, plannedSummary, planStage } from '../project-plan.js'
import { fields } from './fields.js'

const cardStatus = card => card.plans?.length ? plannedSummary(card).status : taskPhase(card, projectStatus(card.rounds?.at(-1)))

const children = {
  team_state: { bots: 'object', rooms: 'object' },
  rooms: { members: 'array', todos: 'array', tasks: 'object', projectCards: 'object' },
  tasks: { rounds: 'array', intakes: 'array', notes: 'array', blocked: 'object' },
}
const kind = value => Array.isArray(value) ? 'array' : typeof value

function encode(value, type, field) {
  if (value == null) return null
  if (type === 'json') return JSON.stringify(value)
  if (type === 'boolean' && typeof value === 'boolean') return Number(value)
  if ((type === 'integer' || type === 'code') && Number.isSafeInteger(value)) return value
  if ((type === 'text' || type === 'code') && typeof value === 'string' && value.isWellFormed()) return value
  throw new Error('Incompatible team state field ' + field + ' (expected ' + type + ')')
}

function record(table, keys, obj) {
  if (!obj || kind(obj) !== 'object') throw new Error('Expected a record in ' + table)
  const extra = { ...obj }
  const shape = Object.create(null)
  const row = { ...keys }
  for (const id of Object.values(keys)) {
    if (typeof id === 'string' && !id.isWellFormed()) throw new Error('Invalid Unicode in ' + table + ' identifier')
  }
  for (const [key, column, type] of fields[table]) {
    const value = Object.hasOwn(obj, key) ? obj[key] : undefined
    row[column] = encode(value, type, table + '.' + key)
    if (value === null) shape[key] = 'null'
    delete extra[key]
  }
  for (const [key, type] of Object.entries(children[table] ?? {})) {
    if (!Object.hasOwn(obj, key)) continue
    const value = obj[key]
    if (value !== null && kind(value) !== type) throw new Error('Expected ' + type + ' in ' + table + '.' + key)
    shape[key] = value === null ? 'null' : type
    delete extra[key]
  }
  if (table === 'tasks' && keys.source_kind === 'project' && !Object.hasOwn(obj, 'status')) {
    row.status = cardStatus(obj)
    shape.status = 'reviewPhase'
  }
  return { ...row, shape_json: JSON.stringify(shape), extra_json: JSON.stringify(extra) }
}

const entries = obj => Object.entries(obj ?? {})
const taskKey = (room, source, id) => JSON.stringify([room, source, id])

export function encodeTeam(team, previousTasks) {
  const rows = { team_state: [record('team_state', { singleton: 1 }, team)], bots: [], rooms: [],
    room_members: [], room_todos: [], tasks: [], task_intakes: [], task_rounds: [], task_notes: [], task_blocks: [] }
  const ids = new Map(previousTasks.map(t => [taskKey(t.room_id, t.source_kind, t.task_id), t.task_pk]))
  let next = previousTasks.reduce((max, t) => Math.max(max, t.task_pk), 0)
  for (const [bot_id, bot] of entries(team.bots)) rows.bots.push(record('bots', { bot_id, position: rows.bots.length }, bot))
  for (const [room_id, room] of entries(team.rooms)) {
    rows.rooms.push(record('rooms', { room_id, position: rows.rooms.length }, room))
    for (const [position, bot_id] of (room.members ?? []).entries()) rows.room_members.push({ room_id, position, bot_id: encode(bot_id, 'text', 'members') })
    for (const [position, todo] of (room.todos ?? []).entries()) rows.room_todos.push(record('room_todos', { room_id, position }, todo))
    for (const [source_kind, collection] of [['member', room.tasks], ['project', room.projectCards]]) {
      let pos = 0
      for (const [task_id, task] of entries(collection)) {
        const task_pk = ids.get(taskKey(room_id, source_kind, task_id)) ?? ++next
        rows.tasks.push(record('tasks', { task_pk, room_id, source_kind, task_id, position: pos++ }, task))
        for (const [position, intake] of (task.intakes ?? []).entries()) rows.task_intakes.push({ task_pk, position, intake_id: encode(intake, 'text', 'intakes') })
        for (const [position, round] of (task.rounds ?? []).entries()) rows.task_rounds.push(record('task_rounds', { task_pk, round_no: position + 1 }, round))
        for (const [position, note] of (task.notes ?? []).entries()) rows.task_notes.push(record('task_notes', { task_pk, position }, note))
        if (task.blocked != null) rows.task_blocks.push(record('task_blocks', { task_pk }, task.blocked))
      }
    }
  }
  return rows
}

function unpack(table, row) {
  const obj = JSON.parse(row.extra_json)
  const shape = JSON.parse(row.shape_json)
  for (const [key, column, type] of fields[table]) {
    const value = row[column]
    if (shape[key] === 'derived' || shape[key] === 'phase' || shape[key] === 'reviewPhase') continue
    if (value !== null) obj[key] = type === 'json' ? JSON.parse(value) : type === 'boolean' ? Boolean(value) : value
    else if (shape[key] === 'null') obj[key] = null
  }
  for (const [key, type] of Object.entries(children[table] ?? {})) {
    if (shape[key] === type) obj[key] = type === 'array' ? [] : {}
    else if (shape[key] === 'null') obj[key] = null
  }
  return obj
}

// Defining an own key also preserves a historical id literally named "__proto__".
const put = (obj, key, value) => Object.defineProperty(obj, key, { configurable: true, writable: true, enumerable: true, value })

// Earlier databases stored the detailed dispatch stage. Validate that original
// value on read; the next room write materializes the current task-level phase.
function previousCardStatus(card) {
  const round = card.rounds?.at(-1)
  if (!card.plans?.length) return projectStatus(round)
  const views = nodeViews(card, card.plans.at(-1)).map(node =>
    node.status === 'failed' && card.rounds[node.round - 1]?.planNode?.block ? { ...node, status: 'blocked' } : node)
  return planStage(views)
}

export function decodeTeam(rows) {
  const team = unpack('team_state', rows.team_state[0])
  const tasks = new Map()
  for (const row of rows.bots) put(team.bots ??= {}, row.bot_id, unpack('bots', row))
  for (const row of rows.rooms) put(team.rooms ??= {}, row.room_id, unpack('rooms', row))
  for (const row of rows.room_members) (team.rooms[row.room_id].members ??= []).push(row.bot_id)
  for (const row of rows.room_todos) (team.rooms[row.room_id].todos ??= []).push(unpack('room_todos', row))
  for (const row of rows.tasks) {
    const task = unpack('tasks', row)
    const group = row.source_kind === 'member' ? 'tasks' : 'projectCards'
    put(team.rooms[row.room_id][group] ??= {}, row.task_id, task)
    tasks.set(row.task_pk, task)
  }
  for (const row of rows.task_intakes) (tasks.get(row.task_pk).intakes ??= []).push(row.intake_id)
  for (const row of rows.task_rounds) (tasks.get(row.task_pk).rounds ??= []).push(unpack('task_rounds', row))
  for (const row of rows.task_notes) (tasks.get(row.task_pk).notes ??= []).push(unpack('task_notes', row))
  for (const row of rows.task_blocks) tasks.get(row.task_pk).blocked = unpack('task_blocks', row)
  // Explicit SQL edits of a derived status must agree with the original rounds.
  for (const row of rows.tasks) {
    const shape = JSON.parse(row.shape_json).status
    if (!['reviewPhase', 'phase', 'derived'].includes(shape)) continue
    const card = tasks.get(row.task_pk)
    const expected = shape === 'derived' ? previousCardStatus(card) : cardStatus(card)
    // Pre-verification records could show review solely from a submitted result.
    if (shape === 'phase' && row.status === 'review' && expected === 'active' && previousCardStatus(card) === 'review') continue
    if (row.status !== expected) throw new Error('Project status conflicts with the saved rounds')
  }
  return team
}

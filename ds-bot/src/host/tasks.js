// The group task board: what each member is working on in a group, one line apiece.
// A Bot registers a task when it takes the work and updates it as the work moves; the
// board is read from the group's own overview and never guessed from the chat. Tasks
// live on the room beside its goal, memory and folder, so they go when the group goes.
import { randomBytes } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'
import { reviewBaseline, verifyReviewCommit } from './project-branches.js'

export const TASK_STATUSES = ['active', 'review', 'blocked', 'clarify', 'failed', 'done', 'cancelled']
const OPEN_STATUSES = ['active', 'review', 'blocked', 'clarify', 'failed']
const GOAL_MAX = 200
const PROGRESS_MAX = 300
const RESULT_MAX = 2000
const NOTE_MAX = 500
const REASON_MAX = 500

const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const tasksOf = room => (room.tasks ??= {})
const listOf = room => Object.values(tasksOf(room)).sort((a, b) => a.startedAt - b.startedAt)
export const openTasksOf = room => listOf(room).filter(task => OPEN_STATUSES.includes(task.status))
export const pastTasksOf = room => listOf(room).filter(task => !OPEN_STATUSES.includes(task.status))
const newId = () => `t_${randomBytes(4).toString('hex')}`

// Called inside the team writer queue. Group messages retain their intake IDs, so
// remember dismissed intakes even for older cards created before the inbox existed.
export function deleteBoardTasks(room, items) {
  if (!room) throw new Error('Unknown group chat')
  if (!Array.isArray(items) || !items.length) throw new Error('Select tasks to delete.')
  const selected = { member: new Set(), project: new Set(), intake: new Set() }
  for (const item of items) {
    if (!item || !Object.hasOwn(selected, item.kind) || typeof item.id !== 'string' || !item.id)
      throw new Error('Invalid task selection.')
    selected[item.kind].add(item.id)
  }
  const dismissed = new Set(room.deletedTaskIntakes)
  const changes = {}
  for (const [kind, field] of [['member', 'tasks'], ['project', 'projectCards']]) {
    const entries = Object.entries(room[field] ?? {})
    const remaining = entries.filter(([id, task]) => {
      if (!selected[kind].has(id)) return true
      if (kind === 'project') for (const intake of task.intakes ?? []) dismissed.add(intake)
      return false
    })
    if (remaining.length !== entries.length) changes[field] = Object.fromEntries(remaining)
  }
  for (const intake of room.projectInbox ?? []) {
    if (!selected.intake.has(intake.id)) continue
    if (!['pending', 'planning', 'clarify'].includes(intake.status)) throw new Error('The intake changed. Check the task list again.')
    dismissed.add(intake.id)
  }
  if (dismissed.size !== (room.deletedTaskIntakes?.length ?? 0)) changes.deletedTaskIntakes = [...dismissed]
  if (room.projectInbox?.some(intake => dismissed.has(intake.id)))
    changes.projectInbox = room.projectInbox.filter(intake => !dismissed.has(intake.id))
  if (room.projectReplyScopes && (dismissed.size || selected.project.size)) {
    changes.projectReplyScopes = Object.fromEntries(Object.entries(room.projectReplyScopes)
      .filter(([, key]) => !dismissed.has(key) && !selected.project.has(key)))
  }
  const previous = Object.fromEntries(Object.keys(changes).map(key => [key, room[key]]))
  Object.assign(room, changes)
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete room[key]
      else room[key] = value
    }
  }
}

// Why DS Bot blocked a task: the member's turn failed, or the user stopped it. The panel
// words the same facts in the user's language.
export const blockedLine = blocked => blocked.cause === 'stopped' ? 'stopped by the user'
  : blocked.cause === 'restarted' ? 'not updated after DeepSeek Harness restarted'
  : `its model call failed (${blocked.code}${blocked.status ? ` ${blocked.status}` : ''})`

// The task an update names: its id, or the caller's own newest open task when no id is
// given (the common case: one Bot working on one thing).
function pickTask(room, id, botId) {
  if (id !== undefined && String(id).trim() !== '') return tasksOf(room)[String(id).trim()]
  return openTasksOf(room).filter(task => task.botId === botId).at(-1)
}

export function install(rt) {
  const open = (room, botId, goal) => {
    const text = oneLine(goal, GOAL_MAX)
    if (text === '') return { error: 'A task needs a one-line goal.' }
    const at = Date.now()
    const task = { id: newId(), botId, goal: text, status: 'active', startedAt: at, updatedAt: at, progress: '' }
    tasksOf(room)[task.id] = task
    return { task }
  }
  const update = (room, botId, id, { status, progress } = {}) => {
    const task = pickTask(room, id, botId)
    if (task === undefined) return { error: 'No open task of yours in this group. Name one with its id, or open a task first.' }
    if (!OPEN_STATUSES.includes(task.status)) return { error: 'That task is already finished.' }
    if (task.botId !== botId) return { error: `Task ${task.id} belongs to another member.` }
    if (status !== undefined && !OPEN_STATUSES.includes(status)) {
      return { error: `A running task\'s status is ${OPEN_STATUSES.join(', ')}; finish it with complete or cancel.` }
    }
    // The Bot is back on the work, whether or not it saw the block.
    if (task.blocked !== undefined) {
      task.status = task.blocked.from
      delete task.blocked
    }
    if (status === 'clarify' && task.status !== 'clarify') task.beforeClarification = task.status
    if (status !== undefined && status !== 'clarify') delete task.beforeClarification
    if (status !== undefined) task.status = status
    if (progress !== undefined) task.progress = oneLine(progress, PROGRESS_MAX)
    task.updatedAt = Date.now()
    return { task }
  }
  const complete = (room, botId, id, result) => {
    const task = pickTask(room, id, botId)
    if (task === undefined) return { error: 'No open task of yours in this group.' }
    if (!OPEN_STATUSES.includes(task.status)) return { error: 'That task is already finished.' }
    if (task.botId !== botId) return { error: `Task ${task.id} belongs to another member.` }
    const text = oneLine(result, RESULT_MAX)
    if (text === '') return { error: 'A finished task needs a result summary.' }
    delete task.beforeClarification
    task.status = 'done'
    delete task.blocked
    task.result = text
    task.updatedAt = Date.now()
    return { task }
  }
  const cancel = (room, botId, id, reason, isAdmin) => {
    const task = pickTask(room, id, botId)
    if (task === undefined) return { error: 'No open task to cancel.' }
    if (!OPEN_STATUSES.includes(task.status)) return { error: 'That task is already finished.' }
    if (task.botId !== botId && !isAdmin) return { error: `Task ${task.id} belongs to another member; only its owner, the admin or a Main Bot cancels it.` }
    delete task.beforeClarification
    task.status = 'cancelled'
    delete task.blocked
    const why = oneLine(reason, REASON_MAX)
    if (why !== '') task.reason = why
    task.updatedAt = Date.now()
    return { task }
  }
  const note = (room, id, text, by) => {
    const task = tasksOf(room)[String(id ?? '')]
    if (task === undefined) return undefined
    const line = oneLine(text, NOTE_MAX)
    if (line === '') return undefined
    if (by === 'user' && task.status === 'clarify') {
      task.status = task.beforeClarification ?? 'active'
      delete task.beforeClarification
    }
    ;(task.notes ??= []).push({ at: Date.now(), by, text: line })
    task.updatedAt = Date.now()
    return task
  }
  const owner = task => rt.botOf(task.botId)

  // What the tool answers with: the current board, not only the task it touched.
  const ledger = (room, self) => {
    const room_ = room
    const open = openTasksOf(room_).map(task => {
      const bot = owner(task)
      const mine = task.botId === self ? ' (yours)' : ''
      const progress = task.progress === '' ? '' : `\n  progress: ${task.progress}`
      const blocked = task.blocked === undefined ? '' : `\n  blocked by DS Bot: ${blockedLine(task.blocked)}`
      return `- ${task.id} · ${bot?.name ?? task.botId} · ${task.status} · ${task.goal}${mine}${progress}${blocked}`
    })
    const past = pastTasksOf(room_)
    const lines = [`Tasks in "${room_.name}"${open.length === 0 ? ': none open.' : ':'}`, ...open]
    if (past.length > 0) lines.push(`${past.length} finished or cancelled in the history; the group shows them under Tasks.`)
    return lines.join('\n')
  }

  rt.teamTools.push(defineTool({
    name: 'group_task',
    description: 'Register and move a group chat task: the work one member is doing in the group, so the user can see who is on what without reading the chat. Only a group member registers work, and every change is explicit: open when you take the work, update while it runs, complete with a one-line result, cancel when it stops. The group overview shows the board to the user; the history keeps finished and cancelled tasks. Called outside a group it refuses; inside a group the group is implied.',
    parameters: {
      action: { type: 'string', required: true, enum: ['open', 'update', 'complete', 'cancel', 'show'], description: 'What to do' },
      goal: { type: 'string', description: 'open: the task in one line, as the user would say the goal' },
      id: { type: 'string', description: 'update, complete, cancel: the task id; the caller\'s newest open task when left out' },
      status: { type: 'string', enum: OPEN_STATUSES, description: 'Use clarify when human context is required, review for submitted work, failed for execution errors, or blocked for other obstacles.' },
      deliveryKind: { type: 'string', enum: ['code', 'other'], description: 'Declare code changes or another deliverable when opening a task, or at first review for an unclassified task.' },
      repository: { type: 'string', description: 'Absolute path to the assigned project repository for a code task.' },
      commit: { type: 'string', description: 'Full delivery commit ID for code review. The host checks local main/master.' },
      progress: { type: 'string', description: 'update: the latest one-line progress' },
      result: { type: 'string', description: 'complete: the result summary the board keeps' },
      reason: { type: 'string', description: 'cancel: why the task stops' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const member = rt.botOf(self)
      if (member === undefined) return 'Only Bots on the team can use group_task.'
      const room = rt.roomOf(rt.groupOwners.get(exec.agent?.id)?.roomId)
      if (room === undefined) return 'group_task works inside a group chat, where the work belongs to the group. Call it from your group session.'
      const isAdmin = rt.isMain(self) || rt.isAdminOf(room, self)
      const action = String(args.action ?? '')
      let result
      switch (action) {
        case 'open': {
          let base
          const kind = args.deliveryKind ?? (args.repository ? 'code' : undefined)
          if (kind === 'other' && args.repository) return 'Use deliveryKind code for a task with an assigned repository.'
          if (kind === 'code') {
            if (!args.repository) return 'Supply the assigned repository for a code task.'
            base = await reviewBaseline(rt, room, args.repository)
          }
          result = open(room, self, args.goal)
          if (result.task && kind) result.task.deliveryKind = kind
          if (result.task && base) Object.assign(result.task, { repository: args.repository, reviewBase: base })
          break
        }
        case 'update': {
          const task = pickTask(room, args.id, self)
          let evidence, kind
          if (args.status === 'review' && task?.botId === self && OPEN_STATUSES.includes(task.status)) {
            if (task.deliveryKind && args.deliveryKind && task.deliveryKind !== args.deliveryKind)
              return 'The delivery kind must match the registered task.'
            kind = task.deliveryKind ?? args.deliveryKind ?? (args.repository || args.commit ? 'code' : undefined)
            if (!kind) return 'Specify deliveryKind as code or other before requesting review.'
            if (kind !== 'code' && (args.commit || args.repository)) return 'Register a code delivery to verify its Git commit.'
            if (kind === 'code') {
              const repository = task.repository ?? args.repository
              if (!repository) return 'Supply the assigned repository for a code task.'
              evidence = await verifyReviewCommit(rt, room, repository, args.commit ?? (task.status === 'review' ? task.mainReview?.commit : undefined), { base: task.reviewBase })
            }
          }
          result = update(room, self, task?.id ?? args.id, { status: args.status, progress: args.progress })
          if (result.task && kind) result.task.deliveryKind = kind
          if (result.task && evidence) Object.assign(result.task, { repository: evidence.repository, mainReview: evidence })
          break
        }
        case 'complete': result = complete(room, self, args.id, args.result); break
        case 'cancel': result = cancel(room, self, args.id, args.reason, isAdmin); break
        case 'show': return ledger(room, self)
        default: return `Unknown action ${action}.`
      }
      if (result.error !== undefined) return result.error
      const task = result.task
      const done = task.status === 'done' ? ` Finished: "${task.result}"` : task.status === 'cancelled' ? ' Cancelled.' : ''
      await rt.save()
      return `${action === 'open' ? `Opened ${task.id}: ${task.goal}` : `Updated ${task.id} (${task.status}).`}${done}\n\n${ledger(room, self)}`
    },
  }))

  // The board follows how the member's work in the group really ended (#1663): a failed
  // turn or the user's stop blocks its running tasks, and its next completed turn there
  // puts them back. A block the Bot set itself is the Bot's to lift.
  // `since`: only tasks the member has not updated since then.
  const blockTasks = (roomId, botId, cause, since) => {
    const room = rt.roomOf(roomId)
    if (room === undefined) return
    // A system block is renewed with the latest cause; a block the Bot set stays its own.
    const running = openTasksOf(room).filter(task => task.botId === botId && task.status !== 'clarify' && (task.status !== 'blocked' || task.blocked !== undefined)
      && (since === undefined || task.updatedAt < since))
    if (running.length === 0) return
    const at = Date.now()
    for (const task of running) {
      task.blocked = { by: 'system', ...cause, from: task.blocked?.from ?? task.status, at }
      task.status = cause.cause === 'failed' ? 'failed' : 'blocked'
      task.updatedAt = at
    }
    void rt.save().catch(() => {})
  }
  const unblockTasks = (roomId, botId) => {
    const room = rt.roomOf(roomId)
    if (room === undefined) return
    const blocked = openTasksOf(room).filter(task => task.botId === botId && task.blocked !== undefined)
    if (blocked.length === 0) return
    const at = Date.now()
    for (const task of blocked) {
      task.status = task.blocked.from
      delete task.blocked
      task.updatedAt = at
    }
    void rt.save().catch(() => {})
  }

  // For the group overview. The endpoint adds the user's note and posts it to the room.
  Object.assign(rt, {
    blockTasks,
    unblockTasks,
    taskNote: (roomId, id, text) => {
      const room = rt.roomOf(roomId)
      if (room === undefined) return { error: 'No such group.' }
      const task = tasksOf(room)[String(id ?? '')]
      if (task === undefined) return { error: 'No such task.' }
      if (!OPEN_STATUSES.includes(task.status)) return { error: 'That task is already finished.' }
      const noted = note(room, id, text, 'user')
      return noted === undefined ? { error: 'Write a note first.' } : { task: noted }
    },
    taskCancel: (roomId, id) => {
      const room = rt.roomOf(roomId)
      if (room === undefined) return { error: 'No such group.' }
      const task = tasksOf(room)[String(id ?? '')]
      if (task === undefined) return { error: 'No such task.' }
      if (!OPEN_STATUSES.includes(task.status)) return { error: 'That task is already finished.' }
      delete task.beforeClarification
      task.status = 'cancelled'
      delete task.blocked
      task.updatedAt = Date.now()
      return { task }
    },
  })
}

import { assistantId, projectNotice } from './project-assistant.js'
// Rebuild a card's input from its own dispatch. A session-wide checkpoint may
// summarize several cards and cannot establish which one owns the work.
import { HISTORY_TIMEOUT_MS, REPLY_KIND, SOURCE_KIND } from './constants.js'
import { blockRound, currentBinding } from './project-recovery.js'
import { projectImages, projectRoomForCard, projectSources } from './project-tasks.js'
import { scopeFields, scopeOf, taskHistory } from './task-routing.js'

export function dispatchedRound(rt, sessionId, source) {
  if (!source?.taskId || !source.exchangeId || source.kind !== SOURCE_KIND) return
  const room = source.roomId && rt.roomOf ? rt.roomOf(source.roomId) : projectRoomForCard(rt, source.taskId)
  const card = room?.projectCards?.[source.taskId]
  const member = rt.groupOwners?.get(sessionId) ?? rt.pastOwners?.get(sessionId)
  if (member && member.roomId !== room?.id) return
  const owner = member?.botId ?? rt.chatOwners.get(sessionId)
  const protocol = rt.state.works?.[rt.workOf?.(source)]
  const dispatchId = protocol?.protocol && protocol.to === owner && protocol.taskId === source.taskId ? protocol.dispatchId : source.exchangeId
  const round = card?.rounds.find(r => r.dispatchId === dispatchId && r.ownerId === owner &&
    (!r.executionSession || r.executionSession === sessionId))
  if (!round || (source.roomId && source.roomId !== room.id)) return
  if (card.plans?.length ? !currentBinding(card, round) : round !== card.rounds.at(-1)) return
  return { room, card, round }
}

// Apply the interruption to the same exchange inside the SQLite writer queue:
// a newer round may already have been committed when the event is delivered.
export async function interruptProject(rt, room, card, round, cause, reason, at = Date.now()) {
  const match = () => {
    const current = rt.roomOf(room.id)?.projectCards?.[card.id]
    const run = current?.rounds.find(r => r.dispatchId === round.dispatchId)
    return run && currentBinding(current, run) && !run.planNode.block && !run.result ? run : undefined
  }
  if (!match()) return
  await rt.save({ required: true, mutate() {
    const run = match()
    if (!run) return
    blockRound(run, { at, cause, by: 'system', reason: rt.redactSecrets(reason).slice(0, 2000) })
    return () => { delete run.planNode.block }
  } })
  const blocked = rt.roomOf(room.id)?.projectCards?.[card.id]?.rounds.find(r => r.dispatchId === round.dispatchId)?.planNode?.block
  if (assistantId(room) && blocked?.at === at) await projectNotice(rt, room, assistantId(room), { taskId: card.id },
    round.dispatchId + ':block', 'The execution was interrupted. Read its blocker and checkpoint, then decide whether to wait, resume or reassign.')

}

export async function reconcileProjectRounds(rt, bootAt) {
  for (const room of Object.values(rt.state.rooms)) for (const card of Object.values(room.projectCards ?? {})) {
    for (const round of card.rounds ?? []) {
      if (!currentBinding(card, round) || round.planNode.block || round.result || !round.startedAt || round.startedAt > bootAt) continue
      const session = round.planNode.session ?? round.executionSession ?? rt.chatOf(round.ownerId)
      const entry = rt.live.get(session)
      if (entry?.turn !== undefined && entry.info?.exchangeId === round.dispatchId) continue
      // A live DSH turn can outlast a plugin reload. Adopt only its own
      // most recent user dispatch, never a different card in the same session.
      const agent = await rt.resolveAgent(session).catch(() => undefined)
      if (agent?.status === 'running' && !entry?.info) {
        const events = await inspectedTurn(rt, session, undefined, true).catch(() => [])
        const source = events.findLast(e => e.type === 'user/message' && [SOURCE_KIND, 'user', 'schedule'].includes(e.data.source?.kind))?.data.source
        if (agent.status === 'running' && !events.some(e => e.type === 'turn/end') &&
            dispatchedRound(rt, session, source)?.round === round) {
          const live = rt.live.get(session)
          if (live?.turn !== undefined && !live.info) live.info = source
          continue
        }
      }
      const protocol = rt.state.works?.[round.dispatchId]
      if (protocol?.protocol && protocol.taskId === card.id && protocol.to === round.ownerId && protocol.toSession === session) continue
      await interruptProject(rt, room, card, round, 'restart', 'Execution could not be confirmed after the host restarted.')
    }
  }
}

function hasDispatch(event, exchangeId) {
  return event.type === 'user/message' && event.data.source?.kind === SOURCE_KIND && event.data.source.exchangeId === exchangeId
}

export function turnRecord(events, turn, exchangeId) {
  const last = exchangeId ? events.findLastIndex(e => hasDispatch(e, exchangeId)) : events.length - 1
  if (last < 0) return
  const start = events.slice(0, last + 1).findLastIndex(event => event.type === 'turn/start' && (turn === undefined || event.data.turn === turn))
  if (start < 0) return
  const rows = []
  for (const event of events.slice(start + 1)) {
    if (event.type === 'turn/start') break
    rows.push(event)
  }
  return rows
}

export function recoveryInput(rt, source, events, dispatch) {
  const key = scopeOf(source)
  const trigger = events.find(e => e.type === 'user/message' && e.data.source?.exchangeId === source.exchangeId && scopeOf(e.data.source) === key)
  if (!trigger || !source.exchangeId) return
  const original = trigger.data.content ?? []
  const lines = dispatch ? projectSources(rt, dispatch.room, dispatch.card.intakes, dispatch.card.id) : []
  if (dispatch?.card.fieldImages) lines.push({ images: projectImages(dispatch.card, []) })
  const changed = new Set(), progress = [], checks = []
  const commands = new Map()
  let active = false, todos
  for (const event of events) {
    const d = event.data
    if (event.type === 'user/message' && [SOURCE_KIND, 'user', 'schedule'].includes(d.source?.kind)) active = scopeOf(d.source) === key
    if (!active) continue
    if (event.type === 'todo/write') todos = d.todos
    if (event.type === 'tool/call' && ['write', 'edit', 'bash'].includes(d.name)) {
      let args = d.arguments
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch { continue } }
      const path = args?.path ?? args?.file_path ?? args?.filePath
      if (d.name !== 'bash' && typeof path === 'string') changed.add(path)
      if (d.name === 'bash' && typeof args?.description === 'string') commands.set(d.callId, args.description.slice(0, 200))
    }
    if (event.type === 'tool/result' && commands.has(d.callId)) {
      const note = (d.message?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join(' ').slice(-600)
      if (note) checks.push(commands.get(d.callId) + ': ' + note)
    }
    if (event.type === 'assistant/message') {
      const text = (d.message.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n')
      if (text) progress.push(text.slice(-1000))
    }
  }
  const parts = [...original]
  const attachments = new Set(parts.filter(p => p.attachment).map(p => p.attachment.attachmentId ?? p.attachment.id))
  for (const line of lines) {
    for (const [type, refs] of [['image', line.images], ['file', line.files]]) {
      for (const attachment of refs ?? []) {
        const id = attachment.attachmentId ?? attachment.id
        if (attachments.has(id)) continue
        parts.push({ type, attachment })
        attachments.add(id)
      }
    }
  }
  parts.push({ type: 'text', text: [
    'Continue the same task from its existing files. Inspect the changes and test results before repeating any work.',
    ...progress.slice(-2),
    ...checks.slice(-3),
    ...[...changed].slice(-30).map(path => 'Previously edited path (verify on disk): ' + path),
    ...(todos?.length ? ['Last checklist: ' + JSON.stringify(todos)] : []),
  ].join('\n') })
  return { role: 'user', source, content: parts }
}

export async function inspectedTurn(rt, sessionId, turn, onlyLatest = false, exchangeId) {
  const agent = await rt.resolveAgent(sessionId)
  const session = agent.session
  if (typeof session.eventAt === 'function') {
    const rows = []
    for (let seq = session.seq - 1; seq >= 0; seq--) {
      const event = session.eventAt(seq)
      if (!event) continue
      if (event.type === 'turn/start') {
        if ((turn === undefined || event.data.turn === turn) && (!exchangeId || rows.some(e => hasDispatch(e, exchangeId)))) return rows.reverse()
        if (onlyLatest || event.data.turn < turn) return []
        rows.length = 0
      } else rows.push(event)
    }
    return []
  }
  if (typeof session.snapshotEvents === 'function') {
    const events = session.snapshotEvents()
    if (turn !== undefined && onlyLatest && events.findLast(event => event.type === 'turn/start')?.data.turn !== turn) return []
    return turnRecord(events, turn, exchangeId) ?? []
  }
  if (!rt.ctx.sessionController?.inspect && rt.eventsBackwards) {
    const rows = []
    for await (const event of rt.eventsBackwards(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS), Infinity)) {
      if (event.type === 'turn/start') {
        if ((turn === undefined || event.data.turn === turn) && (!exchangeId || rows.some(e => hasDispatch(e, exchangeId)))) return rows.reverse()
        if (onlyLatest || event.data.turn < turn) return []
        rows.length = 0
      } else rows.push(event)
    }
    return []
  }
  const inspection = await rt.ctx.sessionController?.inspect?.(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
  const events = inspection?.events ?? []
  if (turn !== undefined && onlyLatest && events.findLast(e => e.type === 'turn/start')?.data.turn !== turn) return []
  return turnRecord(events, turn, exchangeId) ?? []
}

export async function scopedModelInput(rt, sessionId, input, entry) {
  const source = entry.info, key = scopeOf(source)
  const replies = rt.roomOf?.(source.roomId)?.projectReplyScopes
  const replyScope = m => m?.source?.kind === REPLY_KIND ? scopeOf(m.source.projectSource)
    : m?.source?.kind === 'user' && replies && Object.hasOwn(replies, m.id) ? replies[m.id] : undefined
  // The filtered request re-enters the stream. Preserve already-scoped replies
  // so the next pass can hand the same messages to the model.
  input = input.map(m => m.role === 'user' && scopeOf(m.source) !== key && replyScope(m) === key
    ? { ...m, source: { ...m.source, ...scopeFields(key) } } : m)
  const filtered = taskHistory(input, key, SOURCE_KIND)
  const checkpoint = input.findLastIndex(m => m.role === 'user' && m.source?.kind === 'compact-checkpoint')
  if (checkpoint < 0 || input.slice(checkpoint + 1).some(m => m.role === 'user' && scopeOf(m.source) === key && m.source?.exchangeId === source.exchangeId)) return filtered
  const id = input[checkpoint].source.compactionId
  let saved = entry.projectCheckpoint
  if (!saved || saved.id !== id || saved.exchange !== source.exchangeId || saved.turn !== entry.turn) {
    const events = await inspectedTurn(rt, sessionId, entry.turn)
    if (!events.some(e => e.type === 'compaction/start' && e.data.compactionId === id)) return filtered
    const anchor = recoveryInput(rt, source, events, dispatchedRound(rt, sessionId, source))
    if (!anchor) return filtered
    const boundary = events.findIndex(e => e.type === 'compaction/start' && e.data.compactionId === id)
    const preceding = events.slice(0, boundary).findLast(e => e.type === 'user/message' && [SOURCE_KIND, REPLY_KIND, 'user', 'schedule'].includes(e.data.source?.kind))
    saved = entry.projectCheckpoint = { id, exchange: source.exchangeId, turn: entry.turn, anchor,
      ownsTail: (replyScope(preceding?.data) ?? scopeOf(preceding?.data.source)) === key }
  }
  const rules = input.slice(0, checkpoint).filter(m => m.role === 'system' || m.role === 'developer')
  const tail = input.slice(checkpoint + 1)
  return [...rules, ...(saved.ownsTail ? taskHistory([saved.anchor, ...tail], key, SOURCE_KIND) : [saved.anchor, ...taskHistory(tail, key, SOURCE_KIND)])]
}

export function pendingAfterFailure(todos) {
  if (todos?.some(item => item.status === 'in_progress')) return todos.map(item => item.status === 'in_progress' ? { ...item, status: 'pending' } : item)
}

// Earlier versions left both projections active after an error. Repair only
// the last failed turn, while its session is still idle and still on that turn.
export async function restoreFailedProjects(rt, remember) {
  await rt.load()
  if (rt.readOnly() !== undefined) return
  for (const bot of Object.values(rt.state.bots)) {
    const chat = rt.chatOf(bot.id)
    const sessions = new Set(bot.failures?.[chat] ? [chat] : [])
    for (const room of Object.values(rt.state.rooms)) for (const card of Object.values(room.projectCards ?? {})) {
      for (const round of card.rounds ?? []) if (round.ownerId === bot.id && round.startedAt && !round.submittedAt)
        sessions.add(round.planNode?.session ?? round.executionSession ?? rt.chatOf(bot.id))
    }
    for (const sessionId of sessions) await restoreSession(bot, sessionId)
  }

  async function restoreSession(bot, sessionId) {
    const failure = bot.failures?.[sessionId]
    const agent = await rt.resolveAgent(sessionId)
    if (agent.status === 'running') return
    const before = agent.session.seq
    const rows = await inspectedTurn(rt, sessionId, undefined, true)
    const end = rows.findLast(e => e.type === 'turn/end')
    if (end?.data.reason?.kind !== 'error' || before !== agent.session.seq || agent.status === 'running') return
    const source = rows.find(e => e.type === 'user/message' && dispatchedRound(rt, sessionId, e.data.source))?.data.source
    const dispatch = dispatchedRound(rt, sessionId, source)
    if (failure?.turn !== end.data.turn) {
      if (!dispatch || dispatch.round.result) return
      remember?.(sessionId, end.data.turn, end.data.reason.error, agent.session)
    }
    const pending = pendingAfterFailure(rows.findLast(e => e.type === 'todo/write')?.data.todos)
    if (pending) {
      agent.session.append('todo/write', { todos: pending })
      await rt.ctx.sessions?.flush?.(agent.session)
    }
    if (dispatch?.round.planNode && !dispatch.round.result) {
      await interruptProject(rt, dispatch.room, dispatch.card, dispatch.round, 'failure', end.data.reason.error?.message ?? 'The model turn failed.', end.time)
    } else if (dispatch && !dispatch.round.result && !dispatch.round.failedAt) {
      dispatch.round.failedAt = end.time ?? failure?.at ?? Date.now()
      await rt.save({ required: true })
    }
  }
}

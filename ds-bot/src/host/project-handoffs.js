import { createHash, randomUUID } from 'node:crypto'
import { assistantId } from './project-assistant.js'
import { projectCardSummary, projectSources, projectImages, relatedTaskGuidance } from './project-tasks.js'
import { taskRoom } from './task-routing.js'
import { taskMessage } from '../shared/task-message.js'

const RETRY_MS = 30_000

function documentKey(card) {
  return createHash('sha256').update(JSON.stringify([card.title, card.goal, card.acceptance])).digest('hex')
}

function sourceSequence(rt, room, card) {
  return Math.max(card.delegatedSeq ?? 0, card.managementHandoff?.sourceSeq ?? 0,
    projectSources(rt, room, card.intakes ?? [], card.id).at(-1)?.seq ?? 0)
}

function restore(record, previous) {
  for (const key of Object.keys(record)) delete record[key]
  Object.assign(record, previous)
}

export function handoffState(rt, room, card) {
  const assistant = assistantId(room)
  const handoff = card.managementHandoff
  if (projectCardSummary(card).status === 'done' || card.cancelledAt || card.reason)
    return { status: 'finished', retryable: false, reason: 'The task is finished or cancelled.' }
  if (card.plans?.length || card.rounds?.length)
    return { status: 'planned', retryable: false, reason: 'Continue the saved plan and execution rounds; do not create another handoff.' }
  if (card.clarification)
    return { status: 'clarify', retryable: false, reason: card.clarification }
  if (room.unresolvedTaskAssistant || (room.projectAssistantId && !assistant))
    return { status: 'invalid_assistant', retryable: false, reason: 'The appointed task assistant is not a valid non-admin member of this group.' }
  if (!assistant)
    return { status: 'no_assistant', retryable: false, reason: 'No task assistant is appointed. The group admin owns planning and dispatch.' }
  const current = handoff?.toId === assistant && handoff.documentKey === documentKey(card) && handoff.sourceSeq === sourceSequence(rt, room, card)
  if (current && handoff.status === 'delivered')
    return { status: 'delivered', retryable: false, reason: 'The requirement was delivered to the current assistant; wait for its plan.' }
  if (!card.goal?.trim() || !card.acceptance?.trim()) {
    if (!projectSources(rt, room, card.intakes ?? [], card.id).length)
      return { status: 'missing_source', retryable: false, reason: 'Neither a complete requirement nor the original user request is available.' }
    return { status: 'needs_document', retryable: true, reason: 'Accepted work has no saved requirement or acceptance. Normalize the original card before retrying.' }
  }
  return { status: current ? handoff.status : 'not_sent', retryable: true,
    reason: current && handoff.error || 'The current requirement has not been delivered to the appointed assistant.' }
}

export function scanProjectHandoffs(rt, room) {
  return Object.values(room.projectCards ?? {}).map(card => ({ taskId: card.id, title: card.title,
    ...handoffState(rt, room, card), ...(card.managementHandoff && { lastAttemptAt: card.managementHandoff.at,
      attempts: card.managementHandoff.attempts, deliveredAt: card.managementHandoff.deliveredAt }) }))
    .filter(row => !['finished', 'planned'].includes(row.status))
}

async function wasDelivered(rt, sessionId, id) {
  const agent = await rt.resolveAgent(sessionId)
  if ([...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])].some(message => message.source?.exchangeId === id)) return true
  for await (const event of rt.eventsBackwards(sessionId, AbortSignal.timeout(5000))) {
    if (event.type === 'user/message' && event.data?.source?.exchangeId === id) return true
  }
  return false
}

export function install(rt) {
  let timer, scheduledAt, stopped = false, running
  const inflight = new Map()
  const schedule = (delay = 5000) => {
    if (stopped) return
    const due = Date.now() + delay
    if (timer && scheduledAt <= due) return
    clearTimeout(timer)
    scheduledAt = due
    timer = setTimeout(() => {
      timer = undefined
      void recover().catch(error => rt.warn('ds-bot: project handoff scan failed: %s', error))
    }, delay)
    timer.unref?.()
  }
  const send = async (room, record, payload) => {
    if (inflight.has(record.id)) return inflight.get(record.id)
    const work = (async () => {
      if (rt.readOnly() !== undefined || stopped) throw new Error('This host cannot deliver project work.')
      const sessionId = await rt.memberSession(room, record.toId)
      if (stopped) throw new Error('Project handoff recovery stopped.')
      const priorSessions = [...new Set([record.sessionId, sessionId, ...(room.segments?.[record.toId] ?? []).map(segment => typeof segment === 'string' ? segment : segment.sessionId)].filter(id => typeof id === 'string'))]
      let delivered = false
      if (record.attempts) for (const id of priorSessions) if (await wasDelivered(rt, id, record.id)) { delivered = true; break }
      if (delivered) {
        await rt.save({ required: true, mutate() {
          const previous = { ...record }
          Object.assign(record, { status: 'delivered', deliveredAt: Date.now() })
          delete record.error
          delete record.nextAttemptAt
          return () => restore(record, previous)
        } })
        return
      }
      await rt.save({ required: true, mutate() {
        const previous = { ...record }
        Object.assign(record, { sessionId, attempts: (record.attempts ?? 0) + 1, at: Date.now(), status: 'pending' })
        return () => restore(record, previous)
      } })
      try {
        if (payload.projectActorId && assistantId(room) !== record.toId) throw new Error('The appointed assistant changed before delivery. Scan the original card again.')
        if (!payload.projectActorId && room.admin !== record.toId) throw new Error('The group admin changed before recovery notification.')
        await rt.deliver({ ...payload, toId: record.toId, sessionId, roomId: room.id, exchangeId: record.id, recordExchange: false,
          validateDestination: () => !stopped && rt.roomOf(room.id) === room && room.members.includes(record.toId) &&
            (payload.projectActorId ? assistantId(room) === record.toId && room.projectCards[payload.taskId]?.managementHandoff === record &&
              documentKey(room.projectCards[payload.taskId]) === record.documentKey
              : room.admin === record.toId && room.projectHandoffScan === record) })
        await rt.save({ required: true, mutate() {
          const previous = { ...record }
          Object.assign(record, { status: 'delivered', deliveredAt: Date.now() })
          delete record.error
          delete record.nextAttemptAt
          return () => restore(record, previous)
        } })
      } catch (error) {
        await rt.save({ required: true, mutate() {
          const previous = { ...record }
          record.status = 'uncertain'
          record.error = rt.redactSecrets(error.message ?? String(error))
          record.nextAttemptAt = Date.now() + RETRY_MS
          return () => restore(record, previous)
        } })
        schedule(RETRY_MS)
        throw error
      }
    })()
    inflight.set(record.id, work)
    try { return await work } catch (error) {
      if (!stopped && rt.readOnly() === undefined && record.error !== rt.redactSecrets(error.message ?? String(error))) {
        await rt.save({ required: true, mutate() {
          const previous = { ...record }
          record.status = 'uncertain'
          record.error = rt.redactSecrets(error.message ?? String(error))
          record.nextAttemptAt = Date.now() + RETRY_MS
          return () => restore(record, previous)
        } })
      }
      schedule(RETRY_MS)
      throw error
    } finally { inflight.delete(record.id) }
  }
  const retry = async (room, card, { continuation = false } = {}) => {
    const state = handoffState(rt, room, card)
    const toId = assistantId(room)
    const sourceSeq = sourceSequence(rt, room, card)
    const key = documentKey(card)
    let record = card.managementHandoff
    if (record?.toId === toId && record.sourceSeq === sourceSeq && (record.documentKey === key || state.status === 'planned') && record.status === 'delivered')
      return { delegated: true, taskId: card.id, assistantId: toId, replay: true }
    if ((!state.retryable && !(continuation && state.status === 'planned')) || state.status === 'needs_document') throw new Error(state.reason)
    if (!toId) throw new Error('No task assistant is appointed. The group admin must plan this card.')
    if (!record || record.toId !== toId || record.sourceSeq !== sourceSeq || record.documentKey !== key) {
      const next = { id: randomUUID(), toId, sourceSeq, documentKey: key, status: 'pending', attempts: 0, at: Date.now() }
      await rt.save({ required: true, mutate() {
        const previous = card.managementHandoff
        if (previous?.toId === toId && previous.sourceSeq === sourceSeq && previous.documentKey === key) { record = previous; return }
        card.managementHandoff = next
        record = next
        return () => { if (previous) card.managementHandoff = previous; else delete card.managementHandoff }
      } })
    }
    const lines = projectSources(rt, room, card.intakes ?? [], card.id)
    const owners = room.members.filter(id => id !== room.admin && id !== toId).map(rt.botOf).filter(Boolean)
      .map(({ id, name, role }) => ({ id, name, role }))
    const text = [
      'The group admin delegated this existing card to you as its appointed task assistant. Read and continue this taskId in your session for this group. Do not create a new card or require routine user confirmation. If a plan or execution exists, preserve it and coordinate its continuation rather than dispatching it again.',
      relatedTaskGuidance,
      'Requirement: ' + (card.goal ?? lines.map(line => taskMessage(line.text, room).body).join('\n\n')), 'Acceptance: ' + card.acceptance,
      'Eligible node owners: ' + JSON.stringify(owners),
      'Save the complete plan, dispatch ready nodes, review evidence and coordinate blockers. Preserve existing work and respect the user’s authorization. Independent tasks may proceed concurrently. For feature work, keep the candidate on the feature branch and use a final independent read-only test; integration, installation and release require their own authorization.',
      'For every feature task the developer commits on the feature branch. Dispatch the final test with independentReview=true, writePaths=[] and a dependency on the approved developer candidate. Keep user acceptance separate from test methods. Reuse recorded checks and submit the read-only receipt with cleanupEvidence after cleanup. No separate report is required.',
      'After dispatch, use message_bot with taskId, card_round=dispatchRound, reply_to=user and request_id to the assigned owner. Distinguish delivery from its project_task start confirmation. Read the original writer and worktree evidence before recovery; do not restart existing work merely because its manager changed.',
      ...lines.map(line => 'Group #' + line.seq + ': ' + taskMessage(line.text, room).body),
    ].join('\n\n')
    try {
      await send(room, record, { taskId: card.id, projectActorId: room.admin, handoffText: [card.goal ?? lines.map(line => taskMessage(line.text, room).body).join('\n\n'), card.acceptance].join('\n\n'), role: 'request', audience: 'user',
        text, images: projectImages(card, lines), files: lines.flatMap(line => line.files ?? []) })
      return { delegated: true, taskId: card.id, assistantId: toId }
    } catch {
      return { delegated: false, taskId: card.id, ...handoffState(rt, room, card) }
    }
  }
  const recover = () => running ??= (async () => {
    await rt.load()
    if (stopped || rt.readOnly() !== undefined) return
    for (const room of Object.values(rt.state.rooms)) {
      if (stopped) return
      if (!taskRoom(room) || !room.admin || !room.members.includes(room.admin)) continue
      const rows = []
      for (const row of scanProjectHandoffs(rt, room)) {
        if (['delivered', 'clarify'].includes(row.status)) continue
        const pending = room.projectCards[row.taskId].managementHandoff
        if (pending?.status === 'pending' && inflight.has(pending.id)) { schedule(); continue }
        if (row.status === 'uncertain' && pending?.toId === assistantId(room)) {
          if (pending.attempts >= 3) continue
          if (pending.nextAttemptAt > Date.now()) { schedule(pending.nextAttemptAt - Date.now()); continue }
        }
        rows.push(row)
      }
      if (!rows.length) continue
      const sessionId = room.sessions?.[room.admin]
      if (sessionId && rt.live.get(sessionId)?.turn !== undefined) { schedule(); continue }
      let record = room.projectHandoffScan
      if (sessionId && record?.toId === room.admin && record.status === 'delivered') {
        const agent = await rt.resolveAgent(sessionId)
        if (stopped) return
        if ([...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])].some(message => message.source?.exchangeId === record.id)) { schedule(); continue }
      }
      const fingerprint = JSON.stringify([room.admin, assistantId(room), rows.map(row => {
        const card = room.projectCards[row.taskId]
        return [row.taskId, row.status, row.reason, card.title, card.goal, card.acceptance, card.managementHandoff?.attempts]
      })])
      if (record?.fingerprint === fingerprint && record.toId === room.admin) {
        if (record.status === 'delivered' || record.attempts >= 3) continue
        if (record.nextAttemptAt > Date.now()) { schedule(record.nextAttemptAt - Date.now()); continue }
      } else {
        if (stopped) return
        const next = { id: randomUUID(), toId: room.admin, fingerprint, status: 'pending', attempts: 0, at: Date.now() }
        await rt.save({ required: true, mutate() {
          const previous = room.projectHandoffScan
          room.projectHandoffScan = next
          return () => { if (previous) room.projectHandoffScan = previous; else delete room.projectHandoffScan }
        } })
        record = next
      }
      try {
        await send(room, record, { role: 'room', text: [
          'Accepted project cards still have no plan or execution. Scan unassigned cards with project_task scan and explain the actual unsent reason in the group. Process this batch in the same admin group session; keep each original taskId.',
          'Unassigned cards: ' + JSON.stringify(rows),
          assistantId(room)
            ? 'Read the original cards and their user sources. For each retryable card, normalize its title, requirement and acceptance when needed, then call project_task retry_handoff with that taskId and title, plan, acceptance. This retries the original card to the currently appointed assistant. A successful delivery is not an execution start. Do not ask for routine user confirmation or wait for an unrelated task.'
            : room.projectAssistantId || room.unresolvedTaskAssistant
              ? 'The task assistant binding is invalid. Explain the invalid membership or role; do not guess a replacement or retry dispatch with invalid permissions.'
              : 'No assistant is appointed. Continue planning the original cards yourself; do not wait for an assistant. Preserve original sources and authorization.',
        ].join('\n\n') })
      } catch (error) { rt.warn('ds-bot: unassigned project notification failed: %s', error) }
    }
  })().finally(() => { running = undefined })
  Object.assign(rt, { retryProjectHandoff: retry, scanProjectHandoffs: room => scanProjectHandoffs(rt, room),
    recoverProjectHandoffs: recover, scheduleProjectHandoffScan: schedule })
  const off = rt.onSaved(schedule)
  rt.ctx.effect(() => {
    schedule()
    return () => { stopped = true; clearTimeout(timer); off(); return Promise.allSettled([running, ...inflight.values()]) }
  }, 'ds-bot: project handoff recovery')
}

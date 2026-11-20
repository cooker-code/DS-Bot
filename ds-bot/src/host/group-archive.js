// Group transcript turns are identified by their DSH part and turn number. The ledger
// keeps the member replies; the DSH turn keeps the opening message and attachments.
import { relayRange } from '../shared/group-replies.js'

const textOf = content => Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).join('') : ''

// Scoped project discussions can interleave. Use the same next matching anchor
// as the transcript, so searching another task never labels its messages by accident.
function archiveBounds(anchors, lastSeq) {
  const byId = new Map()
  const nextByScope = new Map()
  let next
  for (let i = anchors.length - 1; i >= 0; i--) {
    const anchor = anchors[i]
    const scopes = anchor.scopeKeys
    const boundary = scopes ? (scopes.length === 1 ? nextByScope.get(scopes[0]) : undefined) : next
    byId.set(anchor.id, { scopes, to: boundary === undefined ? lastSeq : boundary - 1 })
    for (const scope of scopes ?? []) nextByScope.set(scope, anchor.from)
    next = anchor.from
  }
  return byId
}

async function readPart(ctx, sessionId, signal) {
  const pages = []
  let beforeSeq
  for (;;) {
    const page = await ctx.sessionController.page({ address: { kind: 'session', sessionId }, beforeSeq, maxMessages: 150 }, signal)
    const events = page.records.map(row => row.event)
    pages.push(events.filter(event => ['turn/start', 'turn/end', 'user/message', 'tool/call', 'tool/result'].includes(event.type)))
    if (!page.hasMore || !events.length) break
    if (beforeSeq !== undefined && events[0].seq >= beforeSeq) throw new Error('Group history cursor did not advance')
    beforeSeq = events[0].seq
  }
  return pages.reverse().flat()
}

export async function groupDiscussions(ctx, rt, room, signal, detail) {
  const list = []
  const ledger = rt.ledger.records('group-' + room.id)
  const anchors = ledger.filter(event => event.event === 'anchor')
  const bounds = archiveBounds(anchors, room.seq)
  const finished = ledger.filter(event => event.event === 'round')
  for (const part of [...(room.parts ?? []).map(row => row.sessionId), rt.sessionOfRoom(room)]) {
    if (detail && !detail.startsWith(part + '/')) continue
    const events = await readPart(ctx, part, signal)
    let start
    let call
    let range
    for (const [index, event] of events.entries()) {
      const data = event.data
      if (event.type === 'turn/start') { start = index; call = range = undefined }
      if (event.type === 'tool/call' && data.name === 'group_relay') call = data.callId
      if (call && event.type === 'tool/result' && data.message?.toolCallId === call) range = relayRange(textOf(data.message.content))
      if (event.type !== 'turn/end' || !call || start === undefined) continue
      const turn = data.turn
      const id = part + '/' + turn
      if (detail && id !== detail) continue
      const group = events.slice(start, index + 1)
      const opener = group.find(e => e.type === 'user/message' && (e.data.source?.kind === 'user' || e.data.source?.role === 'post'))
      const bound = bounds.get(range?.anchor)
      const end = range?.to ?? bound?.to ?? (range ? anchors.reduce((last, a) =>
        a.from > range.from ? Math.min(last, a.from - 1) : last, room.seq) : undefined)
      const scopes = range?.to === undefined ? bound?.scopes : undefined
      const inProgress = range && rt.roomActive(room.id) && !finished.some(r => r.from <= end && r.to >= range.from &&
        (!scopes || scopes.some(key => key === (r.taskId ?? r.intakeId) || (key == null && (r.taskId ?? r.intakeId) == null))))
      if (detail && inProgress) continue
      const item = { id, part, turn, startSeq: events[start].seq, endSeq: event.seq, time: events[start].time, title: textOf(opener?.data.content).slice(0, 160),
        ...(inProgress && { active: true }),
        ...(range ? { from: range.from, to: end, scopes } : {}) }
      if (detail) return { ...item, items: rt.displayItems(part, group, undefined, turn) }
      list.push(item)
    }
  }
  if (detail) throw new Error('Unknown or unfinished group discussion')
  return list
}

export async function setDiscussionArchive(ctx, rt, room, body, signal) {
  if (!['archive', 'restore'].includes(body.action) || !Array.isArray(body.ids) || !body.ids.length) throw new Error('Choose at least one discussion')
  const rows = await groupDiscussions(ctx, rt, room, signal)
  const ids = new Set(body.ids)
  const chosen = rows.filter(row => !row.active && ids.has(row.id))
  if (chosen.length !== ids.size) throw new Error('The selected discussions changed. Reopen the list.')
  await rt.save({ required: true, mutate() {
    if (rt.roomOf(room.id) !== room) throw new Error('The group changed. Reopen the list.')
    const previous = room.archivedDiscussions
    const kept = new Map((previous ?? []).map(row => [row.id, row]))
    for (const { id, part, turn, startSeq, endSeq, from, to, scopes } of chosen) {
      if (body.action === 'archive') kept.set(id, { id, part, turn, startSeq, endSeq, from, to, scopes })
      else kept.delete(id)
    }
    if (kept.size) room.archivedDiscussions = [...kept.values()]
    else delete room.archivedDiscussions
    return () => { if (previous) room.archivedDiscussions = previous; else delete room.archivedDiscussions }
  } })
  return true
}

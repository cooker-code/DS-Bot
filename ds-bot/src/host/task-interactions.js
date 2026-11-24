// The detail reader only joins records explicitly scoped to this card or its intakes.
import { SOURCE_KIND } from './constants.js'
import { isIntakeReceipt, taskMessage } from '../shared/task-message.js'
import { scopeOf } from './task-routing.js'
import { textOf } from './text.js'

const recent = new WeakMap()

export async function taskInteractions(rt, room, card, signal, taskId = card.id) {
  const scopes = new Set([taskId, ...(card.intakes ?? [])].filter(id => typeof id === 'string' && id))
  const belongs = r => scopes.has(scopeOf(r)) && (!r.roomId || r.roomId === room.id)
  const ledger = rt.ledger.records('group-' + room.id).filter(belongs)
  const messages = ledger.filter(r => !r.kind && !r.event && !isIntakeReceipt(r) && r.text && (r.botId || r.who === 'User')).map(r =>
    ({ key: 'group-' + r.seq, at: r.time, from: r.botId, sender: r.who, kind: 'Group message', text: taskMessage(r.text, room).body }))
  const since = [...ledger.map(r => r.time), ...(card.plans ?? []).map(p => p.at),
    ...(card.rounds ?? []).map(r => r.assignedAt)].reduce((first, at) => Number.isFinite(at) ? Math.min(first, at) : first, Infinity)
  const sessions = new Map()
  for (const [bot, parts] of Object.entries(room.segments ?? {}))
    for (const part of parts) if (!Number.isFinite(since) || !part.endedAt || part.endedAt >= since) sessions.set(part.sessionId, bot)
  for (const [bot, id] of Object.entries(room.sessions ?? {})) sessions.set(id, bot)
  for (const round of card.rounds ?? []) if (round.executionSession) sessions.set(round.executionSession, round.ownerId)
  const participants = [...new Set([...room.members, ...sessions.values(), ...ledger.map(r => r.botId), ...(card.rounds ?? []).map(r => r.ownerId),
    ...(card.plans ?? []).map(p => p.by)].filter(Boolean))]
  const delivered = new Map()
  for (const [i, a] of participants.entries()) for (const b of participants.slice(i + 1)) {
    for (const record of rt.taskPairMessages(a, b).filter(belongs)) {
      let body = { text: record.text, whole: true }
      if (record.length > (record.text?.length ?? 0)) body = await rt.exchangeText({ ...record, ledger: true })
      delivered.set(record.id, { key: 'exchange-' + record.id, exchangeId: record.id, at: record.time, from: record.from, to: record.to,
        kind: record.role === 'reply' ? 'Bot reply' : 'Bot message', text: body.text, partial: !body.whole })
    }
  }
  // Keep one open card's cursor per session. Refresh only reads events since the last visit.
  const identity = JSON.stringify([room.id, ...scopes])
  let cache = recent.get(rt)
  if (cache?.identity !== identity) recent.set(rt, cache = { identity, parts: new Map() })
  let incomplete = false
  const seenDelivery = new Set()
  for (const [session, to] of sessions) {
    const old = cache.parts.get(session)
    let seq = old?.seq ?? -1
    const found = []
    try {
      for await (const event of rt.eventsBackwards(session, signal, Infinity)) {
        if (event.seq <= (old?.seq ?? -1) || (Number.isFinite(since) && event.time < since)) break
        seq = Math.max(seq, event.seq)
        const source = event.data?.source
        if (event.type !== 'user/message' || source?.kind !== SOURCE_KIND || !belongs(source)) continue
        const content = event.data.content
        const body = textOf(content)
        const from = source.projectActorId ?? source.senderSessionId ?? source.askedBy
        found.push({ key: session + '/' + event.seq, exchangeId: source.exchangeId, at: event.time, from, to,
          kind: from ? (source.role === 'reply' ? 'Bot reply' : 'Bot message') : 'Host delivery',
          repeated: Boolean(source.retried || source.resumed || source.deferred),
          text: [body.slice(body.indexOf('\n') + 1), ...(content ?? []).map(p => p.attachment?.name).filter(Boolean)].filter(Boolean).join('\n') })
      }
      if (seq >= (cache.parts.get(session)?.seq ?? -1)) cache.parts.set(session, { seq, rows: [...(old?.rows ?? []), ...found.reverse()] })
    } catch (error) {
      if (signal?.aborted) throw error
      messages.push(...found.filter(row => row.repeated || !delivered.has(row.exchangeId)))
      incomplete = true
    }
    for (const row of cache.parts.get(session)?.rows ?? []) {
      if (!row.repeated && delivered.has(row.exchangeId) && !seenDelivery.has(row.exchangeId)) {
        seenDelivery.add(row.exchangeId)
        continue
      }
      messages.push(row)
    }
  }
  return { messages: [...messages, ...delivered.values()].sort((a, b) => a.at - b.at), incomplete }
}

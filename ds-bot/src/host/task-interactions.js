// The detail reader only joins records explicitly scoped to this card or its intakes.
import { SOURCE_KIND } from './constants.js'
import { taskMessage } from '../shared/task-message.js'
import { scopeOf } from './task-routing.js'
import { lineText, mentionsIn } from './groups.js'
import { textOf } from './text.js'

const recent = new WeakMap()

// Read archived parts through the history API without creating or waking their agents.
async function* sessionEvents(ctx, sessionId, signal) {
  let beforeSeq
  for (;;) {
    const page = await ctx.sessionController.page({ address: { kind: 'session', sessionId }, beforeSeq, maxMessages: 150 }, signal)
    for (let i = page.records.length - 1; i >= 0; i--) yield page.records[i].event
    if (!page.hasMore) return
    const next = page.records[0]?.event.seq
    if (!Number.isInteger(next) || (beforeSeq !== undefined && next >= beforeSeq)) throw new Error('Session history cursor did not advance')
    beforeSeq = next
  }
}

export async function taskInteractions(rt, room, card, signal, taskId = card.id) {
  const scopes = new Set([taskId, ...(card.intakes ?? [])].filter(id => typeof id === 'string' && id))
  const belongs = r => scopes.has(scopeOf(r)) && (!r.roomId || r.roomId === room.id)
  const ledger = rt.ledger.records('group-' + room.id).filter(belongs)
  const posts = new Map(ledger.filter(r => r.botId && !r.kind && !r.event && r.text).map(r => [r.seq, r]))
  const roster = room.members.map(id => rt.botOf?.(id)).filter(Boolean)
  const since = [...ledger.map(r => r.time), ...(card.plans ?? []).map(p => p.at),
    ...(card.rounds ?? []).map(r => r.assignedAt)].reduce((first, at) => Number.isFinite(at) ? Math.min(first, at) : first, Infinity)
  const sessions = new Map()
  for (const [bot, parts] of Object.entries(room.segments ?? {}))
    for (const part of parts) if (!Number.isFinite(since) || !part.endedAt || part.endedAt >= since) sessions.set(part.sessionId, bot)
  for (const [bot, id] of Object.entries(room.sessions ?? {})) sessions.set(id, bot)
  for (const round of card.rounds ?? []) if (round.executionSession) sessions.set(round.executionSession, round.ownerId)
  const participants = [...new Set([...room.members, ...sessions.values(), ...ledger.map(r => r.botId), ...(card.rounds ?? []).map(r => r.ownerId),
    ...(card.plans ?? []).map(p => p.by)].filter(Boolean))]
  const dispatchIds = new Set((card.rounds ?? []).map(r => r.dispatchId).filter(Boolean))
  const delivered = new Map()
  for (const [i, a] of participants.entries()) for (const b of participants.slice(i + 1)) {
    for (const record of rt.taskPairMessages(a, b).filter(belongs)) {
      let body = { text: record.text, whole: true }
      if (record.length > (record.text?.length ?? 0)) body = await rt.exchangeText({ ...record, ledger: true })
      let text = taskMessage(record.handoffText ?? body.text, room).body
      if (record.handoffText === undefined && dispatchIds.has(record.id) && card.title) {
        const boundary = text.indexOf('\n\n' + card.title + '\n\n')
        if (boundary >= 0 && text.includes('\n\nCheck the assignment and, for code changes,')) text = text.slice(0, boundary)
      }
      delivered.set(record.id, { key: 'exchange-' + record.id, exchangeId: record.id, at: record.time, from: record.from, to: record.to,
        replyTo: record.parentExchangeId ?? record.replyTo,
        kind: record.role === 'reply' ? 'Bot reply' : 'Bot message', text, partial: record.handoffText === undefined && !body.whole })
    }
  }
  // Keep one open card's cursor per session. Refresh only reads events since the last visit.
  const identity = JSON.stringify([room.id, ...scopes])
  let cache = recent.get(rt)
  if (cache?.identity !== identity) recent.set(rt, cache = { identity, parts: new Map() })
  let incomplete = false
  const messages = new Map()
  function add(row) {
    if (!messages.has(row.key)) messages.set(row.key, { ...row })
  }
  for (const [session, to] of sessions) {
    const old = cache.parts.get(session)
    let seq = old?.seq ?? -1
    const found = []
    try {
      for await (const event of sessionEvents(rt.ctx, session, signal)) {
        if (event.seq <= (old?.seq ?? -1) || (Number.isFinite(since) && event.time < since)) break
        seq = Math.max(seq, event.seq)
        const source = event.data?.source
        if (event.type !== 'user/message' || source?.kind !== SOURCE_KIND || !belongs(source)) continue
        if (source.retried || source.resumed) {
          found.push({ key: session + '/' + event.seq, retryOf: source.retryOf ?? source.exchangeId, to, at: event.time,
            restart: Boolean(source.resumed), input: textOf(event.data.content).split('\n').slice(1).join('\n') })
          continue
        }
        if (source.deferred) continue
        const body = textOf(event.data.content)
        if (source.role === 'room') {
          const recipient = roster.find(bot => bot.id === to)
          // Older deliveries have no sequence references. Require the named caller,
          // an addressed post and its exact transcript line in this round.
          const current = body.match(/This round so far[^\n]*:\n([\s\S]*)/)?.[1] ?? ''
          const refs = source.groupHandoffSeqs ?? [...posts.values()].filter(post =>
            post.botId === source.askedBy && recipient && post.time <= event.time &&
            mentionsIn(post.text, roster, post.references).found.some(bot => bot.id === to) &&
            ('\n' + current + '\n').includes('\n' + lineText(post) + '\n')).map(post => post.seq)
          for (const seq of refs) {
            const post = posts.get(seq)
            if (!post || post.botId === to) continue
            found.push({ key: 'post-' + seq + '-' + to, exchangeId: source.exchangeId, at: event.time,
              from: post.botId, to, kind: 'Bot message', text: taskMessage(post.text, room).body })
          }
        } else if (source.projectActorId && source.projectActorId !== to) {
          const delegated = body.includes('The group admin delegated this requirement to you as its task assistant.') &&
            body.match(/\n\nRequirement: ([\s\S]+?)\n\nAcceptance: ([\s\S]+?)\n\nEligible node owners: /)
          const text = source.handoffText ?? (delegated ? delegated.slice(1).join('\n\n') :
            body.match(/\nIssue or decision: ([\s\S]+)$/)?.[1])
          if (!text) continue
          found.push({ key: 'exchange-' + source.exchangeId, exchangeId: source.exchangeId, at: event.time,
            from: source.projectActorId, to, kind: 'Bot message', text })
        }
      }
      if (seq >= (cache.parts.get(session)?.seq ?? -1)) cache.parts.set(session, { seq, rows: [...(old?.rows ?? []), ...found.reverse()] })
    } catch (error) {
      if (signal?.aborted) throw error
      found.forEach(add)
      incomplete = true
    }
    for (const row of cache.parts.get(session)?.rows ?? []) add(row)
  }
  for (const row of delivered.values()) add(row)
  const rows = [...messages.values()].filter(row => !row.retryOf && row.from && row.to && row.from !== row.to)
  for (const retry of messages.values()) {
    if (!retry.retryOf) continue
    for (const edge of rows.filter(row => row.exchangeId === retry.retryOf && row.to === retry.to))
      (edge.retries ??= []).push({ at: retry.at, input: retry.input, restart: retry.restart })
  }
  return { messages: rows.sort((a, b) => a.at - b.at), incomplete }
}

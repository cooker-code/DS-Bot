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

// Legacy links use the input handled by the sender's Session and its successful
// send or authored group message. Global time ordering is insufficient.
function linkHistory(rows, parts, belongs, room, roster) {
  for (const part of parts) {
    let input
    const calls = new Map()
    function linkPost(text, at, parent) {
      const matches = rows.filter(row => !row.replyTo && row.postSeq && row.from === part.bot &&
        row.sentAt >= at && row.text === taskMessage(text, room).body)
      const seq = Math.min(...matches.map(row => row.postSeq))
      for (const row of matches.filter(row => row.postSeq === seq)) row.replyTo = parent
    }
    for (const event of [...part.events].sort((a, b) => a.seq - b.seq)) {
      if (event.type === 'turn/start') input = undefined
      if (event.type === 'user/message' && (event.source.kind === SOURCE_KIND || !event.source.kind))
        input = belongs(event.source) ? event.source.exchangeId : undefined
      if (event.type === 'assistant/message' && input) linkPost(event.text, event.time, input)
      if (event.type === 'tool/call' && input) {
        let args
        try { args = JSON.parse(event.arguments) } catch { continue }
        if (!args || typeof args !== 'object') continue
        if (args.taskId && !belongs({ taskId: args.taskId })) continue
        calls.set(event.callId, { ...event, input, args })
      }
      const call = event.type === 'tool/result' && calls.get(event.callId)
      if (!call) continue
      calls.delete(event.callId)
      if (event.failed) continue
      if (call.name === 'post_to_group') linkPost(call.args.message, call.time, call.input)
      if (call.name !== 'message_bot') continue
      for (const row of rows) {
        if (row.replyTo || row.from !== part.bot || !Number.isFinite(row.sentAt) || row.sentAt < call.time || row.sentAt > event.time) continue
        if ((call.args.to === row.to || roster.some(bot => bot.id === row.to && bot.name === call.args.to)) &&
            taskMessage(call.args.message, room).body === row.text) row.replyTo = call.input
      }
    }
  }
}

export async function taskInteractions(rt, room, card, signal, taskId = card.id) {
  const scopes = new Set([taskId, ...(card.intakes ?? [])].filter(id => typeof id === 'string' && id))
  const belongs = r => scopes.has(scopeOf(r)) && (!r.roomId || r.roomId === room.id)
  const ledger = rt.ledger.records('group-' + room.id).filter(belongs)
  const posts = new Map(ledger.filter(r => r.botId && !r.kind && !r.event && r.text).map(r => [r.seq, r]))
  const roster = room.members.map(id => rt.botOf?.(id)).filter(Boolean)
  let since = [...ledger.map(r => r.time), ...(card.plans ?? []).map(p => p.at),
    ...(card.rounds ?? []).map(r => r.assignedAt)].reduce((first, at) => Number.isFinite(at) ? Math.min(first, at) : first, Infinity)
  const sessions = new Map()
  for (const [bot, parts] of Object.entries(room.segments ?? {}))
    for (const part of parts) sessions.set(part.sessionId, bot)
  for (const [bot, id] of Object.entries(room.sessions ?? {})) sessions.set(id, bot)
  for (const round of card.rounds ?? []) if (round.executionSession) sessions.set(round.executionSession, round.ownerId)
  const participants = [...new Set([...room.members, ...sessions.values(), ...ledger.map(r => r.botId), ...(card.rounds ?? []).map(r => r.ownerId),
    ...(card.plans ?? []).map(p => p.by)].filter(Boolean))]
  const dispatchIds = new Set((card.rounds ?? []).map(r => r.dispatchId).filter(Boolean))
  const delivered = new Map()
  for (const [i, a] of participants.entries()) for (const b of participants.slice(i + 1)) {
    for (const record of rt.taskPairMessages(a, b).filter(belongs)) {
      if (Number.isFinite(record.time)) since = Math.min(since, record.time)
      let body = { text: record.text, whole: true }
      if (record.length > (record.text?.length ?? 0)) body = await rt.exchangeText({ ...record, ledger: true })
      let text = taskMessage(record.handoffText ?? body.text, room).body
      if (record.handoffText === undefined && dispatchIds.has(record.id) && card.title) {
        const boundary = text.indexOf('\n\n' + card.title + '\n\n')
        if (boundary >= 0 && text.includes('\n\nCheck the assignment and, for code changes,')) text = text.slice(0, boundary)
      }
      delivered.set(record.id, { key: 'exchange-' + record.id, exchangeId: record.id, at: record.time, sentAt: record.time, from: record.from, to: record.to,
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
    const events = []
    try {
      for await (const event of sessionEvents(rt.ctx, session, signal)) {
        if (event.seq <= (old?.seq ?? -1) || (Number.isFinite(since) && event.time < since)) break
        seq = Math.max(seq, event.seq)
        const source = event.data?.source
        if (event.type === 'assistant/message') {
          const text = textOf(event.data?.message?.content)
          if (text) events.push({ seq: event.seq, type: event.type, time: event.time, text })
        }
        if (event.type === 'turn/start') events.push({ seq: event.seq, type: event.type })
        if (event.type === 'user/message') events.push({ seq: event.seq, type: event.type, source: source ?? {} })
        if (event.type === 'tool/call' && ['message_bot', 'post_to_group'].includes(event.data?.name))
          events.push({ seq: event.seq, type: event.type, time: event.time, ...event.data })
        if (event.type === 'tool/result') events.push({ seq: event.seq, type: event.type, time: event.time,
          callId: event.data.message?.toolCallId, failed: event.data.message?.isError === true })
        if (event.type !== 'user/message' || source?.kind !== SOURCE_KIND || !belongs(source)) continue
        if (source.retried || source.resumed) {
          found.push({ key: session + '/' + event.seq, retryOf: source.retryOf ?? source.exchangeId, to, at: event.time,
            restart: Boolean(source.resumed), input: textOf(event.data.content).split('\n').slice(1).join('\n') })
          continue
        }
        if (source.deferred) continue
        const body = textOf(event.data.content)
        if (source.intakeSeq !== undefined && to === room.admin && !source.senderSessionId && !source.projectActorId) {
          const post = ledger.find(post => post.seq === source.intakeSeq && !post.botId && post.who === 'User' && !post.kind)
          if (post) found.push({ key: 'intake-' + post.seq, exchangeId: source.exchangeId, at: event.time,
            sentAt: post.time, sender: 'user', to, postSeq: post.seq, kind: 'User request', text: taskMessage(post.text, room).body })
        }
        if (source.role === 'room') {
          const recipient = roster.find(bot => bot.id === to)
          // Older deliveries have no sequence references. Require the named caller,
          // an addressed post and its exact transcript line in this round.
          const current = body.match(/This round so far[^\n]*:\n([\s\S]*)/)?.[1] ?? ''
          const returnedBy = roster.filter(bot => body.split('\n', 1)[0].endsWith(' · ' + bot.name + ' finished the work you asked for]'))
          const returned = returnedBy.length === 1 ? [...posts.values()].filter(post =>
            post.botId === returnedBy[0].id && post.botId !== to && post.time <= event.time &&
            ('\n' + current + '\n').includes('\n' + lineText(post) + '\n')).at(-1) : undefined
          const refs = source.groupHandoffSeqs ?? [...new Set([...posts.values()].filter(post =>
            post.botId === source.askedBy && recipient && post.time <= event.time &&
            mentionsIn(post.text, roster, post.references).found.some(bot => bot.id === to) &&
            ('\n' + current + '\n').includes('\n' + lineText(post) + '\n')).map(post => post.seq).concat(returned ? [returned.seq] : []))]
          for (const seq of refs) {
            const post = posts.get(seq)
            if (!post || post.botId === to) continue
            found.push({ key: 'post-' + seq + '-' + to, exchangeId: source.exchangeId, at: event.time,
              from: post.botId, to, postSeq: post.seq, sentAt: post.time, kind: post.seq === returned?.seq ? 'Result return' : 'Bot message', text: taskMessage(post.text, room).body })
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
      if (seq >= (cache.parts.get(session)?.seq ?? -1)) cache.parts.set(session, { seq, bot: to, events: [...(old?.events ?? []), ...events.reverse()], rows: [...(old?.rows ?? []), ...found.reverse()] })
    } catch (error) {
      if (signal?.aborted) throw error
      found.forEach(add)
      incomplete = true
    }
    for (const row of cache.parts.get(session)?.rows ?? []) add(row)
  }
  for (const row of delivered.values()) add(row)
  const rows = [...messages.values()].filter(row => !row.retryOf && (row.from || row.sender === 'user') && row.to && row.from !== row.to)
  for (const retry of messages.values()) {
    if (!retry.retryOf) continue
    for (const edge of rows.filter(row => row.exchangeId === retry.retryOf && row.to === retry.to))
      (edge.retries ??= []).push({ at: retry.at, input: retry.input, restart: retry.restart })
  }
  linkHistory(rows, cache.parts.values(), belongs, room, roster)
  for (const row of rows) {
    const index = (card.rounds ?? []).findIndex(round => round.dispatchId === row.exchangeId && round.ownerId === row.to)
    if (index < 0) continue
    const round = card.rounds[index]
    const plan = card.plans?.find(plan => plan.version === round.planNode?.version)
    Object.assign(row, { kind: 'Dispatch', round: index + 1, planVersion: round.planNode?.version,
      node: round.planNode?.node, planReason: plan?.reason,
      requirementVersion: round.requirementVersion ?? (!card.requirementHistory?.length && !card.fieldEditTimes?.requirement ? 1 : undefined) })
  }
  return { messages: rows.sort((a, b) => a.at - b.at), incomplete }
}

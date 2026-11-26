// Persistent lifecycle for explicit work. Sessions use the local thread model;
// taskId always means a project card, never an upstream background-task key.
import { isAckLikeText, isWorkTool, isSilentTurnText, HISTORY_TIMEOUT_MS, WORK_REWORK_CHECKPOINT, PAIR_LOOP_TTL_MS } from './constants.js'
import { scopeFields } from './task-routing.js'
import { threadCurrentOfPart } from './threads.js'

export function installLifecycle(rt, { records, receipt, serial, destination, send }) {
  const { ctx, state } = rt
  const notes = () => (state.silentNotes ??= {})
  const outbox = () => (state.workOutbox ??= {})
  const flushing = new Set()
  const workForSource = source => records()[rt.workOf(source)]
  const pairKey = (a, b) => [a, b].sort().join(':')
  const pair = (a, b) => (state.pairLoops ??= {})[pairKey(a, b)]
  const save = () => rt.save({ required: true })
  const resolve = ref => {
    const key = String(ref ?? '').replace(/^#/, '').trim()
    return records()[key]?.protocol ? key : Object.keys(records()).find(id => records()[id]?.protocol && records()[id]?.ref === key.toUpperCase())
  }
  const decorate = work => {
    state.workSeq = (state.workSeq ?? 0) + 1
    return Object.assign(work, { ref: `W${state.workSeq}`, state: 'open', rounds: 0, worked: false })
  }
  async function executionSession(bot, original, room) {
    const agent = await rt.resolveAgent(original)
    const busy = agent.status === 'running' || rt.live.get(original)?.turn !== undefined ||
      Object.values(records()).some(work => work.protocol && work.to === bot.id && work.toSession === original)
    if (!busy) return original
    const { freshId: sid } = await rt.makeWorkPart(bot, agent, room)
    try {
      await rt.save({ required: true, mutate() {
        const before = bot.openParts
        bot.openParts = [...(before ?? []), { sessionId: sid, startedAt: Date.now(), segments: [] }]
        return () => { bot.openParts = before }
      } })
      rt.indexSessions()
      await rt.ensureCapabilities(sid)
      return sid
    } catch (error) {
      await ctx.workspaceRegistry.archiveSession(sid, { stopActivity: true })
      throw error
    }
  }
  async function flushNotes(sid) {
    if (flushing.has(sid) || !notes()[sid]?.length || rt.readOnly() !== undefined) return
    flushing.add(sid)
    try {
      const bot = rt.botOf(rt.selfOf(sid))
      const target = bot ? threadCurrentOfPart(bot, sid) ?? sid : sid
      const agent = await rt.resolveAgent(target)
      if (agent.status === 'running' || rt.live.get(target)?.turn !== undefined) return
      const list = notes()[sid]
      for (const item of list) {
        // Inbox entries and the session log both keep source.silent through rollover.
        const seen = [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])].some(message => message.source?.exchangeId === item.message.source.exchangeId)
        let stored = seen
        if (!stored) for await (const event of rt.eventsBackwards(target, AbortSignal.timeout(HISTORY_TIMEOUT_MS))) {
          if (event.type === 'user/message' && event.data?.source?.exchangeId === item.message.source.exchangeId) { stored = true; break }
        }
        if (!stored) agent.inject(item.message)
      }
      await ctx.sessions.flush(agent.session)
      delete notes()[sid]
      await save()
    } finally { flushing.delete(sid) }
  }
  async function bufferNote(sid, message, book) {
    const list = notes()[sid] ??= []
    if (!list.some(item => item.message.source.exchangeId === message.source.exchangeId)) list.push({ message })
    await save()
    if (book) { rt.ledger.append(book, { event: 'delivered', id: message.source.exchangeId }); await rt.ledger.written(book) }
    await flushNotes(sid)
    return message.source.exchangeId
  }
  async function drainOutbox() {
    for (const [id, item] of Object.entries(outbox())) {
      if (flushing.has(id)) continue
      flushing.add(id)
      try {
        const work = item.work
        // deliver deduplicates by exchangeId against the actual inbox and log.
        await send(work, 'from', item.text, { protocolDeliveryId: id, protocolReturn: item.id, role: 'reply', replyTo: item.id, exchangeId: id, silent: !work.parent && (isSilentTurnText(item.text) || isAckLikeText(item.text)),
          ...(work.parent ? { work: work.parent } : {}), ...(item.long ? { files: item.long.files, length: item.long.length } : {}) })
        delete outbox()[id]
        await save()
      } catch (error) { rt.warn('ds-bot: delegated result remains queued: %s', error) }
      finally { flushing.delete(id) }
    }
  }
  async function complete(id, text, long) {
    return serial(id, async () => {
      const work = records()[id]
      if (!work?.protocol || receipt(id) || work.question || work.pendingAnswer || work.state === 'paused') return
      const resultId = `result-${id}`
      // Save the return address and the whole reply in the same SQLite transaction as
      // the terminal receipt. A host restart cannot strand an already closed work.
      outbox()[resultId] = { id, work: structuredClone(work), text, ...(long ? { long } : {}) }
      rt.closeWork(id, rt.botOf(work.to)?.name ?? 'Teammate', text)
      const loop = pair(work.from, work.to) ?? { bounces: 0 }
      loop.bounces = work.worked ? 0 : loop.bounces + 1
      loop.ack = !work.worked && isAckLikeText(text)
      loop.at = Date.now()
      ;(state.pairLoops ??= {})[pairKey(work.from, work.to)] = loop
      await save()
      await drainOutbox()
    })
  }
  async function pause(id, kind, message) {
    const work = records()[id]
    work.state = 'paused'
    work.paused = { kind, reason: message, at: Date.now() }
    await save()
  }
  async function resume(id) {
    id = resolve(id)
    return serial(id, async () => {
      const work = records()[id]
      if (!work || work.state !== 'paused') throw new Error('This work is no longer paused.')
      delete (state.pairLoops ?? {})[pairKey(work.from, work.to)]
      const action = work.paused.kind
      if (action === 'question') {
        work.state = 'need_input'
        work.rounds = 0
        delete work.paused
        await save()
        await send(work, 'from', `Work ${work.ref} needs an answer:\n${work.question}\nUse answer_work or cancel_work.`, { audience: 'user', workQuestion: id, ...(work.parent ? { work: work.parent } : {}) })
      } else {
        work.state = 'open'
        delete work.paused
        await save()
        await send(work, 'to', work.goal, { exchangeId: id, resumed: true })
      }
      return true
    })
  }
  const current = (work, side) => { try { return destination(work, side) } catch { return side === 'from' ? work.callerSession : work.toSession } }
  const view = () => Object.entries(records()).filter(([, work]) => work.protocol).map(([id, work]) => ({
    id, ref: work.ref, from: work.from, to: work.to, fromName: rt.botOf(work.from)?.name, toName: rt.botOf(work.to)?.name,
    sessionId: current(work, 'from'), toSession: current(work, 'to'), roomId: work.fromRoom, ...scopeFields(work.taskId), dispatchId: work.dispatchId,
    parent: work.parent, taskTitle: rt.roomOf(work.fromRoom)?.projectCards?.[work.taskId]?.title,
    round: rt.roomOf(work.fromRoom)?.projectCards?.[work.taskId]?.rounds.find(round => round.dispatchId === work.dispatchId)?.round,
    status: work.state ?? (work.question ? 'need_input' : 'open'), goal: work.goal, question: work.question,
    reason: work.paused?.reason, at: work.at,
  }))
  Object.assign(rt, {
    protocolRoomOf(sid) {
      const bot = rt.botOf(rt.selfOf(sid))
      const work = Object.values(records()).find(work => work.protocol && work.fromRoom && work.to === bot?.id && threadCurrentOfPart(bot, work.toSession) === sid)
      return rt.roomOf(work?.fromRoom)
    },
    advanceProtocolPart(oldSid, freshSid) {
      for (const [id, work] of Object.entries(records())) {
        if (!work.protocol || !work.dispatchId || current(work, 'to') !== freshSid) continue
        const round = rt.roomOf(work.fromRoom)?.projectCards?.[work.taskId]?.rounds.find(round => round.dispatchId === work.dispatchId)
        if (round && (round.executionSession === oldSid || round.planNode?.session === oldSid) && id === work.dispatchId) {
          round.executionSession = freshSid
          if (round.planNode?.session === oldSid) round.planNode.session = freshSid
        }
      }
    },
    protocolResolve: resolve, decorateProtocolWork: decorate, protocolExecutionSession: executionSession,
    registerProtocolDispatch: async (id, input) => {
      if (records()[id]?.protocol) return
      records()[id] = decorate({ protocol: true, ...(rt.captureWorkImOrigin?.(input.callerSession) ? { imOrigin: rt.captureWorkImOrigin(input.callerSession) } : {}), ...input, fromPart: input.callerSession, open: [], results: [], at: Date.now() })
      await save()
    },
    protocolPairPause: (from, to) => {
      const existing = Object.values(records()).some(work => work.protocol && work.state === 'paused' && pairKey(work.from, work.to) === pairKey(from, to))
      if (existing) throw new Error('This pair already has paused work. Continue or cancel it before delegating again.')
      const loop = pair(from, to)
      return loop && Date.now() - loop.at < PAIR_LOOP_TTL_MS && (loop.ack || loop.bounces >= WORK_REWORK_CHECKPOINT)
    },
    protocolTurnEnd(sid, source, text, failure, reason) {
      const work = workForSource(source)
      if (!work?.protocol) return !source?.silent
      if (receipt(rt.workOf(source)) || work.state === 'paused' || work.question || work.pendingAnswer) return false
      if (!failure && reason?.kind !== 'aborted' && isSilentTurnText(text)) {
        // A terminal PASS closes the work but its return is silent, so it cannot
        // wake the caller into acknowledging the acknowledgement.
        void complete(rt.workOf(source), text).catch(error => rt.warn('ds-bot: silent work completion failed: %s', error))
        return false
      }
      return true
    },
    noteProtocolActivity(sid, name) { const work = workForSource(rt.live.get(sid)?.info); if (work?.protocol && isWorkTool(name)) work.worked = true },
    completeProtocolWork: complete, bufferProtocolNote: bufferNote, flushProtocolNotes: flushNotes,
    resumePausedWork: resume, protocolWorksView: view,
    protocolSkipReplay(args) {
      if (args.silent) return true
      if (!args.controlNotice && [args.exchangeId, args.work, args.replyTo, args.workQuestion].some(id => receipt(id)?.status === 'cancelled')) return true
      const id = args.work ?? args.exchangeId
      const work = records()[id]
      if (work?.pendingAnswer && !args.workAnswer && !args.workQuestion) return true
      return Boolean(receipt(id) && args.role !== 'reply') || Boolean(work?.protocol && (work.state === 'paused' || work.question) && !args.workQuestion)
    },
    async resumeProtocolTurn(sid, source, text) {
      const id = rt.workOf(source), work = records()[id]
      if (!work?.protocol || work.question || work.pendingAnswer || work.state === 'paused' || receipt(id)) return
      await send(work, 'to', text, { exchangeId: id, resumed: true })
    },
    async resumeProtocolControl(sid, source, text) {
      if (source.workQuestion) {
        const work = records()[source.workQuestion]
        if (!work?.question || work.state !== 'need_input') return
        await send(work, 'from', `${text}\n\nQuestion: ${work.question}`, { audience: 'user', workQuestion: source.workQuestion, ...(work.parent ? { work: work.parent } : {}), resumed: true })
        return
      }
      if (source.protocolReturn && receipt(source.protocolReturn)?.status !== 'cancelled') {
        await rt.deliver({ sessionId: sid, toId: rt.selfOf(sid), fromId: source.senderSessionId, fromPart: source.senderPart,
          ...scopeFields(source.taskId), parentExchangeId: source.parentExchangeId, role: 'reply', work: source.work,
          protocolReturn: source.protocolReturn, replyTo: source.replyTo ?? source.protocolReturn, resumed: true, text })
      }
    },
    pauseProtocolWork: pause,
  })
  ctx.on('session/event', (session, event) => {
    const sid = session.id
    const source = rt.live.get(sid)?.info
    const work = workForSource(source)
    if ((event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') && work?.protocol) {
      const name = event.data?.name
      if (isWorkTool(name)) work.worked = true
    }
    if (event.type === 'user/message' && event.data?.source?.workAnswer) {
      const answered = records()[event.data.source.exchangeId]
      if (answered?.protocol && answered.to === rt.selfOf(sid)) { delete answered.pendingAnswer; void save().catch(error => rt.warn('ds-bot: recording work answer pickup failed: %s', error)) }
    }
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      const bot = rt.selfOf(sid)
      for (const key of Object.keys(state.pairLoops ?? {})) if (key.split(':').includes(bot)) delete state.pairLoops[key]
    }
    if (event.type === 'turn/end') setImmediate(() => void flushNotes(sid).catch(error => rt.warn('ds-bot: flushing notes failed: %s', error)))
  })
  ctx.on('agent/status', (agent, status) => {
    if (status !== 'idle') return
    for (const sid of Object.keys(notes())) {
      const bot = rt.botOf(rt.selfOf(sid))
      if (sid === agent.id || threadCurrentOfPart(bot, sid) === agent.id) void flushNotes(sid).catch(error => rt.warn('ds-bot: flushing notes failed: %s', error))
    }
  })
  ctx.effect(() => {
    const timer = setTimeout(() => void rt.load().then(async () => {
      for (const sid of Object.keys(notes())) await flushNotes(sid)
      const pending = Object.entries(state.protocolSends ?? {})
      for (const [id, args] of pending) {
        if (!args.silent && rt.protocolSkipReplay(args)) { delete state.protocolSends[id]; continue }
        await rt.deliver(args)
        delete state.protocolSends[id]
      }
      if (pending.length) await save()
      await drainOutbox()
    }).catch(error => rt.warn('ds-bot: restoring work lifecycle failed: %s', error)), 0)
    return () => clearTimeout(timer)
  }, 'ds-bot: restore work lifecycle')
}

// Explicit collaboration tools over the local handoff tree. Project cards keep
// their own dispatch, submission and approval state.
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { WORK_ASK_BACK_LIMIT } from './constants.js'
import { absoluteLinks } from './links.js'
import { installLifecycle } from './work-lifecycle.js'
import { scopeFields, scopeOf } from './task-routing.js'
import { threadCurrentOfPart, threadOfPart } from './threads.js'

const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
const text = value => String(value ?? '').trim()
const invalid = message => { throw new Error(message) }

export function install(rt) {
  const { state } = rt
  const queues = new Map()
  const records = () => (state.works ??= {})
  const caller = exec => rt.botOf(rt.selfOf(exec.agent?.id))
  const liveInfo = exec => rt.live.get(exec.agent?.id)?.info
  const receiptKey = id => `closed:${id}`
  const receipt = id => records()[receiptKey(id)]?.protocolReceipt
  const serial = (id, fn) => {
    const job = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(fn)
    queues.set(id, job)
    return job.finally(() => { if (queues.get(id) === job) queues.delete(id) })
  }
  function closed(id, work, status = 'completed') {
    if (!work?.protocol || receipt(id)) return
    records()[receiptKey(id)] = { open: [], results: [], protocolReceipt: {
      id, ref: work.ref, ...(work.imOrigin ? { imOrigin: work.imOrigin } : {}), status, from: work.from, to: work.to, callerSession: work.callerSession,
      ...(work.taskId ? { taskId: work.taskId } : {}), ...(work.dispatchId ? { dispatchId: work.dispatchId } : {}), at: Date.now(),
    } }
    const done = Object.entries(records()).filter(([, entry]) => entry.protocolReceipt)
      .sort((a, b) => a[1].protocolReceipt.at - b[1].protocolReceipt.at)
    for (const [key] of done.slice(0, Math.max(0, done.length - 100))) delete records()[key]
  }
  const workFor = (exec, id, side) => {
    const self = caller(exec)
    const work = records()[id]
    const managerCancel = side === 'from' && exec.allowWorkCancel && rt.isMain(self?.id)
    if (!self || !work?.protocol || (work[side] !== self.id && !managerCancel)) invalid('No open delegated work belongs to this caller.')
    if (!exec.userWorkControl && work.taskId && scopeOf(liveInfo(exec)) !== work.taskId) invalid('This delegated work belongs to another project card.')
    const info = liveInfo(exec)
    if (!exec.userWorkControl && side === 'to' && rt.workOf(info) !== id) invalid('Continue the currently delegated work only.')
    if (!exec.userWorkControl && side === 'from' && work.dispatchId && info?.exchangeId !== work.dispatchId && info?.parentExchangeId !== work.dispatchId) invalid('This delegated work belongs to another dispatch round.')
    const original = side === 'from' ? work.callerSession : work.toSession
    const owner = rt.groupOwners.get(original) ?? rt.pastOwners.get(original)
    const expected = threadCurrentOfPart(self, original) ?? rt.roomOf(owner?.roomId)?.sessions?.[self.id] ?? original
    if (!managerCancel && expected !== exec.agent?.id) invalid('Continue this work in its original conversation.')
    return work
  }
  const destination = (work, side) => {
    const bot = rt.botOf(work[side])
    const original = side === 'from' ? work.callerSession : work.toSession
    if (!bot || !original) invalid('The original work conversation is unavailable.')
    const thread = threadCurrentOfPart(bot, original)
    if (thread) return thread
    const member = rt.groupOwners.get(original) ?? rt.pastOwners.get(original)
    if (member?.roomId) {
      const room = rt.roomOf(member.roomId)
      if (!room?.members.includes(bot.id)) invalid('The original group membership ended.')
      return room.sessions?.[bot.id] ?? invalid('The original group conversation is unavailable.')
    }
    return threadCurrentOfPart(bot, original) ?? invalid('The original work conversation has ended.')
  }
  const scope = work => ({ ...scopeFields(work.taskId), ...(work.dispatchId ? { parentExchangeId: work.dispatchId } : {}) })
  const send = async (work, side, message, extra = {}) => {
    const deliveryId = extra.protocolDeliveryId ?? randomUUID()
    message = absoluteLinks(message, rt.sessionFolder?.((await rt.resolveAgent(destination(work, side))).session))
    const long = await rt.attachLong(message, 'Delegated work.txt')
    if (!long) invalid('The work message could not be attached; nothing was sent.')
    const args = {
    ...scope(work), fromId: work[side === 'to' ? 'from' : 'to'], toId: work[side],
    sessionId: destination(work, side), text: long.text, files: long.files, ...(long.length ? { length: long.length } : {}), role: 'request',
    ...(work.fromRoom ? { fromRoomId: work.fromRoom } : {}),
    exchangeId: extra.exchangeId ?? randomUUID(), protocolDeliveryId: deliveryId,
    fromPart: side === 'to' ? work.callerSession : work.toSession,
    ...(work.fromRoom ? { roomId: work.fromRoom } : {}), ...extra,
    }
    ;(state.protocolSends ??= {})[deliveryId] = args
    await rt.save({ required: true })
    try {
      const result = await rt.deliver(args)
      delete state.protocolSends[deliveryId]
      await rt.save({ required: true })
      return result
    } catch (error) {
      if (!error.deliveryUncertain) { delete state.protocolSends[deliveryId]; rt.forgetDelivery?.(args.exchangeId); await rt.save({ required: true }) }
      throw error
    }
  }
  const locate = (exec, args, side) => {
    const requested = text(args.work_id ?? args.target)
    const candidates = Object.keys(records()).filter(id => records()[id]?.protocol && records()[id][side] === caller(exec)?.id && (side !== 'from' || records()[id].question) && records()[id].callerSession === exec.agent?.id)
    const id = (requested ? rt.protocolResolve(requested) ?? requested : (side === 'from' ? liveInfo(exec)?.workQuestion : rt.workOf(liveInfo(exec))) ?? (candidates.length === 1 ? candidates[0] : undefined))
    if (!id) invalid('Name the delegated work_id.')
    return { id, work: workFor(exec, id, side) }
  }
  const add = (name, description, parameters, execute) => rt.teamTools.push(defineTool({ name, description, parameters, output,
    async execute(args, exec) {
      await rt.load()
      if (rt.readOnly() !== undefined) invalid('This window cannot save the Bot team.')
      return execute(args, exec)
    },
  }))
  installLifecycle(rt, { records, receipt, closed, serial, destination, send })

  const workId = { type: 'string', description: 'Exact work_id returned by delegate_work. Required when answering or cancelling.' }

  add('delegate_work', 'Delegate concrete work. Its reply returns automatically. Keep project_task submission and approval unchanged; do not delegate acknowledgements.', {
    to: { type: 'string', required: true, description: 'Exact teammate name' },
    goal: { type: 'string', required: true, description: 'Self-contained task or question' },
    when: { type: 'string', enum: ['now', 'queue'], description: 'now uses an independent conversation when the recipient is busy; queue waits in its conversation' },
    deliver_to: { type: 'string', enum: ['me', 'user'], description: 'Return to the caller, or also show the result in the recipient conversation' },
    request_id: { type: 'string', description: 'Stable identity for retries of this same request' },
    taskId: { type: 'string', description: 'Existing project card; inherited in its execution' },
    card_round: { type: 'integer', description: 'Existing formal project handoff. Preserves the local message_bot dispatch contract.' },
  }, async (args, exec) => {
    const self = caller(exec)
    const target = rt.findBot(args.to)
    if (!self || !target || self.id === target.id || !text(args.goal)) invalid('Choose another teammate and a concrete goal.')
    if (args.card_round !== undefined) return rt.teamTools.find(tool => tool.name === 'message_bot').execute({
      to: args.to, message: args.goal, taskId: args.taskId, card_round: args.card_round,
      request_id: args.request_id, reply_to: 'user', when: args.when ?? 'now',
    }, { ...exec, protocolDispatch: true })
    const info = liveInfo(exec)
    const key = scopeOf(info)
    if (args.taskId !== undefined && args.taskId !== key) invalid('Delegate inside the original project card execution.')
    const room = rt.roomOf(rt.groupOwners.get(exec.agent?.id)?.roomId ?? liveInfo(exec)?.roomId)
    if (room && !room.members.includes(target.id)) invalid('Work for a group stays with its members.')
    if (rt.upstreamOf([rt.workOf(info)].filter(Boolean)).has(target.id)) invalid('Use ask_back to ask the caller; do not delegate back up the waiting chain.')
    const name = text(args.request_id)
    if (name.length > 120) invalid('The request_id is too long.')
    const thread = threadOfPart(self, exec.agent.id)?.segments?.[0]?.sessionId ?? room?.segments?.[self.id]?.[0]?.sessionId ?? exec.agent.id
    const request = name ? rt.requestIdentity({ caller: self.id, context: `delegate:${thread}:${key ?? ''}`, name,
      payload: { to: target.id, goal: text(args.goal), taskId: key ?? null, when: args.when ?? 'now', deliver_to: args.deliver_to ?? 'me' } }) : undefined
    const run = async () => {
      const id = randomUUID()
      const original = room ? await rt.memberSession(room, target.id) : rt.chatOf(target.id)
      const toSession = args.when === 'queue' ? original : await rt.protocolExecutionSession(target, original, room)
      const parent = rt.workOf(info)
      if (receipt(parent)) invalid('The original work has already closed.')
      const above = records()[parent]
      const work = rt.decorateProtocolWork({ protocol: true, goal: text(args.goal), ...(rt.captureWorkImOrigin?.(exec.agent.id) ? { imOrigin: rt.captureWorkImOrigin(exec.agent.id) } : {}), ...(args.deliver_to === 'user' ? { audience: 'user' } : {}), from: self.id, to: target.id, callerSession: exec.agent.id,
        fromPart: exec.agent.id, toSession, open: [], results: [], at: Date.now(),
        ...(above ? { parent } : {}), ...(room ? { fromRoom: room.id } : {}),
        ...scopeFields(key), ...(key && info?.exchangeId ? { dispatchId: above?.dispatchId ?? info.parentExchangeId ?? info.exchangeId } : {}),
      })
      const pairPaused = rt.protocolPairPause(self.id, target.id)
      if (pairPaused) { work.state = 'paused'; work.paused = { kind: 'delegate', reason: 'Four consecutive tool-free Bot handoffs. Confirm to continue this automated chain, or cancel.', at: Date.now() } }
      await rt.save({ required: true, mutate() {
        records()[id] = work
        const previous = above?.open
        if (above) above.open = [...above.open, id]
        return () => { delete records()[id]; if (above) above.open = previous }
      } })
      if (pairPaused) return `Paused work ${work.ref}. work_id: ${id}. Waiting for the user to continue or cancel.`
      try {
        await send(work, 'to', `Delegated work ${id}:\n${text(args.goal)}\n\nIf blocked, use ask_back. Your final reply returns to the caller automatically.`, { exchangeId: id, ...(work.audience ? { audience: work.audience } : {}) })
      } catch (error) {
        if (error.deliveryUncertain) return `Delivery persistence is uncertain. work_id: ${id}. Do not delegate again; inspect this work or cancel it.`
        await rt.save({ required: true, mutate() {
          if (records()[id] !== work) return
          const previous = above?.open
          delete records()[id]
          if (above) above.open = above.open.filter(child => child !== id)
          return () => { records()[id] = work; if (above) above.open = previous }
        } })
        rt.forgetDelivery?.(id)
        if (request) request.unsent = true
        throw error
      }
      return `Delegated to ${target.name} (${work.ref}). work_id: ${id}. End your turn after handing on the work; its result returns automatically.`
    }
    if (!request) return run()
    const result = await rt.admitRequest(request, run)
    if (['sent', 'replay'].includes(result.status)) return result.receipt
    invalid(`This request was not sent again (${result.status}); inspect its earlier result before retrying.`)
  })

  add('ask_back', 'Ask the original caller a blocking question without closing the delegated work. End this turn and wait for answer_work.', {
    work_id: workId, question: { type: 'string', required: true, description: 'The decision or information needed to continue' },
  }, async (args, exec) => {
    const found = locate(exec, args, 'to')
    return serial(found.id, async () => {
      const work = workFor(exec, found.id, 'to')
      const question = text(args.question)
      if (!question) invalid('Write the blocking question.')
      if (work.question) {
        if (work.question === question) return `Already waiting for the caller on work ${found.id}.`
        invalid('This work already has an unanswered question.')
      }
      const previous = { state: work.state, rounds: work.rounds, question: work.question }
      work.rounds = (work.rounds ?? 0) + 1
      work.question = question
      work.state = 'need_input'
      if (work.rounds > WORK_ASK_BACK_LIMIT || (!work.worked && work.rounds >= 2)) {
        await rt.pauseProtocolWork(found.id, 'question', 'Repeated clarification without progress. Continue to ask the caller, or cancel.')
        exec.concludeTurn?.()
        return `Paused work ${work.ref}; the user must continue or cancel. The question remains saved.`
      }
      await rt.save({ required: true, mutate() { return () => Object.assign(work, previous) } })
      try {
        await send(work, 'from', `Question on work ${found.id}:\n${question}\n\nUse answer_work with this work_id to unblock it, or cancel_work.`, {
          audience: 'user', workQuestion: found.id, ...(work.parent ? { work: work.parent } : {}),
        })
      } catch (error) {
        if (error.deliveryUncertain) { exec.concludeTurn?.(); return `Question delivery persistence is uncertain for work ${found.id}; do not send it again. The work remains open.` }
        await rt.save({ required: true, mutate() {
          if (records()[found.id] !== work || work.question !== question) return
          Object.assign(work, previous)
          return () => { work.question = question; work.state = 'need_input' }
        } })
        throw error
      }
      exec.concludeTurn?.()
      return `Asked the caller. Work ${found.id} remains open; wait for its answer.`
    })
  })

  add('answer_work', 'Answer a blocking question on work you delegated. Resume only that work in its recorded conversation.', {
    work_id: workId, answer: { type: 'string', required: true, description: 'Answer to the worker question' },
  }, async (args, exec) => {
    const { id } = locate(exec, args, 'from')
    return serial(id, async () => {
    const work = workFor(exec, id, 'from')
    if (work.state === 'paused' || !work.question || !text(args.answer)) invalid('This work has no unanswered question, or the answer is empty.')
    const question = work.question
    await rt.save({ required: true, mutate() { delete work.question; work.state = 'open'; work.pendingAnswer = true; return () => { work.question = question; work.state = 'need_input'; delete work.pendingAnswer } } })
    try {
      await send(work, 'to', `Answer on work ${id}:\n${text(args.answer)}\n\nContinue the original delegated work.`, { exchangeId: id, workAnswer: true })
    } catch (error) {
      if (error.deliveryUncertain) return `Answer delivery persistence is uncertain for work ${id}; do not send it again. Inspect the original conversation.`
      await rt.save({ required: true, mutate() {
        if (records()[id] !== work || work.question !== undefined) return
        work.question = question
        work.state = 'need_input'
        delete work.pendingAnswer
        return () => { delete work.question; work.state = 'open' }
      } })
      throw error
    }
    return `Answered work ${id}; its original conversation continues.`
    })
  })

  add('cancel_work', 'Cancel only work you delegated. Stop its own active turn, keep a closed receipt, and leave project cards and other conversations unchanged.', {
    target: { type: 'string', description: 'Exact work ID or short reference, e.g. W3' }, work_id: workId, reason: { type: 'string', description: 'Why this work is no longer needed' },
  }, async (args, exec) => {
    const requested = text(args.target ?? args.work_id)
    const named = rt.findBot(requested)
    if (named && !rt.protocolResolve(requested)) {
      const mine = Object.entries(records()).filter(([, work]) => work.protocol && work.to === named.id && (work.from === caller(exec)?.id || rt.isMain(caller(exec)?.id)) && work.taskId === scopeOf(liveInfo(exec)))
      if (!mine.length) return `No open delegated work for ${named.name}; nothing left to cancel.`
      for (const [id] of mine) workFor({ ...exec, allowWorkCancel: true }, id, 'from')
      for (const [id] of mine) await rt.cancelDelegatedWork(id, text(args.reason))
      return `Cancelled ${mine.length} delegated work(s) silently.`
    }
    const { id } = locate({ ...exec, allowWorkCancel: true }, args, 'from')
    return rt.cancelDelegatedWork(id, text(args.reason))
  })

  rt.cancelDelegatedWork = (id, reason = '') => serial(id, async () => {
    const work = records()[id]
    if (!work?.protocol) invalid('This work has already finished.')
    const branch = []
    const visit = key => {
      const entry = records()[key]
      if (!entry || branch.some(item => item.id === key)) return
      branch.push({ id: key, work: entry })
      for (const child of entry.open ?? []) visit(child)
    }
    visit(id)
    await rt.save({ required: true, mutate() {
      if (records()[id] !== work || receipt(id)) invalid('This work has already finished.')
      const before = structuredClone(records())
      const parent = records()[work.parent]
      if (parent) {
        parent.open = parent.open.filter(child => child !== id)
        parent.results.push({ id, name: rt.botOf(work.to)?.name ?? 'Teammate', text: `Work cancelled: ${reason || 'no longer needed'}`, at: Date.now() })
      }
      for (const item of branch) {
        closed(item.id, { ...item.work, protocol: true }, 'cancelled')
        delete records()[item.id]
      }
      return () => { state.works = before }
    } })
    let unavailable = 0
    for (const item of branch) {
      let sid, agent
      try {
        sid = item.work.toSession ? destination(item.work, 'to') : rt.chatOf(item.work.to)
        agent = await rt.resolveAgent(sid)
      } catch { unavailable++; continue }
      for (const list of [agent.inbox?.nextStep, agent.inbox?.nextTurn]) {
        for (const entry of [...(list ?? [])]) if ([entry.source?.exchangeId, entry.source?.work, entry.source?.workQuestion, entry.source?.replyTo].some(key => branch.some(node => node.id === key))) agent.inbox.remove(entry.id)
      }
      try {
        const asker = await rt.resolveAgent(destination(item.work, 'from'))
        for (const list of [asker.inbox?.nextStep, asker.inbox?.nextTurn]) for (const entry of [...(list ?? [])]) {
          if ([entry.source?.work, entry.source?.workQuestion, entry.source?.replyTo].some(key => branch.some(node => node.id === key))) { asker.inbox.remove(entry.id); rt.forgetDelivery?.(entry.source?.exchangeId) }
        }
      } catch { /* An ended caller still has the durable cancellation receipt. */ }
      rt.forgetDelivery?.(item.id)
      const active = rt.live.get(sid)
      if (active?.info?.exchangeId === item.id || active?.info?.work === item.id) {
        agent.cancel({ kind: 'hook', reason: 'ds-bot/work-cancelled' })
        await agent.whenIdle()
      }
      try { await send(item.work, 'to', `Work cancelled: ${reason || 'no longer needed'}`, { role: 'note', silent: true, controlNotice: true }) } catch { unavailable++ }
    }
    for (const [key, args] of Object.entries(state.protocolSends ?? {})) if ([args.exchangeId, args.work, args.replyTo, args.workQuestion].some(id => branch.some(item => item.id === id)) && !args.silent) delete state.protocolSends[key]
    await rt.save({ required: true })
    for (const item of branch) rt.releaseWorkResults?.(item.work)
    if (work.parent && records()[work.parent]) await send(work, 'from', `Work cancelled: ${reason || 'no longer needed'}`, { role: 'reply', replyTo: id, work: work.parent, controlNotice: true })
    return `Cancelled work ${id}. No project card was submitted or approved.${unavailable ? ` ${unavailable} ended or unavailable conversations could not be stopped; their late results remain closed.` : ''}`
  })
  rt.answerDelegatedWork = (id, answer) => {
    id = rt.protocolResolve(id)
    const work = records()[id]
    if (!work) invalid('This work has already finished.')
    return rt.teamTools.find(tool => tool.name === 'answer_work').execute({ work_id: id, answer }, { agent: { id: destination(work, 'from') }, userWorkControl: true })
  }
  rt.cancelProtocolBot = async botId => {
    for (const [id, work] of Object.entries(records())) if (work.protocol && work.to === botId && !receipt(id)) await rt.cancelDelegatedWork(id, 'The Bot was stopped.')
  }

  add('note_bot', 'Leave a one-way note without waking the recipient or opening delegated work. It can read the note during its next normal turn.', {
    to: { type: 'string', required: true, description: 'Exact teammate name' },
    note: { type: 'string', description: 'A short fact or acknowledgement; not a new task' },
    message: { type: 'string', description: 'A short fact or acknowledgement; not a new task' },
  }, async (args, exec) => {
    const self = caller(exec), target = rt.findBot(args.to)
    const note = text(args.note ?? args.message)
    if (!self || !target || self.id === target.id || !note) invalid('Choose another teammate and write a note.')
    const room = rt.roomOf(rt.groupOwners.get(exec.agent?.id)?.roomId ?? liveInfo(exec)?.roomId)
    if (room && !room.members.includes(target.id)) invalid('Work for a group stays with its members.')
    const sid = room ? await rt.memberSession(room, target.id) : rt.chatOf(target.id)
    const key = scopeOf(liveInfo(exec))
    const active = rt.live.get(sid)
    if (active?.turn !== undefined && scopeOf(active.info) !== key) invalid('That conversation is working on another card; keep this note in its original card.')
    const long = await rt.attachLong(absoluteLinks(note, rt.sessionFolder?.(exec.agent?.session)), `Note from ${self.name}.txt`)
    if (!long) invalid('The note could not be attached; nothing was sent.')
    await rt.deliver({ fromId: self.id, toId: target.id, sessionId: sid, text: long.text, files: long.files, ...(long.length ? { length: long.length } : {}), role: 'note', silent: true, ...scopeFields(key) })
    return `Left a note for ${target.name}; no turn was started.`
  })

  Object.assign(rt, {
    protocolClosed: (id, source) => receipt(id) !== undefined || Boolean(id && source?.workProtocol && !records()[id]),
    protocolCancelled: id => receipt(id)?.status === 'cancelled',
    protocolOnClose: closed,
    workProtocolTarget(exec) {
      const args = exec.arguments ?? {}
      if (['delegate_work', 'note_bot'].includes(exec.name)) return { to: args.to, message: args.goal ?? args.note ?? args.message }
      const side = exec.name === 'ask_back' ? 'to' : 'from'
      const named = exec.name === 'cancel_work' ? rt.findBot(args.target) : undefined
      if (named) return { to: named.name, message: args.reason }
      const { work } = locate({ ...exec, allowWorkCancel: exec.name === 'cancel_work' }, args, side)
      return { to: rt.botOf(work[side === 'from' ? 'to' : 'from'])?.name, message: args.question ?? args.answer ?? args.reason }
    },
  })
}

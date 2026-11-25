// Explicit collaboration tools over the local handoff tree. Project cards keep
// their own dispatch, submission and approval state.
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SOURCE_KIND } from './constants.js'
import { scopeFields, scopeOf, tagged } from './task-routing.js'
import { threadCurrentOfPart, threadOfPart } from './threads.js'

const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
const text = value => String(value ?? '').trim()
const invalid = message => { throw new Error(message) }

export function install(rt) {
  const { state, ctx } = rt
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
      id, status, from: work.from, to: work.to, callerSession: work.callerSession,
      ...(work.taskId ? { taskId: work.taskId } : {}), ...(work.dispatchId ? { dispatchId: work.dispatchId } : {}), at: Date.now(),
    } }
    const done = Object.entries(records()).filter(([, entry]) => entry.protocolReceipt)
      .sort((a, b) => a[1].protocolReceipt.at - b[1].protocolReceipt.at)
    for (const [key] of done.slice(0, Math.max(0, done.length - 100))) delete records()[key]
  }
  const workFor = (exec, id, side) => {
    const self = caller(exec)
    const work = records()[id]
    if (!self || !work?.protocol || work[side] !== self.id) invalid('No open delegated work belongs to this caller.')
    if (work.taskId && scopeOf(liveInfo(exec)) !== work.taskId) invalid('This delegated work belongs to another project card.')
    const info = liveInfo(exec)
    if (side === 'to' && rt.workOf(info) !== id) invalid('Continue the currently delegated work only.')
    if (side === 'from' && work.dispatchId && info?.exchangeId !== work.dispatchId && info?.parentExchangeId !== work.dispatchId) invalid('This delegated work belongs to another dispatch round.')
    const original = side === 'from' ? work.callerSession : work.toSession
    const expected = threadCurrentOfPart(self, original) ?? original
    if (expected !== exec.agent?.id) invalid('Continue this work in its original conversation.')
    return work
  }
  const destination = (work, side) => {
    const bot = rt.botOf(work[side])
    const original = side === 'from' ? work.callerSession : work.toSession
    if (!bot || !original) invalid('The original work conversation is unavailable.')
    const member = rt.groupOwners.get(original) ?? rt.pastOwners.get(original)
    if (member?.roomId) {
      const room = rt.roomOf(member.roomId)
      if (!room?.members.includes(bot.id)) invalid('The original group membership ended.')
      return room.sessions?.[bot.id] ?? invalid('The original group conversation is unavailable.')
    }
    return threadCurrentOfPart(bot, original) ?? invalid('The original work conversation has ended.')
  }
  const scope = work => ({ ...scopeFields(work.taskId), ...(work.dispatchId ? { parentExchangeId: work.dispatchId } : {}) })
  const send = (work, side, message, extra = {}) => rt.deliver({
    ...scope(work), fromId: work[side === 'to' ? 'from' : 'to'], toId: work[side],
    sessionId: destination(work, side), text: message, role: 'request',
    ...(work.fromRoom ? { fromRoomId: work.fromRoom } : {}),
    fromPart: work.callerSession, ...extra,
  })
  const locate = (exec, args, side) => {
    const id = text(args.work_id) || rt.workOf(liveInfo(exec))
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
  const workId = { type: 'string', description: 'Exact work_id returned by delegate_work. Required when answering or cancelling.' }

  add('delegate_work', 'Delegate concrete work. Its reply returns automatically. Keep project_task submission and approval unchanged; do not delegate acknowledgements.', {
    to: { type: 'string', required: true, description: 'Exact teammate name' },
    goal: { type: 'string', required: true, description: 'Self-contained task or question' },
    request_id: { type: 'string', description: 'Stable identity for retries of this same request' },
    taskId: { type: 'string', description: 'Existing project card; inherited in its execution' },
    card_round: { type: 'integer', description: 'Existing formal project handoff. Preserves the local message_bot dispatch contract.' },
  }, async (args, exec) => {
    const self = caller(exec)
    const target = rt.findBot(args.to)
    if (!self || !target || self.id === target.id || !text(args.goal)) invalid('Choose another teammate and a concrete goal.')
    if (args.card_round !== undefined) return rt.teamTools.find(tool => tool.name === 'message_bot').execute({
      to: args.to, message: args.goal, taskId: args.taskId, card_round: args.card_round,
      request_id: args.request_id, reply_to: 'user', when: 'queue',
    }, exec)
    const info = liveInfo(exec)
    const key = scopeOf(info)
    if (args.taskId !== undefined && args.taskId !== key) invalid('Delegate inside the original project card execution.')
    const room = rt.roomOf(rt.groupOwners.get(exec.agent?.id)?.roomId)
    if (room && !room.members.includes(target.id)) invalid('Work for a group stays with its members.')
    if (rt.upstreamOf([rt.workOf(info)].filter(Boolean)).has(target.id)) invalid('Use ask_back to ask the caller; do not delegate back up the waiting chain.')
    const name = text(args.request_id)
    if (name.length > 120) invalid('The request_id is too long.')
    const thread = threadOfPart(self, exec.agent.id)?.segments?.[0]?.sessionId ?? room?.segments?.[self.id]?.[0]?.sessionId ?? exec.agent.id
    const request = name ? rt.requestIdentity({ caller: self.id, context: `delegate:${thread}:${key ?? ''}`, name,
      payload: { to: target.id, goal: text(args.goal), taskId: key ?? null } }) : undefined
    const run = async () => {
      const id = randomUUID()
      const toSession = room ? await rt.memberSession(room, target.id) : rt.chatOf(target.id)
      const parent = rt.workOf(info)
      if (receipt(parent)) invalid('The original work has already closed.')
      const above = records()[parent]
      const work = { protocol: true, from: self.id, to: target.id, callerSession: exec.agent.id,
        fromPart: exec.agent.id, toSession, open: [], results: [], at: Date.now(),
        ...(above ? { parent } : {}), ...(room ? { fromRoom: room.id } : {}),
        ...scopeFields(key), ...(key && info?.exchangeId ? { dispatchId: above?.dispatchId ?? info.parentExchangeId ?? info.exchangeId } : {}),
      }
      await rt.save({ required: true, mutate() {
        records()[id] = work
        const previous = above?.open
        if (above) above.open = [...above.open, id]
        return () => { delete records()[id]; if (above) above.open = previous }
      } })
      try {
        await send(work, 'to', `Delegated work ${id}:\n${text(args.goal)}\n\nIf blocked, use ask_back. Your final reply returns to the caller automatically.`, { exchangeId: id })
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
      return `Delegated to ${target.name}. work_id: ${id}. End your turn after handing on the work; its result returns automatically.`
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
      await rt.save({ required: true, mutate() { work.question = question; return () => { delete work.question } } })
      try {
        await send(work, 'from', `Question on work ${found.id}:\n${question}\n\nUse answer_work with this work_id to unblock it, or cancel_work.`, {
          audience: 'user', ...(work.parent ? { work: work.parent } : {}),
        })
      } catch (error) {
        if (error.deliveryUncertain) { exec.concludeTurn?.(); return `Question delivery persistence is uncertain for work ${found.id}; do not send it again. The work remains open.` }
        await rt.save({ required: true, mutate() {
          if (records()[found.id] !== work || work.question !== question) return
          delete work.question
          return () => { work.question = question }
        } })
        throw error
      }
      exec.concludeTurn?.()
      return `Asked the caller. Work ${found.id} remains open; wait for its answer.`
    })
  })

  add('answer_work', 'Answer a blocking question on work you delegated. Resume only that work in its recorded conversation.', {
    work_id: { ...workId, required: true }, answer: { type: 'string', required: true, description: 'Answer to the worker question' },
  }, async (args, exec) => serial(text(args.work_id), async () => {
    const { id, work } = locate(exec, args, 'from')
    if (!work.question || !text(args.answer)) invalid('This work has no unanswered question, or the answer is empty.')
    const question = work.question
    await rt.save({ required: true, mutate() { delete work.question; return () => { work.question = question } } })
    try {
      await send(work, 'to', `Answer on work ${id}:\n${text(args.answer)}\n\nContinue the original delegated work.`, { exchangeId: id, resumed: true })
    } catch (error) {
      if (error.deliveryUncertain) return `Answer delivery persistence is uncertain for work ${id}; do not send it again. Inspect the original conversation.`
      await rt.save({ required: true, mutate() {
        if (records()[id] !== work || work.question !== undefined) return
        work.question = question
        return () => { delete work.question }
      } })
      throw error
    }
    return `Answered work ${id}; its original conversation continues.`
  }))

  add('cancel_work', 'Cancel only work you delegated. Stop its own active turn, keep a closed receipt, and leave project cards and other conversations unchanged.', {
    work_id: { ...workId, required: true }, reason: { type: 'string', description: 'Why this work is no longer needed' },
  }, async (args, exec) => serial(text(args.work_id), async () => {
    const { id, work } = locate(exec, args, 'from')
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
        parent.results.push({ id, name: rt.botOf(work.to)?.name ?? 'Teammate', text: `Work cancelled: ${text(args.reason) || 'no longer needed'}`, at: Date.now() })
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
        for (const entry of [...(list ?? [])]) if (entry.source?.exchangeId === item.id) agent.inbox.remove(entry.id)
      }
      rt.forgetDelivery?.(item.id)
      const active = rt.live.get(sid)
      if (active?.info?.exchangeId === item.id || active?.info?.work === item.id) {
        agent.cancel({ kind: 'hook', reason: 'ds-bot/work-cancelled' })
        await agent.whenIdle()
      }
    }
    for (const item of branch) rt.releaseWorkResults?.(item.work)
    return `Cancelled work ${id}. No project card was submitted or approved.${unavailable ? ` ${unavailable} ended or unavailable conversations could not be stopped; their late results remain closed.` : ''}`
  }))

  add('note_bot', 'Leave a one-way note without waking the recipient or opening delegated work. It can read the note during its next normal turn.', {
    to: { type: 'string', required: true, description: 'Exact teammate name' },
    message: { type: 'string', required: true, description: 'A short fact or acknowledgement; not a new task' },
  }, async (args, exec) => {
    const self = caller(exec), target = rt.findBot(args.to)
    if (!self || !target || self.id === target.id || !text(args.message)) invalid('Choose another teammate and write a note.')
    const room = rt.roomOf(rt.groupOwners.get(exec.agent?.id)?.roomId)
    if (room && !room.members.includes(target.id)) invalid('Work for a group stays with its members.')
    const sid = room ? await rt.memberSession(room, target.id) : rt.chatOf(target.id)
    const key = scopeOf(liveInfo(exec))
    const active = rt.live.get(sid)
    if (active?.turn !== undefined && scopeOf(active.info) !== key) invalid('That conversation is working on another card; keep this note in its original card.')
    const id = randomUUID(), book = `pair-${[self.id, target.id].sort().join('-')}`
    rt.ledger.append(book, { id, ...scopeFields(key), from: self.id, to: target.id, role: 'note', text: text(args.message), time: Date.now() })
    await rt.ledger.written(book)
    const agent = await rt.resolveAgent(sid)
    agent.inject(createUserMessage({ content: [{ type: 'text', text: tagged(key, `Note from ${self.name}:\n${text(args.message)}`) }],
      source: { kind: SOURCE_KIND, role: 'note', senderSessionId: self.id, exchangeId: id, ...scopeFields(key) } }))
    await ctx.sessions.flush(agent.session)
    rt.ledger.append(book, { event: 'delivered', id })
    await rt.ledger.written(book)
    return `Left a note for ${target.name}; no turn was started.`
  })

  Object.assign(rt, {
    protocolClosed: (id, source) => receipt(id) !== undefined || Boolean(id && source?.workProtocol && !records()[id]),
    protocolCancelled: id => receipt(id)?.status === 'cancelled',
    protocolOnClose: closed,
    workProtocolTarget(exec) {
      const args = exec.arguments ?? {}
      if (['delegate_work', 'note_bot'].includes(exec.name)) return { to: args.to, message: args.goal ?? args.message }
      const side = exec.name === 'ask_back' ? 'to' : 'from'
      const { work } = locate(exec, args, side)
      return { to: rt.botOf(work[side === 'from' ? 'to' : 'from'])?.name, message: args.question ?? args.answer ?? args.reason }
    },
  })
}

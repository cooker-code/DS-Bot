import { planItemId } from './project-plan.js'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { assistantId } from './project-assistant.js'
import { taskManagementEnabled } from '../shared/task-settings.js'

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const allQuestions = card => card.questions?.length ? card.questions : card.clarification ? [{ id: 'legacy', question: card.clarification, nodes: [], options: [] }] : []
export const openProjectQuestions = card => allQuestions(card).filter(question => !question.answer && !question.withdrawnAt)
function questionItemIds(card, question) {
  if (question.itemIds) return question.itemIds
  const plan = card.plans?.find(plan => plan.version === question.version)
  return question.nodes.flatMap(no => plan?.nodes[no - 1] ? [planItemId(card, plan, plan.nodes[no - 1])] : [])
}

export function questionBlocksNode(card, no) {
  const plan = card.plans?.at(-1)
  const node = plan?.nodes[no - 1]
  return openProjectQuestions(card).some(question => !question.nodes.length ||
    (node && questionItemIds(card, question).includes(planItemId(card, plan, node))))
}
export const publicProjectQuestions = card => allQuestions(card).map(({ imOrigin: _origin, ...question }) => {
  if (!question.answer) return question
  const { deliveries: _deliveries, ...answer } = question.answer
  return { ...question, answer }
})

export function setProjectQuestions(rt, room, card, args, actor) {
  const supplied = args.questions ?? [{ question: args.reason }]
  if (!Array.isArray(supplied) || !supplied.length || supplied.length > 10) throw invalid('Provide one to ten focused questions.')
  const plan = card.plans?.at(-1)
  const text = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit ? value.trim() : undefined
  const origin = room.projectIntakeOrigins?.[card.intakes?.[0]]
  const questions = supplied.map(raw => {
    const question = text(raw.question, 2000)
    if (!Array.isArray(raw.options ?? [])) throw invalid('Supply an array of answer options.')
    const options = (raw.options ?? []).map(option => typeof option === 'string' ? { label: option } : option)
    if (!question || !Array.isArray(raw.options ?? []) || options.length > 6 || options.some(option => !text(option?.label, 200) || (option.description !== undefined && !text(option.description, 500))) || new Set(options.map(option => option.label)).size !== options.length) throw invalid('Supply a question and distinct short answer options.')
    const nodes = raw.nodes ?? []
    if (!Array.isArray(nodes) || new Set(nodes).size !== nodes.length || nodes.some(no => !Number.isSafeInteger(no) || !plan?.nodes[no - 1])) throw invalid('Question dependencies must name nodes in the current plan.')
    return { id: randomUUID(), question, options, nodes, itemIds: nodes.map(no => planItemId(card, plan, plan.nodes[no - 1])), version: plan?.version, askedBy: actor, askedAt: Date.now(),
      ...(raw.detail && { detail: text(raw.detail, 1000) }), ...(origin && { imOrigin: origin }) }
  })
  const pending = openProjectQuestions(card)
  if (isDeepStrictEqual(pending.map(({ question, options, nodes }) => ({ question, options, nodes })), questions.map(({ question, options, nodes }) => ({ question, options, nodes })))) return
  for (const question of pending) question.withdrawnAt = Date.now()
  ;(card.questions ??= []).push(...questions)
  card.clarification = questions.map(question => question.question).join('\n')
}

export function installProjectQuestions(rt) {
  let stopped = false, timer, running, dirty = false
  const syncCards = () => {
    let changed = false
    for (const room of Object.values(rt.state.rooms)) {
      const session = room.sessions?.[room.admin]
      if (!session || !taskManagementEnabled(room)) continue
      const existing = rt.state.questions[session]
      if (existing && !existing.projectTask) continue
      const card = Object.values(room.projectCards ?? {}).find(card => openProjectQuestions(card).length)
      const question = card && openProjectQuestions(card)[0]
      if (!question?.imOrigin) {
        if (existing?.projectTask) { delete rt.state.questions[session]; changed = true }
        continue
      }
      if (existing?.id === question.id) continue
      changed = true
      rt.state.questions[session] = { ...question, allowCustom: true, projectTask: { roomId: room.id, taskId: card.id, questionId: question.id } }
    }
    return changed
  }
  const deliver = async () => {
    if (stopped || rt.readOnly() !== undefined) return
    if (syncCards()) await rt.save({ required: true })
    for (const room of Object.values(rt.state.rooms)) for (const card of Object.values(room.projectCards ?? {})) {
      if (!taskManagementEnabled(room)) continue
      for (const question of card.questions ?? []) {
        const current = () => rt.roomOf(room.id)?.projectCards?.[card.id]?.questions?.find(item => item.id === question.id)
        const update = change => rt.save({ required: true, mutate() {
          const saved = current()
          if (!saved?.answer) return
          const before = structuredClone(saved.answer)
          change(saved.answer)
          return () => { saved.answer = before }
        } })
        if (!question.answer || question.answer.deliveredAt) continue
        rt.restoreProjectQuestionOrigin?.(room.id, question.imOrigin)
        const recipients = [...new Set([room.admin, assistantId(room)].filter(Boolean))]
        try {
          for (const botId of recipients) {
            const coordinator = botId === (assistantId(room) ?? room.admin)
            const text = `The user answered a clarification on the existing task ${card.id}.\nQuestion: ${question.question}\nAnswer: ${question.answer.text}\n` +
              (coordinator ? 'Read this card and the current plan. Apply this answer, revise only affected work, then recover the original blocked round or dispatch ready nodes and deliver their returned round. Preserve existing artifacts. Report the concrete next action to the group.' : 'Record this business decision on the original card when needed and report it to the user. The task assistant has the same answer and coordinates execution.')
            let receipt
            await update(answer => { receipt = (answer.deliveries ??= {})[botId] ??= { id: randomUUID() } })
            if (!receipt || receipt.deliveredAt) continue
            const sessionId = await rt.memberSession(room, botId)
            if (stopped) return
            let found = false
            if (receipt.sessionId && receipt.sessionId !== sessionId) for await (const event of rt.eventsBackwards(receipt.sessionId, AbortSignal.timeout(5000))) {
              if (event.type === 'user/message' && event.data?.source?.exchangeId === receipt.id) { found = true; break }
            }
            if (!found) {
              await update(answer => { const saved = answer.deliveries?.[botId]; if (saved?.id === receipt.id) saved.sessionId = sessionId })
              if (stopped) return
              await rt.deliver({ toId: botId, sessionId, roomId: room.id, taskId: card.id, exchangeId: receipt.id,
                deduplicate: true, recordExchange: false, role: 'request', audience: 'user', text,
                validateDestination: () => !stopped && Boolean(current()?.answer) && rt.roomOf(room.id) === room && (room.admin === botId || assistantId(room) === botId) })
            }
            await update(answer => { const saved = answer.deliveries?.[botId]; if (saved?.id === receipt.id) saved.deliveredAt = Date.now() })
          }
          await update(answer => {
            if (recipients.every(id => answer.deliveries?.[id]?.deliveredAt)) { answer.deliveredAt = Date.now(); delete answer.error }
          })
        } catch (error) {
          if (stopped) return
          await update(answer => { answer.error = rt.redactSecrets?.(String(error.message)) ?? String(error.message) })
          dirty = false
        }
      }
    }
  }
  const schedule = () => {
    if (stopped) return
    dirty = true
    clearTimeout(timer)
    if (running) return
    timer = setTimeout(() => {
      timer = undefined
      dirty = false
      running = deliver().catch(error => rt.warn('ds-bot: project answer delivery: %s', error)).finally(() => {
        running = undefined
        if (stopped) return
        if (dirty) schedule()
        else if (Object.values(rt.state.rooms).some(room => Object.values(room.projectCards ?? {}).some(card => card.questions?.some(question => question.answer && !question.answer.deliveredAt)))) {
          timer = setTimeout(schedule, 30_000); timer.unref?.()
        }
      })
    }, 0)
    timer.unref?.()
  }
  rt.onSaved(schedule)
  rt.answerProjectQuestion = async ({ roomId, taskId, questionId, answer }) => {
    let room = rt.roomOf(roomId)
    let card = room?.projectCards?.[taskId]
    if (!card || !taskManagementEnabled(room)) throw invalid('Choose an enabled task in this group.')
    let question = allQuestions(card).find(question => question.id === questionId)
    if (!question || question.withdrawnAt) throw Object.assign(new Error('This question is no longer open'), { code: 'bot/stale' })
    const selected = answer?.selected ?? []
    const custom = typeof answer?.custom === 'string' ? answer.custom.trim() : ''
    if (!Array.isArray(selected) || selected.length > 1 || selected.some(label => !question.options.some(option => option.label === label)) || (!selected.length && !custom) || custom.length > 4000) throw invalid('Choose a listed answer or enter your answer.')
    const text = [...selected, custom].filter(Boolean).join('\n')
    const asked = question.question
    await rt.save({ required: true, mutate() {
      room = rt.roomOf(roomId)
      card = room?.projectCards?.[taskId]
      question = card && allQuestions(card).find(item => item.id === questionId)
      if (!question || question.question !== asked || question.withdrawnAt) throw Object.assign(new Error('This question is no longer open'), { code: 'bot/stale' })
      if (question.answer) {
        if (question.answer.text !== text) throw Object.assign(new Error('This question was already answered'), { code: 'bot/stale' })
        return
      }
      const previousQuestions = card.questions
      if (!card.questions?.length) card.questions = [question]
      const previous = card.clarification
      question.answer = { text, selected, custom, by: 'user', at: Date.now() }
      if (!openProjectQuestions(card).length) delete card.clarification
      return () => { card.questions = previousQuestions; delete question.answer; if (previous !== undefined) card.clarification = previous }
    } })
    schedule()
    return { saved: true, questionId, delivered: Boolean(question.answer.deliveredAt) }
  }
  rt.syncProjectQuestionCards = syncCards
  rt.ctx.effect(() => {
    void rt.load().then(schedule).catch(() => {})
    return async () => { stopped = true; clearTimeout(timer); await running }
  }, 'ds-bot: project questions')
}

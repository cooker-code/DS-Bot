import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { QuestionView } from './questions.js'
import { createSource } from './sources.js'
import { call } from './api.js'
import { sendsOnEnter } from './enter-key.js'
import { t } from './i18n.js'

const focusTarget = createSource(null)
export function focusProjectQuestion(roomId, taskId) { focusTarget.set({ roomId, taskId, at: Date.now() }) }

export function ProjectQuestionDock({ sessionId, useRoster }) {
  const roster = useRoster(value => value)
  const room = roster.roomsById?.[sessionId]
  const target = useSyncExternalStore(focusTarget.subscribe, focusTarget.getSnapshot)
  const [selected, select] = useState(null)
  const [hidden, hide] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState([])
  const lock = useRef(false)
  const panel = useRef(null)
  const pending = (room?.projectCards ?? []).flatMap(card => (card.questions ?? []).filter(question => !question.answer && !question.withdrawnAt && !saved.includes(question.id)).map(question => ({ card, question })))
  const current = pending.find(item => item.card.taskId === selected) ?? pending[0]
  useEffect(() => { select(null); hide(false); setSaved([]); setError('') }, [sessionId])
  useEffect(() => {
    if (!target || target.roomId !== room?.id) return
    select(target.taskId); hide(false)
    requestAnimationFrame(() => { panel.current?.scrollIntoView({ block: 'nearest' }); panel.current?.querySelector('button,textarea')?.focus() })
  }, [target])
  if (!room) return null
  if (!current) {
    const last = room.projectCards?.flatMap(card => card.questions ?? []).find(question => question.id === saved.at(-1))
    return last ? h('div', { className: 'bt-q-dock bt-project-question-head', role: 'status' },
      h('span', null, t(last.answer?.deliveredAt ? 'Answer delivered to the task coordinator' : 'Answer saved; delivery pending')),
      h('button', { type: 'button', className: 'bt-mini', onClick: () => setSaved([]) }, t('Close'))) : null
  }
  const { card, question } = current
  const ownQuestions = card.questions.filter(item => !item.withdrawnAt)
  const answer = async value => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      await call('answer-project-question', { roomId: room.id, taskId: card.taskId, questionId: question.id, answer: value })
      setSaved(ids => [...ids, question.id])
    } catch (failure) { setError(failure.message) }
    finally { lock.current = false; setBusy(false) }
  }
  return h('div', { className: 'bt-q-dock', ref: panel },
    hidden ? h('button', { type: 'button', className: 'bt-soft', onClick: () => hide(false) }, t('{count} questions need your answer', { count: pending.length })) : h('div', null,
      h('div', { className: 'bt-project-question-head' },
        h('select', { className: 'bt-select', 'aria-label': t('Task needing an answer'), disabled: busy, value: card.taskId, onChange: event => { select(event.target.value); setError('') } },
          [...new Map(pending.map(({ card }) => [card.taskId, card])).values()].map(card => h('option', { key: card.taskId, value: card.taskId }, card.title))),
        h('span', null, t('Question {current} of {total}', { current: ownQuestions.findIndex(item => item.id === question.id) + 1, total: ownQuestions.length }))),
      h(QuestionView, { key: question.id, question, onAnswer: answer, onDismiss: () => hide(true), busy, ownAnswer: true, raised: true, enterToSend: sendsOnEnter(roster.prefs) }),
      h('p', { className: 'bt-project-question-head' }, t('Received by {name}; the task coordinator continues the work.', { name: roster.byId?.[room.admin]?.name ?? t('Group admin') })),
      error && h('p', { role: 'alert' }, error)))
}

export function ProjectQuestionHistory({ questions = [], roster }) {
  if (!questions.length) return null
  return h('details', { className: 'bt-project-question-history' }, h('summary', null, t('Questions and answers')),
    h('ol', null, questions.map(question => h('li', { key: question.id },
      h('strong', null, question.question),
      h('p', null, t('Asked by {name}', { name: roster.byId?.[question.askedBy]?.name ?? t('Not recorded') })),
      h('p', null, question.answer?.text ?? t(question.withdrawnAt ? 'Superseded question' : 'Waiting for your answer')),
      question.answer && h('small', { role: 'status' }, t(question.answer.deliveredAt ? 'Answer delivered to the task coordinator' : 'Answer saved; delivery pending')),
      question.answer?.error && h('p', { role: 'alert' }, question.answer.error)))))
}

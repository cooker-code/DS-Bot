import { createElement as h, useState } from 'react'
import { useLinger } from './motion.js'
import { t } from './i18n.js'

export function WorkCard({ work, actions, leaving = false }) {
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async fn => {
    if (busy) return
    setBusy(true)
    setError('')
    try { await fn() } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  return h('section', { className: 'bt-q bt-q-raised', 'aria-label': t('Delegated work'), 'data-work-id': work.id, 'aria-busy': busy || leaving || undefined },
    h('div', { className: 'bt-q-title' }, `${work.ref ?? ''} · ${work.fromName} → ${work.toName}`),
    work.taskTitle ? h('p', null, `${work.taskTitle} · ${work.taskId}`) : null,
    h('p', null, work.status === 'paused' ? t('Work paused') : t('Waiting for an answer')),
    h('p', { className: 'bt-q-detail' }, work.reason ?? work.question ?? work.goal),
    work.status === 'need_input' ? h('textarea', { className: 'bt-q-input', value: answer, disabled: busy || leaving,
      'aria-label': t('Your answer'), onChange: event => setAnswer(event.target.value) }) : null,
    error ? h('p', { role: 'alert' }, error) : null,
    h('div', { className: 'bt-q-foot' },
      work.status === 'paused'
        ? h('button', { type: 'button', className: 'bt-q-submit', disabled: busy || leaving, onClick: () => run(() => actions.resumeWork(work.id)) }, t('Continue'))
        : h('button', { type: 'button', className: 'bt-q-submit', disabled: busy || leaving || !answer.trim(), onClick: () => run(() => actions.answerWork(work.id, answer.trim())) }, t('Answer')),
      h('button', { type: 'button', className: 'bt-q-btn', disabled: busy || leaving, onClick: () => run(() => actions.cancelWork(work.id)) }, t('Cancel work'))))
}

function GroupPause({ room, actions }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const resume = async () => {
    setBusy(true)
    try { await actions.resumeRoomPause(room.id) } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  return h('section', { className: 'bt-q bt-q-raised', 'aria-label': t('Group paused') },
    h('p', null, t('Group paused')),
    h('p', null, t('Bots reached an automatic handoff checkpoint. Continue when you want them to proceed.')),
    error ? h('p', { role: 'alert' }, error) : null,
    h('button', { type: 'button', className: 'bt-q-submit', disabled: busy, onClick: resume }, t('Continue')))
}

export function WorkDock({ sessionId, useWork, useRoster, actions }) {
  const entries = useWork(work => work.delegated ?? [])
  const here = entries.filter(work => ['paused', 'need_input'].includes(work.status) && (work.sessionId === sessionId || work.toSession === sessionId || work.roomId === sessionId))
  const room = useRoster(roster => roster.roomsById?.[sessionId])
  const model = here.length || room?.idlePaused ? JSON.stringify({ here, room: room?.idlePaused ? room : null }) : null
  const [kept, leaving] = useLinger(model, 160)
  if (!kept) return null
  const shown = JSON.parse(kept)
  return h('div', { className: 'bt-q-dock', 'data-leaving': leaving || undefined },
    shown.room ? h(GroupPause, { room: shown.room, actions }) : null,
    shown.here.map(work => h(WorkCard, { key: work.id, work, actions, leaving })))
}

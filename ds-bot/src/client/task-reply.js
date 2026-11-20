import { createElement as h, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'

export function TaskReply({ room, initialId, close }) {
  const [id, select] = useState(initialId ?? '')
  const [text, write] = useState('')
  const [busy, pending] = useState(false)
  const [error, fail] = useState('')
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const submit = async event => {
    event.preventDefault()
    if (busy || !id || !text.trim()) return
    pending(true)
    fail('')
    try {
      await call('continue-project-task', { roomId: room.id, taskId: id, text, requestId })
      close()
    } catch (failure) { fail(failure.message) }
    finally { pending(false) }
  }
  return h('form', { className: 'bt-set-row bt-bs-stack', onSubmit: submit },
    h('label', null, t('Link task'), h('select', { className: 'bt-select', value: id, disabled: busy, autoFocus: !initialId,
      onChange: e => { select(e.target.value); setRequestId(crypto.randomUUID()) } },
      h('option', { value: '', disabled: true }, t('Choose a task')),
      (room.projectCards ?? []).map(card => h('option', { key: card.taskId, value: card.taskId }, card.title + ' · ' + card.taskId.slice(-8))))),
    h('textarea', { 'aria-label': t('Task reply'), placeholder: t('Task reply'), value: text, disabled: busy, autoFocus: !!initialId,
      onChange: e => { write(e.target.value); setRequestId(crypto.randomUUID()) } }),
    error ? h('span', { role: 'alert' }, error) : null,
    h('div', null, h('button', { type: 'submit', className: 'bt-soft', disabled: busy || !id || !text.trim() }, t('Send')),
      h('button', { type: 'button', className: 'bt-mini', disabled: busy, onClick: close }, t('Cancel'))))
}

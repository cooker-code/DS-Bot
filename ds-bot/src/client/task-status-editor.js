import { createElement as h, useId, useState } from 'react'
import { TASK_STATUS, editableProjectStatuses } from '../shared/task-settings.js'
import { t } from './i18n.js'

export function TaskStatusEditor({ detail, readOnly, onSave }) {
  const id = useId()
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const editable = !readOnly && ['blocked', 'failed'].includes(detail.status)
  const cancel = () => { setDraft(null); setError('') }
  const save = async event => {
    event.preventDefault()
    if (busy || !editable || !draft.reason.trim() || draft.status === draft.previous) return
    setBusy(true)
    setError('')
    try {
      await onSave(draft.previous, draft.status, draft.reason.trim())
      setDraft(null)
      setSaved(true)
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  return h('section', { 'aria-labelledby': id },
    h('div', { className: 'bt-project-field-head' },
      h('h3', { id, className: 'bt-section-title' }, t('Task status')),
      editable && !draft ? h('button', { type: 'button', className: 'bt-mini', onClick: () => {
        setDraft({ previous: detail.status, status: detail.status, reason: '' }); setSaved(false); setError('')
      } }, t('Change status')) : null),
    h('span', { className: 'bt-task-status', 'data-status': detail.status }, t(TASK_STATUS[detail.status] ?? detail.status)),
    draft ? h('form', { className: 'bt-task-checkout-edit', onSubmit: save },
      h('label', { htmlFor: id + '-status' }, t('New status')),
      h('select', { id: id + '-status', className: 'bt-select', autoFocus: true, value: draft.status, disabled: busy || !editable,
        onChange: event => setDraft({ ...draft, status: event.target.value }) },
      editableProjectStatuses.map(status => h('option', { key: status, value: status }, t(TASK_STATUS[status])))),
      h('label', { htmlFor: id + '-reason' }, t('Reason for change (required)')),
      h('textarea', { id: id + '-reason', className: 'bt-input', rows: 3, required: true, maxLength: 2000,
        value: draft.reason, disabled: busy || !editable, onChange: event => setDraft({ ...draft, reason: event.target.value }) }),
      h('p', { className: 'bt-note' }, t('Changing status does not restart or stop Bots.')),
      h('div', { className: 'bt-task-actions' },
        h('button', { type: 'submit', className: 'bt-soft-sm', disabled: busy || !editable || !draft.reason.trim() || draft.status === draft.previous }, t(busy ? 'Saving…' : 'Save')),
        h('button', { type: 'button', className: 'bt-mini', disabled: busy, onClick: cancel }, t('Cancel')))) : null,
    error ? h('p', { className: 'bt-error', role: 'alert' }, error) : null,
    saved ? h('p', { className: 'bt-note', role: 'status' }, t('Status saved')) : null,
    detail.statusHistory?.length ? h('details', { className: 'bt-project-workspace' },
      h('summary', null, t('Status change history')),
      detail.statusHistory.map((change, index) => h('div', { key: index },
        h('p', null, t(TASK_STATUS[change.from]), ' → ', t(TASK_STATUS[change.status]), ' · ', new Date(change.at).toLocaleString()),
        h('p', { className: 'bt-task-status-reason' }, change.reason)))) : null)
}

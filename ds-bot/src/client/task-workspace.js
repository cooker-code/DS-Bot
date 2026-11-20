import { createElement as h, useEffect, useId, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'
import { workspacePolicies } from '../shared/project-workspace.js'

const keyOf = row => row ? JSON.stringify([row.repository, row.workRef]) : ''

function WorkspaceDecision({ roomId, card }) {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState()
  const [error, setError] = useState('')
  const [attempt, retry] = useState(0)
  useEffect(() => {
    if (!open) return
    setDetail(undefined)
    const abort = new AbortController()
    setError('')
    call('project-task-detail', { roomId, taskId: card.taskId, workspaceOnly: true }, abort.signal).then(value => {
      if (!abort.signal.aborted) setDetail(value)
    }, failure => { if (!abort.signal.aborted) setError(failure.message) })
    return () => abort.abort()
  }, [open, roomId, card.taskId, card.version, card.updatedAt, card.textUpdatedAt, card.round, attempt])
  return h('details', { className: 'bt-project-workspace', onToggle: event => setOpen(event.currentTarget.open) },
    h('summary', null, t('Policy when planned')),
    open ? error ? h('div', { role: 'alert' }, error, ' ',
      h('button', { type: 'button', className: 'bt-mini', onClick: () => retry(n => n + 1) }, t('Retry')))
    : detail ? h('div', null,
      detail.policy ? h('p', null, t(workspacePolicies[detail.policy])) : null,
      detail.userSelected ? h('span', null, t('Chosen by you for this task')) : detail.reason ? h('span', null, detail.reason)
          : !detail.policy || detail.policy === 'auto' ? h('span', null, t('No reason recorded.')) : null)
    : h('p', { role: 'status' }, t('Loading…')) : null)
}

export function TaskWorkspace({ room, card, readOnly }) {
  const id = useId()
  const [data, setData] = useState(null), [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [attempt, reload] = useState(0)
  const roomId = room.id, taskId = card.taskId
  useEffect(() => {
    const abort = new AbortController()
    call('project-task-detail', { roomId, taskId, workspaceChoices: true }, abort.signal).then(view => {
      if (!abort.signal.aborted) setData(view)
    }, failure => { if (!abort.signal.aborted) setError(failure.message) })
    return () => abort.abort()
  }, [roomId, taskId, room.workDir, room.projectWorkspacePolicy, card.round, card.version, card.updatedAt, card.textUpdatedAt, attempt])
  const refresh = () => { setError(''); reload(n => n + 1) }
  const edit = () => {
    setDraft({ previous: data.selected, key: keyOf(data.selected) })
    refresh()
  }
  const choice = draft && data?.choices.find(row => keyOf(row) === draft.key)
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await call('select-task-workspace', { roomId, taskId, selection: choice || null, previous: draft.previous })
      setDraft(null)
      refresh()
    } catch (failure) { setError(failure.message); reload(n => n + 1) }
    finally { setBusy(false) }
  }
  const current = data?.effective
  return h('section', { 'aria-labelledby': id },
    h('div', { className: 'bt-project-field-head' },
      h('h3', { id, className: 'bt-section-title' }, t('Branch and worktree')),
      data && !readOnly && !draft && (data.selected || data.choices.length > 0) ? h('button', { type: 'button', className: 'bt-mini', onClick: edit }, t('Change')) : null),
    current ? h('div', { className: 'bt-task-checkout' },
      current.workRef ? h('strong', null, current.workRef) : null,
      current.workDir ? h('code', null, current.workDir) : null,
      !data.available && data.hasRepository ? h('span', { className: 'bt-note' }, t('Selected worktree unavailable')) : null)
      : data ? h('span', { className: 'bt-note' }, t(data.hasRepository ? 'Task worktree not selected yet.' : 'No project Git repository found.')) : null,
    current && card.workspace?.branch ? h(WorkspaceDecision, { roomId, card }) : null,
    !data && !error ? h('span', { role: 'status' }, t('Loading…')) : null,
    draft ? h('div', { className: 'bt-task-checkout-edit' },
      data.policy !== 'auto' ? h('span', { className: 'bt-note' }, t(workspacePolicies[data.policy])) : null,
      h('select', { className: 'bt-select', 'aria-labelledby': id, autoFocus: true, disabled: busy || readOnly, value: draft.key,
        onChange: event => setDraft({ ...draft, key: event.target.value }) },
        h('option', { value: '' }, t('Follow the task plan')),
        data.choices.map(row => h('option', { key: keyOf(row), value: keyOf(row) }, row.workRef + ' · ' + (row.workDir || row.repository + ' · ' + t('New worktree'))))),
      choice ? h('code', null, choice.workDir || t('A separate worktree will be created for this branch.')) : null,
      h('div', { className: 'bt-task-actions' },
        h('button', { type: 'button', className: 'bt-soft-sm', onClick: save, disabled: readOnly || busy || draft.key === keyOf(draft.previous) || (!!draft.key && !choice) },
          t(busy ? 'Saving…' : choice && !choice.workDir ? 'Create worktree and use branch' : 'Save')),
        h('button', { type: 'button', className: 'bt-mini', disabled: busy, onClick: () => { setDraft(null); refresh() } }, t('Cancel')))) : null,
    error ? h('div', { className: 'bt-error', role: 'alert' }, error, ' ', h('button', { type: 'button', className: 'bt-mini', onClick: refresh }, t('Retry'))) : null)
}

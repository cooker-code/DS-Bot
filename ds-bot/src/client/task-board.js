import { taskManagementEnabled } from '../shared/task-settings.js'
// The group task board in the group's details panel: what each member is working on,
// the latest line of progress, and the history of finished and cancelled work. The
// board also holds accepted project cards. Users manage the list here.
import { createElement as h, Fragment, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BotMark } from './mark.js'
import { clockLabel, elapsedLabel } from './text.js'
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from './icons.js'
import { useAnchoredMenu } from './model-menu.js'
import { t } from './i18n.js'

export const TASK_STATUS = {
  pending: 'Awaiting intake', clarify: 'Needs clarification', planning: 'Planning', dispatching: 'Dispatching',
  active: 'In progress', review: 'Awaiting review', human_review: 'Human acceptance', blocked: 'Blocked',
  failed: 'Failed', done: 'Done', cancelled: 'Cancelled',
}

const BOARD_STATES = {
  clarify: 'The task needs more information from you to continue.',
  planning: 'The manager is preparing or correcting the execution plan.',
  dispatching: 'The plan is ready and the first Bot has yet to start.',
  active: 'The team has started executing the plan.',
  review: 'Review the submitted deliverable. For project code, check the candidate commit on its assigned branch.',
  human_review: 'Your acceptance was explicitly requested for the final delivery.',
  blocked: 'A blocker must be resolved before work can continue.',
  failed: 'The execution attempt failed.',
  done: 'The final output was approved or the owner marked the work complete.',
  cancelled: 'The task was cancelled.',
}

const statusKeys = Object.keys(BOARD_STATES)
const defaultStatuses = new Set(statusKeys.filter(status => status !== 'clarify'))

function TaskStatusFilter({ statuses, onChange, disabled }) {
  const { isOpen, shownPlace, leaving, button, menu, open, close } = useAnchoredMenu('start')
  const label = t('Filter tasks by status')
  const selected = statuses ?? defaultStatuses
  const all = selected.size === statusKeys.length
  const toggle = status => {
    const next = new Set(selected)
    if (next.has(status)) next.delete(status)
    else next.add(status)
    onChange(next)
  }
  const option = (key, text, checked, onClick) => h('button', {
    key, type: 'button', role: 'menuitemcheckbox', 'aria-checked': checked, autoFocus: key === 'all', onClick,
  }, h('span', { className: 'bt-menu-label' }, text),
    h('span', { className: 'bt-model-tick', 'aria-hidden': true }, checked === 'mixed' ? '−' : checked ? h(CheckIcon) : null))
  return h(Fragment, null,
    h('button', { ref: button, type: 'button', className: 'bt-section-title bt-task-filter', title: label, disabled,
      'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': isOpen, 'data-filtered': !all || undefined,
      onClick: isOpen ? close : open, onKeyDown: e => {
        if (e.key === 'ArrowDown' && !isOpen) { e.preventDefault(); open() }
      } }, t('Tasks'), h(ChevronDownIcon)),
    shownPlace ? createPortal(h('div', { ref: menu, role: 'menu', 'aria-label': label, style: shownPlace,
      className: 'bt-menu bt-task-filter-menu' + (shownPlace.bottom !== undefined ? ' bt-menu-up' : ''),
      'data-leaving': leaving || undefined, onBlur: e => {
        if (e.relatedTarget && e.relatedTarget !== button.current && !e.currentTarget.contains(e.relatedTarget)) close()
      } },
      option('all', t('Select all'), all || (selected.size > 0 ? 'mixed' : false), () => onChange(all ? new Set() : new Set(statusKeys))),
      h('div', { className: 'bt-menu-sep', role: 'separator' }),
      statusKeys.map(status => option(status, t(TASK_STATUS[status]), selected.has(status), () => toggle(status)))),
    document.body) : null)
}

function TaskStatusHelp() {
  const id = useId()
  const [side, setSide] = useState(null)
  const show = event => {
    const trigger = event.currentTarget
    const bounds = trigger.getBoundingClientRect()
    const drawer = trigger.closest('.bt-drawer-body')?.getBoundingClientRect()
    const below = (drawer?.bottom ?? window.innerHeight) - bounds.bottom
    setSide(below < 260 && bounds.top - (drawer?.top ?? 0) > below ? 'above' : 'below')
  }
  return h('div', { className: 'bt-task-help', onMouseLeave: () => setSide(null),
    onBlur: e => { if (!e.currentTarget.contains(e.relatedTarget)) setSide(null) },
    onKeyDown: e => {
      if (side && e.key === 'Escape') {
        e.stopPropagation()
        e.currentTarget.querySelector('button').focus()
        setSide(null)
      }
    } },
    h('button', { type: 'button', className: 'bt-task-help-button', 'aria-label': t('Task statuses'),
      'aria-expanded': !!side, 'aria-describedby': side ? id : undefined,
      onMouseEnter: show, onFocus: show, onClick: show }, '?'),
    side ? h('div', { id, role: 'tooltip', tabIndex: 0, className: 'bt-task-help-pop', 'data-side': side },
      h('strong', null, t('Task statuses')), h('dl', null, Object.entries(BOARD_STATES).map(([status, meaning]) =>
        h('div', { key: status }, h('dt', null, t(TASK_STATUS[status])), h('dd', null, t(meaning)))))) : null)
}

export function projectElapsed(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—'
  const duration = end - start
  return duration < 60_000 ? elapsedLabel(duration) : t('{n} min', { n: Math.floor(duration / 60_000) })
}

function projectStartLabel(time) {
  const date = new Date(time)
  const pad = value => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function ProjectCard({ card, predecessor, successors, roster, now, onOpen, restoreFocus }) {
  const owners = card.owners ?? (card.ownerId ? [card.ownerId] : [])
  const start = card.startedAt
  const end = card.submittedAt ?? card.stoppedAt ?? (card.status === 'active' ? now : undefined)
  const branch = card.workspace?.branch
  const hasStart = Number.isFinite(start)
  return h(onOpen ? 'button' : 'span', {
    className: 'bt-task bt-project-row', 'data-status': card.status,
    ...(onOpen && { type: 'button', autoFocus: restoreFocus, onClick: () => onOpen(card.taskId) }),
  },
    card.status !== 'done' && owners.length > 0 ? h('span', { className: 'bt-project-owner' }, owners.map(id => {
      const bot = roster.byId?.[id], label = bot?.name ?? t('Deleted Bot')
      return h('span', { key: id, title: label }, h(BotMark, { bot, label, size: 22, state: card.status === 'active' ? 'work' : 'idle' }))
    })) : null,
    h('span', { className: 'bt-project-body' },
      h('span', { className: 'bt-task-head' },
        h('span', { className: 'bt-task-name', title: card.title }, card.title),
        !owners.length && card.status !== 'done' ? h('span', { className: 'bt-set-hint' }, t('Unassigned')) : null,
        h('span', { className: 'bt-project-statuses' },
          h('span', { className: 'bt-task-status' }, t(card.validatingMerge ? 'Merged into dev, validating' : TASK_STATUS[card.status] ?? card.status))),
        onOpen ? h('span', { className: 'bt-project-arrow' }, h(ChevronRightIcon)) : null),
      predecessor ? h('span', { className: 'bt-project-meta' }, t('Follows {task}', { task: predecessor.title })) : null,
      successors?.map(task => h('span', { key: task.taskId, className: 'bt-project-meta' }, t('Follow-up: {task}', { task: task.title }))),
      branch || hasStart ? h('span', { className: 'bt-project-meta' },
        branch ? h('span', { className: 'bt-project-branch', title: branch }, branch) : null,
        hasStart ? h('span', { className: 'bt-project-times' },
          h('span', null, t('Started {time}', { time: projectStartLabel(start) })),
          h('span', null, t('Elapsed {time}', { time: projectElapsed(start, end) }))) : null) : null))
}

function ProjectRetry({ card, roomId, actions }) {
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState('')
  const retry = async () => {
    if (status !== 'idle') return
    setStatus('busy')
    setError('')
    try {
      await actions.resume(card.ownerId, { roomId, taskId: card.taskId, round: card.round, failedAt: card.updatedAt })
      setStatus('sent')
    } catch (failure) {
      setStatus('idle')
      setError(failure.message)
    }
  }
  return h('div', { className: 'bt-task-actions' },
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: status !== 'idle', onClick: retry },
      t(status === 'sent' ? 'Sent' : status === 'busy' ? 'Retrying…' : 'Retry')),
    error ? h('span', { role: 'alert' }, error) : null)
}

const OPEN = ['active', 'review', 'blocked', 'clarify', 'failed']
function TaskRow({ task, bot, room, actions }) {
  const [writing, setWriting] = useState(false)
  const [text, setText] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [confirming])
  const open = OPEN.includes(task.status)
  const failed = (error) => { setBusy(false); actions.reportError?.(error, 'task') }
  const send = () => {
    const line = text.trim()
    if (line === '' || busy) return
    setBusy(true)
    Promise.resolve(actions.taskNote(room.id, task.id, line)).then(
      () => { setText(''); setWriting(false); setBusy(false) },
      failed,
    )
  }
  const cancel = () => {
    if (!confirming) { setConfirming(true); return }
    setConfirming(false)
    setBusy(true)
    Promise.resolve(actions.taskCancel(room.id, task.id)).then(() => setBusy(false), failed)
  }
  return h('div', { className: 'bt-task', 'data-status': task.status, 'data-busy': busy || undefined },
    h('div', { className: 'bt-task-head' },
      bot ? h(BotMark, { bot, size: 22, state: open ? 'work' : 'idle' }) : null,
      h('span', { className: 'bt-task-name' }, bot?.name ?? t('a Bot')),
      h('span', { className: 'bt-task-status' }, t(TASK_STATUS[task.status])),
      h('span', { className: 'bt-task-time' }, clockLabel(task.startedAt))),
    h('div', { className: 'bt-task-goal' }, task.goal),
    open ? h('div', { className: 'bt-task-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, 'aria-expanded': writing, onClick: () => setWriting(value => !value) }, t('Add a note')),
      h('button', {
        type: 'button', className: 'bt-soft bt-soft-sm', 'data-confirm': confirming || undefined, disabled: busy,
        'aria-label': confirming ? t('Click again to cancel') : t('Cancel task'), onClick: cancel,
      }, confirming ? t('Cancel task') : t('Cancel'))) : null,
    writing ? h('div', { className: 'bt-task-write' },
      h('input', {
        className: 'bt-input bt-task-input', value: text, placeholder: t('What should change?'), 'aria-label': t('What should change?'),
        onChange: event => setText(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); send() }
          if (event.key === 'Escape') { event.stopPropagation(); setWriting(false) }
        },
      }),
      h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: text.trim() === '' || busy, onClick: send }, t('Send'))) : null)
}

export function TaskBoard({ room, roster, actions, onOpen, returnId, statuses = null, onStatusesChange }) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const [selection, setSelection] = useState(null)
  const [confirmation, setConfirmation] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const deleting = useRef(false)
  const editButton = useRef(null), deleteButton = useRef(null)
  const editing = selection !== null
  const matches = task => statuses === null ? task.status !== 'clarify' : statuses.has(task.status)
  const all = Object.entries(room.tasks ?? {}).filter(([, task]) => matches(task)).sort(([, a], [, b]) => a.startedAt - b.startedAt)
  const open = all.filter(([, task]) => OPEN.includes(task.status))
  const cards = (room.projectCards ?? []).filter(matches).sort((a, b) => b.updatedAt - a.updatedAt)
  const ticking = cards.some(card => card.status === 'active' && Number.isFinite(card.startedAt))
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  const count = cards.length + (taskManagementEnabled(room) ? 0 : open.length)
  const hasRows = Boolean(cards.length || open.length)
  const past = all.filter(([, task]) => !OPEN.includes(task.status)).reverse()
  const selected = editing ? [
    ...all.map(([id]) => ({ kind: 'member', id })),
    ...cards.map(card => ({ kind: 'project', id: card.taskId })),
  ].filter(({ kind, id }) => selection.has(kind + ':' + id)) : []
  const pick = (kind, id, title, content) => {
    const key = kind + ':' + id
    return h('label', { key, className: 'bt-task-pick' },
      h('input', { type: 'checkbox', checked: selection.has(key), 'aria-label': t('Select {name}', { name: title }),
        disabled: confirmation !== null, onChange: ({ target }) => {
          const checked = target.checked
          setSelection(previous => {
            const next = new Set(previous)
            if (checked) next.add(key)
            else next.delete(key)
            return next
          })
        } }), content)
  }
  const summary = (title, status) => h('span', { className: 'bt-task bt-task-head' },
    h('span', { className: 'bt-task-name' }, title), h('span', { className: 'bt-task-status' }, status))
  const row = ([id, task]) => editing ? pick('member', id, task.goal, summary(task.goal, t(TASK_STATUS[task.status])))
    : h(TaskRow, { key: id, task, bot: roster.byId?.[task.botId], room, actions })
  const remove = async () => {
    if (deleting.current || !confirmation?.length) return
    deleting.current = true
    setBusy(true)
    try {
      await actions.deleteTasks(room.id, confirmation)
      setSelection(null)
      setError('')
      requestAnimationFrame(() => editButton.current?.focus())
    } catch (failure) {
      setError(t(failure.message))
      requestAnimationFrame(() => deleteButton.current?.focus())
    } finally {
      deleting.current = false
      setBusy(false)
      setConfirmation(null)
    }
  }
  const cancelConfirmation = () => {
    setConfirmation(null)
    requestAnimationFrame(() => deleteButton.current?.focus())
  }
  const [collapsed, setCollapsed] = useState(() => new Set())
  const byId = new Map((room.projectCards ?? []).map(card => [card.taskId, card]))
  const successors = new Map()
  for (const card of byId.values()) {
    if (!card.followsTaskId) continue
    if (!successors.has(card.followsTaskId)) successors.set(card.followsTaskId, [])
    successors.get(card.followsTaskId).push(card)
  }
  const visible = new Set(cards.map(card => card.taskId))
  const roots = [], children = new Map()
  for (const card of cards) {
    if (!visible.has(card.parentTaskId)) { roots.push(card); continue }
    if (!children.has(card.parentTaskId)) children.set(card.parentTaskId, [])
    children.get(card.parentTaskId).push(card)
  }
  function renderCard(card) {
    const row = h(ProjectCard, { key: card.taskId, card, predecessor: byId.get(card.followsTaskId), successors: successors.get(card.taskId), roster, now, onOpen: editing ? undefined : onOpen, restoreFocus: returnId === card.taskId })
    if (editing) return pick('project', card.taskId, card.title, row)
    if (!taskManagementEnabled(room) || card.status !== 'failed' || card.version || !card.ownerId || !actions.resume) return row
    return h('div', { key: card.taskId }, row,
      h(ProjectRetry, { key: card.round + '-' + card.updatedAt, card, roomId: room.id, actions }))
  }
  function renderTree(card) {
    const row = renderCard(card)
    const related = children.get(card.taskId)
    if (!related) return row
    const expanded = !collapsed.has(card.taskId)
    const toggle = () => setCollapsed(previous => {
      const next = new Set(previous)
      if (next.has(card.taskId)) next.delete(card.taskId)
      else next.add(card.taskId)
      return next
    })
    return h('div', { key: card.taskId },
      h('div', { className: 'bt-related-parent' },
        h('button', { type: 'button', className: 'bt-mini bt-related-toggle', 'aria-expanded': expanded,
          'aria-label': t('Related tasks for {name}', { name: card.title }), onClick: toggle },
        h(expanded ? ChevronDownIcon : ChevronRightIcon)), row),
      expanded ? h('div', { className: 'bt-related-children' }, related.map(renderTree)) : null)
  }
  return h('div', { className: 'bt-tasks' },
    h('div', { className: 'bt-tasks-head' },
      h('div', { className: 'bt-task-heading' },
        h(TaskStatusFilter, { statuses, onChange: onStatusesChange, disabled: confirmation !== null }), h(TaskStatusHelp)),
      h('div', { className: 'bt-task-toolbar' },
        h('span', { className: 'bt-tasks-count', 'aria-live': 'polite' }, count),
        editing ? h('button', { ref: deleteButton, type: 'button', className: 'bt-mini bt-task-delete',
          disabled: !selected.length || confirmation !== null, onClick: () => { setError(''); setConfirmation(selected) } },
          t('Delete ({count})', { count: selected.length })) : null,
        hasRows || past.length || editing ? h('button', { ref: editButton, type: 'button', className: 'bt-mini', disabled: confirmation !== null,
          onClick: () => { setError(''); setSelection(editing ? null : new Set()) } }, t(editing ? 'Cancel' : 'Edit')) : null)),
    confirmation ? h('div', { className: 'bt-task-confirm', role: 'alertdialog', 'aria-label': t('Delete task'),
      onKeyDown: e => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); cancelConfirmation() } } },
      h('p', null, t('Permanently delete the selected tasks ({count})?', { count: confirmation.length })),
      h('p', null, t('Group messages are kept. Bots already working may continue.')),
      h('div', { className: 'bt-task-toolbar' },
        h('button', { type: 'button', className: 'bt-mini', autoFocus: true, disabled: busy, onClick: cancelConfirmation }, t('Cancel')),
        h('button', { type: 'button', className: 'bt-mini bt-task-delete', disabled: busy, onClick: remove }, t('Confirm')))) : null,
    error ? h('p', { className: 'bt-task-error', role: 'alert' }, error) : null,
    !taskManagementEnabled(room) ? h('div', { className: 'bt-set-hint' }, t('Existing tasks are still available to view.'), ' ',
      h('button', { type: 'button', className: 'bt-mini', onClick: () => actions.openSettings('groups', room.id) }, t('Group settings'))) : null,
    h('div', { className: 'bt-task-list' },
      roots.map(renderTree),
      open.map(row),
      !hasRows && !(statuses !== null && past.length) ? h('div', { className: 'bt-muted bt-tasks-empty' },
        statuses === null ? t('No task is running in this group.') : t('No results')) : null),
    past.length > 0 ? h('button', { type: 'button', className: 'bt-more', 'aria-expanded': historyOpen, onClick: () => setHistoryOpen(value => !value) },
      historyOpen ? t('Hide history') : t('History ({count})', { count: past.length })) : null,
    historyOpen ? h('div', { className: 'bt-task-list bt-task-history' }, past.map(row)) : null)
}

export const TASK_CSS = `
.bt-tasks{margin-top:16px}
.bt-task-acceptance{padding:0 6px 8px;overflow-wrap:anywhere}
.bt-task-acceptance textarea{box-sizing:border-box;width:100%;resize:vertical}
.bt-tasks-head{position:relative;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.bt-task-heading{display:flex;align-items:center;gap:2px}
.bt-task-heading>.bt-section-title{margin:0}
.bt-task-filter{display:inline-flex;align-items:center;gap:3px;min-height:24px;padding:0 3px;border:0;border-radius:6px;background:transparent;font-family:inherit;cursor:pointer}
.bt-task-filter:hover,.bt-task-filter:focus-visible{background:var(--bt-hover)}
.bt-task-filter[data-filtered]{color:var(--bt-accent)}
.bt-task-filter:focus-visible,.bt-task-filter-menu button:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-task-filter-menu{overflow-y:auto}
.bt-task-help{display:flex;align-items:center}
.bt-task-help-button{width:24px;height:24px;display:grid;place-items:center;padding:0;border:0;border-radius:6px;background:transparent;color:var(--bt-ink-2);font:inherit;cursor:help}
.bt-task-help-button:hover,.bt-task-help-button:focus-visible{background:var(--bt-hover);color:var(--bt-ink)}
.bt-task-help-button:focus-visible{outline:2px solid var(--bt-accent)}
.bt-task-help-pop{position:absolute;z-index:4;inset-inline-start:0;width:min(100%,24rem);box-sizing:border-box;max-height:min(50vh,20rem);overflow:auto;padding:10px 12px;border:1px solid var(--bt-line);border-radius:10px;background:var(--bt-main);color:var(--bt-ink);box-shadow:var(--bt-glass-shadow);font-size:12px;line-height:1.45}
.bt-task-help-pop[data-side=below]{top:calc(50% + 11px)}
.bt-task-help-pop[data-side=above]{bottom:calc(50% + 11px)}
.bt-task-help-pop dl{display:grid;gap:5px;margin:8px 0 0}
.bt-task-help-pop dl>div{display:grid;grid-template-columns:minmax(60px,30%) 1fr;gap:8px}
.bt-task-help-pop dd{margin:0;color:var(--bt-ink-2)}
.bt-task-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bt-task-toolbar .bt-mini{margin:0}
.bt-task-toolbar button:disabled{opacity:.5;cursor:default}
.bt-task-delete:not(:disabled),.bt-task-error{color:var(--bt-danger)}
.bt-task-confirm{background:var(--bt-hover);border-radius:10px;padding:8px 10px;margin-bottom:8px}
.bt-task-confirm p,.bt-task-error{font-size:13px;line-height:18px;margin:0 0 6px}
.bt-task-pick{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;padding-inline-start:8px;border-radius:12px;cursor:pointer}
.bt-task-pick:hover,.bt-task-pick:focus-within{background:var(--bt-hover)}
.bt-task-pick input{margin:0;accent-color:var(--bt-accent);width:16px;height:16px}
.bt-tasks-count{font-size:12px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-tasks-empty{padding:4px 8px}
.bt-task-list{display:flex;flex-direction:column;gap:2px;margin:0 -8px}
.bt-task{padding:8px;border-radius:12px;transition:background-color .12s ease}
.bt-task:hover{background:var(--bt-hover)}
.bt-task[data-busy]{opacity:.6}
.bt-task-head{display:flex;align-items:center;gap:6px;min-width:0}
.bt-task-head>.bt-mark{flex:none}
.bt-task-name{min-width:0;font-size:14px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-task-status{flex:none;padding:0 6px;border-radius:999px;font-size:11px;line-height:16px;background:var(--bt-tag-bg);color:var(--bt-tag-ink)}
.bt-task[data-status=active] .bt-task-status{color:var(--bt-green)}
.bt-task[data-status=review] .bt-task-status,.bt-task[data-status=human_review] .bt-task-status{color:var(--bt-accent)}
.bt-task[data-status=failed] .bt-task-status,.bt-task[data-status=blocked] .bt-task-status{color:var(--bt-danger)}
.bt-task-time{flex:none;margin-left:auto;font-size:12px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-task-list{container-type:inline-size}
.bt-related-parent{display:grid;grid-template-columns:24px minmax(0,1fr);align-items:start}
.bt-related-toggle{width:24px;height:28px;margin-top:4px;display:grid;place-items:center}
.bt-related-toggle svg{width:14px;height:14px}
.bt-related-children{margin-inline-start:32px;padding-inline-start:16px;border-inline-start:1px solid var(--bt-line-2);display:grid;gap:2px}
.bt-project-row{box-sizing:border-box;width:100%;min-width:0;border:0;color:var(--bt-ink);background:transparent;font:inherit;text-align:start;cursor:pointer;display:flex;align-items:flex-start;gap:6px}
.bt-project-body{flex:1;min-width:0;display:grid;gap:2px}
.bt-project-row .bt-task-name{flex:1}
.bt-project-meta{display:flex;align-items:baseline;flex-wrap:wrap;gap:0 8px;min-width:0;font-size:12px;line-height:16px;color:var(--bt-ink-2);font-variant-numeric:tabular-nums}
.bt-project-branch{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
.bt-project-workspace{margin-top:6px;min-width:0;font-size:12px;line-height:1.5;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-project-workspace summary{cursor:pointer}
.bt-project-workspace summary:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-project-workspace p{margin:5px 0}
.bt-project-row:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-project-owner,.bt-project-arrow,.bt-project-statuses{display:flex;align-items:center}
.bt-project-statuses{gap:4px;flex-wrap:wrap}
.bt-project-owner{flex:none;gap:2px;flex-wrap:wrap;max-width:72px}
.bt-project-arrow{color:var(--bt-ink-2)}
.bt-project-times{display:contents}
.bt-project-times span{white-space:nowrap}
@container (max-width:420px){.bt-project-row .bt-task-name{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:normal;overflow-wrap:anywhere}}
.bt-drawer-body.bt-project-detail{display:block;overflow-wrap:anywhere}
.bt-project-detail>section+section{margin-top:20px;padding-top:16px;border-top:1px solid var(--bt-line)}
.bt-project-detail .bt-section-title{color:var(--bt-ink);font-size:17px;font-weight:600;line-height:1.35}
.bt-requirement-attachments{display:grid;justify-items:start;grid-template-columns:minmax(0,1fr);gap:6px;margin-top:12px}
.bt-requirement-attachments h4{font-size:14px;color:var(--bt-ink-2);margin:0}
.bt-requirement-attachments button{max-width:100%;white-space:normal;overflow-wrap:anywhere;text-align:start}
.bt-requirement-attachments .bt-reference-file{color:var(--bt-accent)}
.bt-project-field-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.bt-project-field-head>.bt-section-title{margin:0}
.bt-project-markdown{min-width:0;overflow-wrap:anywhere;overflow-x:auto;font-size:14px;line-height:1.5}
.bt-project-detail .bt-project-markdown ol{padding-inline-start:3.5em;list-style-position:outside}
.bt-project-markdown img,.bt-task-image img{max-width:100%;height:auto}
.bt-result-items{padding-inline-start:2.2em;list-style:decimal outside;margin:6px 0}
.bt-result-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(150px,100%),1fr));gap:8px}
.bt-result-gallery .bt-task-image-open img{width:100%;max-height:140px;object-fit:contain}
.bt-result-document{cursor:pointer;color:var(--bt-accent);text-decoration:underline;margin-top:8px}
.bt-task-image{display:grid;justify-items:start;gap:4px;margin-top:8px}
.bt-task-image img{display:block;border-radius:8px}
.bt-task-image-open{display:block;max-width:100%;padding:0;border:0;background:none;cursor:zoom-in}
.bt-task-image-open:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-task-image-preview{max-width:96vw;max-height:94vh;box-sizing:border-box;padding:10px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-main);color:var(--bt-ink)}
.bt-task-image-preview[open]{display:grid;justify-items:end;gap:8px}
.bt-task-image-preview img{max-height:80vh;object-fit:contain}
.bt-task-checkout{display:grid;gap:3px;margin:6px 0;font-size:13px}
.bt-task-checkout code,.bt-task-checkout-edit code{font-size:12px;overflow-wrap:anywhere;color:var(--bt-ink-2)}
.bt-task-checkout-edit{display:grid;gap:4px;margin-top:8px}
.bt-task-checkout-edit select{max-width:100%;width:100%;min-width:0}
.bt-project-detail textarea{font-family:ui-monospace,monospace;tab-size:4}
.bt-task-goal{margin-top:2px;font-size:13px;line-height:18px;color:var(--bt-ink)}
.bt-task-progress{margin-top:2px;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-task-result{margin-top:2px;font-size:12px;line-height:17px;color:var(--bt-ink-2);white-space:pre-wrap}
.bt-task-reason{margin-top:2px;font-size:12px;line-height:17px;color:var(--bt-ink-3)}
.bt-task-note{margin-top:4px;padding-left:6px;border-left:2px solid var(--bt-line-2);font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bt-task-actions{display:flex;gap:6px;margin-top:6px}
.bt-task-actions>.bt-soft-sm{margin:0}
.bt-task-actions>.bt-soft-sm[data-confirm]{color:var(--bt-danger)}
.bt-task-write{display:flex;align-items:center;gap:6px;margin-top:6px}
.bt-task-input{flex:1;min-width:0;height:28px;font-size:13px}
.bt-task-write>.bt-send{flex:none;margin:0}
.bt-task-history .bt-task{opacity:.85}
`

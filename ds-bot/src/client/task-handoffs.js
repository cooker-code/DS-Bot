import { createElement as h, Fragment, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { viewBottom } from './motion.js'
import { RETRY_TEXT, RETRY_PROMISE_TEXT } from '../shared/retry-prompts.js'
import { TaskPlans } from './task-plans.js'
import { TaskContent, CopyTaskText } from './task-content.js'
import { InfoIcon } from './icons.js'
import { colorOf } from './characters.js'
import { paintCss } from './inks.js'
import { t } from './i18n.js'

function retryReason(retry) {
  if (retry.restart) return t('The host restarted during execution.')
  if (retry.input === RETRY_TEXT) return t('The Bot wrote the tool call as text, so the tool did not run.')
  if (retry.input === RETRY_PROMISE_TEXT) return t('The Bot ended its turn before calling a tool.')
  if (retry.failedAt) return retry.previousOutput || t('The previous attempt failed without an error message.')
  return t('No retry reason was recorded.')
}

// One row per delivered handoff. Only an explicit parent exchange attaches
// a later send as the receiving Bot’s output.
function handoffs(detail, history) {
  const rows = []
  const received = new Map()
  const rounds = detail.rounds ?? []
  const ordered = []
  for (const edge of history?.messages ?? []) {
    if ((!edge.from && edge.sender !== 'user') || !edge.to || edge.from === edge.to) continue
    ordered.push({ at: edge.at, edge })
    const index = rounds.findIndex(round => round.dispatchId && round.dispatchId === edge.exchangeId && round.ownerId === edge.to)
    const round = rounds[index] ?? {}
    const block = rounds[round.planNode?.previousRound - 1]?.planNode?.block
    const decision = block?.decisions?.find(item => item.nextRound === index + 1)
    if (round.planNode?.previousRound) ordered.at(-1).reason =
      [...new Set([block?.reason, decision?.reason].filter(Boolean))].join('\n') || t('No retry reason was recorded.')
    for (const [i, retry] of (round.retries?.length ? round.retries : edge.retries ?? []).entries())
      ordered.push({ at: retry.at, edge, attempt: i + 1, reason: retryReason(retry) })
  }
  for (const { at, edge, attempt, reason } of ordered.sort((a, b) => a.at - b.at)) {
    if (!attempt) {
      const parent = received.get(edge.replyTo)
      if (parent && parent.owner === edge.from) parent.outputs.push(edge)
    }
    const row = { key: edge.key + '/receive/' + (attempt ?? 0), owner: edge.to, incoming: edge, at, reason, outputs: [] }
    rows.push(row)
    if (edge.exchangeId) received.set(edge.exchangeId, row)
  }
  return rows
}

function contextLabel(edge) {
  if (!edge) return ''
  return [edge.kind && ['User request', 'Result return', 'Dispatch'].includes(edge.kind) && t(edge.kind),
    edge.requirementVersion && t('Requirement v{version}', { version: edge.requirementVersion }),
    edge.kind === 'Dispatch' && !edge.requirementVersion && t('Requirement version not recorded'),
    edge.planVersion && t('Plan v{version}', { version: edge.planVersion }),
    edge.node && [t('Node {n}', { n: edge.node }), edge.nodeTitle].filter(Boolean).join(' '),
    edge.round && t('Round {number}', { number: edge.round })].filter(Boolean).join(' · ')
}

function HandoffContext({ edge, onPlan }) {
  const id = useId()
  const trigger = useRef(null)
  const tooltip = useRef(null)
  const timer = useRef(null)
  const [place, setPlace] = useState(null)
  const close = () => { clearTimeout(timer.current); setPlace(null) }
  const cancelClose = () => clearTimeout(timer.current)
  const leave = () => { timer.current = setTimeout(close, 120) }
  const show = () => {
    clearTimeout(timer.current)
    const rect = trigger.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(560, window.innerWidth - 16)
    const below = viewBottom() - rect.bottom
    const above = rect.top - (window.visualViewport?.offsetTop ?? 0)
    const useAbove = below < 180 && above > below
    setPlace({ width, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      ...(useAbove ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
      maxHeight: Math.max(40, (useAbove ? above : below) - 16) })
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (!place) return
    const scroll = event => { if (event.target === window || !tooltip.current?.contains(event.target)) close() }
    const key = event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', key, true)
    }
  }, [Boolean(place)])
  if (!edge?.planVersion && !edge?.requirementVersion && !edge?.node) return null
  const description = [contextLabel(edge), edge.planReason && t('Plan change reason') + ' · ' + edge.planReason,
    edge.planVersion && t('View plan v{version}', { version: edge.planVersion })].filter(Boolean).join('\n')
  return h(Fragment, null,
    h('button', { ref: trigger, type: 'button', className: 'bt-tool', 'aria-label': description,
      'aria-describedby': place ? id : undefined, onMouseEnter: show, onMouseLeave: leave,
      onFocus: show, onBlur: close,
      onClick: event => { event.preventDefault(); event.stopPropagation(); close(); if (edge.planVersion) onPlan(edge.planVersion) } }, h(InfoIcon)),
    place && createPortal(h('div', { ref: tooltip, id, role: 'tooltip', className: 'bt-handoff-tooltip', style: place,
      onMouseEnter: cancelClose, onMouseLeave: leave }, description), document.body))
}

function HandoffRow({ entry, children, onPlan }) {
  const [open, setOpen] = useState(false)
  const [tab, select] = useState(0)
  const id = useId()
  const tabs = entry.reason ? ['Input', 'Output', 'Retry reason'] : ['Input', 'Output']
  const output = entry.outputs[0]
  const edge = tab === 0 ? entry.incoming : tab === 1 && entry.outputs.length === 1 ? output : undefined
  const text = [entry.incoming?.text ?? t('No recorded input'), output?.text ?? t('No recorded output'),
    entry.reason ?? t('No retry this time.')][tab]
  const tabBar = h('div', { className: 'bt-task-content-modes bt-handoff-tabs', role: 'tablist', 'aria-label': t('Task handoffs') },
    tabs.map((label, i) => h('button', { key: label, type: 'button', id: id + i, role: 'tab', 'aria-selected': i === tab,
      'aria-controls': id, tabIndex: i === tab ? 0 : -1, onClick: () => select(i), onKeyDown: e => {
        const next = { ArrowLeft: (i + tabs.length - 1) % tabs.length, ArrowRight: (i + 1) % tabs.length, Home: 0, End: tabs.length - 1 }[e.key]
        if (next === undefined) return
        e.preventDefault()
        e.currentTarget.parentElement.children[next].focus()
        select(next)
      } }, t(label))))
  const sections = tab === 1 && entry.outputs.length > 0 ? entry.outputs.map(item => ({
    key: item.key, label: item.route + (Number.isFinite(item.at) ? ' · ' + new Date(item.at).toLocaleString() : ''),
    text: item.text, control: h(HandoffContext, { edge: item, onPlan }),
  })) : undefined
  return h('details', { className: 'bt-handoff-row', onToggle: e => setOpen(e.currentTarget.open) },
    children, open && h(TaskContent, { key: tab, header: h('div', { className: 'bt-handoff-content-tabs' },
      tabBar, h(HandoffContext, { edge, onPlan })), panelId: id, selectedId: id + tab, text, sections }),
    open && [edge, ...(tab === 1 ? entry.outputs : [])].some(item => item?.partial) &&
      h('small', null, t('Only part of the message is available.')))
}

export function TaskHandoffs({ detail, roster, history }) {
  const [planVersion, selectPlan] = useState(null)
  const name = id => roster?.byId?.[id]?.name ?? id
  const messages = history?.messages.map(edge => ({ ...edge,
    nodeTitle: detail.plans?.find(plan => plan.version === edge.planVersion)?.nodes?.find(node => node.no === edge.node)?.title, route: (edge.sender === 'user' ? t('User') : name(edge.from)) + ' → ' + name(edge.to) }))
  const entries = handoffs(detail, history && { ...history, messages }).map((entry, index) => {
    const bot = roster?.byId?.[entry.owner]
    const label = [String(index + 1) + '. ' + (entry.incoming.sender === 'user' ? t('User') : name(entry.incoming.from)) + ' → ' + name(entry.incoming.to),
      ['User request', 'Result return', 'Dispatch'].includes(entry.incoming.kind) && t(entry.incoming.kind), entry.reason && t('Retry')].filter(Boolean).join(' · ')
    return { ...entry, label, background: paintCss(colorOf(bot ?? { id: entry.owner })) }
  })
  return h('section', { 'aria-label': t('Task handoffs') },
    detail.title && h('div', { className: 'bt-task-detail-name' }, h('h2', null, detail.title),
      h(CopyTaskText, { text: detail.title, label: t('Copy task name') })),
    h('h3', { className: 'bt-section-title' }, t('Task handoffs')),
    h(TaskPlans, { plans: detail.plans, roster, version: planVersion, onSelect: selectPlan }),
    !history && h('small', { role: 'status' }, t('Loading message history…')),
    history?.incomplete && h('small', { role: 'status' }, t('Some session history is unavailable.')),
    entries.length ? h('div', { className: 'bt-handoff-bar', 'aria-hidden': true },
      entries.map(entry => h('span', { key: entry.key, style: { background: entry.background }, title: entry.label, 'data-retry': Boolean(entry.reason) })))
      : history && h('p', { className: 'bt-empty' }, t('No Bot handoffs recorded.')),
    entries.map(entry => h(HandoffRow, { key: entry.key, entry, onPlan: selectPlan },
      h('summary', null, h('span', { className: 'bt-handoff-dot', style: { background: entry.background } }), entry.label, h(HandoffContext, { edge: entry.incoming, onPlan: selectPlan }),
        Number.isFinite(entry.at) && h('time', null, new Date(entry.at).toLocaleString())))))
}

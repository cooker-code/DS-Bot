import { createElement as h, useId, useState } from 'react'
import { RETRY_TEXT, RETRY_PROMISE_TEXT } from '../shared/retry-prompts.js'
import { TaskContent, CopyTaskText } from './task-content.js'
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
      if (parent?.owner === edge.from) parent.outputs.push(edge)
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
    edge.node && t('Node {n}', { n: edge.node }),
    edge.round && t('Round {number}', { number: edge.round })].filter(Boolean).join(' · ')
}

const tabs = ['Input', 'Output', 'Retry reason']
function HandoffRow({ entry, children }) {
  const [open, setOpen] = useState(false)
  const [tab, select] = useState(0)
  const id = useId()
  const [outputIndex, selectOutput] = useState(0)
  const output = entry.outputs[outputIndex] ?? entry.outputs[0]
  const edge = [entry.incoming, output][tab]
  const text = [entry.incoming?.text ?? t('No recorded input'), output?.text ?? t('No recorded output'),
    entry.reason ?? t('No retry this time.')][tab]
  const tabBar = h('div', { className: 'bt-task-content-modes bt-handoff-tabs', role: 'tablist', 'aria-label': t('Task handoffs') },
    tabs.map((label, i) => h('button', { key: label, type: 'button', id: id + i, role: 'tab', 'aria-selected': i === tab,
      'aria-controls': id, tabIndex: i === tab ? 0 : -1, onClick: () => select(i), onKeyDown: e => {
        const next = { ArrowLeft: (i + 2) % 3, ArrowRight: (i + 1) % 3, Home: 0, End: 2 }[e.key]
        if (next === undefined) return
        e.preventDefault()
        e.currentTarget.parentElement.children[next].focus()
        select(next)
      } }, t(label))))
  return h('details', { className: 'bt-handoff-row', onToggle: e => setOpen(e.currentTarget.open) },
    children, open && edge?.planReason && h('small', { className: 'bt-handoff-context' }, t('Plan change reason') + ' · ' + edge.planReason), open && h(TaskContent, { key: tab + '/' + outputIndex, header: h('div', { className: 'bt-handoff-content-tabs' }, tabBar, h('small', null, contextLabel(edge)),
      tab === 1 && entry.outputs.length > 1 && h('select', { 'aria-label': t('Output recipient'), value: outputIndex,
        onChange: e => selectOutput(Number(e.target.value)) }, entry.outputs.map((item, index) =>
          h('option', { key: item.key, value: index }, item.route, contextLabel(item) && ' · ' + contextLabel(item), Number.isFinite(item.at) && ' · ' + new Date(item.at).toLocaleString())))), panelId: id, selectedId: id + tab, text }),
    open && edge?.partial && h('small', null, t('Only part of the message is available.')))
}

export function TaskHandoffs({ detail, roster, history }) {
  const name = id => roster?.byId?.[id]?.name ?? id
  const messages = history?.messages.map(edge => ({ ...edge, route: (edge.sender === 'user' ? t('User') : name(edge.from)) + ' → ' + name(edge.to) }))
  const entries = handoffs(detail, history && { ...history, messages }).map((entry, index) => {
    const bot = roster?.byId?.[entry.owner]
    const label = [String(index + 1) + '. ' + (entry.incoming.sender === 'user' ? t('User') : name(entry.incoming.from)) + ' → ' + name(entry.incoming.to),
      contextLabel(entry.incoming), entry.reason && t('Retry')].filter(Boolean).join(' · ')
    return { ...entry, label, background: paintCss(colorOf(bot ?? { id: entry.owner })) }
  })
  return h('section', { 'aria-label': t('Task handoffs') },
    detail.title && h('div', { className: 'bt-task-detail-name' }, h('h2', null, detail.title),
      h(CopyTaskText, { text: detail.title, label: t('Copy task name') })),
    h('h3', { className: 'bt-section-title' }, t('Task handoffs')),
    !history && h('small', { role: 'status' }, t('Loading message history…')),
    history?.incomplete && h('small', { role: 'status' }, t('Some session history is unavailable.')),
    entries.length ? h('div', { className: 'bt-handoff-bar', 'aria-hidden': true },
      entries.map(entry => h('span', { key: entry.key, style: { background: entry.background }, title: entry.label, 'data-retry': Boolean(entry.reason) })))
      : history && h('p', { className: 'bt-empty' }, t('No Bot handoffs recorded.')),
    entries.map(entry => h(HandoffRow, { key: entry.key, entry },
      h('summary', null, h('span', { className: 'bt-handoff-dot', style: { background: entry.background } }), entry.label,
        Number.isFinite(entry.at) && h('time', null, new Date(entry.at).toLocaleString())))))
}

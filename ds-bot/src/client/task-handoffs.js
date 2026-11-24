import { createElement as h, useState } from 'react'
import { RETRY_TEXT, RETRY_PROMISE_TEXT } from '../shared/retry-prompts.js'
import { TaskContent, CopyTaskText } from './task-content.js'
import { colorOf } from './characters.js'
import { paintCss } from './inks.js'
import { t } from './i18n.js'

function legacyInput(rounds, round, index) {
  const node = round.planNode
  const predecessors = node ? (node.inputs ?? []).map(input => rounds[input.round - 1]) : [rounds[index - 1]]
  return [round.plan, ...predecessors.map(run => run?.result)].filter(Boolean).join('\n\n')
}

function retryReason(retry) {
  if (retry.restart) return t('The host restarted during execution.')
  if (retry.input === RETRY_TEXT) return t('The Bot wrote the tool call as text, so the tool did not run.')
  if (retry.input === RETRY_PROMISE_TEXT) return t('The Bot ended its turn before calling a tool.')
  if (retry.failedAt) return retry.previousOutput || t('The previous attempt failed without an error message.')
  return t('No retry reason was recorded.')
}

function handoffs(detail, history) {
  const rounds = detail.rounds ?? []
  const messages = history?.messages ?? []
  const dispatches = new Map()
  for (const message of messages) if (message.exchangeId && !message.repeated && !dispatches.has(message.exchangeId))
    dispatches.set(message.exchangeId, message)
  const used = new Set()
  const entries = []
  for (const [index, round] of rounds.entries()) {
    const node = round.planNode
    const dispatch = dispatches.get(round.dispatchId)
    if (dispatch) used.add(dispatch.key)
    for (const retry of round.retries ?? []) {
      const received = messages.find(m => m.exchangeId === round.dispatchId && !used.has(m.key) && m.text === retry.input)
      if (received) used.add(received.key)
    }
    const plan = detail.plans?.find(plan => plan.version === node?.version)
    const title = plan?.nodes?.find(item => item.no === node.node)?.title
    const block = rounds[node?.previousRound - 1]?.planNode?.block
    const decision = block?.decisions?.find(item => item.nextRound === index + 1)
    const firstAt = dispatch?.at ?? round.sentAt ?? round.startedAt ?? round.assignedAt
    const attempts = [{ at: round.retries?.length ? Math.min(firstAt ?? Infinity, round.retries[0].at) : firstAt,
      input: [round.dispatchInput ?? dispatch?.text ?? legacyInput(rounds, round, index), ...(round.inputFiles ?? [])].filter(Boolean).join('\n'),
      retry: Boolean(node?.previousRound), restart: block?.cause === 'restart',
      reason: [...new Set([block?.reason, decision?.reason].filter(Boolean))].join('\n') },
    ...(round.retries ?? []).map(retry => ({ ...retry, retry: true, reason: retryReason(retry) }))]
    attempts.forEach((attempt, i) => {
      const next = attempts[i + 1]
      const output = next ? (next.previousOutput || (next.failedAt ? t('Attempt failed') : '')) :
        [round.result, node?.lateResult, node?.artifact, node?.completed, node?.checkpointArtifact,
          node?.block?.reason, node?.block?.evidence, round.failedAt && t('Attempt failed'),
          ...(round.resultFiles ?? []).map(file => file.name)].filter(Boolean).join('\n')
      entries.push({ ...attempt, from: i === 0 ? dispatch?.from : undefined, title, node, round: index + 1, key: (round.dispatchId ?? index) + '/' + i, ownerId: round.ownerId,
        waiting: !round.startedAt && !round.result && !node?.block && !round.failedAt && !attempt.retry, output })
    })
    if (round.submittedAt) entries.push({ key: 'submit-' + index, at: round.submittedAt, ownerId: round.ownerId,
      kind: 'Submitted result', title, output: round.result, round: index + 1 })
    if (node?.acceptedAt) entries.push({ key: 'approve-' + index, at: node.acceptedAt, ownerId: node.acceptedBy,
      kind: 'Approved result', title, input: round.result, output: node.artifact, round: index + 1 })
  }
  for (const plan of detail.plans ?? []) entries.push({ key: 'plan-' + plan.version, at: plan.at, ownerId: plan.by,
    kind: 'Task plan', title: 'v' + plan.version, input: plan.reason, output: plan.nodes.map(n => n.no + '. ' + n.title).join('\n') })
  for (const m of messages) {
    if (used.has(m.key)) continue
    entries.push({ key: m.key, at: m.at, from: m.from, sender: m.sender, to: m.to, ownerId: m.to ?? m.from,
      kind: m.kind, message: m.text, partial: m.partial })
  }
  return entries.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
}

function HandoffRow({ children }) {
  const [open, setOpen] = useState(false)
  return h('details', { className: 'bt-handoff-row', onToggle: event => setOpen(event.currentTarget.open) },
    children[0], open && children.slice(1))
}

export function TaskHandoffs({ detail, roster, history }) {
  const name = id => roster?.byId?.[id]?.name ?? id
  const entries = handoffs(detail, history).map((entry, index) => {
    const bot = roster?.byId?.[entry.ownerId]
    const flags = [entry.retry && t('Retry'), entry.restart && t('Restart recovery'), entry.waiting && t('Assigned, awaiting start')]
    let route = name(entry.ownerId) ?? t('DS Bot')
    if (entry.to || entry.kind === 'Group message') route = (name(entry.from) ?? entry.sender ?? t('DS Bot')) + ' → ' + (name(entry.to) ?? t('Group chat'))
    else if (entry.from) route = name(entry.from) + ' → ' + route
    const context = entry.kind ? t(entry.kind) : entry.node ? t('Dispatch') : ''
    const nodeLabel = entry.node?.node && 'v' + entry.node.version + ' · ' + t('Node {n}', { n: entry.node.node })
    const label = [String(index + 1) + '. ' + route, context, nodeLabel, entry.title, ...flags].filter(Boolean).join(' · ')
    return { ...entry, label, background: paintCss(colorOf(bot ?? { id: entry.ownerId })) }
  })
  return h('section', { 'aria-label': t('Task handoffs') },
    detail.title && h('div', { className: 'bt-task-detail-name' }, h('h2', null, detail.title),
      h(CopyTaskText, { text: detail.title, label: t('Copy task name') })),
    h('h3', { className: 'bt-section-title' }, t('Task handoffs')),
    !history && h('small', { role: 'status' }, t('Loading message history…')),
    history?.incomplete && h('small', { role: 'status' }, t('Some session history is unavailable.')),
    entries.length ? h('div', { className: 'bt-handoff-bar', 'aria-hidden': true },
      entries.map(entry => h('span', { key: entry.key, style: { background: entry.background }, title: entry.label, 'data-retry': entry.retry })))
      : h('p', { className: 'bt-empty' }, t('No assignments yet')),
    entries.map(entry => h(HandoffRow, { key: entry.key },
      h('summary', null, h('span', { className: 'bt-handoff-dot', style: { background: entry.background } }), entry.label, Number.isFinite(entry.at) && h('time', null, new Date(entry.at).toLocaleString())),
      entry.message !== undefined ? h(TaskContent, { label: t('Message text'), text: entry.message }) :
        h(TaskContent, { label: t('Handoff input'), text: entry.input || t('No recorded input') }),
      entry.partial && h('small', null, t('Only part of the message is available.')),
      entry.message === undefined && h(TaskContent, { label: t('Handoff output'), text: entry.output || t('No recorded output') }),
      entry.retry && h(TaskContent, { label: t('Retry reason'), text: entry.reason || t('No retry reason was recorded.') }))))
}

import { createElement as h } from 'react'
import { RETRY_TEXT, RETRY_PROMISE_TEXT } from '../shared/retry-prompts.js'
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

function handoffs(rounds) {
  const entries = []
  for (const [index, round] of rounds.entries()) {
    const node = round.planNode
    const block = rounds[node?.previousRound - 1]?.planNode?.block
    const decision = block?.decisions?.find(item => item.nextRound === index + 1)
    const firstAt = round.startedAt ?? round.sentAt ?? round.assignedAt
    const attempts = [{ at: round.retries?.length ? Math.min(firstAt ?? Infinity, round.retries[0].at) : firstAt,
      input: [round.dispatchInput ?? legacyInput(rounds, round, index), ...(round.inputFiles ?? [])].filter(Boolean).join('\n'),
      retry: Boolean(node?.previousRound), restart: block?.cause === 'restart',
      reason: [...new Set([block?.reason, decision?.reason].filter(Boolean))].join('\n') },
    ...(round.retries ?? []).map(retry => ({ ...retry, retry: true, reason: retryReason(retry) }))]
    attempts.forEach((attempt, i) => {
      const next = attempts[i + 1]
      const output = next ? (next.previousOutput || (next.failedAt ? t('Attempt failed') : '')) :
        [round.result, node?.lateResult, node?.artifact, node?.completed, node?.checkpointArtifact,
          node?.block?.reason, node?.block?.evidence, round.failedAt && t('Attempt failed'),
          ...(round.resultFiles ?? []).map(file => file.name)].filter(Boolean).join('\n')
      entries.push({ ...attempt, key: (round.dispatchId ?? index) + '/' + i, ownerId: round.ownerId,
        waiting: !round.startedAt && !round.result && !node?.block && !round.failedAt && !attempt.retry, output })
    })
  }
  return entries.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
}

export function TaskHandoffs({ detail, roster }) {
  const entries = handoffs(detail.rounds ?? []).map((entry, index) => {
    const bot = roster?.byId?.[entry.ownerId]
    const flags = [entry.retry && t('Retry'), entry.restart && t('Restart recovery'), entry.waiting && t('Assigned, awaiting start')]
    const label = [String(index + 1) + '. ' + (bot?.name ?? entry.ownerId ?? t('Deleted Bot')), ...flags.filter(Boolean)].join(' · ')
    return { ...entry, label, background: paintCss(colorOf(bot ?? { id: entry.ownerId })) }
  })
  return h('section', { 'aria-label': t('Task handoffs') },
    h('h3', { className: 'bt-section-title' }, t('Task handoffs')),
    entries.length ? h('div', { className: 'bt-handoff-bar', 'aria-hidden': true },
      entries.map(entry => h('span', { key: entry.key, style: { background: entry.background }, title: entry.label, 'data-retry': entry.retry })))
      : h('p', { className: 'bt-empty' }, t('No assignments yet')),
    entries.map(entry => h('details', { key: entry.key, className: 'bt-handoff-row' },
      h('summary', null, h('span', { className: 'bt-handoff-dot', style: { background: entry.background } }), entry.label),
      h('strong', null, t('Handoff input')), h('p', null, entry.input || t('No recorded input')),
      h('strong', null, t('Handoff output')), h('p', null, entry.output || t('No recorded output')),
      entry.retry && h('strong', null, t('Retry reason')),
      entry.retry && h('p', null, entry.reason || t('No retry reason was recorded.')))))
}

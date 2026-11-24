import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import { TaskContent } from './task-content.js'
import { hostText, t } from './i18n.js'

const labels = {
  at: 'Plan created', by: 'Planner', reason: 'Plan change reason', ownerId: 'Node owner', title: 'Title',
  instructions: 'Instructions', deliverable: 'Deliverable', acceptance: 'Acceptance criteria',
  dependsOn: 'Dependencies', repository: 'Repository', baseRef: 'Base branch', workRef: 'Branch',
  workDir: 'Working directory', environment: 'Execution environment', contextGap: 'Missing context',
  workspaceMode: 'Workspace mode', workspaceReason: 'Workspace reason', writePaths: 'Write paths',
  independentReview: 'Independent review', fixedOwner: 'Fixed owner', reuseRound: 'Reused round',
}

function valueText(key, value, roster) {
  if (value === undefined) return t('Not recorded')
  if (key === 'ownerId' || key === 'by') {
    const name = roster?.byId?.[value]?.name
    return name && name !== value ? name + ' (' + value + ')' : String(value)
  }
  if (key === 'at' && Number.isFinite(value)) return new Date(value).toLocaleString() + ' (' + value + ')'
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function fieldsText(object, roster, omitted = []) {
  return Object.entries(object).filter(([key]) => !omitted.includes(key))
    .map(([key, value]) => '#### ' + t(labels[key] ?? key) + '\n\n' + valueText(key, value, roster)).join('\n\n')
}

function nodeText(node, roster) {
  return '### ' + t('Node {n}', { n: node.no }) + ' · ' + node.title + '\n\n' + fieldsText(node, roster, ['no', 'title'])
}

export function fullPlanText(plan, roster) {
  return ['# ' + t('Plan v{version}', { version: plan.version }), fieldsText(plan, roster, ['version', 'nodes']),
    ...(plan.nodes ?? []).map(node => nodeText(node, roster))].filter(Boolean).join('\n\n')
}

function sameValue(a, b) {
  const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
  return canonical(a) === canonical(b)
}

function changedFields(before, after, roster, omitted = []) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => !omitted.includes(key) && !sameValue(before[key], after[key]))
    .map(key => '#### ' + t(labels[key] ?? key) + '\n\n**' + t('Before change') + '**\n\n' +
      valueText(key, before[key], roster) + '\n\n**' + t('After change') + '**\n\n' + valueText(key, after[key], roster))
    .join('\n\n')
}

export function planDifferenceText(before, after, roster) {
  const sections = ['# ' + t('Changes from plan v{before} to v{after}', { before: before.version, after: after.version })]
  const fields = changedFields(before, after, roster, ['version', 'at', 'by', 'nodes'])
  if (fields) sections.push(fields)
  const oldNodes = new Map((before.nodes ?? []).map(node => [node.no, node]))
  const newNodes = new Map((after.nodes ?? []).map(node => [node.no, node]))
  for (const no of [...new Set([...oldNodes.keys(), ...newNodes.keys()])].sort((a, b) => a - b)) {
    const old = oldNodes.get(no), current = newNodes.get(no)
    if (!old) sections.push('## ' + t('Added node {n}', { n: no }), nodeText(current, roster))
    else if (!current) sections.push('## ' + t('Removed node {n}', { n: no }), nodeText(old, roster))
    else {
      const changes = changedFields(old, current, roster, ['no'])
      if (changes) sections.push('## ' + t('Changed node {n}', { n: no }), changes)
    }
  }
  return sections.length === 1 ? sections[0] + '\n\n' + t('No plan content changes.') : sections.join('\n\n')
}

export function planHistory(plans, rounds, entries, failures) {
  const ordered = [...plans].sort((a, b) => a.version - b.version)
  return ordered.map((plan, i) => {
    const bound = rounds.filter(round => round.planNode?.version === plan.version)
    const delivered = entries.flatMap((entry, index) => entry.incoming.kind === 'Dispatch' && entry.incoming.planVersion === plan.version
      ? [{ entry, number: index + 1 }] : [])
    const prior = entries.map((entry, index) => ({ entry, number: index + 1 })).filter(item => item.entry.at <= plan.at).at(-1)
    const next = entries.map((entry, index) => ({ entry, number: index + 1 })).find(item => item.entry.at > plan.at)
    return { plan, nextPlan: ordered[i + 1], prior, next, delivered,
      status: delivered.length || bound.some(round => round.sentAt) ? 'Dispatched' : bound.length ? 'Dispatch registered; delivery not recorded' : 'Not dispatched',
      failures: failures.filter(failure => failure.version === plan.version),
      showReason: !bound.length || (i > 0 && !rounds.some(round => round.planNode?.version === ordered[i - 1].version)) }
  })
}

function PlanHistory({ plans, rounds, entries, history, roster, onSelect, onReveal }) {
  const records = planHistory(plans, rounds, entries, history?.planDispatchFailures ?? [])
  const link = (item, label) => h('button', { type: 'button', className: 'bt-mini', 'aria-controls': item.entry.id,
    onClick: () => onReveal({ key: item.entry.key }) }, t(label, { number: item.number }))
  const time = at => Number.isFinite(at) ? new Date(at).toLocaleString() : t('Not recorded')
  return h('details', { className: 'bt-plan-history', open: true },
    h('summary', null, t('Plan version history')),
    h('ol', null, records.map(({ plan, nextPlan, prior, next, delivered, status, failures, showReason }) =>
      h('li', { key: plan.version, 'data-plan-version': plan.version },
        h('div', { className: 'bt-plan-history-meta' }, h('strong', null, t('Plan v{version}', { version: plan.version })),
          h('span', null, t('Saved {time}', { time: time(plan.at) })),
          h('span', null, t('Saved by {name}', { name: roster?.byId?.[plan.by]?.name ?? plan.by ?? t('Not recorded') })),
          h('strong', null, t(status)),
          h('button', { type: 'button', className: 'bt-mini', 'aria-label': t('View plan v{version}', { version: plan.version }),
            onClick: () => onSelect(plan.version) }, t('Full plan'))),
        history && h('div', { className: 'bt-plan-history-meta' }, t('Saved in the flow'),
          prior && link(prior, 'After handoff {number}'), next && link(next, 'Before handoff {number}'),
          !prior && !next && t('No matching handoff recorded.')),
        delivered.length > 0 && h('div', { className: 'bt-plan-history-meta' }, t('Dispatched handoffs'),
          delivered.map(item => h('button', { key: item.entry.key, type: 'button', className: 'bt-mini',
            'aria-controls': item.entry.id, onClick: () => onReveal({ key: item.entry.key }) },
          t('Handoff {number}', { number: item.number }) + ' · ' + item.entry.label.replace(/^\d+\.\s*/, '')))),
        status === 'Dispatched' && !delivered.length && history && h('p', null, t('Delivery is recorded, but its handoff history is unavailable.')),
        failures.map(failure => h('p', { key: failure.sessionId + '/' + failure.seq, className: 'bt-plan-dispatch-failure' },
          t('Dispatch failed') + ' · ' + time(failure.at) + ' · ' + t('Node {n}', { n: failure.node }) + ' · ' +
          hostText(failure.error.replace(/^Error:\s*/, '')))),
        status === 'Not dispatched' && !failures.length && h('p', null,
          t(history ? 'No undispatched reason was recorded.' : 'Loading dispatch history…')),
        plan.reason && h('details', { open: showReason, className: 'bt-plan-change-reason' },
          h('summary', null, t('Plan change reason')), h('p', null, plan.reason)),
        nextPlan && h('div', { className: 'bt-plan-history-meta' },
          t('Next version saved {time}', { time: time(nextPlan.at) }),
          h('button', { type: 'button', className: 'bt-mini', onClick: () => onSelect(nextPlan.version) },
            t('View plan v{version}', { version: nextPlan.version })))))))
}

export function TaskPlans({ plans = [], roster, version, onSelect, rounds = [], entries = [], history, onReveal }) {
  const [mode, setMode] = useState('full')
  const id = useId()
  const panel = useRef(null)
  const ordered = [...plans].sort((a, b) => a.version - b.version)
  const current = ordered.find(plan => plan.version === version)
  const previous = ordered.filter(plan => plan.version < version).at(-1)
  const activeMode = previous ? mode : 'full'
  useEffect(() => { if (current) panel.current?.scrollIntoView({ block: 'nearest' }) }, [version])
  if (!plans.length) return null
  return h('div', { className: 'bt-task-plans', ref: panel },
    h('div', { className: 'bt-task-plan-versions' }, h('strong', null, t('Execution plans')),
      ordered.map(plan => h('button', { key: plan.version, type: 'button', className: 'bt-mini',
        'aria-pressed': version === plan.version, onClick: () => onSelect(plan.version) },
      t('Plan v{version}', { version: plan.version }))),
      current && h('button', { type: 'button', className: 'bt-mini', onClick: () => onSelect(null) }, t('Close'))),
    current && h('p', { className: 'bt-handoff-context' }, t('Node numbers identify work items within this plan version.')),
    current && h(TaskContent, { key: current.version + activeMode, panelId: id, selectedId: id + activeMode,
      header: h('div', { className: 'bt-task-content-modes', role: 'tablist', 'aria-label': t('Execution plans') },
        ['full', 'diff'].map(item => h('button', { key: item, type: 'button', role: 'tab', id: id + item,
          'aria-controls': id, 'aria-selected': activeMode === item, disabled: item === 'diff' && !previous,
          onClick: () => setMode(item), onKeyDown: event => {
            if (!previous || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : item === 'full' ? 1 : 0
            event.currentTarget.parentElement.children[next].focus()
            setMode(next ? 'diff' : 'full')
          } }, item === 'full' ? t('Full plan') :
            previous ? t('Compare with v{version}', { version: previous.version }) : t('First plan version')))),
      text: activeMode === 'diff' ? planDifferenceText(previous, current, roster) : fullPlanText(current, roster) }),
    h(PlanHistory, { plans, rounds, entries, history, roster, onSelect, onReveal }))
}

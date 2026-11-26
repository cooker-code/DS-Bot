import { createElement as h, useEffect, useRef } from 'react'
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

export function unsentPlanNotes(plans, rounds, entries, failures, roster) {
  const ordered = [...plans].sort((a, b) => a.version - b.version)
  const time = at => Number.isFinite(at) ? new Date(at).toLocaleString() : t('Not recorded')
  return ordered.flatMap(plan => {
    const bound = rounds.filter(round => round.planNode?.version === plan.version)
    if (bound.some(round => round.sentAt) || entries.some(entry =>
      entry.incoming.kind === 'Dispatch' && entry.incoming.planVersion === plan.version)) return []
    const anchor = entries.filter(entry => entry.at <= plan.at).at(-1)
    const reasons = failures.filter(failure => failure.version === plan.version)
    const description = [t('Plan v{version}', { version: plan.version }) + ' · ' +
      t(bound.length ? 'Dispatch registered; delivery not recorded' : 'Not dispatched'),
    t('Saved {time}', { time: time(plan.at) }) + ' · ' +
      t('Saved by {name}', { name: roster?.byId?.[plan.by]?.name ?? plan.by ?? t('Not recorded') }),
    ...reasons.map(failure => t('Dispatch failed') + ' · ' + time(failure.at) + ' · ' + t('Node {n}', { n: failure.node }) + '\n' +
      hostText(failure.error.replace(/^Error:\s*/, ''))),
    !reasons.length && t('No undispatched reason was recorded.')].filter(Boolean).join('\n')
    return [{ version: plan.version, after: anchor?.key, description }]
  })
}

const nodeStatuses = { verified: 'Done', active: 'In progress', ready: 'Ready', waiting: 'Waiting for dependencies', assigned: 'Assigned', delivered: 'Delivered', review: 'Awaiting review', blocked: 'Blocked', failed: 'Failed', omitted: 'Cancelled' }

export function TaskPlans({ plans = [], roster, version, onSelect }) {
  const panel = useRef(null)
  const ordered = [...plans].sort((a, b) => a.version - b.version)
  const current = ordered.find(plan => plan.version === version) ?? ordered.at(-1)
  const previous = ordered.filter(plan => plan.version < current?.version).at(-1)
  useEffect(() => { if (version) panel.current?.scrollIntoView({ block: 'nearest' }) }, [version])
  if (!current) return null
  const nodes = current.nodes ?? []
  const total = nodes.filter(node => node.status !== 'omitted').length
  const completed = nodes.filter(node => node.status === 'verified').length
  const name = id => roster?.byId?.[id]?.name ?? t('Not recorded')
  return h('section', { className: 'bt-task-plans', ref: panel, 'aria-label': t('Execution plans') },
    h('div', { className: 'bt-task-plan-versions' }, h('strong', null, t('Execution plans')),
      h('select', { className: 'bt-select', value: current.version, 'aria-label': t('Plan version'), onChange: event => onSelect(Number(event.target.value)) },
        ordered.map(plan => h('option', { key: plan.version, value: plan.version }, t('Plan v{version}', { version: plan.version })))),
      h('span', { role: 'status' }, t('{completed} of {total} completed', { completed, total }))),
    h('ol', { className: 'bt-plan-checklist' }, nodes.map(node => h('li', { key: node.itemId ?? node.no, 'data-status': node.status },
      h('details', null,
        h('summary', null, h('input', { type: 'checkbox', checked: node.status === 'verified', disabled: true, 'aria-label': node.title }),
          h('span', { className: 'bt-plan-item-title' }, node.title),
          h('span', { className: 'bt-plan-item-meta' }, name(node.ownerId), ' · ', t(nodeStatuses[node.status] ?? 'Not started'))),
        h('div', { className: 'bt-plan-item-body' },
          node.dependsOn?.length > 0 && h('p', null, t('Dependencies'), ': ', node.dependsOn.map(no => nodes.find(item => item.no === no)?.title ?? no).join(', ')),
          node.reuseRound && h('p', null, t('Completed in an earlier plan')),
          h(TaskContent, { text: ['### ' + t('Instructions'), node.instructions, '### ' + t('Deliverable'), node.deliverable,
            '### ' + t('Acceptance criteria'), node.acceptance].filter(Boolean).join('\n\n') })))))),
    h('details', { className: 'bt-plan-metadata' }, h('summary', null, t('Plan details')),
      h(TaskContent, { text: fullPlanText(current, roster) })),
    previous && h('details', { className: 'bt-plan-metadata' }, h('summary', null, t('Compare with v{version}', { version: previous.version })),
      h(TaskContent, { text: planDifferenceText(previous, current, roster) })))
}

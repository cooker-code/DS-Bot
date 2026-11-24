import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import { TaskContent } from './task-content.js'
import { t } from './i18n.js'

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

export function TaskPlans({ plans = [], roster, version, onSelect }) {
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
      text: activeMode === 'diff' ? planDifferenceText(previous, current, roster) : fullPlanText(current, roster) }))
}

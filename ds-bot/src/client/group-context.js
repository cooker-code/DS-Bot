import { createElement as h, useEffect, useId, useState } from 'react'
import { t } from './i18n.js'

export function useGroupContext(room, actions) {
  const [read, setRead] = useState(null)
  const ids = room.members.map(id => room.memberSessions?.[id]?.at(-1)?.id ?? '').join(',')
  useEffect(() => {
    if (!actions.roomContext) return
    let active = true
    let timer
    async function refresh() {
      let members
      try { members = await actions.roomContext(room.id) } catch { members = {} }
      if (!active) return
      setRead({ roomId: room.id, members })
      timer = setTimeout(refresh, 5000)
    }
    void refresh()
    return () => { active = false; clearTimeout(timer) }
  }, [room.id, ids, actions.roomContext])
  return read?.roomId === room.id ? read.members : {}
}

function Help({ label, text }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  return h('span', { className: 'bt-context-help', onMouseEnter: () => setOpen(true), onMouseLeave: () => setOpen(false) },
    h('button', { type: 'button', 'aria-label': t(label), 'aria-describedby': open ? id : undefined,
      onFocus: () => setOpen(true), onBlur: () => setOpen(false), onClick: () => setOpen(true),
      onKeyDown: e => { if (e.key === 'Escape') setOpen(false) } }, '?'),
    open && h('span', { role: 'tooltip', id }, t(text)))
}

export function MemberContext({ room, member, stats }) {
  const configured = room.memberSettings?.[member.id]?.model ?? member.model
  const model = stats?.model ?? (configured && t('Configured: {model}', { model: configured })) ?? t('Model unknown')
  const effort = stats?.model ? stats.effort : member.effort
  return h('small', { className: 'bt-member-context' },
    [model, stats?.supportsEffort === false ? t('No reasoning levels') : effort ? t('Reasoning: {effort}', { effort }) : t('Default reasoning'),
      stats?.percent == null ? t('Context unavailable') : t('Context {percent}%', { percent: stats.percent })].join(' · '))
}

export function GroupContext({ room, members, stats, actions, run, readOnly }) {
  const [selected, select] = useState('')
  const target = members.find(member => member.id === selected) ?? members[0]
  const current = target && stats[target.id]
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(null)
  const policy = room.contextPolicy ?? 'system'
  const submit = async action => {
    setBusy(true)
    try { return await run(action()) } finally { setBusy(false) }
  }
  return h('div', { className: 'bt-group-context' },
    h('details', null, h('summary', null, t('Session handoff')),
      ...[['system', 'Let the system decide', 'For ongoing work, the system chooses whether to compress this session or start a new one.'],
        ['summary', 'Automatically start with a summary', 'For independent tasks. After a member reaches the warning level, start its next session with a summary at the end of its turn.']].map(([value, label, text]) =>
        h('div', { key: value }, h('label', null, h('input', { type: 'radio', name: 'context-' + room.id, checked: policy === value,
          disabled: readOnly || busy, onChange: () => submit(() => actions.updateRoom(room.id, { contextPolicy: value })) }), t(label)), h(Help, { label, text }))),
      h('div', null, h('select', { value: target?.id ?? '', 'aria-label': t('Member'), onChange: e => select(e.target.value) },
        members.map(member => h('option', { key: member.id, value: member.id }, member.name))),
      h('button', { type: 'button', className: 'bt-soft', disabled: readOnly || busy || !current?.id || current.status === 'pending',
        onClick: async () => { if (await submit(() => actions.memberSummary(room.id, target.id, current.id))) setSent(current.id) } }, t('Start with summary once')),
      h(Help, { label: 'Start with summary once', text: 'For a new topic. Carry a summary and recent messages into this member’s next session after the current reply. Keep the group preference.' })),
      h('small', { role: 'status' }, current?.status === 'failed' ? t('Summary unavailable; previous session retained.')
        : current?.status === 'pending' || (sent && sent === current?.id) ? t('Handoff requested') : '')))
}

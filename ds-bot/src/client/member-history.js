import { createElement as h, useEffect, useRef, useState } from 'react'
import { ChevronLeftIcon, CloseIcon } from './icons.js'
import { MarkdownText } from './dsh-primitives.js'
import { messageClock } from './text.js'
import { mdLabels, t } from './i18n.js'

function memberHistoryRows(records, bot, room) {
  const rows = []
  for (const { event } of records) {
    const { type, seq, time, data } = event
    if (type === 'tool/call') {
      let text = data.name
      if (data.name === 'post_to_group') {
        let args = data.arguments
        if (typeof args === 'string') {
          try { args = JSON.parse(args) } catch { args = null }
        }
        if (typeof args?.message === 'string') text = args.message
      }
      rows.push({ seq, time, name: bot, text })
      continue
    }
    if (type !== 'user/message' && type !== 'assistant/message') continue
    const assistant = type === 'assistant/message'
    const content = assistant ? data.message?.content : data.content
    const text = (content ?? []).map(block => {
      if (block.type === 'text') return block.text
      if (block.type === 'file' || block.type === 'image') return block.attachment?.name ?? t('File')
      return ''
    }).filter(Boolean).join('\n')
    if (text) rows.push({ seq, time, name: assistant ? bot : data.source?.senderName ?? room, text })
  }
  return rows
}

export function MemberHistory({ member, label, bot, actions, hasStrip, back, close }) {
  const [rows, setRows] = useState([])
  const [before, setBefore] = useState(undefined)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const request = useRef(null)
  const load = async cursor => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError('')
    try {
      const result = await actions.memberHistory(member.id, cursor, controller.signal)
      if (controller.signal.aborted) return
      if (!result.ok) throw new Error(result.error.message)
      const { records, hasMore } = result.value
      const next = memberHistoryRows(records, bot.name, member.roomName)
      setRows(old => cursor === undefined ? next : [...next, ...old])
      setBefore(hasMore ? records[0]?.event.seq : undefined)
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message ?? String(failure))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  useEffect(() => {
    void load(undefined)
    return () => request.current?.abort()
  }, [member.id])
  return [
    h('div', { key: 'head', className: 'bt-subhead' },
      h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back to details'), onClick: back }, h(ChevronLeftIcon)),
      h('span', { className: 'bt-subhead-title' }, bot.name, ' · ', label),
      hasStrip ? null : h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close details'), onClick: close }, h(CloseIcon))),
    h('div', { key: 'body', className: 'bt-drawer-body', 'aria-busy': busy },
      busy ? h('div', { role: 'status' }, t('Loading…')) : null,
      error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null,
      !busy && (error || before !== undefined) ? h('button', { type: 'button', className: 'bt-soft', onClick: () => load(before) }, t(error ? 'Retry' : 'Load earlier')) : null,
      !rows.length && !busy && !error && before === undefined ? h('div', { className: 'bt-muted' }, t('No messages yet')) : null,
      rows.map(row => h('div', { key: row.seq, className: 'bt-group-msg' },
        h('span', { className: 'bt-group-name' }, row.name, ' · ', messageClock(row.time)),
        h(MarkdownText, { text: row.text, labels: mdLabels(), variant: 'compact' })))),
  ]
}

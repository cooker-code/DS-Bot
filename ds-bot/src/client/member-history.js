import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronLeftIcon } from './icons.js'
import { useEscape } from './overlay-hooks.js'
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
      const args = data.arguments
      const detail = data.name === 'post_to_group' ? undefined : typeof args === 'string' ? args : JSON.stringify(args, null, 2)
      rows.push({ seq, time, name: bot, text, detail })
      continue
    }
    const result = type === 'tool/result'
    if (type !== 'user/message' && type !== 'assistant/message' && !result) continue
    const assistant = type === 'assistant/message'
    const content = assistant || result ? data.message?.content : data.content
    const text = (content ?? []).map(block => {
      if (block.type === 'text') return block.text
      if (block.type === 'file' || block.type === 'image') return block.attachment?.name ?? t('File')
      return ''
    }).filter(Boolean).join('\n')
    if (result && text) rows.push({ seq, time, name: bot, text: t('Result'), detail: text })
    else if (text) rows.push({ seq, time, name: assistant ? bot : data.source?.senderName ?? room, text })
  }
  return rows
}

function MemberLog({ member, room, bot, actions }) {
  const [rows, setRows] = useState([])
  const [before, setBefore] = useState(undefined)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [pageError, setPageError] = useState('')
  const page = useRef(null)
  const body = useRef(null)
  const atEnd = useRef(true)
  const anchor = useRef(null)
  useLayoutEffect(() => {
    const node = body.current
    if (!node) return
    if (anchor.current) {
      node.scrollTop += anchor.current.node.offsetTop - anchor.current.previousOffset
      anchor.current = null
    } else if (atEnd.current) node.scrollTop = node.scrollHeight
  }, [rows])
  const sessionId = member?.id
  useEffect(() => {
    if (!sessionId) { setBusy(false); return }
    const controller = new AbortController()
    const { signal } = controller
    const show = ({ records, hasMore }) => {
      setRows(memberHistoryRows(records, bot.name, room.name))
      setBefore(hasMore ? records[0]?.event.seq : undefined)
      setBusy(false)
    }
    const read = async () => {
      setBusy(true)
      setError('')
      if (member.current) {
        for await (const frame of actions.followMember(sessionId, signal)) {
          if (signal.aborted) return
          if (frame.type === 'snapshot') show(frame)
          else if (frame.event) {
            const next = memberHistoryRows([frame], bot.name, room.name)
            if (next.length) setRows(old => [...old, ...next])
          }
        }
      } else {
        const result = await actions.memberHistory(sessionId, undefined, signal)
        if (!signal.aborted) {
          if (!result.ok) throw new Error(result.error.message)
          show(result.value)
        }
      }
    }
    void read().catch(failure => {
      if (!signal.aborted) { setError(failure.message ?? String(failure)); setBusy(false) }
    })
    return () => { controller.abort(); page.current?.abort() }
  }, [sessionId, member?.current, bot?.name, room?.name, attempt, actions])
  const earlier = async () => {
    if (page.current || before === undefined) return
    const controller = new AbortController()
    page.current = controller
    setBusy(true)
    setPageError('')
    try {
      const result = await actions.memberHistory(sessionId, before, controller.signal)
      if (controller.signal.aborted) return
      if (!result.ok) throw new Error(result.error.message)
      const { records, hasMore } = result.value
      const first = body.current?.querySelector('.bt-group-msg')
      if (first) anchor.current = { node: first, previousOffset: first.offsetTop }
      setRows(old => [...memberHistoryRows(records, bot.name, room.name), ...old])
      setBefore(hasMore ? records[0]?.event.seq : undefined)
    } catch (failure) {
      if (!controller.signal.aborted) setPageError(failure.message ?? String(failure))
    } finally {
      page.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return h('div', { ref: body, className: 'bt-dialog-log', 'aria-busy': busy,
    onScroll: ({ currentTarget: node }) => { atEnd.current = node.scrollHeight - node.scrollTop - node.clientHeight < 4 } },
    busy && h('div', { role: 'status' }, t('Loading…')),
    (error || pageError) && h('div', { className: 'bt-error', role: 'alert' }, error || pageError),
    error ? h('button', { type: 'button', className: 'bt-soft', onClick: () => setAttempt(value => value + 1) }, t('Retry'))
      : before !== undefined && h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: earlier }, t(pageError ? 'Retry' : 'Load earlier')),
    !rows.length && !busy && !error && before === undefined && h('div', { className: 'bt-hint' }, t('No messages yet')),
    rows.map(row => h('div', { key: row.seq, className: 'bt-group-msg' },
      h('span', { className: 'bt-group-name' }, row.name, ' · ', messageClock(row.time)),
      row.detail ? h('details', null, h('summary', null, row.text), h('pre', null, row.detail))
        : h(MarkdownText, { text: row.text, labels: mdLabels(), variant: 'compact' }))))
}

function ListedTranscript({ member, actions, SessionProvider, renderSlot, fallback }) {
  const [reference, setReference] = useState(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let current = true
    let retained
    try {
      retained = actions.retainMember(member.id)
      retained.ready.then(() => { if (current) setReference(retained) }, () => { if (current) setFailed(true) })
    } catch { setFailed(true) }
    return () => { current = false; retained?.release() }
  }, [member.id, actions])
  if (failed) return fallback
  if (!reference) return h('div', { role: 'status' }, t('Loading…'))
  return h('div', { className: 'bt-member-conversation' },
    h(SessionProvider, { session: reference }, renderSlot('ds-bot.member-conversation', {})))
}

function MemberChatView({ renderSlot }) {
  return renderSlot('conversation.session', { view: 'chat' })
}

export function MemberConversation({ renderFactorySlot }) {
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, {
    slots: { views: MemberChatView },
  })
}

export function MemberHistory({ member, room, bot, paneLeft, running, actions, listed, SessionProvider, renderSlot }) {
  const back = useRef(null)
  useEscape(actions.closeMemberSession)
  useEffect(() => { back.current?.focus() }, [])
  const title = [bot?.name, member ? `${room.name}-${member.number}` : room?.name].filter(Boolean).join(' · ')
  const fallback = h(MemberLog, { member, room, bot, actions })
  return h('section', { className: 'bt-pane', style: { left: paneLeft }, 'aria-label': title },
    h('div', { className: 'bt-dialog' },
      h('div', { className: 'bt-subhead' },
        h('button', { ref: back, type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back to details'), onClick: actions.closeMemberSession }, h(ChevronLeftIcon)),
        h('span', { className: 'bt-subhead-title' }, title),
        running && h('span', { className: 'bt-agent-session-run', role: 'status' }, t('Running'))),
      listed ? h(ListedTranscript, { member, actions, SessionProvider, renderSlot, fallback }) : fallback))
}

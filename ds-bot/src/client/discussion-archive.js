import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'
import { ChatRows } from './cells.js'

export function DiscussionArchive({ room, request, roster, actions, useUi }) {
  const dialog = useRef(null)
  const [rows, setRows] = useState(null)
  const [selected, setSelected] = useState([])
  const [detail, setDetail] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const library = request.mode === 'library'
  const archived = new Set((room.archivedDiscussions ?? []).map(row => row.id))
  const show = rows?.filter(row => !row.active && (library ? archived.has(row.id) : !archived.has(row.id)))
  useEffect(() => { dialog.current.showModal() }, [])
  useEffect(() => {
    let active = true
    actions.discussions(room.id).then(list => {
      if (!active) return
      const at = list.findIndex(row => row.id === request.boundary)
      const candidates = request.mode === 'before' ? list.slice(0, Math.max(0, at)) : list.filter(row => row.id === request.boundary)
      setSelected(candidates.filter(row => !archived.has(row.id)).map(row => row.id))
      setRows(request.mode === 'before' ? candidates : request.mode === 'one' ? list.slice(at, at + 1) : list)
    }).catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [room.id, request.token])
  const change = async fn => {
    setBusy(true); setError('')
    try { await fn() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const checked = new Set(selected)
  const ids = (show ?? []).filter(row => checked.has(row.id)).map(row => row.id)
  const write = (mode, values) => change(async () => {
    await actions.archiveDiscussions(room.id, mode, values)
    if (library) setDetail(null)
    else actions.closeArchive()
  })
  const title = library ? 'Archived discussions' : request.mode === 'before' ? 'Archive earlier discussions' : 'Archive discussions'
  return h('dialog', { ref: dialog, className: 'bt-archive-dialog', 'aria-label': t(title), onCancel: actions.closeArchive, onKeyDown: e => { if (e.key === 'Escape') e.stopPropagation() } },
    h('header', null, h('strong', null, t(title)), h('button', { className: 'bt-soft', onClick: actions.closeArchive }, t('Close'))),
    error && h('p', { role: 'alert' }, error),
    detail ? h('section', null, h('button', { className: 'bt-soft', onClick: () => setDetail(null) }, t('Back')),
      h(ChatRows, { items: detail.items, sessionId: detail.part, roster, actions, useUi }),
      h('button', { disabled: busy || roster.readOnly, className: 'bt-soft', onClick: () => write('restore', [detail.id]) }, t('Restore to chat')))
      : h('section', null, rows === null ? !error && t('Loading…') : !show.length ? t('No discussions available') : show.map(row => {
        const label = new Date(row.time).toLocaleString() + ' · ' + (row.title || t('Group discussion'))
        return library ? h('button', { key: row.id, className: 'bt-archive-item', disabled: busy,
          onClick: () => change(async () => setDetail(await actions.discussions(room.id, row.id))) }, label)
          : h('label', { key: row.id, className: 'bt-archive-item' }, h('input', { type: 'checkbox', checked: checked.has(row.id),
            disabled: request.mode !== 'multi' || busy, onChange: e => setSelected(e.target.checked ? [...ids, row.id] : ids.filter(id => id !== row.id)) }), label)
      })),
    !library && h('footer', null, h('button', { className: 'bt-soft', disabled: !ids.length || busy || roster.readOnly,
      onClick: () => write('archive', ids) }, ids.length === 1 ? t('Archive 1 discussion') : t('Archive {count} discussions', { count: ids.length }))))
}

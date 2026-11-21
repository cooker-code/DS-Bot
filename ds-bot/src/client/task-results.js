import { createElement as h, useEffect, useState } from 'react'
import { call } from './api.js'
import { MarkdownText } from './dsh-primitives.js'
import { mdLabels, t } from './i18n.js'
import { MarkdownField } from './markdown-field.js'
import { TaskImage } from './task-images.js'

function ResultDocument({ roomId, taskId, file }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(null)
  const [error, setError] = useState('')
  const documentId = file.ref?.attachmentId
  useEffect(() => {
    if (!open || text !== null) return
    const abort = new AbortController()
    setError('')
    call('project-task-detail', { roomId, taskId, ...(file.receiptFile ? { receiptFile: file.receiptFile } : { documentId }) }, abort.signal).then(value => {
      if (!abort.signal.aborted) setText(value)
    }, failure => { if (!abort.signal.aborted) setError(failure.message) })
    return () => abort.abort()
  }, [open, text, roomId, taskId, documentId, file.receiptFile])
  return h('details', { onToggle: event => setOpen(event.currentTarget.open) },
    h('summary', { className: 'bt-result-document' }, file.name),
    open && (error ? h('p', { role: 'alert' }, error)
      : text === null ? h('p', { role: 'status' }, t('Loading…'))
        : h('div', { className: 'bt-project-markdown' }, h(MarkdownText, { text, labels: mdLabels(), variant: 'compact' }))))
}

export function TaskResults({ roomId, taskId, detail }) {
  const groups = detail.results ?? []
  const items = [...new Set(groups.flatMap(group => group.items))]
  const files = groups.flatMap(group => group.files)
  return h(MarkdownField, { title: t('Acceptance results'), placeholder: groups.length ? null : t('No results submitted yet') },
    items.length ? h('ol', { className: 'bt-result-items' }, items.map(item => h('li', { key: item }, item))) : null,
    files.filter(file => file.kind === 'markdown').map(file => h(ResultDocument, { key: file.receiptFile ?? file.ref.attachmentId + file.name, roomId, taskId, file })),
    h('div', { className: 'bt-result-gallery' }, files.filter(file => file.kind === 'image').map(file =>
      h(TaskImage, { key: file.receiptFile ?? file.ref.attachmentId + file.name, roomId, taskId,
        image: file.ref, receiptFile: file.receiptFile, label: file.name }))))
}

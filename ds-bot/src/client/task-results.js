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
  const documentId = file.ref.attachmentId
  useEffect(() => {
    if (!open || text !== null) return
    const abort = new AbortController()
    setError('')
    call('project-task-detail', { roomId, taskId, documentId }, abort.signal).then(value => {
      if (!abort.signal.aborted) setText(value)
    }, failure => { if (!abort.signal.aborted) setError(failure.message) })
    return () => abort.abort()
  }, [open, text, roomId, taskId, documentId])
  return h('details', { onToggle: event => setOpen(event.currentTarget.open) },
    h('summary', null, file.name),
    open && (error ? h('p', { role: 'alert' }, error)
      : text === null ? h('p', { role: 'status' }, t('Loading…'))
        : h('div', { className: 'bt-project-markdown' }, h(MarkdownText, { text, labels: mdLabels(), variant: 'compact' }))))
}

export function TaskResults({ roomId, taskId, detail }) {
  const entries = (detail.rounds ?? []).flatMap((round, index) => {
    const binding = round.planNode
    const feedback = binding?.feedback
    if (!round.result && !feedback) return []
    const node = detail.plans?.find(plan => plan.version === binding?.version)?.nodes.find(node => node.no === binding?.node)
    const title = [t('Round {round}', { round: index + 1 }), node?.title, feedback && t('Returned for changes')].filter(Boolean).join(' · ')
    return h(MarkdownField, { key: index, title, value: [round.result, feedback, feedback && binding.block?.evidence].filter(Boolean).join('\n\n') },
      (round.resultFiles ?? []).map(file => file.kind === 'image'
        ? h(TaskImage, { key: file.path, roomId, taskId, image: file.ref, label: file.name })
        : h(ResultDocument, { key: file.path + file.ref.attachmentId, roomId, taskId, file })))
  }).reverse()
  return h(MarkdownField, { title: t('Acceptance results'), placeholder: entries.length ? null : t('No results submitted yet') }, entries)
}

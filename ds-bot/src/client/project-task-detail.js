import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { call } from './api.js'
import { MarkdownField } from './markdown-field.js'
import { ChevronLeftIcon, CloseIcon } from './icons.js'
import { TaskWorkspace } from './task-workspace.js'
import { stageTaskImage, TaskImage, taskImageTypes } from './task-images.js'
import { t } from './i18n.js'

// Preserve authored Markdown blocks. Plain legacy notes can be listed without changing their saved text.
function taskList(text) {
  if (!text || /^(?: {4}|\t|#{1,6} |>|\x60\x60\x60|~~~|\||\d+[.)] )/m.test(text)) return text
  return text.split(/\n+/).map(line => line.trim().replace(/^[-*+]\s+/, '')).filter(Boolean)
    .map((line, index) => (index + 1) + '. ' + line).join('\n')
}

function TaskField({ roomId, taskId, label, value, versions, sourceImages = [], images = [], readOnly, maxLength, required, onSave }) {
  const [version, setVersion] = useState(null)
  const snapshot = version === null ? undefined : versions?.[version]
  const currentVersion = versions?.length ?? 0
  if (snapshot) {
    value = snapshot.text
    sourceImages = snapshot.images
    images = []
    readOnly = true
  }
  const picker = useRef(null)
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const finish = () => {
    setDraft(null)
    setError('')
  }
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const added = []
      for (const file of draft.files) added.push(await stageTaskImage(file))
      await onSave(draft.original, draft.text, added, draft.removed)
      finish()
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy(false)
    }
  }
  const addFiles = files => {
    if (!files.length || readOnly || busy) return
    if (files.some(file => !taskImageTypes.split(',').includes(file.type))) return setError(t('Choose a PNG, JPEG, WebP, or GIF image'))
    if (files.some(file => file.size > 25 * 1024 * 1024)) return setError(t('Choose an image smaller than 25 MB'))
    setError('')
    setDraft(current => ({ ...current, files: [...new Set([...current.files, ...files])] }))
  }
  const originals = new Set(sourceImages.map(image => image.attachmentId ?? image.id))
  const visible = [...sourceImages, ...images.filter(image => !originals.has(image.attachmentId) && !draft?.removed.includes(image.attachmentId))]
  const gallery = [...visible.map((image, index) => h(TaskImage, { key: image.attachmentId ?? image.id, roomId, taskId, image,
    label: image.name || label + ' · ' + (index + 1), disabled: busy || readOnly,
    onRemove: draft && !originals.has(image.attachmentId ?? image.id) ? () => setDraft({ ...draft, removed: [...draft.removed, image.attachmentId] }) : undefined })),
  ...(draft?.files ?? []).map((file, index) => h(TaskImage, { key: 'file-' + index, file, label: file.name,
    disabled: busy || readOnly, onRemove: () => setDraft({ ...draft, files: draft.files.filter(other => other !== file) }) }))]
  const changed = draft && (draft.text !== draft.original || draft.files.length || draft.removed.length)
  return h(MarkdownField, { title: label, value: taskList(value),
    headerControl: versions && h('select', { className: 'bt-select', 'aria-label': t('Requirement version'),
      disabled: !!draft, value: snapshot ? version : currentVersion, onChange: event => {
        const selected = Number(event.target.value)
        setVersion(selected === currentVersion ? null : selected)
      } }, Array.from({ length: currentVersion + 1 }, (_, index) => h('option', { key: index, value: index }, 'v' + (index + 1)))),
    placeholder: visible.length ? null : '—', maxLength,
    draft: draft?.text, busy, error, disableSave: !changed || (required && !draft?.text.trim()),
    onEdit: readOnly ? undefined : () => setDraft({ original: value, text: value, removed: [], files: [] }),
    onChange: text => setDraft({ ...draft, text }), onSave: save, onCancel: finish,
    onPaste: event => {
      const files = Array.from(event.clipboardData.files)
      if (files.length) { event.preventDefault(); addFiles(files) }
    },
    tools: h('button', { type: 'button', className: 'bt-mini', disabled: busy || readOnly, onClick: () => picker.current?.click() }, t('Add image')),
  }, gallery, draft ? h('input', { type: 'file', multiple: true, hidden: true, accept: taskImageTypes, ref: picker, onChange: event => {
    addFiles(Array.from(event.target.files))
    event.target.value = ''
  } }) : null)
}

export function ProjectTaskDetail({ room, card, readOnly, move, hasStrip, onBack, close }) {
  const [detail, setDetail] = useState()
  const [error, setError] = useState('')
  const [attempt, retry] = useState(0)
  const activeRead = useRef(null)
  const taskId = card?.taskId
  useEffect(() => {
    if (!taskId) return
    const abort = new AbortController()
    activeRead.current = abort
    setError('')
    call('project-task-detail', { roomId: room.id, taskId }, abort.signal).then(value => {
      if (!abort.signal.aborted) setDetail(value)
    }, failure => {
      if (!abort.signal.aborted) setError(failure.message)
    })
    return () => abort.abort()
  }, [room.id, room.seq, taskId, card?.status, card?.version, card?.round, card?.updatedAt, card?.textUpdatedAt, card?.intakes?.length, attempt])
  const save = async (field, previous, value, addImages, removeImages) => {
    try {
      const saved = await call('update-project-task-text', { roomId: room.id, taskId, field, previous, value, addImages, removeImages })
      activeRead.current?.abort()
      setDetail(current => ({ ...current, [field]: saved }))
    } finally {
      retry(n => n + 1)
    }
  }
  readOnly ||= room.taskManagementEnabled === false
  return h(Fragment, null,
    h('div', { className: 'bt-subhead', 'data-move': move },
      h('button', { type: 'button', autoFocus: true, className: 'bt-icon-btn', 'aria-label': t('Back to details'), onClick: onBack }, h(ChevronLeftIcon)),
      h('span', { className: 'bt-subhead-title' }, t('Task details')),
      hasStrip ? null : h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close details'), onClick: close }, h(CloseIcon))),
    h('div', { className: 'bt-drawer-body bt-project-detail', 'data-move': move },
      !card ? h('p', { role: 'status' }, t('No such task')) : h(Fragment, null,
        error ? h('div', { role: 'alert' }, h('p', null, error), h('button', { type: 'button', className: 'bt-soft', onClick: () => retry(n => n + 1) }, t('Retry'))) : null,
        detail ? h(Fragment, null,
          h(TaskField, { roomId: room.id, taskId, label: t('Requirement'), readOnly, value: detail.requirement, versions: detail.requirementHistory ?? [],
            sourceImages: detail.sourceImages, images: detail.fieldImages?.requirement, onSave: (...args) => save('requirement', ...args) }),
          h(TaskField, { roomId: room.id, taskId, label: t('Acceptance criteria'), readOnly, value: detail.acceptance, required: true, maxLength: 2000,
            images: detail.fieldImages?.acceptance, onSave: (...args) => save('acceptance', ...args) }),
          h(TaskWorkspace, { room, card, readOnly }))
        : !error ? h('p', { role: 'status' }, t('Loading…')) : null)))
}

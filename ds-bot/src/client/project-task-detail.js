import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { call } from './api.js'
import { SaveFileAction } from './file-save.js'
import { MarkdownField } from './markdown-field.js'
import { ChevronLeftIcon, CloseIcon } from './icons.js'
import { TaskHandoffs } from './task-handoffs.js'
import { TaskResults } from './task-results.js'
import { TaskWorkspace } from './task-workspace.js'
import { TaskStatusEditor } from './task-status-editor.js'
import { stageTaskImage, TaskImage, taskImageTypes } from './task-images.js'
import { t } from './i18n.js'

// Preserve authored Markdown blocks. Plain legacy notes can be listed without changing their saved text.
function taskList(text) {
  if (!text || /^(?: {4}|\t|#{1,6} |>|\x60\x60\x60|~~~|\|| {0,3}(?:[-*+]|\d+[.)])\s)/m.test(text)) return text
  return text.split(/\n+/).map(line => line.trim()).filter(Boolean)
    .map((line, index) => (index + 1) + '. ' + line).join('\n')
}

function requirementDocuments(sources) {
  const documents = new Map()
  for (const line of sources) {
    for (const file of line.files ?? []) {
      const id = file.attachmentId ?? file.id
      if (id) documents.set(id + '/' + file.name, { id, name: file.name })
    }
    // The composer serializes local file chips as @path or @"path with spaces".
    for (const match of (line.text ?? '').matchAll(/(?:^|\s)@(?:"([^"\n]+)"|([^\s"]+))/gu)) {
      const path = match[1] ?? match[2].replace(/[.,;:!?，。；：！？]+$/u, '')
      const name = path.split(/[\\/]/u).at(-1)
      if (!name || !/\.[\p{L}\p{N}]+$/u.test(name) || path.startsWith('[')) continue
      documents.set('path:' + path, { path, name })
    }
  }
  return [...documents.values()]
}

function TaskField({ roomId, taskId, label, value, versions, sources, openReference, sourceImages = [], images = [], readOnly, maxLength, required, onSave }) {
  const [version, setVersion] = useState(null)
  const snapshot = version === null ? undefined : versions?.[version]
  const currentVersion = versions?.length ?? 0
  if (snapshot) {
    value = snapshot.text
    sourceImages = snapshot.images
    sources = sources?.filter(line => snapshot.documentSources?.includes(line.seq))
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
  const markdown = taskList(value)
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const added = []
      for (const file of draft.files) added.push(await stageTaskImage(file))
      const text = draft.text === draft.initialText ? draft.original : draft.text
      await onSave(draft.original, text, added, draft.removed)
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
  const documents = requirementDocuments(sources ?? [])
  const attachments = sources && (documents.length || gallery.length) ? h('div', { className: 'bt-requirement-attachments' },
    h('h4', null, t('Attachments')),
    documents.map(file => file.path
      ? h('button', { key: file.path, type: 'button', className: 'bt-mini bt-reference-file', title: file.path,
        onClick: () => setError(openReference(file.path) ? '' : t('File preview unavailable')) }, file.name)
      : h(SaveFileAction, { key: file.id + '/' + file.name, attachmentTarget: { sessionId: roomId, attachmentId: file.id }, label: file.name })),
    gallery) : gallery
  const changed = draft && (draft.text !== draft.initialText || draft.files.length || draft.removed.length)
  return h(MarkdownField, { title: label, autoSize: true, value: markdown,
    headerControl: versions && h('select', { className: 'bt-select', 'aria-label': t('Requirement version'),
      disabled: !!draft, value: snapshot ? version : currentVersion, onChange: event => {
        const selected = Number(event.target.value)
        setVersion(selected === currentVersion ? null : selected)
      } }, Array.from({ length: currentVersion + 1 }, (_, index) => h('option', { key: index, value: index },
        t('Requirement v{version}', { version: index + 1 }) + ' · ' + t(index === currentVersion ? 'Current' : 'Historical version')))),
    placeholder: visible.length || documents.length ? null : '—', maxLength,
    draft: draft?.text, busy, error, disableSave: !changed || (required && !draft?.text.trim()),
    onEdit: readOnly ? undefined : () => {
      // Generated numbering must not push a legacy criterion past its saved-text limit.
      const initialText = maxLength && markdown.length > maxLength ? value : markdown
      setDraft({ original: value, initialText, text: initialText, removed: [], files: [] })
    },
    onChange: text => setDraft({ ...draft, text }), onSave: save, onCancel: finish,
    onPaste: event => {
      const files = Array.from(event.clipboardData.files)
      if (files.length) { event.preventDefault(); addFiles(files) }
    },
    tools: h('button', { type: 'button', className: 'bt-mini', disabled: busy || readOnly, onClick: () => picker.current?.click() }, t('Add image')),
  }, attachments, draft ? h('input', { type: 'file', multiple: true, hidden: true, accept: taskImageTypes, ref: picker, onChange: event => {
    addFiles(Array.from(event.target.files))
    event.target.value = ''
  } }) : null)
}

export function ValidationProgress({ detail }) {
  // Use the plan's selected round so a late receipt cannot replace current progress.
  const nodes = detail.plans?.at(-1)?.nodes ?? []
  return nodes.filter(node => node.independentReview && !node.mergeToDev && node.writePaths?.length === 0 && node.round && node.status !== 'omitted').map(node => {
    const round = detail.rounds?.[node.round - 1]
    if (!round) return null
    if (round.result) return h('details', { key: node.round },
      h('summary', null, t('Test receipt submitted')), h('p', null, round.result))
    const progress = round.validation
    const checkpoint = round.planNode
    if (!progress && !checkpoint?.completed) return null
    return h('section', { key: node.round, 'aria-label': t('Validation progress') },
      h('h3', { className: 'bt-section-title' }, t('Validation progress'), ' · ', node.title),
      progress?.checking && !checkpoint?.block ? h('p', null, t('Testing: {check}', { check: progress.checking })) : null,
      checkpoint?.block ? h('p', null, checkpoint.block.reason) : null,
      progress?.passed.length ? h('ul', null, progress.passed.map(check => h('li', { key: check.name },
        h('strong', null, t('Passed: {check}', { check: check.name })), ' · ', check.evidence))) : null,
      progress?.checksComplete && !progress.cleanup && !checkpoint?.block ? h('p', null, t('Checks passed · awaiting cleanup')) : null,
      progress?.cleanup ? h('p', null, t('Cleanup: {result}', { result: progress.cleanup })) : null,
      progress ? h('p', null, t('Candidate'), ' · ', progress.candidates.join(', ')) : null,
      !progress && checkpoint?.completed ? h('p', null, checkpoint.completed) : null,
      !progress && checkpoint?.remaining ? h('p', null, checkpoint.remaining) : null)
  })
}

function AcceptanceRequest({ roomId, card, actions, readOnly }) {
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const review = card.acceptanceRequest
  const decide = async decision => {
    setBusy(true)
    setError('')
    try {
      await actions.decideAcceptance(roomId, card.taskId, review.id, decision, decision === 'return' ? feedback.trim() : undefined)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy(false)
    }
  }
  return h('div', { className: 'bt-task-acceptance' },
    !readOnly ? h('div', null,
      h('textarea', { className: 'bt-input', rows: 2, value: feedback, maxLength: 2000, disabled: busy,
        placeholder: t('Requested changes'), 'aria-label': t('Requested changes'), onChange: e => setFeedback(e.target.value) }),
      h('div', { className: 'bt-task-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => decide('approve') }, t('Accept delivery')),
        h('button', { type: 'button', className: 'bt-mini', disabled: busy || !feedback.trim(), onClick: () => decide('return') }, t('Request changes')))) : null,
    error ? h('p', { className: 'bt-task-error', role: 'alert' }, error) : null)
}

export function ProjectTaskDetail({ room, card, roster, actions, readOnly, openReference, move, hasStrip, onBack, close }) {
  const [detail, setDetail] = useState()
  const [error, setError] = useState('')
  const [attempt, retry] = useState(0)
  const activeRead = useRef(null)
  const taskId = card?.taskId
  const [history, setHistory] = useState()
  const readHistory = useRef(null)
  useEffect(() => {
    if (!taskId) return
    const abort = new AbortController()
    let loading = false
    let pending = false
    readHistory.current = async () => {
      pending = true
      if (loading) return
      loading = true
      while (pending && !abort.signal.aborted) {
        pending = false
        try {
          const value = await call('project-task-detail', { roomId: room.id, taskId, interactionsOnly: true }, abort.signal)
          if (!abort.signal.aborted) setHistory(value)
        } catch {
          if (!abort.signal.aborted) setHistory(current => ({ ...current, incomplete: true }))
        }
      }
      loading = false
    }
    return () => { readHistory.current = null; abort.abort() }
  }, [room.id, taskId])
  useEffect(() => { void readHistory.current?.() }, [room.id, taskId, room.seq, roster?.revision, card?.updatedAt, attempt])
  useEffect(() => {
    if (!taskId) return
    const abort = new AbortController()
    activeRead.current = abort
    setError('')
    call('project-task-detail', { roomId: room.id, taskId, withResults: true }, abort.signal).then(value => {
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
  const saveStatus = async (previous, status, reason) => {
    try {
      const saved = await call('update-project-task-status', { roomId: room.id, taskId, previous, status, reason })
      activeRead.current?.abort()
      setDetail(current => ({ ...current, ...saved }))
    } finally { retry(n => n + 1) }
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
          h(TaskHandoffs, { detail, roster, history, roomId: room.id, taskId }),
          h(TaskField, { roomId: room.id, taskId, label: t('Requirement'), readOnly, value: detail.requirement, versions: detail.requirementHistory,
            sources: detail.requirements ?? [], openReference, sourceImages: detail.sourceImages, images: detail.fieldImages?.requirement, onSave: (...args) => save('requirement', ...args) }),
          h(TaskField, { roomId: room.id, taskId, label: t('Acceptance criteria'), readOnly, value: detail.acceptance, required: true, maxLength: 2000,
            images: detail.fieldImages?.acceptance, onSave: (...args) => save('acceptance', ...args) }),
          h(TaskResults, { key: room.id + taskId, roomId: room.id, taskId, detail }),
          detail.acceptanceRequest ? h(AcceptanceRequest, { key: detail.acceptanceRequest.id, roomId: room.id, card: detail, actions, readOnly }) : null,
          h(ValidationProgress, { detail }),
          h(TaskWorkspace, { room, card, readOnly }),
          h(TaskStatusEditor, { key: room.id + taskId, detail, readOnly, onSave: saveStatus }))
        : !error ? h('p', { role: 'status' }, t('Loading…')) : null)))
}

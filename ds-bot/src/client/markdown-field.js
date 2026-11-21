import { createElement as h, useEffect, useRef, useState } from 'react'
import { MarkdownText } from './dsh-primitives.js'
import { mdLabels, t } from './i18n.js'

export function MarkdownField({ title, label = title, hint, value = '', placeholder, maxLength,
  settings, autoSize, draft, onEdit, onChange, onSave, onCancel, busy, disableSave, onPaste, children, tools, error }) {
  const previewHeight = useRef(0)
  const body = useRef(null)
  const edit = useRef(null)
  const editing = draft != null
  const wasEditing = useRef(false)
  useEffect(() => {
    if (wasEditing.current && !editing) edit.current?.focus()
    wasEditing.current = editing
  }, [editing])
  return h('section', { className: settings ? 'bt-set-row bt-bs-stack' : undefined, 'aria-label': title,
    onKeyDown: event => {
      if (editing && event.key === 'Escape' && !event.nativeEvent.isComposing) {
        event.stopPropagation()
        if (!busy) onCancel()
      }
    } },
    h('div', { className: 'bt-project-field-head' },
      h('span', { className: 'bt-set-copy' },
        h('span', { className: settings ? 'bt-bs-label' : 'bt-section-title', role: 'heading', 'aria-level': 3 }, title),
        hint ? h('span', { className: 'bt-set-hint' }, hint) : null),
      !editing && onEdit ? h('button', { ref: edit, type: 'button', className: 'bt-mini', onClick: () => {
        if (autoSize) previewHeight.current = body.current?.offsetHeight ?? 0
        onEdit()
      } }, t('Edit')) : null),
    editing ? h('textarea', { className: settings ? 'bt-bs-input bt-bs-area' : 'bt-input bt-input-area',
      style: autoSize ? { fieldSizing: 'content', resize: 'none', minHeight: previewHeight.current || undefined, boxSizing: 'border-box' } : undefined,
      'aria-label': label, autoFocus: true, value: draft ?? '', placeholder, maxLength, readOnly: busy || !onEdit,
      onChange: event => onChange(event.target.value), onPaste })
      : h('div', { className: 'bt-project-markdown', ref: body },
        value ? h(MarkdownText, { text: value, labels: mdLabels(), variant: 'compact' }) : placeholder),
    children,
    editing ? h('div', { className: 'bt-task-actions' },
      h('button', { type: 'button', className: 'bt-soft-sm', disabled: busy || !onEdit || disableSave, onClick: onSave }, busy ? t('Saving…') : t('Save')),
      tools,
      h('button', { type: 'button', className: 'bt-mini', disabled: busy, onClick: onCancel }, t('Cancel'))) : null,
    error ? h('p', { className: 'bt-error', role: 'alert' }, error) : null)
}

export function MarkdownSetting({ onSave, readOnly, value = '', ...props }) {
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const finish = () => { setDraft(null); setError('') }
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      if (draft.trim() === value || await onSave(draft.trim()) !== false) finish()
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy(false)
    }
  }
  return h(MarkdownField, { ...props, autoSize: true, value, draft, busy, error, onEdit: onSave && !readOnly ? () => setDraft(value) : undefined,
    onChange: setDraft, onSave: save, onCancel: finish })
}

import { createElement as h, useEffect, useRef, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'

export const taskImageTypes = 'image/png,image/jpeg,image/webp,image/gif'

export async function stageTaskImage(file) {
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(reader.result.split(',')[1])
    reader.readAsDataURL(file)
  })
  const { id } = await call('stage-image', { name: file.name, mediaType: file.type, data })
  return id
}

export function TaskImage({ roomId, taskId, image, receiptFile, file, label, onRemove, disabled }) {
  const [url, setUrl] = useState()
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const preview = useRef(null)
  const id = image?.attachmentId ?? image?.id
  useEffect(() => {
    setFailed(false)
    if (file) {
      const local = URL.createObjectURL(file)
      setUrl(local)
      return () => URL.revokeObjectURL(local)
    }
    const abort = new AbortController()
    call('project-task-detail', { roomId, taskId, ...(receiptFile ? { receiptFile } : { imageId: id }) }, abort.signal).then(value => {
      if (!abort.signal.aborted) setUrl(value)
    }, () => { if (!abort.signal.aborted) setFailed(true) })
    return () => abort.abort()
  }, [roomId, taskId, id, receiptFile, file])
  return h('div', { className: 'bt-task-image' },
    failed ? h('span', { role: 'status' }, t('Image unavailable') + ' · ' + label)
      : url ? h('button', { type: 'button', className: 'bt-task-image-open', title: t('Original image'),
        'aria-label': t('Original image') + ' · ' + label, onClick: () => { setOpen(true); preview.current.showModal() } },
        h('img', { src: url, alt: label, onError: () => setFailed(true) })) : null,
    h('dialog', { ref: preview, className: 'bt-task-image-preview', 'aria-label': label, onClose: () => setOpen(false),
      onClick: event => { if (event.target === preview.current) preview.current.close() },
      onKeyDown: event => { if (event.key === 'Escape') event.stopPropagation() } },
      open ? h('img', { src: url, alt: label }) : null,
      h('button', { type: 'button', className: 'bt-mini', onClick: () => preview.current.close() }, t('Close'))),
    onRemove ? h('button', { type: 'button', className: 'bt-mini', disabled, 'aria-label': t('Remove photo') + ' · ' + label, onClick: onRemove }, t('Remove photo')) : null)
}

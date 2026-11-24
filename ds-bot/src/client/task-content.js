import { createElement as h, useEffect, useRef, useState } from 'react'
import { MarkdownText, writeClipboard } from './dsh-primitives.js'
import { CopyIcon, CheckIcon, SearchIcon } from './icons.js'
import { mdLabels, t } from './i18n.js'

export function CopyTaskText({ text, label }) {
  const [status, setStatus] = useState('')
  useEffect(() => {
    if (!status) return
    const timer = setTimeout(() => setStatus(''), 1600)
    return () => clearTimeout(timer)
  }, [status])
  return h('button', { type: 'button', className: 'bt-tool', 'aria-label': status || label, title: status || label,
    onClick: async () => {
      try { setStatus(await writeClipboard(text) ? t('Copied') : t('Copy failed')) }
      catch { setStatus(t('Copy failed')) }
    } }, status === t('Copied') ? h(CheckIcon) : h(CopyIcon), status && h('span', { role: 'status', className: 'bt-task-copy-feedback' }, status))
}

export function TaskContent({ header, panelId, selectedId, text, sections }) {
  const [raw, setRaw] = useState(false)
  const [search, setSearch] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const active = useRef(null)
  useEffect(() => { setIndex(0); setQuery(''); setSearch(false) }, [selectedId])
  const contentText = sections ? sections.map(section => section.text).join('\n\n') : text
  let matches = 0
  const blocks = (sections ?? [{ text }]).map(section => {
    const parts = search && query ? section.text.split(query) : [section.text]
    const offset = matches
    matches += parts.length - 1
    return { ...section, parts, offset }
  })
  const renderText = block => raw || search
    ? h('pre', null, block.parts.map((piece, i) => h('span', { key: i },
      i ? h('mark', { ref: block.offset + i - 1 === index ? active : undefined,
        'data-current': block.offset + i - 1 === index }, query) : null, piece)))
    : h(MarkdownText, { text: block.text, labels: mdLabels(), variant: 'compact' })
  useEffect(() => { active.current?.scrollIntoView({ block: 'nearest' }) }, [query, index])
  return h('div', { className: 'bt-task-content' },
    h('div', { className: 'bt-task-content-head' }, h('div', { className: 'bt-task-content-context' }, header),
      h('div', { className: 'bt-task-content-actions' },
      h('small', null, t('{n} lines', { n: contentText.split('\n').length })),
      h('div', { className: 'bt-task-content-modes' }, [true, false].map(mode => h('button', { key: String(mode), type: 'button',
        'aria-pressed': mode === (raw || search), onClick: () => { setRaw(mode); setSearch(false) } }, mode ? t('Raw text') : 'Markdown'))),
      h(CopyTaskText, { key: selectedId, text: contentText, label: t(sections?.length > 1 ? 'Copy all outputs' : 'Copy') }),
      h('button', { type: 'button', className: 'bt-tool', title: t('Search'), 'aria-label': t('Search'), 'aria-expanded': search,
        onClick: () => setSearch(!search) }, h(SearchIcon)))),
    search && h('div', { className: 'bt-task-find' }, h('input', { autoFocus: true, value: query, 'aria-label': t('Find in text'),
      placeholder: t('Find in text'), onChange: e => { setQuery(e.target.value); setIndex(0) },
      onKeyDown: e => { if (e.key === 'Escape') setSearch(false)
        if (e.key === 'Enter' && matches) setIndex((index + (e.shiftKey ? matches - 1 : 1)) % matches) } }),
      query && h('small', { role: 'status' }, (matches ? index + 1 : 0) + ' / ' + matches),
      matches > 1 && h('button', { type: 'button', onClick: () => setIndex((index + 1) % matches) }, t('Next match'))),
    h('div', { className: 'bt-task-content-body', role: 'tabpanel', id: panelId, 'aria-labelledby': selectedId },
      sections ? blocks.map(block => h('section', { key: block.key, className: 'bt-task-content-section', 'aria-label': block.label },
        h('div', { className: 'bt-task-content-section-head' }, h('span', null, block.label), block.control,
          sections.length > 1 && h(CopyTaskText, { text: block.text, label: t('Copy this output') })), renderText(block))) : renderText(blocks[0])))
}

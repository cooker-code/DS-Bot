import { createElement as h } from 'react'
import { taskMessage } from '../shared/task-message.js'

export const quoteMarkdown = text => text.replace(/\r\n?/gu, '\n').split('\n').map(line => `> ${line}`).join('\n')

// A separate quoted marker preserves the card through the native Markdown
// composer while its preview starts with the speaker and the selected words.
export function attributedQuote(text, name, prefix) {
  return [name && name + ':', text, prefix].filter(Boolean).join('\n')
}

export function messageExcerpt(text) {
  return text.length > 200 ? text.slice(0, 200).replace(/[\uD800-\uDBFF]$/u, '').trimEnd() + '…' : text
}

// The native API inserts at the editor selection. A message reply belongs
// above an existing draft, including when its current selection is nonempty.
export function insertReplyQuote(inputActions, text, editor) {
  if (editor?.textContent.trim()) {
    editor.focus()
    const doc = editor.ownerDocument
    const selection = doc.getSelection()
    selection?.collapse(editor.firstElementChild ?? editor, 0)
    // The editor must receive the new caret before its synchronous insertion.
    doc.dispatchEvent(new Event('selectionchange'))
  }
  const inserted = inputActions.insertQuote(text)
  if (inserted && editor) {
    const selection = editor.ownerDocument.getSelection()
    selection?.selectAllChildren(editor)
    selection?.collapseToEnd()
  }
  return inserted
}

export function splitReply(text = '', room) {
  const first = text.match(/^(?: {0,3}>[^\n]*(?:\n|$))+/u)
  if (!first) return { body: text }
  const quote = first[0].trimEnd().replace(/^ {0,3}> ?/gmu, '')
  if (!quote.trim()) return { body: text }
  const last = quote.lastIndexOf('\n')
  const marker = last < 0 ? undefined : taskMessage(quote.slice(last + 1), room)
  const source = marker?.prefix && !marker.body ? { body: quote.slice(0, last), prefix: marker.prefix } : taskMessage(quote, room)
  return { quote: source.body, prefix: source.prefix, body: text.slice(first[0].length).replace(/^(?:[ \t]*\r?\n)+/u, '') }
}

export function QuotePreview({ text }) {
  if (!text) return null
  return h('blockquote', { className: 'bt-reply-quote' }, text)
}

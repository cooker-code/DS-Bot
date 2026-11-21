// Unassigned user input has a separate intake key until the manager identifies the card.
import { randomUUID } from 'node:crypto'
import { REPLY_KIND } from './constants.js'
import { uuid } from '../shared/task-message.js'

const card = new RegExp('^' + uuid + '$', 'i')

export { taskManagementEnabled as taskRoom } from '../shared/task-settings.js'
export const scopeOf = item => item?.taskId ?? item?.intakeId
export function scopeFields(key) {
  if (!key) return {}
  return key.startsWith('intake-') ? { intakeId: key } : { taskId: key }
}

const quotedCard = new RegExp(' · \\[task:(' + uuid + ')\\]$', 'i')
// The selected card determines the subject. The user's own words determine the action.
export function mentionedProjectCard(text = '') {
  const ids = []
  let single
  const body = text.replace(/^>[^\n]*(?:\n>[^\n]*)*/gm, (quote, offset) => {
    const id = quotedCard.exec(quote.split('\n', 2)[1])?.[1]?.toLowerCase()
    if (!id) return quote
    ids.push(id)
    if (ids.length === 1) single = { offset, end: offset + quote.length }
    return '[task:' + id + ']'
  })
  if (!ids.length) return
  if (ids.length > 1) return { taskId: ids[0], text: body.trim(), referencedCards: ids }
  const instruction = (text.slice(0, single.offset) + ' ' + text.slice(single.end)).trim()
  return { taskId: ids[0], text: instruction || body.trim() }
}

export function inboundScope(post) {
  const bound = scopeOf(post)
  if (bound) return bound
  if (post.botId && !(post.stopped || post.failed || post.resumed || post.done)) throw new Error('A Bot task message needs a taskId.')
  return 'intake-' + randomUUID()
}

export function outgoingScope(source, explicit, text, required, manager = false) {
  const bound = scopeOf(source)
  if (explicit !== undefined && (typeof explicit !== 'string' || !card.test(explicit))) throw new Error('Use the persistent card UUID as taskId.')
  const declared = explicit?.toLowerCase()
  const proposed = declared
  if (proposed && bound && proposed !== bound && !(manager && source.intakeId && card.test(proposed))) throw new Error('The message belongs to a different task than this execution.')
  if (!bound && proposed?.startsWith('intake-')) throw new Error('An intake reply needs its original intake context.')
  const result = proposed ?? bound
  if (required && !result) throw new Error('A Bot task message needs its persistent card taskId.')
  return result
}

export const tagged = (key, text) => !key || !text || text.trimStart().toLowerCase().startsWith('[' + key + ']')
  ? text : '[' + key + '] ' + text

// Group members keep their DSH Session identity (including tool permissions). Only
// messages from turns on this card are passed back to the model on its next step.
export function taskHistory(messages, key, sourceKind) {
  let include = false
  return messages.filter(message => {
    if (message.role === 'system' || message.role === 'developer') return true
    if (message.role === 'user') {
      const source = message.source
      if (source?.kind === REPLY_KIND && source.projectSource) {
        include = scopeOf(source.projectSource) === key
      } else if (!source || source.kind === sourceKind || source.kind === 'user' || source.kind === 'schedule' || source.kind === 'compact-checkpoint') {
        include = scopeOf(source) === key
      }
    }
    return include
  })
}

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
const resumeCommand = /^(?:请\s*)?(?:(?:task|任务)\s*)?(?:继续(?:推进|执行|处理|开发|跟进)?|恢复(?:推进|执行|处理|开发)|(?:please\s+)?(?:continue|resume)(?:\s+(?:this|the))?(?:\s+task)?)[。.!！]?$/iu

// Only a single selected card and an explicit instruction outside its quotation
// constitute a continuation. A discussion of quotations remains an ordinary intake.
export function mentionedContinuation(text = '') {
  const quotes = [...text.matchAll(/^>[^\n]*(?:\n>[^\n]*)*/gm)]
  if (quotes.length !== 1) return
  const [quote] = quotes
  const id = quotedCard.exec(quote[0].split('\n', 2)[1])?.[1]
  if (!id) return
  const body = (text.slice(0, quote.index) + ' ' + text.slice(quote.index + quote[0].length)).trim()
  if (resumeCommand.test(body)) return { taskId: id.toLowerCase(), text: body, continueTask: true }
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

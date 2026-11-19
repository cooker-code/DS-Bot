// A group's notice opts its task messages into routing with the literal [taskId] marker.
// Unassigned user input has a separate intake key until the manager identifies the card.
import { randomUUID } from 'node:crypto'

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const card = new RegExp('^' + uuid + '$', 'i')
const prefix = new RegExp('^\\[(' + uuid + '|intake-' + uuid + ')\\]', 'i')

export const taskRoom = room => room?.notice?.includes('[taskId]') === true
export const scopeOf = item => item?.taskId ?? item?.intakeId
export function scopeFields(key) {
  if (!key) return {}
  return key.startsWith('intake-') ? { intakeId: key } : { taskId: key }
}

function messageKey(text) {
  const body = String(text ?? '').trimStart()
  const keys = new Set()
  // DS Bot's Reply action inserts a Markdown quotation before the new text.
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const quote = trimmed.startsWith('>')
    const head = (quote ? trimmed.slice(1).trimStart() : trimmed).match(prefix)
    if (head) keys.add(head[1].toLowerCase())
    if (!quote) break
  }
  if (keys.size > 1) throw new Error('Conflicting task IDs in the message and its quotation.')
  return [...keys][0]
}

export function inboundScope(post) {
  const key = messageKey(post.text)
  const bound = scopeOf(post)
  if (bound && key && bound !== key) throw new Error('The message belongs to a different task.')
  if (bound || key) return bound ?? key
  if (post.botId && !(post.stopped || post.failed || post.resumed || post.done)) throw new Error('A Bot task message needs a taskId.')
  return 'intake-' + randomUUID()
}

export function outgoingScope(source, explicit, text, required, manager = false) {
  const bound = scopeOf(source)
  const key = messageKey(text)
  if (explicit !== undefined && (typeof explicit !== 'string' || !card.test(explicit))) throw new Error('Use the persistent card UUID as taskId.')
  const declared = explicit?.toLowerCase()
  if (declared && key && declared !== key) throw new Error('The message prefix and taskId differ.')
  const proposed = declared ?? key
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
      if (!source || source.kind === sourceKind || source.kind === 'user' || source.kind === 'schedule') {
        include = scopeOf(source) === key
      }
    }
    return include
  })
}

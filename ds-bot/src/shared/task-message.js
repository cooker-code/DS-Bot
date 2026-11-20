import { taskManagementEnabled } from './task-settings.js'
// The wire prefix belongs to routing. Human-readable views resolve it within its room.
export const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
export const taskPrefix = new RegExp('^\\[(' + uuid + '|intake-' + uuid + ')\\]', 'i')

export function taskMessage(text, room) {
  const match = room && typeof text === 'string' && text.trimStart().match(taskPrefix)
  if (!match) return { body: text }
  const key = match[1].toLowerCase()
  const cards = room.projectCards ?? {}
  const card = cards[key] ?? Object.values(cards).find(item => item.taskId === key || item.intakes?.includes(key))
  if (!card && !taskManagementEnabled(room)) return { body: text }
  const body = text.trimStart().slice(match[0].length).replace(/^(?:[ \t]*\r?\n| )/, '')
  return { title: card?.title, body, prefix: match[0] }
}

export const taskCaption = ({ title, body }) => title ? [title, body].filter(Boolean).join('\n\n') : body

const forwarded = /^(?:Forwarded group message #\d+ to [^\r\n]+'s own chat\.|Already forwarded\.)$/
export function isIntakeReceipt(line) {
  if (typeof line?.text !== 'string' || line.botId) return false
  const text = line.text.trim()
  const tag = text.match(taskPrefix)
  const intake = tag?.[1].toLowerCase().startsWith('intake-')
  // Ledger records retain the author. Old embedded relay results only retained 'user'.
  const generated = line.who === 'DS Bot' && !line.kind && (line.intakeId || intake)
    || line.kind === 'user' && !line.who && intake
  return Boolean(generated && forwarded.test(text.slice(tag?.[0].length ?? 0).trim()))
}

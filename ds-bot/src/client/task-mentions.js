import { call } from './api.js'
import { GoalIcon } from './icons.js'
import { t } from './i18n.js'
import { quoteMarkdown } from './message-quote.js'
import { TASK_STATUS } from './task-board.js'
import { taskPrefix } from '../shared/task-message.js'

const SOURCE = 'ds-bot-tasks'
const statusOf = status => t(TASK_STATUS[status] ?? status)

function candidates(roster, sessionId, query) {
  if (!roster.ready) return []
  const here = roster.roomsById[sessionId]
  const bot = roster.byId[sessionId]
  const rooms = here ? [here] : bot ? roster.rooms.filter(room => room.members.includes(bot.id)) : []
  const needle = query.trim().toLowerCase()
  const rows = []
  for (const room of rooms) {
    const add = (kind, id, title, status, updated, owners = []) => {
      if (![title, id].some(value => value.toLowerCase().includes(needle))) return
      const description = [room.name, statusOf(status), ...owners.map(owner => roster.byId[owner]?.name)].filter(Boolean).join(' · ')
      rows.push({ updated: updated ?? 0, id, candidate: { name: title, description, section: t('Tasks'), icon: GoalIcon,
        value: JSON.stringify({ sessionId, roomId: room.id, kind, id, title }) } })
    }
    for (const card of room.projectCards ?? [])
      add('project', card.taskId, card.title, card.status, Math.max(card.textUpdatedAt ?? 0, card.updatedAt ?? 0), card.owners ?? [card.ownerId])
    for (const [id, task] of Object.entries(room.tasks ?? {}))
      add('member', id, task.goal, task.status, task.updatedAt ?? task.startedAt, [task.botId])
    for (const item of room.pendingIntakes ?? [])
      add('intake', item.id, item.title || t('Original request'), item.status, item.receivedAt)
  }
  const shown = rows.sort((a, b) => b.updated - a.updated).slice(0, 12)
  return shown.map(({ id, candidate }) => {
    const duplicate = shown.some(({ candidate: other }) => other !== candidate && other.name === candidate.name && other.description === candidate.description)
    return duplicate ? { ...candidate, description: candidate.description + ' · ' + id.slice(-8) } : candidate
  })
}

const clipboardText = ref => '@' + JSON.parse(ref).title

// Each occurrence occupies its own quotation, even in the middle of a sentence.
// The group must only act on Bot mentions and routing IDs the user wrote outside it.
function taskQuotation(task, projectCard) {
  const lines = [t('Task details') + ' · ' + (task.title || t('Original request')),
    [task.room, statusOf(task.status), ...(task.owners ?? []), projectCard ? '[task:' + task.id + ']' : task.id].join(' · ')]
  for (const [key, label] of [
    ['requirement', 'Requirement'], ['acceptance', 'Acceptance criteria'], ['branch', 'Working revision'],
    ['plan', task.version ? 'Plan v{version}' : 'Instructions'], ['progress', 'Progress'], ['reason', 'Details'], ['result', 'Results'],
  ]) {
    if (task[key]) lines.push(t(label, { version: task.version }) + ': ' + task[key])
  }
  if (task.note) lines.push(t('Note: {text}', { text: task.note }))
  if (task.attachments) lines.push(t('Attachments: {names}', { names: task.attachments }))
  // DSH also recognizes bare session URIs inside quoted text.
  const text = lines.join('\n').replaceAll('dsh-session:', 'dsh-session：').replace(/\r\n?/g, '\n')
    .split('\n').map(line => taskPrefix.test(line.trimStart()) ? '\\' + line.trimStart() : line).join('\n')
  return '\n\n' + quoteMarkdown(text) + '\n\n'
}

export function taskMentionSource(roster, read = call) {
  return {
    name: SOURCE, trigger: '@', order: -15, showGroupTitle: false,
    async candidates({ sessionId }, { query }) { return candidates(roster.getSnapshot(), sessionId, query) },
    onPick({ candidate }) {
      return { insert: { source: SOURCE, ref: candidate.value, label: candidate.name, clipboardText: clipboardText(candidate.value) } }
    },
    codec: {
      clipboardText,
      async serialize(ref, signal) {
        const { sessionId, roomId, kind, id } = JSON.parse(ref)
        const task = await read('task-reference', { sessionId, roomId, kind, id }, signal)
        const groupCard = kind === 'project' && roster.getSnapshot().roomsById[sessionId]?.id === roomId
        return taskQuotation(task, groupCard)
      },
    },
  }
}

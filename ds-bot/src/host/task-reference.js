import { taskMessage } from '../shared/task-message.js'
import { cardForIntake, intakeLines, pendingIntakes, projectCardSummary, projectImages, projectRequirement, projectSources } from './project-tasks.js'
import { nodeViews, taskCheckout } from './project-plan.js'
import { blockedLine } from './tasks.js'
import { headOf } from './text.js'

// Leave room for the user's question and additional references in a group message.
const preview = (value, limit = 2000) => value?.length > limit ? headOf(value, limit) + '…' : value

function attachmentNames(card, sources) {
  const images = projectImages(card, sources).map(image => image.name || image.mediaType || 'Image')
  const files = sources.flatMap(line => (line.files ?? []).map(file => file.name))
  return preview([...images, ...files].filter(Boolean).join(', '), 1000)
}

export function readTaskReference(rt, { sessionId, roomId, kind, id }) {
  if (![sessionId, roomId, id].every(value => typeof value === 'string' && value)) return
  const room = rt.roomOf(roomId)
  if (!room || room.id !== roomId) return
  const conversationRoom = rt.roomOf(sessionId)?.id ?? rt.pastOwners.get(sessionId)?.roomId ?? rt.groupOwners.get(sessionId)?.roomId
  if (conversationRoom ? conversationRoom !== roomId : !room.members.includes(rt.selfOf(sessionId) ?? rt.botOf(sessionId)?.id)) return
  const name = owner => rt.botOf(owner)?.name ?? owner
  const base = { room: room.name, id }
  if (kind === 'member') {
    if (!Object.hasOwn(room.tasks ?? {}, id)) return
    const task = room.tasks[id]
    return { ...base, title: task.goal, status: task.status, owners: [name(task.botId)], progress: task.progress,
      result: task.result, reason: task.blocked ? blockedLine(task.blocked) : task.reason, note: task.notes?.at(-1)?.text }
  }
  if (kind !== 'project' && kind !== 'intake') return
  const card = kind === 'intake' ? cardForIntake(room, id) : Object.hasOwn(room.projectCards ?? {}, id) && room.projectCards[id]
  if (card) {
    const key = kind === 'project' ? id : card.id
    const summary = projectCardSummary(card, key)
    const last = card.rounds?.at(-1)
    const plan = card.plans?.at(-1)
    const steps = plan && nodeViews(card, plan)
    const fromSteps = read => steps?.flatMap(step => {
      const value = read(card.rounds[step.round - 1] ?? {})
      return value ? [step.title + ' — ' + value] : []
    }).join('\n')
    const sources = projectSources(rt, room, card.intakes ?? [], key)
    const review = card.humanReview?.version === plan?.version ? card.humanReview : undefined
    return { ...base, id: key, title: card.title, status: summary.status,
      owners: (summary.owners?.length ? summary.owners : [summary.ownerId].filter(Boolean)).map(name),
      requirement: preview(projectRequirement(room, card, sources), 4000), acceptance: preview(card.acceptance),
      version: plan?.version, plan: preview(steps ? steps.map(node => node.no + '. ' + node.title + ' · ' + name(node.ownerId) + ' · ' + node.status).join('\n') : last?.plan),
      progress: preview(fromSteps(r => r.planNode?.completed)),
      reason: preview(card.clarification || review?.feedback || fromSteps(r => r.planNode?.block?.reason)),
      result: preview(review?.artifact || (steps ? fromSteps(r => r.result) : last?.result)), branch: taskCheckout(card)?.workRef,
      attachments: attachmentNames(card, sources) }
  }
  const receipt = kind === 'intake' && pendingIntakes(room).find(item => item.id === id)
  if (!receipt) return
  const sources = intakeLines(rt, room, id)
  const requirement = sources.map(line => taskMessage(line.text, room).body).join('\n\n')
  return { ...base, title: receipt.title, status: receipt.status, requirement: preview(requirement, 4000),
    reason: receipt.reason, attachments: attachmentNames(undefined, sources) }
}

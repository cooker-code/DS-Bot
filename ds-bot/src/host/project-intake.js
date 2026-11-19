import { intakeLines } from './project-tasks.js'
import { taskRoom } from './task-routing.js'

// A project follows the group ID and its current admin across chat part changes.
export function projectDestination(rt, room) {
  if (!taskRoom(room)) return
  const manager = room.members.map(rt.botOf).find(bot => bot && rt.isAdminOf(room, bot.id))
  if (!manager) return
  const sessionId = rt.chatOf(manager.id)
  return { manager, sessionId, project: room.id }
}

export async function forwardProjectIntake(rt, room, intakeId, throughSeq) {
  const target = projectDestination(rt, room)
  if (!target || !intakeId || !Number.isSafeInteger(throughSeq)) throw new Error('This project intake has no bound manager chat.')
  const lines = intakeLines(rt, room, intakeId).filter(line => line.seq <= throughSeq)
  if (!lines.length || lines.at(-1).seq !== throughSeq) throw new Error('Original user intake not found.')
  const { manager, sessionId, project } = target
  const request = rt.requestIdentity({
    caller: manager.id, context: 'project-intake:' + room.id, name: intakeId + ':' + throughSeq,
    payload: { project, intakeId, sequences: lines.map(line => line.seq) },
  })
  const outcome = await rt.admitRequest(request, async () => {
    const text = [
      `Project ${project}, group "${room.name}", user intake ${intakeId}. Handle it here in your own manager chat.`,
      'Use project_task list for open cards and member IDs. For a new requirement call assign with title, ownerId, plan and acceptance. To continue an existing requirement, attach this intake to its taskId. Read the card and verify the owner and round. Keep original attachments with the card.',
      'For a new assignment send message_bot to the owner with taskId, card_round, reply_to=user and request_id. The plugin forwards the saved handoff and original attachments. Distinguish delivery from the owner explicitly confirming start with project_task start. Report the card ID and actual status to the group.',
      ...lines.flatMap(line => (line.images || []).map(image => `Group #${line.seq} image: ${image.name || ''} ${image.attachmentId || image.id || ''}`)),
      ...lines.map(line => `Group message #${line.seq}\n${line.text}`),
    ].join('\n\n')
    await rt.deliver({
      toId: manager.id, sessionId, role: 'request', audience: 'user', intakeId, roomId: room.id,
      text, images: lines.flatMap(line => line.images ?? []), files: lines.flatMap(line => line.files ?? []),
      recordExchange: false,
    })
    return `Forwarded group message #${throughSeq} to ${manager.name}'s own chat.`
  })
  if (['sent', 'replay', 'expired'].includes(outcome.status)) return outcome.receipt ?? 'Already forwarded.'
  throw new Error('Project intake delivery: ' + outcome.status + '. Check the manager chat before retrying.')
}

import { taskRoom } from './task-routing.js'

// Only the two sessions already bound to the same Kanban project can relay an intake.
export function projectDestination(rt, room) {
  if (!taskRoom(room)) return
  const manager = room.members.map(rt.botOf).find(bot => bot && rt.isAdminOf(room, bot.id))
  if (!manager) return
  const sessionId = rt.chatOf(manager.id)
  const project = rt.ctx.get?.('dshKanban')?.dispatchProjectFor?.(room.sessions?.[manager.id], sessionId)
  if (project) return { manager, sessionId, project }
}

export async function forwardProjectIntake(rt, room, intakeId, throughSeq) {
  const target = projectDestination(rt, room)
  if (!target || !intakeId || !Number.isSafeInteger(throughSeq)) throw new Error('This project intake has no bound manager chat.')
  const lines = rt.ledger.records('group-' + room.id).filter(line => line.intakeId === intakeId &&
    line.seq <= throughSeq && line.who === 'User' && !line.kind && !line.botId && typeof line.text === 'string')
  if (!lines.length || lines.at(-1).seq !== throughSeq) throw new Error('Original user intake not found.')
  const { manager, sessionId, project } = target
  const request = rt.requestIdentity({
    caller: manager.id, context: 'project-intake:' + room.id, name: intakeId + ':' + throughSeq,
    payload: { project, intakeId, sequences: lines.map(line => line.seq) },
  })
  const outcome = await rt.admitRequest(request, async () => {
    const text = [
      `Project ${project}, group "${room.name}", user intake ${intakeId}. Handle it here in your own manager chat.`,
      'Use board_dispatch(active, includeMembers=true) once for open cards and member IDs. Read only plausible matching cards. Inspect the original image once; pass its attachment ID to assign. The developer owns source and database investigation. For a new card use the intake ID as the stable ref. Keep the original text and images. Plan all handoffs through final acceptance under project rules. Use the team member IDs.',
      'Read the saved card back. Dispatch from here with message_bot, its persistent card UUID as taskId, reply_to=user, and a stable request_id for that card and round. Set card_round to the round you just verified. DS Bot includes the saved requirement, development handoff, checklist and attachment paths; message only needs additional scope or constraints.',
      'Ask the owner to check the actual worktree and explicitly confirm starting to your own chat using message_bot with the same taskId. When you receive that confirmation, read the card and use board_dispatch(start), then read again and report the card ID and status to the group. A send receipt alone does not confirm work.',
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

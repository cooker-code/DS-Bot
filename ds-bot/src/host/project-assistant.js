// The user appoints a coordinator for this room only. The group admin keeps intake.
export function assistantId(room) {
  const id = room?.projectAssistantId
  return id && room.admin && id !== room.admin && room.members.includes(id) ? id : undefined
}

export function runsProject(rt, room, actor) {
  const assistant = assistantId(room)
  if (room?.unresolvedTaskAssistant || (room?.projectAssistantId && !assistant)) return false
  return assistant ? actor === assistant : rt.isAdminOf(room, actor)
}

export function decidesGitWorkspace(rt, room, actor) {
  if (room.unresolvedTaskAssistant) return false
  return room.projectAssistantId ? actor === assistantId(room) : rt.isMain(actor)
}

export async function projectNotice(rt, room, toId, scope, event, text, attachments = {}, details) {
  const key = rt.requestIdentity({ caller: toId, context: 'project-coordination:' + room.id,
    name: event, payload: { event, details } })
  const result = await rt.admitRequest(key, async () => rt.deliver({
    ...scope, roomId: room.id, toId, sessionId: await rt.memberSession(room, toId), role: 'request', audience: 'user',
    recordExchange: false, text, ...attachments,
  }))
  if (!['sent', 'replay', 'expired'].includes(result.status)) throw new Error('Check project message delivery: ' + result.status)
}

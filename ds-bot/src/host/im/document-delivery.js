import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from '../tools.js'
import { nodeViews } from '../project-plan.js'
import { taskResultView, readReceiptFile } from '../task-result-view.js'
import { readResultDocument } from '../project-result-files.js'
import { currentBinding } from '../project-recovery.js'

export function documentTargets(connections, roomId) {
  return Object.values(connections).flatMap(conn => conn.enabled === false || conn.platform !== 'wecom' ? [] :
    Object.entries(conn.chats ?? {}).filter(([key, chat]) => chat.target?.roomId === roomId &&
      (chat.kind !== 'direct' || conn.paired?.some(sender => sender.id === key)))
      .map(([chatKey, chat]) => ({ id: conn.id, platform: conn.platform, chatKey, title: chat.title, kind: chat.kind })))
}

export async function deliverDocument(rt, body) {
  const room = rt.roomOf(body.roomId)
  const card = room?.projectCards?.[body.taskId]
  if (!card) throw new Error('Choose a task in this group.')
  if (typeof body.requestId !== 'string' || !body.requestId.trim() || body.requestId.length > 200)
    throw new Error('Supply a stable delivery requestId up to 200 characters.')
  const target = rt.imDocumentTarget(body)
  const detail = { rounds: card.rounds, plans: card.plans?.map(plan => ({ ...plan, nodes: nodeViews(card, plan) })) }
  const groups = await taskResultView(rt, room, card, detail)
  const files = groups.flatMap(group => group.files).filter(file => file.kind === 'markdown' && file.name === body.fileName)
  const unique = [...new Map(files.map(file => [file.receiptFile ?? file.ref?.attachmentId, file])).values()]
  if (unique.length !== 1) throw new Error('Choose one Markdown document registered on this task by its exact fileName.')
  const file = unique[0]
  const text = file.receiptFile ? await readReceiptFile(rt, room, card, file.receiptFile) : await readResultDocument(rt, card, file.ref.attachmentId)
  const request = rt.requestIdentity({ caller: 'im-document', context: room.id, name: body.requestId,
    payload: { taskId: card.id, target: { id: target.id, chatKey: target.chatKey }, fileName: file.name, text } })
  if (await rt.knownRequest(request) === undefined) rt.imDocumentTarget({ ...target, roomId: room.id }, true)
  const result = await rt.admitRequest(request, async () => {
    const receipt = await rt.imSendDocument(target, { name: file.name, data: Buffer.from(text) }, room.id)
    return JSON.stringify({ status: 'sent', ...target, taskId: card.id, fileName: file.name, ...receipt, sentAt: Date.now() })
  })
  if (!['sent', 'replay'].includes(result?.status))
    throw new Error('This delivery has no confirmed result (' + result?.status + '). Check the original receipt before sending again.')
  return JSON.parse(result.receipt)
}

export function installDocumentTool(rt) {
  rt.teamTools.push(defineTool({
    name: 'send_im_document',
    description: 'Send a Markdown document already registered on the current group task through its configured WeCom IM connection. Use only when the user requests IM delivery. This reuses the bound chat; do not ask for a new contact when exactly one bound chat exists. fileName is the exact document basename from the task artifact or blocker. Supply one stable requestId for this delivery and reuse it after a lost response. Returns a platform acknowledgement; a prepared document alone is not a sent file. This is independent of wecom-cli.',
    parameters: {
      taskId: { type: 'string', description: 'Current task ID; inferred from the dispatched execution when omitted.' },
      fileName: { type: 'string', required: true, description: 'Exact registered Markdown filename.' },
      requestId: { type: 'string', required: true, description: 'Stable identity for this document delivery.' },
      id: { type: 'string', description: 'Configured connection ID, only needed when more than one matches.' },
      chatKey: { type: 'string', description: 'Configured chat key, only needed when more than one matches.' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      if (rt.readOnly() !== undefined) throw new Error('Use the host holding the team write lock.')
      const session = exec.agent?.id
      const actor = rt.selfOf(session)
      const source = rt.live.get(session)?.info
      const room = rt.roomOf(rt.groupOwners.get(session)?.roomId ?? source?.roomId)
      const taskId = args.taskId ?? source?.taskId
      const card = room?.projectCards?.[taskId]
      if (!room?.members.includes(actor) || !card || (source?.taskId && source.taskId !== taskId)) throw new Error('Use this task’s group execution.')
      const admin = rt.isAdminOf(room, actor) && room.sessions?.[actor] === session
      if (!admin && !card.rounds.some(round => source?.exchangeId && round.ownerId === actor && round.dispatchId === source.exchangeId &&
        (!round.executionSession || round.executionSession === session) && (card.plans?.length ? currentBinding(card, round) : round === card.rounds.at(-1))))
        throw new Error('Only the group admin or its dispatched document owner can send this task document.')
      return JSON.stringify(await deliverDocument(rt, { ...args, taskId, roomId: room.id }))
    },
  }))
}

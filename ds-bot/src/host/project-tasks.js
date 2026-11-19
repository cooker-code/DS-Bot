// Project cards belong to the group. Keep small assignment records here and resolve
// the original text and attachments from the group's durable ledger when delivering.
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { taskRoom } from './task-routing.js'
import { output } from './tools.js'

export function projectRoomForCard(rt, id) {
  if (typeof id !== 'string') return undefined
  return Object.values(rt.state.rooms).find(room => Object.hasOwn(room.projectCards ?? {}, id.toLowerCase()))
}

export function intakeLines(rt, room, intakeId) {
  return rt.ledger.records('group-' + room.id).filter(line => line.intakeId === intakeId &&
    line.who === 'User' && !line.botId && !line.kind && typeof line.text === 'string')
}

function cardForIntake(room, intakeId) {
  return Object.values(room.projectCards ?? {}).find(card => card.intakes.includes(intakeId))
}

function sources(rt, room, card) {
  const ids = new Set(card.intakes)
  return rt.ledger.records('group-' + room.id).filter(line => ids.has(line.intakeId) &&
    line.who === 'User' && !line.botId && !line.kind && typeof line.text === 'string')
}

export const projectCardSummary = card => {
  const round = card.rounds.at(-1)
  return {
    taskId: card.id, title: card.title, round: card.rounds.length, ownerId: round.ownerId,
    updatedAt: round.submittedAt ?? round.startedAt ?? round.sentAt ?? round.assignedAt,
    status: round.result ? 'review' : round.startedAt ? 'active' : round.sentAt ? 'delivered' : 'assigned',
  }
}

function field(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Supply ' + label + ' (up to ' + max + ' characters).')
  return value.trim()
}

export function developmentHandoff(rt, session, room, card, owner, number) {
  const sender = rt.selfOf(session)
  const round = card?.rounds.at(-1)
  const source = rt.live.get(session)?.info
  if (!taskRoom(room) || !rt.isAdminOf(room, sender) || session !== rt.chatOf(sender) ||
      !round || card.rounds.length !== number || round.ownerId !== owner || !room.members.includes(owner) ||
      (source?.intakeId && (source.roomId !== room.id || !card.intakes.includes(source.intakeId)))) {
    throw new Error('Verify the project, manager, assigned owner and current round before dispatch.')
  }
  const lines = sources(rt, room, card)
  if (!lines.length) throw new Error('Original project intake not found.')
  const previous = card.rounds.at(-2)?.result
  const text = [card.title, ...lines.map(line => line.text), previous && 'Previous delivery: ' + previous, 'Handoff: ' + round.plan, 'Acceptance: ' + card.acceptance].filter(Boolean).join('\n\n')
  return { text, images: lines.flatMap(line => line.images ?? []), files: lines.flatMap(line => line.files ?? []), round }
}

export function install(rt) {
  rt.teamTools.push(defineTool({
    name: 'project_task',
    description: 'Manage DS Bot project cards in a group with [taskId] in its notice. In the manager chat, list cards and members, assign an intake, or attach it to an existing card. Read before sending the assignment with message_bot. The owner starts and submits its actual dispatch round. The manager can hand a submitted result to the next member.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'read', 'assign', 'attach', 'start', 'submit', 'handoff'] },
      roomId: { type: 'string', description: 'Group ID for list outside a project turn.' },
      taskId: { type: 'string', description: 'Persistent card ID for read, attach, start, submit or handoff.' },
      ownerId: { type: 'string', description: 'Group member ID for assign or handoff.' },
      title: { type: 'string', description: 'Short title for a new card.' },
      plan: { type: 'string', description: 'Work and planned handoffs through final user acceptance.' },
      acceptance: { type: 'string', description: 'How the user can verify the result.' },
      round: { type: 'integer', description: 'Current round for start, submit or handoff.' },
      result: { type: 'string', description: 'Deliverable and actual verification evidence.' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const session = exec.agent?.id
      const actor = rt.selfOf(session)
      const source = rt.live.get(session)?.info
      const id = args.taskId?.toLowerCase() ?? source?.taskId
      const boundRoom = rt.groupOwners.get(session)?.roomId ?? source?.roomId
      const room = rt.roomOf(boundRoom ?? args.roomId) ?? (!boundRoom && !args.roomId ? projectRoomForCard(rt, id) : undefined)
      if (!taskRoom(room) || !room.members.includes(actor) || (args.roomId && args.roomId !== room.id)) throw new Error('Choose a task-enabled group you belong to.')
      if (source?.taskId && source.taskId !== id) throw new Error('This execution belongs to a different card.')
      const manager = rt.isAdminOf(room, actor) && rt.chatOf(actor) === session
      const members = room.members.map(rt.botOf).filter(Boolean).map(({ id, name, role }) => ({ id, name, role }))
      const cards = Object.values(room.projectCards ?? {})
      if (args.action === 'list') return JSON.stringify({ roomId: room.id, members, cards: cards.map(projectCardSummary) })
      let card = cards.find(item => item.id === id)
      if (args.action === 'read') {
        if (!card) throw new Error('No such card in this group.')
        return JSON.stringify({ ...projectCardSummary(card), acceptance: card.acceptance, rounds: card.rounds,
          requirements: sources(rt, room, card).map(({ seq, text, images, files }) => ({ seq, text, images, files })) })
      }
      if (rt.readOnly() !== undefined) throw new Error('This host cannot write the Bot team.')
      if (args.action === 'assign' || args.action === 'attach') {
        if (!manager || !source?.intakeId || !intakeLines(rt, room, source.intakeId).length) throw new Error('Use the manager chat handling the original group intake.')
        const linked = cardForIntake(room, source.intakeId)
        if (args.action === 'attach') {
          if (!card || (linked && linked !== card)) throw new Error('Intake and card must belong to the same project and agree.')
          if (!linked) card.intakes.push(source.intakeId)
        } else {
          if (args.taskId) throw new Error('Use attach to add the intake to an existing card.')
          const title = field(args.title, 'a title', 200)
          const plan = field(args.plan, 'a handoff plan', 4000)
          const acceptance = field(args.acceptance, 'acceptance conditions', 2000)
          if (linked) {
            const first = linked.rounds[0]
            if (linked.title !== title || first.ownerId !== args.ownerId || first.plan !== plan || linked.acceptance !== acceptance) {
              throw new Error('This intake was already assigned with different details. Read card ' + linked.id + '.')
            }
            card = linked
          } else {
            checkOwner(room, actor, args.ownerId)
            card = { id: randomUUID(), title, acceptance, intakes: [source.intakeId], rounds: [assignment(args.ownerId, plan)] }
            ;(room.projectCards ??= {})[card.id] = card
          }
        }
      } else {
        if (!card) throw new Error('No such card in this group.')
        const round = card.rounds.at(-1)
        if (args.round !== card.rounds.length) throw new Error('Read the current card round.')
        if (args.action === 'handoff') {
          if (!manager || !round.result || (source?.intakeId && !card.intakes.includes(source.intakeId))) throw new Error('The manager can hand off a submitted result.')
          checkOwner(room, actor, args.ownerId)
          card.rounds.push(assignment(args.ownerId, field(args.plan, 'a handoff plan', 4000)))
        } else {
          if (actor !== round.ownerId || source?.exchangeId !== round.dispatchId) throw new Error('Only the owner in the dispatched execution can confirm or submit it.')
          if (args.action === 'start') round.startedAt ??= Date.now()
          else if (args.action === 'submit' && round.startedAt) {
            const result = field(args.result, 'the verified result', 4000)
            if (round.result && result !== round.result) throw new Error('This round already has a different result.')
            round.result = result
            round.submittedAt ??= Date.now()
          } else throw new Error('Confirm the start before submitting the result.')
        }
      }
      await rt.save({ required: true })
      return JSON.stringify(projectCardSummary(card))
    },
  }))
}

function checkOwner(room, manager, owner) {
  if (owner === manager || !room.members.includes(owner)) throw new Error('Pick an executing Bot from this group other than the dispatching manager.')
}

function assignment(ownerId, plan) {
  return { ownerId, plan, assignedAt: Date.now(), dispatchId: randomUUID() }
}

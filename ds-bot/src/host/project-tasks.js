import { beginValidation, checkpointValidation, validationReceipt } from './project-validation.js'
import { taskError } from '../shared/task-settings.js'
import { assistantId, decidesGitWorkspace, runsProject, projectNotice } from './project-assistant.js'
// Project cards belong to the group. Keep small assignment records here and resolve
// the original text and attachments from the group's durable ledger when delivering.
import { existingProjectDir, manageBranches, taskWorkspaceChoices, resolvePlanWorkspaces, reserveNodePaths, resolveNodeWorkspace, verifiedTree, projectRepository, reviewBaseline, verifyReviewCommit, verifyIntegration } from './project-branches.js'
import { workspacePolicyOf } from '../shared/project-workspace.js'
import { isDeepStrictEqual } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { approveRound, completeRelatedCards, checkOwner, dispatchNode, field, nodeHandoff, nodeViews, plannedSummary, planParameters, savePlan, taskCheckout, taskWorkspaceFor } from './project-plan.js'
import { blockRound, checkProjectStart, currentBinding, inspectReplannedWriter, inspectRecovery, recoverNode, recoveryParameters } from './project-recovery.js'
import { codeDelivery, projectStatus, taskPhase } from './project-status.js'
import { scopeFields, scopeOf, taskRoom } from './task-routing.js'
import { taskMessage } from '../shared/task-message.js'
import { speakerOf } from '../shared/mentions.js'
import { excerpt } from './text.js'
import { output } from './tools.js'

export const relatedTaskGuidance = 'Before planning, list the group cards and read plausible matches. Compare the actual fix, deliverables and acceptance criteria. If one implementation can satisfy both cards, call relate with taskId for the child and parentTaskId for the primary card. Inspect existing plans and rounds. Coordinate the shared fix once on the primary card and track both acceptance criteria; do not dispatch duplicate work on the child. Keep independent work separate; a similar title alone is insufficient.'

export function projectRoomForCard(rt, id) {
  if (typeof id !== 'string') return undefined
  return Object.values(rt.state.rooms).find(room => Object.hasOwn(room.projectCards ?? {}, id.toLowerCase()))
}

export function hasBlockedExecution(card) {
  return card?.rounds.some(run => currentBinding(card, run) && run.planNode.block && !run.result)
}

export function intakeLines(rt, room, intakeId) {
  return rt.ledger.records('group-' + room.id).filter(line => line.intakeId === intakeId &&
    line.who === 'User' && !line.botId && !line.kind && line.reminderFor === undefined && typeof line.text === 'string')
}

export function pendingIntakes(room) {
  return (room.projectInbox ?? []).filter(item => ['pending', 'planning', 'clarify'].includes(item.status))
}

function intakeCard(room, receipt, reason, title) {
  const existing = cardForIntake(room, receipt.id)
  const card = existing ?? { id: randomUUID(), title: title || receipt.title || reason.slice(0, 200),
    classificationReason: reason, intakes: [receipt.id], rounds: [], plans: [] }
  ;(room.projectCards ??= {})[card.id] = card
  receipt.status = 'accepted'
  receipt.reason = reason
  return card
}

async function acceptWork(rt, room, intakeId, reason, title, delegatedSeq, document) {
  await rt.save({ required: true, mutate() {
    if (!taskRoom(room)) throw taskError('TASK_MANAGEMENT_DISABLED')
    const existing = cardForIntake(room, intakeId)
    if (existing) {
      if (delegatedSeq && delegatedSeq > (existing.delegatedSeq ?? 0)) {
        const updated = { ...existing, ...(existing.goal === undefined && !existing.plans?.length ? document : {}), delegatedSeq }
        delete updated.clarification
        room.projectCards[existing.id] = updated
        return () => { room.projectCards[existing.id] = existing }
      }
      return
    }
    const receipt = room.projectInbox?.find(item => item.id === intakeId)
    if (!receipt || room.deletedTaskIntakes?.includes(intakeId)) throw new Error('This intake is unavailable.')
    const previous = { ...receipt }
    const card = intakeCard(room, receipt, field(reason, 'the independently verifiable outcome for this new task', 4000), title)
    if (delegatedSeq) Object.assign(card, document, { delegatedSeq })
    return () => {
      delete room.projectCards[card.id]
      delete receipt.reason
      Object.assign(receipt, previous)
    }
  } })
}

export function cardForIntake(room, intakeId) {
  return Object.values(room.projectCards ?? {}).find(card => card.intakes?.includes(intakeId))
}

// A manager classifying a new intake may need the public exchange immediately
// before it. Keep this read separate from the sources and files of a task.
export function intakeContext(rt, room, beforeSeq, query) {
  const messages = rt.ledger.records('group-' + room.id).filter(line =>
    line.seq < beforeSeq && !line.kind && line.reminderFor === undefined && (line.botId || line.who === 'User') &&
    typeof line.text === 'string' && !room.deletedTaskIntakes?.includes(line.intakeId) &&
    (!query || line.text.includes(query))).slice(-8)
  return messages.map(line => {
    const body = taskMessage(line.text, room).body
    const receipt = !line.botId && line.intakeId && room.projectInbox?.find(item => item.id === line.intakeId && item.seq < beforeSeq)
    const card = line.taskId ? room.projectCards?.[line.taskId] : line.intakeId && cardForIntake(room, line.intakeId)
    return { seq: line.seq, speaker: speakerOf(line), text: excerpt(body, query ?? '', 800),
      ...(receipt ? { status: receipt.status, reason: receipt.reason } : {}),
      ...(card ? { card: card.title, taskId: card.id } : {}) }
  })
}

export function projectSources(rt, room, intakeIds, taskId, throughSeq = Infinity) {
  const records = rt.ledger.records('group-' + room.id)
  const users = records.filter(line => line.seq <= throughSeq && line.who === 'User' && !line.botId && !line.kind && line.reminderFor === undefined && typeof line.text === 'string')
  const ids = new Set(intakeIds)
  // A copied web annotation can keep its exact text while losing its screenshot.
  // Only one earlier, unclaimed original in this group may supply the missing image.
  const annotation = line => line.text.replace(/^\[(?:intake-)?[a-f\d-]+\]\s*/i, '').trim()
  for (const line of users) {
    if (!ids.has(line.intakeId) || line.images?.length) continue
    const body = annotation(line)
    if (!body.startsWith('【网页批注】')) continue
    const originals = users.filter(other => other.seq < line.seq && other.intakeId && other.images?.length && annotation(other) === body)
    if (originals.length !== 1) continue
    const original = originals[0]
    const owner = cardForIntake(room, original.intakeId)
    if (!owner || owner.id === taskId) ids.add(original.intakeId)
  }
  return users.filter(line => ids.has(line.intakeId) || (taskId && line.taskId === taskId))
}

export const projectCardSummary = (card, taskId = card.id) => {
  const round = card.rounds?.at(-1)
  return {
    taskId, ...(card.parentTaskId ? { parentTaskId: card.parentTaskId } : {}), title: card.title, humanAcceptanceRequired: card.humanAcceptanceRequired ?? Boolean(card.humanReview), classificationReason: card.classificationReason, round: card.rounds?.length ?? 0, ownerId: round?.ownerId,
    ...(card.finishAfterIntegration && { finishAfterIntegration: card.finishAfterIntegration }),
    ...(card.updatedAt !== undefined ? { textUpdatedAt: card.updatedAt } : {}),
    startedAt: round?.startedAt, submittedAt: round?.submittedAt, stoppedAt: round?.failedAt,
    ...(card.clarification ? { clarification: card.clarification } : {}),
    ...(!card.completedWithTaskId && card.humanReview?.status === 'pending' && card.humanReview.version === card.plans?.at(-1)?.version
      ? { acceptanceRequest: { id: card.humanReview.id, artifact: card.humanReview.artifact } } : {}),
    updatedAt: round?.submittedAt ?? round?.failedAt ?? round?.startedAt ?? round?.sentAt ?? round?.assignedAt,
    status: taskPhase(card, projectStatus(round)), ...(card.plans?.length ? plannedSummary(card) : {}),
  }
}

export function projectRequirement(room, card, sources) {
  const original = sources.find(line => line.intakeId === card.intakes?.[0]) ?? sources[0]
  return card.goal ?? (original && taskMessage(original.text, room).body) ?? card.title ?? ''
}

// Workers still need later instructions, even when the requirement itself has not changed.
export function projectWorkContext(room, card, sources) {
  const covered = new Set(card.requirementSources)
  const parts = sources.filter(line => !covered.has(line.seq)).map(line => taskMessage(line.text, room).body)
  if (card.goal !== undefined) parts.unshift(card.goal)
  return parts.length ? parts.filter(Boolean).join('\n\n') : card.title ?? ''
}

function uniqueImages(images) {
  return [...new Map(images.map(image => [image.attachmentId ?? image.id, image])).values()]
}

function requirementHistory(room, card, sources) {
  if (card.requirementHistory) return card.requirementHistory
  // Older hosts recorded a user edit and its source messages but did not take snapshots.
  if (!card.fieldEditTimes?.requirement || typeof card.goal !== 'string') return []
  const original = sources.find(line => line.intakeId === card.intakes?.[0] && card.requirementSources?.includes(line.seq))
  if (!original) return []
  const text = taskMessage(original.text, room).body
  return text && text !== card.goal ? [{ text, images: original.images ?? [] }] : []
}

export function projectImages(card, sources) {
  return uniqueImages([...sources.flatMap(line => line.images ?? []),
    ...(card?.fieldImages?.requirement ?? []), ...(card?.fieldImages?.acceptance ?? [])])
}

export async function readProjectImage(rt, room, card, taskId, imageId, signal) {
  const sources = projectSources(rt, room, card.intakes ?? [], taskId)
  const available = [...projectImages(card, sources), ...(card.requirementHistory ?? []).flatMap(entry => entry.images)]
  const ref = available.find(image => (image.attachmentId ?? image.id) === imageId)
  if (!ref) throw Object.assign(new Error('Image unavailable'), { code: 'bot/not-found' })
  const stored = await rt.ctx.get('attachments').readImage(ref.attachmentId ? ref : { ...ref, attachmentId: imageId }, signal)
  return 'data:' + stored.ref.mediaType + ';base64,' + Buffer.from(stored.data).toString('base64')
}

export function projectCardDetail(rt, room, card, taskId = card.id, textOnly = false) {
  const sources = projectSources(rt, room, card.intakes ?? [], taskId)
  const text = { requirement: projectRequirement(room, card, sources), acceptance: card.acceptance ?? '' }
  const sourceImages = uniqueImages(sources.flatMap(line => line.images ?? []))
  if (sourceImages.length) text.sourceImages = sourceImages
  if (card.fieldImages) text.fieldImages = card.fieldImages
  if (textOnly) return text
  const checkout = taskCheckout(card)
  return {
    ...projectCardSummary(card, taskId), requirementHistory: requirementHistory(room, card, sources), supportsHumanAcceptance: Boolean(card.plans), ...(checkout && { taskWorkspace: checkout }), ...(card.workspace && { selectedWorkspace: card.workspace }), ...text, ...(card.humanReview ? { humanReview: card.humanReview } : {}), rounds: card.rounds ?? [],
    ...(card.plans?.length ? { plans: card.plans.map(plan => ({ ...plan, nodes: nodeViews(card, plan) })) } : {}),
    ...(card.previousReviews?.length ? { previousReviews: card.previousReviews } : {}),
    requirements: sources.map(({ seq, text, images, files }) => ({ seq, text, images, files })),
  }
}

export async function updateProjectTaskText(rt, { roomId, taskId, field: key, previous, value, removeImages = [] }, saveImages) {
  if (!['requirement', 'acceptance'].includes(key) || typeof value !== 'string' || typeof previous !== 'string')
    throw new Error('Invalid task edit.')
  if (!Array.isArray(removeImages) || removeImages.some(id => typeof id !== 'string')) throw new Error('Invalid task edit.')
  if (key === 'acceptance') field(value, 'acceptance conditions', 2000)
  const targetRoom = () => {
    const room = rt.roomOf(roomId)
    if (!room) throw taskError('GROUP_CONTEXT_REQUIRED')
    if (!taskRoom(room)) throw taskError('TASK_MANAGEMENT_DISABLED')
    if (typeof taskId !== 'string' || !Object.hasOwn(room?.projectCards ?? {}, taskId))
      throw Object.assign(new Error('No such task'), { code: 'bot/not-found' })
    return room
  }
  targetRoom()
  const added = saveImages ? await saveImages() : []
  await rt.save({ required: true, mutate() {
    const room = targetRoom()
    const card = room.projectCards[taskId]
    const beforeImages = card.fieldImages?.[key] ?? []
    const images = uniqueImages([...beforeImages.filter(image => !removeImages.includes(image.attachmentId)), ...added])
    const sources = key === 'requirement' ? projectSources(rt, room, card.intakes ?? [], taskId) : []
    const current = key === 'requirement' ? projectRequirement(room, card, sources) : card.acceptance ?? ''
    if (current !== previous && current !== value) throw new Error('This field has changed. Reopen it to edit the latest text.')
    const changes = {}
    if (current !== value) Object.assign(changes, key === 'requirement'
      ? { goal: value, requirementSources: sources.map(line => line.seq) } : { acceptance: value })
    if (!isDeepStrictEqual(images, beforeImages)) changes.fieldImages = { ...card.fieldImages, [key]: images }
    if (!Object.keys(changes).length) return
    if (key === 'requirement') changes.requirementHistory = [...requirementHistory(room, card, sources), {
      text: current, images: uniqueImages([...sources.flatMap(line => line.images ?? []), ...beforeImages]),
    }]
    const updatedAt = Math.max(Date.now(), (card.updatedAt ?? 0) + 1)
    if (card.plans?.length) changes.fieldEditTimes = { ...card.fieldEditTimes, [key]: updatedAt }
    room.projectCards[taskId] = { ...card, ...changes, updatedAt }
    delete room.projectCards[taskId].clarification
    return () => { room.projectCards[taskId] = card }
  } })
  const room = targetRoom()
  const card = room.projectCards[taskId]
  const editedAt = card.fieldEditTimes?.[key]
  if (editedAt && projectCardSummary(card).status !== 'done') {
    await projectNotice(rt, room, assistantId(room) ?? room.admin, { taskId },
      'task-edit:' + taskId + ':' + key + ':' + editedAt,
      'The user edited the task ' + key + '. Read the latest requirement and acceptance on this card. Update affected plan nodes, coordinate any active writer, then dispatch and deliver the ready work on this card.')
  }
  return value
}

export function developmentHandoff(rt, session, room, card, owner, number) {
  const sender = rt.selfOf(session)
  const round = card?.rounds[number - 1]
  const current = round?.planNode ? currentBinding(card, round) && !round.planNode.block : number === card?.rounds.length
  const source = rt.live.get(session)?.info
  if (!room) throw taskError('GROUP_CONTEXT_REQUIRED')
  if (!room.members.includes(sender) || !room.members.includes(owner)) throw taskError('NOT_GROUP_MEMBER')
  if (source?.roomId && source.roomId !== room.id) throw taskError('GROUP_CONTEXT_MISMATCH')
  if (!taskRoom(room)) throw taskError('TASK_MANAGEMENT_DISABLED')
  if (room.unresolvedTaskAssistant || (room.projectAssistantId && !assistantId(room))) throw taskError('TASK_ASSISTANT_INVALID')
  if (!runsProject(rt, room, sender) || session !== room.sessions?.[sender]) throw taskError('TASK_ROLE_REQUIRED')
  if (!round || !current || round.ownerId !== owner ||
      (source?.intakeId && !card.intakes.includes(source.intakeId))) {
    throw new Error('Verify the project, manager, assigned owner and current round before dispatch.')
  }
  const lines = projectSources(rt, room, card.intakes, card.id)
  if (!lines.length) throw new Error('Original project intake not found.')
  const previous = !round.planNode && card.rounds.at(-2)?.result
  const requirement = card.goal === undefined ? lines.map(line => line.text).join('\n\n') : projectWorkContext(room, card, lines)
  const legacyWorkspace = !round.planNode && round.workspace
  const folder = legacyWorkspace && 'Before starting, use working_directory to enter ' + legacyWorkspace.workDir + ' on branch ' + legacyWorkspace.workRef + '.'
  const text = [card.title, requirement, folder, previous && 'Previous delivery: ' + previous, round.planNode && nodeHandoff(card, round), 'Handoff: ' + round.plan, 'Acceptance: ' + card.acceptance].filter(Boolean).join('\n\n')
  return { text, images: projectImages(card, lines), files: lines.flatMap(line => line.files ?? []), round }
}

export function install(rt) {
  rt.teamTools.push(defineTool({
    name: 'project_task',
    description: 'Manage DS Bot project cards. When the room has a task assistant, the admin uses delegate with plan and acceptance to hand off a user intake. The assistant owns the plan, dispatch, recovery and review. The admin uses report with message for results or questions returned by the assistant. For Git work the appointed task assistant (or the Main Bot if unassigned) in its group chat calls branches to inventory local branches, describe_branch to record its purpose, prepare_worktree to create or reuse one, then plan one task workspaceMode, workRef and workspaceReason with writePaths per Git step. Manager: use context to resolve references against earlier public group messages and recorded classifications. List members, plan a complete DAG for an intake or attach, clarify or classify as chat. Use clarify with a specific question. Unclassified intakes wait for an answer without creating a card. For an explicit user request to relate A to B, use relate with taskId A and parentTaskId B. The current owner may also clarify their assigned card. On blocked rounds clarify coordinates on the card between the assistant and admin. Use block for an execution impediment, inspect_recovery or plan for recovery, and give the user progress updates. Only the group admin can mark a blocked card as needing human input with humanInput and a specific user-only question. After revising requirements or acceptance, dispatch ready nodes in the current plan. Dispatch checks whether the same developer can reclaim a stopped historical writer’s clean checkout at its original start commit. Plan creates zero rounds. Dispatch each ready node with its version and node, then message_bot with the returned dispatchRound. Owners start and submit that round. Normally approve the last artifact to finish automatically. Only if the user explicitly requested human sign-off, request_acceptance for the final submitted artifact instead. Approve its artifact before dispatching dependents. Independent nodes run concurrently. Owners checkpoint or block their dispatched round. For a blocked node the manager can wait, revise the plan, or inspect_recovery for a candidate. Read its artifact, original writer and worktree evidence. Pass inspection, expectedCommit, remaining checks, eligibility and worktreeReview to resume or takeover, then send the returned dispatchRound.',
    parameters: {
      acceptWork: { type: 'boolean', description: 'With reply, create the formal task card before announcing acceptance of actual work, including read-only investigation.' },
      humanInput: { type: 'string', enum: ['requirement', 'external_permission'], description: 'Only the group admin may set this with clarify on a blocked execution, for a missing user requirement or permission outside the team. Ordinary branch, review, testing and recovery decisions belong to the assistant and admin.' },
      humanAcceptanceRequired: { type: 'boolean', description: 'Record required human sign-off on the first plan.' },
      classificationReason: { type: 'string', description: 'For new work accepted by reply, specify the distinct deliverable and how its completion can be verified.' },
      action: { type: 'string', required: true, enum: ['reply', 'report', 'delegate', 'branches', 'describe_branch', 'prepare_worktree', 'list', 'context', 'read', 'relate', 'assign', 'attach', 'start', 'submit', 'handoff', 'plan', 'dispatch', 'approve', 'request_acceptance', 'clarify', 'chat', 'checkpoint', 'block', 'record_merge', 'return_for_changes', 'wait', 'inspect_recovery', 'resume', 'takeover'] },
      message: { type: 'string', description: 'First public answer to the current group input. Use reply before planning, or chat with message and reason to answer and classify an unassigned question together. Members are not called.' },
      ...planParameters, ...recoveryParameters,
      repository: { type: 'string', description: 'Repository root inside the configured project working folder.' },
      baseRef: { type: 'string', description: 'Local branch for merge comparison and baseline for a new worktree. Defaults to the current checkout branch.' },
      workRef: { type: 'string', description: 'Local branch to prepare. Supply reason for its purpose.' },
      roomId: { type: 'string', description: 'Group ID for list outside a project turn.' },
      query: { type: 'string', description: 'For context, an optional literal excerpt to find in earlier public group messages.' },
      taskId: { type: 'string', description: 'Persistent card ID for read, attach, start, submit or handoff.' },
      parentTaskId: { type: 'string', description: 'For relate, the existing primary project card in this group. The child keeps its ID and history.' },
      ownerId: { type: 'string', description: 'Group member ID for assign or handoff.' },
      title: { type: 'string', description: 'Short title for a new card.' },
      plan: { type: 'string', description: 'For first plan and delegation, the clarified requirement as a concise numbered list. For assignment or handoff, instructions for the next owner.' },
      acceptance: { type: 'string', description: 'Concise numbered list of observable conditions the user can verify.' },
      round: { type: 'integer', description: 'Execution round for start, checkpoint, block, submit or handoff. Required for approve and request_acceptance together with taskId, version, node and artifact. Use the submitted node’s round from project_task read.' },
      checking: { type: 'string', description: 'Checkpoint: the acceptance check now in progress.' },
      passedCheck: { type: 'string', description: 'Checkpoint: name of a passed check. Supply evidence with the observed result or existing artifact.' },
      checksComplete: { type: 'boolean', description: 'Checkpoint: set true with the last passing check to show that validation passed and cleanup is pending.' },
      cleanupEvidence: { type: 'string', description: 'Submit a read-only validation receipt after all acceptance checks pass. Supply the verified cleanup outcome, or state why no resources were created. The host reuses recorded checks and candidate; omit result and commit.' },
      result: { type: 'string', description: 'Deliverable and actual verification evidence.' },
      commit: { type: 'string', description: 'Full delivery commit ID for a code submission. The host checks the assigned branch for a project candidate, and dev for tested integrations. On approve, supply it for an older code delivery without verified evidence.' },
      mergeCommit: { type: 'string', description: 'For record_merge, the full immutable commit on dev resulting from integrating the candidate. Send this receipt immediately before post-merge validation.' },
      testedCommit: { type: 'string', description: 'Full immutable integration commit actually verified after merging the candidate. It must include the candidate and remain on local dev; dev may have advanced since testing.' },
      feedback: { type: 'string', description: 'For a failed integration test, actionable changes for the developer, with the failed expectation and reproduction.' },
      deliveryKind: { type: 'string', enum: ['code', 'other'], description: 'For older assignments without a recorded Git scope, declare whether this submission changes code.' },
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
      if (!room) throw taskError('GROUP_CONTEXT_REQUIRED')
      if (!room.members.includes(actor)) throw taskError('NOT_GROUP_MEMBER')
      if (args.roomId && args.roomId !== room.id) throw taskError('GROUP_CONTEXT_MISMATCH')
      if (!['list', 'read', 'context'].includes(args.action)) {
        if (!taskRoom(room)) throw taskError('TASK_MANAGEMENT_DISABLED')
        if (room.unresolvedTaskAssistant || (room.projectAssistantId && !assistantId(room))) throw taskError('TASK_ASSISTANT_INVALID')
      }
      const manager = runsProject(rt, room, actor) && room.sessions?.[actor] === session
      const original = Number.isSafeInteger(source?.intakeSeq) && rt.ledger.record('group-' + room.id, source.intakeSeq)
      const contact = rt.isAdminOf(room, actor) && room.sessions?.[actor] === session
      const intakeRelation = args.action === 'relate' && contact && source?.role === 'request' &&
        source.roomId === room.id && !source.senderSessionId && original?.who === 'User' && !original.botId &&
        original.intakeId && (source.taskId ? original.taskId === source.taskId : original.intakeId === source.intakeId)
      const planningAccess = (manager && args.action === 'read') ||
        ((manager || intakeRelation) && args.action === 'relate' && source?.taskId === args.parentTaskId)
      if (source?.taskId && source.taskId !== id && !planningAccess) throw new Error('This execution belongs to a different card.')
      const members = room.members.map(rt.botOf).filter(Boolean).map(({ id, name, role }) => ({ id, name, role }))
      const cards = Object.values(room.projectCards ?? {})
      if (args.action === 'list') return JSON.stringify({ roomId: room.id, workspacePolicy: workspacePolicyOf(room), members, inbox: pendingIntakes(room), cards: cards.map(card => projectCardSummary(card)) })
      const reminder = original?.reminderFor !== undefined
      if (reminder && !['reply', 'context', 'read'].includes(args.action) && !(args.action === 'chat' && args.message !== undefined))
        throw new Error('This mention asks for a group answer. Use project_task reply.')
      if (['branches', 'describe_branch', 'prepare_worktree'].includes(args.action)) return JSON.stringify(await manageBranches(rt, room, args, actor, exec))
      const card = cards.find(item => item.id === id)
      const assistant = assistantId(room)
      if (['delegate', 'report', 'reply', 'chat', 'attach'].includes(args.action) && !contact) throw taskError('TASK_ROLE_REQUIRED')
      if (['relate', 'plan', 'dispatch', 'approve', 'request_acceptance', 'wait', 'takeover', 'resume', 'inspect_recovery'].includes(args.action) && !manager && !intakeRelation) throw taskError('TASK_ROLE_REQUIRED')
      const handoffOnReply = args.action === 'reply' && args.acceptWork === true && assistant && args.plan && args.acceptance
      if (args.action === 'delegate' || handoffOnReply) {
        const intakeId = original?.intakeId
        const linked = intakeId && cardForIntake(room, intakeId)
        if (!assistant || !contact || source?.role !== 'request' || source.roomId !== room.id || source.senderSessionId ||
            !intakeId || original.who !== 'User' || original.botId || original.reminderFor !== undefined ||
            room.deletedTaskIntakes?.includes(intakeId) || (source.intakeId !== intakeId && (!linked || source.taskId !== linked.id)) ||
            (id && linked?.id !== id)) throw new Error('Delegate from the admin chat handling this original group intake.')
        const goal = field(args.plan, 'the clarified requirement', 4000)
        const acceptance = field(args.acceptance, 'acceptance conditions', 2000)
        const lines = projectSources(rt, room, linked?.intakes ?? [intakeId], linked?.id, original.seq)
        const owners = members.filter(bot => bot.id !== actor && bot.id !== assistant)
        await acceptWork(rt, room, intakeId, args.classificationReason || goal, args.title, original.seq, { goal, acceptance, requirementSources: lines.map(line => line.seq) })
        if (handoffOnReply) {
          const message = field(args.message, 'the answer for the group', 4000)
          await rt.replyToProjectIntake(room, rt.botOf(actor), original, message)
        }
        const scope = linked ? { taskId: linked.id } : { intakeId }
        const text = [
          'The group admin delegated this requirement to you as its task assistant. Manage this same project card in your session for this group.',
          relatedTaskGuidance,
          'For every feature task, the developer commits on the feature branch. Dispatch a final independent read-only test node with independentReview=true, writePaths=[] and a dependency on the approved developer candidate. Keep the user’s acceptance criteria separate from the tester’s choice of checks. Reuse existing results, record each check on the card, and submit the read-only receipt with cleanupEvidence. No separate report file is needed. Approve the receipt to finish; keep the candidate on the feature branch. Integration, installation and release require separate work. On test failure return the feedback to the developer and retest the revised candidate.',
          'Requirement: ' + goal, 'Acceptance: ' + acceptance, 'Eligible node owners: ' + JSON.stringify(owners),
          linked ? 'Read and continue the existing card: ' + linked.id : 'For independent work, save the complete plan with project_task plan (version 1).',
          'For Git work, inventory branches, prepare the checkout if needed, and follow the group workspace policy: ' + workspacePolicyOf(room) + '.',
          'When revising the test plan, reuse the accepted developer round and preserve its branch and candidate. Trellis records requirements and evidence; an authorized feature commit needs no separate grouping approval.',
          'Dispatch ready nodes and use message_bot with taskId, card_round, reply_to=user and request_id to the assigned owner. Review submitted evidence, approve nodes, and resolve blocks. Handle branch, review, validation and recovery blockers within the team. On a blocked round clarify sends a technical question to the admin for a decision. The host informs the admin of clarification and completion. Normally approve the final node; request_acceptance only for explicit human sign-off.',
          ...lines.map(line => 'Group #' + line.seq + ': ' + taskMessage(line.text, room).body),
        ].join('\n\n')
        await projectNotice(rt, room, assistant, scope, 'delegate-' + original.seq, text, { images: projectImages(linked, lines), files: lines.flatMap(line => line.files ?? []) }, { goal, acceptance })
        return JSON.stringify({ delegated: true, assistantId: assistant, ...scope })
      }
      if (args.action === 'report') {
        if (!assistant || !contact || source?.role !== 'request' || source.roomId !== room.id || !scopeOf(source) ||
            (args.taskId && args.taskId !== source.taskId)) throw new Error('Report from the group admin chat handling this task.')
        const message = field(args.message, 'the message for the user', 4000)
        const request = rt.requestIdentity({ caller: actor, context: 'project-report:' + room.id, name: source.exchangeId, payload: { scope: scopeOf(source) } })
        const result = await rt.admitRequest(request, () => rt.postToRoom(room, rt.botOf(actor), message, { ...scopeFields(scopeOf(source)), quiet: true }))
        if (!['sent', 'replay', 'expired'].includes(result.status)) throw new Error('Check report delivery: ' + result.status)
        return JSON.stringify({ reported: true })
      }
      let publish
      if (args.action === 'reply' || (args.action === 'chat' && args.message !== undefined)) {
        if (!contact || source?.role !== 'request' || source.senderSessionId || source.roomId !== room.id ||
            !original?.intakeId || original.who !== 'User' || original.botId || room.deletedTaskIntakes?.includes(original.intakeId) ||
            (source.intakeId !== original.intakeId && !card?.intakes?.includes(original.intakeId)) ||
            (args.taskId && !card?.intakes?.includes(original.intakeId)))
          throw new Error('Reply from the manager chat handling this group message.')
        const message = field(args.message, 'the answer for the group', 4000)
        if (args.action === 'reply' && args.acceptWork === true && !reminder) await acceptWork(rt, room, original.intakeId, args.classificationReason, args.title)
        publish = () => rt.replyToProjectIntake(room, rt.botOf(actor), original, message)
        if (args.action === 'reply' || reminder) return publish()
      }
      if (args.action === 'context') {
        if (!contact || source?.role !== 'request' || !source.intakeId || !Number.isSafeInteger(source.intakeSeq) || source.roomId !== room.id)
          throw new Error('Read conversation context from the manager chat handling this group intake.')
        const before = Number.isSafeInteger(original?.reminderFor) ? original.reminderFor + 1 : source.intakeSeq
        return JSON.stringify(intakeContext(rt, room, before, args.query?.trim()))
      }
      const recorded = card && taskCheckout(card)
      let inheritedCheckout
      if (recorded?.workDir && !recorded.workspaceMode && (args.action === 'read' ||
          (args.action === 'dispatch' && manager && card.plans?.at(-1)?.nodes[args.node - 1]?.workspaceMode !== 'none'))) {
        const view = await taskWorkspaceChoices(rt, room.id, id)
        if (view.available) inheritedCheckout = view.effective
        else if (args.action === 'dispatch' && view.hasRepository) throw new Error('The task worktree is unavailable. Select the task branch before dispatch.')
      }
      const executionCard = inheritedCheckout ? { ...card, plannedWorkspace: inheritedCheckout } : card
      if (args.action === 'read') {
        if (!card) throw new Error('No such card in this group.')
        return JSON.stringify(projectCardDetail(rt, room, executionCard))
      }
      if (args.action === 'plan' && manager && Array.isArray(args.nodes)) {
        const planningCard = card ?? (source?.intakeId && cardForIntake(room, source.intakeId))
        const nodes = await resolvePlanWorkspaces(rt, room, args, actor, planningCard)
        for (const node of nodes.filter(n => n.mergeToDev && n.candidateCommit)) {
          const producer = planningCard?.rounds.findLast(r => r.startedAt && r.ownerId !== node.ownerId && r.workspace?.repository === node.repository &&
            r.workspace.workRef === node.workRef && codeDelivery(planningCard, r))
          if (!producer) throw new Error('Choose an existing developer round on this feature branch.')
          await verifyReviewCommit(rt, room, node.repository, node.candidateCommit, { ...codeDelivery(planningCard, producer), base: producer.reviewBase })
        }
        args = { ...args, nodes }
      }
      let ownershipTransfer
      if (args.action === 'dispatch' && manager && card?.plans?.at(-1)?.version === args.version) {
        const node = nodeViews(executionCard, card.plans.at(-1))[args.node - 1]
        const selection = node && (node.round ? card.rounds[node.round - 1].workspace : taskWorkspaceFor(executionCard, node))
        if (node?.writePaths || selection) {
          if (!decidesGitWorkspace(rt, room, actor)) throw new Error('Only the task assistant (or the Main Bot if unassigned) can dispatch Git assignments.')
          if (node.writePaths) {
            await resolveNodeWorkspace(rt, room, node, selection)
            ownershipTransfer = await inspectReplannedWriter(rt, card, node)
          }
          else await verifiedTree(rt, node.repository, node.workRef, node.workDir)
        } else if (node?.workDir && !node.contextGap) await existingProjectDir(node.workDir)
      }
      if (manager && card?.plans?.length && ['approve', 'request_acceptance'].includes(args.action) &&
          (!Number.isSafeInteger(args.round) || args.round < 1))
        throw new Error('Supply the submitted node’s round from project_task read with its version, node and verified artifact.')
      const legacyRound = card?.rounds?.[args.round - 1]
      if (args.action === 'start' && !legacyRound?.planNode && legacyRound?.workspace && !legacyRound.startedAt &&
          legacyRound.ownerId === actor && legacyRound.dispatchId === source?.exchangeId) {
        const { repository, workRef, workDir } = legacyRound.workspace
        const dir = rt.sessionFolder((await rt.resolveAgent(session)).session)
        if (await verifiedTree(rt, repository, workRef, dir) !== workDir) throw new Error('Enter the assigned working folder before starting this Git node.')
      }
      let observation
      if (['inspect_recovery', 'resume', 'takeover'].includes(args.action)) {
        if (!card || !manager || (source?.intakeId && !card.intakes.includes(source.intakeId))) throw new Error('Use the manager chat for this card.')
        if (args.action === 'inspect_recovery' || !card.rounds[args.round - 1]?.planNode?.supersededBy) observation = await inspectRecovery(rt, room, card, args, actor)
        if (args.action === 'inspect_recovery') return JSON.stringify(observation.facts)
      }
      if (args.action === 'start' && card?.rounds[args.round - 1]?.planNode && !card.rounds[args.round - 1].startedAt) {
        const target = card.rounds[args.round - 1]
        if (target.ownerId !== actor || !source?.exchangeId || source.exchangeId !== target.dispatchId || !currentBinding(card, target)) throw new Error('Use the current dispatched execution.')
        if (target.planNode.block) throw new Error('This execution is blocked. Read its recovery decision.')
        try { await checkProjectStart(rt, card, target, session) } catch (error) {
          await rt.save({ required: true, mutate() {
            const current = rt.roomOf(room.id)?.projectCards?.[id], run = current?.rounds[args.round - 1]
            if (!currentBinding(current, run) || run.dispatchId !== target.dispatchId || run.planNode.block || run.startedAt) return
            blockRound(run, { by: 'system', cause: 'worktree', reason: rt.redactSecrets(error.message), waitingFor: 'Manager verification of the working tree' })
            return () => { delete run.planNode.block }
          } })
          if (assistantId(room) && room.projectCards?.[id]?.rounds[args.round - 1]?.planNode?.block)
            await projectNotice(rt, room, assistantId(room), { taskId: id }, target.dispatchId + ':block',
              'The project working tree could not be verified at start. Read the blocker and plan recovery.')
          throw error
        }
      }
      let baseline, review
      const run = legacyRound
      const scope = run && codeDelivery(card, run)
      const selectedForReview = (targetCard, target) => {
        if (!target.planNode) return targetCard.rounds.at(-1) === target
        if (currentBinding(targetCard, target)) return !target.planNode.block
        const plan = targetCard.plans?.at(-1)
        return args.action === 'approve' && args.version === plan?.version && plan?.nodes[args.node - 1]?.reuseRound === args.round
      }
      const owner = run && run.ownerId === actor && source?.exchangeId === run.dispatchId
      const testNode = run?.planNode && card.plans.find(p => p.version === run.planNode.version)?.nodes[run.planNode.node - 1]
      if (args.action === 'return_for_changes') {
        if (!testNode?.independentReview || testNode.writePaths?.length !== 0 || !owner || !run.startedAt || !currentBinding(card, run)) throw new Error('Return changes from the current independent test execution.')
        const feedback = field(args.feedback, 'specific corrective feedback for the developer', 2000)
        args = { ...args, action: 'block', feedback, reason: feedback, waitingFor: 'Developer fix and independent retest' }
      }
      let integration, mergeReceipt
      if (testNode?.mergeToDev && owner && run.startedAt && ['record_merge', 'submit'].includes(args.action) && selectedForReview(card, run)) {
        const candidates = run.planNode.inputs.map(i => card.rounds[i.round - 1].mainReview?.commit).filter(Boolean)
        const candidate = testNode.candidateCommit ?? (candidates.length === 1 && candidates[0])
        if (!candidate || args.commit !== candidate) throw new Error('Submit the exact independently tested candidate commit.')
        const repo = run.workspace.repository
        await verifyReviewCommit(rt, room, repo, candidate, { branch: run.workspace.workRef })
        if (args.action === 'record_merge') {
          const merged = field(args.mergeCommit, 'the exact dev merge commit', 64)
          if (run.mergeReceipt && run.mergeReceipt.mergeCommit !== merged) throw new Error('This round already recorded a different merge.')
          const verified = await verifyIntegration(rt, room, repo, candidate, merged)
          mergeReceipt = { commit: candidate, mergeCommit: verified.testedCommit, devTip: verified.tip, at: Date.now() }
        } else {
          if (!run.mergeReceipt) throw new Error('Call record_merge before submitting post-merge validation.')
          const tested = field(args.testedCommit, 'the dev commit tested after the merge', 64)
          await verifyIntegration(rt, room, repo, run.mergeReceipt.mergeCommit, tested)
          if (run.integration && run.integration.testedCommit !== tested) throw new Error('This round already has a different integration receipt.')
          integration = run.integration ?? await verifyIntegration(rt, room, repo, candidate, tested)
        }
      }
      if (!run?.validation && !testNode?.mergeToDev && !scope && owner && args.action === 'submit' && run.startedAt && selectedForReview(card, run)) {
        const node = run.planNode && card.plans?.at(-1)?.nodes[run.planNode.node - 1]
        if (args.commit || args.deliveryKind === 'code') {
          if (run.mainReview && args.commit?.toLowerCase() !== run.mainReview.commit) throw new Error('This round already has a different verified delivery commit.')
          review = run.mainReview ?? await verifyReviewCommit(rt, room, args.repository, args.commit)
        } else if (!run.result && !node?.workspaceMode && !node?.writePaths && !args.deliveryKind && room.workDir &&
            await projectRepository(rt, room, undefined, true)) {
          throw new Error('Specify deliveryKind as code or other for this unclassified Git assignment.')
        }
      }
      if (scope && selectedForReview(card, run)) {
        if (owner && args.action === 'start' && !run.startedAt)
          baseline = run.reviewBase ?? await reviewBaseline(rt, room, scope.repository, scope.branch)
        if ((owner && args.action === 'submit' && run.startedAt) ||
            (manager && ['approve', 'request_acceptance', 'handoff'].includes(args.action) && run.result)) {
          if (!run.mainReview) review = await verifyReviewCommit(rt, room, scope.repository, args.commit, { ...scope, base: run.reviewBase })
          else if (args.commit && args.commit.toLowerCase() !== run.mainReview.commit) throw new Error('This round already has a different verified delivery commit.')
        }
      }
      if (rt.readOnly() !== undefined) throw new Error('This host cannot write the Bot team.')
      let result
      await rt.save({ required: true, mutate() {
        if (!taskRoom(room)) throw taskError('TASK_MANAGEMENT_DISABLED')
        if (rt.roomOf(room.id) !== room || !room.members.includes(actor)) throw new Error('Read the group again before changing a card.')
        if (args.action === 'dispatch' && card) {
          const current = room.projectCards?.[id]
          if (!current || (!isDeepStrictEqual(taskCheckout(current), taskCheckout(card)) &&
              (!inheritedCheckout || !isDeepStrictEqual(taskCheckout(current), inheritedCheckout))))
            throw new Error('The task workspace changed. Read the card before dispatch.')
        }
        const previousCards = room.projectCards, previousInbox = room.projectInbox
        const draft = { ...room, projectCards: { ...previousCards } }
        const linked = source?.intakeId && cardForIntake(room, source.intakeId)
        for (const key of new Set([id, linked?.id])) {
          if (key && Object.hasOwn(draft.projectCards, key)) draft.projectCards[key] = structuredClone(draft.projectCards[key])
        }
        if (ownershipTransfer) ownershipTransfer.apply(draft.projectCards[id])
        if (inheritedCheckout && draft.projectCards[id] && !draft.projectCards[id].plannedWorkspace)
          draft.projectCards[id].plannedWorkspace = inheritedCheckout
        if (review || baseline || integration || mergeReceipt) {
          const fresh = draft.projectCards[id], target = fresh?.rounds[args.round - 1]
          if (!target || target.dispatchId !== run.dispatchId || !isDeepStrictEqual(codeDelivery(fresh, target), scope))
            throw new Error('The assignment changed. Read the current round before submitting.')
          if (selectedForReview(fresh, target)) {
            if (mergeReceipt) {
              if (target.mergeReceipt && target.mergeReceipt.mergeCommit !== mergeReceipt.mergeCommit) throw new Error('This round already recorded a different merge.')
              target.mergeReceipt ??= mergeReceipt
            }
            if (integration) target.integration ??= integration
            if (baseline) target.reviewBase ??= baseline
            if (review) {
              if (target.mainReview && target.mainReview.commit !== review.commit) throw new Error('This round already has a different verified delivery commit.')
              target.mainReview ??= review
            }
          }
        }
        if (previousInbox) draft.projectInbox = previousInbox.map(r => r.id === source?.intakeId ? { ...r } : r)
        const intakeAction = ['attach', 'chat'].includes(args.action)
        const allowed = intakeAction ? rt.isAdminOf(room, actor) : runsProject(rt, room, actor) || ((args.action === 'clarify' || intakeRelation) && rt.isAdminOf(room, actor))
        result = changeProject(rt, draft, args, actor, source, id, allowed && room.sessions?.[actor] === session, observation, session, exec.agent?.session ?? exec.agent)
        if (args.action === 'approve' || args.action === 'plan') completeRelatedCards(draft.projectCards)
        if (Object.keys(draft.projectCards).length) room.projectCards = draft.projectCards
        if (previousInbox) room.projectInbox = draft.projectInbox
        return () => {
          if (previousCards) room.projectCards = previousCards
          else delete room.projectCards
          if (previousInbox) room.projectInbox = previousInbox
        }
      } })
      if (publish) await publish()
      const change = JSON.parse(result)
      if (assistantId(room) || change.coordination || args.action === 'record_merge' || (args.action === 'submit' && legacyRound?.planNode && legacyRound.planNode.version < card.plans.at(-1).version)) await notifyProjectChange(rt, room, args, actor, source, change)
      return result
    },
  }))
}

async function notifyProjectChange(rt, room, args, actor, source, result) {
  const assistant = assistantId(room)
  const card = room.projectCards?.[result.taskId ?? args.taskId ?? source?.taskId]
  const scope = card ? { taskId: card.id } : { intakeId: source?.intakeId }
  const round = card?.rounds[args.round - 1]
  if (args.action === 'record_merge' && round?.mergeReceipt) {
    await projectNotice(rt, room, assistant ?? room.admin, scope, round.dispatchId + ':merged',
      'Merged into dev, validating. Candidate ' + round.mergeReceipt.commit + ', dev merge ' + round.mergeReceipt.mergeCommit +
      '. The tester will submit post-merge checks. Wait for that report before approving.')
  } else if (args.action === 'submit' && round?.planNode && round.planNode.version < card.plans.at(-1).version &&
      projectCardSummary(card).status !== 'done' && !round.ownershipTransfer) {
    await projectNotice(rt, room, assistant ?? room.admin, scope, round.dispatchId + ':historical-submit',
      'A previous plan execution has returned. Read the current plan and dispatch its ready work. The historical receipt does not approve a current node.')
  } else if (result.coordination) {
    const { toId, instruction } = result.coordination
    if (toId && toId !== actor) await projectNotice(rt, room, toId, scope,
      'technical-block:' + card.id + ':' + actor + ':' + (source?.exchangeId ?? '') + ':' + createHash('sha256').update(args.reason).digest('hex'),
      instruction + '\nIssue or decision: ' + args.reason, {}, args.reason)
  } else if ((args.action === 'submit' || args.action === 'block') && round && !result.lateReceiptRound && (round.planNode ? currentBinding(card, round) : round === card.rounds.at(-1))) {
    const status = args.action === 'submit' ? 'submitted evidence for review' : 'reported a blocker'
    const next = args.action === 'submit' && round.planNode
      ? 'Verify the evidence. For approve, or request_acceptance when the user requested final sign-off, supply the verified artifact and ' +
        JSON.stringify({ taskId: card.id, version: round.planNode.version, node: round.planNode.node, round: args.round }) + '. Then dispatch any ready successors.'
      : 'Read the card and the evidence. Review or recover the node and dispatch ready successors.'
    await projectNotice(rt, room, assistant, scope, round.dispatchId + ':' + args.action,
      'The owner ' + status + ' on round ' + args.round + '. ' + next + (round.planNode?.feedback ? '\nReturn this failed test to the developer on the same card. Dispatch a repair with these changes, then retest the new candidate: ' + round.planNode.feedback : ''))
  } else if (args.action === 'clarify' && actor !== room.admin) {
    await projectNotice(rt, room, room.admin, scope, scopeOf(scope) + ':clarify:' + (source?.exchangeId ?? ''),
      'The project needs a user decision. Use project_task report to ask this question in the group: ' + args.reason, {}, args.reason)
  } else if (card && (args.action === 'approve' && result.status === 'done' || args.action === 'request_acceptance')) {
    await projectNotice(rt, room, room.admin, scope, card.id + ':' + args.action + ':' + args.round,
      (result.status === 'done' ? 'The last node is approved. The task is complete.' : 'The task is ready for the human sign-off requested by the user.') +
      ' Read its result and verification evidence, then use project_task report to tell the user in the group.')
  }
}

function changeProject(rt, room, args, actor, source, id, manager, observation, session, executionSession) {
  if (room.deletedTaskIntakes?.includes(source?.intakeId)) throw new Error('This intake was deleted from the task list.')
  let card = id && Object.hasOwn(room.projectCards, id) ? room.projectCards[id] : undefined
  const receipt = room.projectInbox?.find(item => item.id === source?.intakeId)
  const linked = source?.intakeId && cardForIntake(room, source.intakeId)
  let dispatchRound
  if (args.action === 'relate') {
    const parentId = args.parentTaskId
    if (!manager) throw taskError('TASK_ROLE_REQUIRED')
    if (!card || typeof parentId !== 'string' || !Object.hasOwn(room.projectCards, parentId))
      throw new Error('Choose two existing project cards in this group.')
    if (linked && linked.id !== id && linked.id !== parentId) throw new Error('This intake belongs to a different card.')
    for (let cursor = parentId; cursor; cursor = room.projectCards[cursor]?.parentTaskId)
      if (cursor === id) throw new Error('Related tasks cannot form a cycle.')
    if (card.parentTaskId && card.parentTaskId !== parentId) throw new Error('This card already belongs to another primary task.')
    card.parentTaskId = parentId
    if (receipt && !linked) {
      ;(card.intakes ??= []).push(receipt.id)
      receipt.status = 'attached'
      delete receipt.reason
    }
    completeRelatedCards(room.projectCards)
    return JSON.stringify(projectCardSummary(room.projectCards[id]))
  }
  if ((card ?? linked)?.completedWithTaskId && !['attach', 'chat', 'submit'].includes(args.action))
    throw new Error('This task was completed with its primary task.')
  if (args.action === 'clarify' && id && !card) throw new Error('No such card in this group.')
  if (args.action === 'clarify' && (card || linked)) {
    card ??= linked
    const owner = card.rounds.some((round, i) => round.ownerId === actor && round.dispatchId === source?.exchangeId &&
      source?.taskId === card.id && (round.planNode ? currentBinding(card, round) : i === card.rounds.length - 1))
    if ((source?.intakeId && linked !== card) || (!manager && !owner)) throw new Error('Use the manager chat or the assigned execution to request clarification.')
    if (projectCardSummary(card).status === 'done') throw new Error('This task is complete.')
    const reason = field(args.reason, 'the question or coordination request', 2000)
    if (hasBlockedExecution(card) && !(rt.isAdminOf(room, actor) && ['requirement', 'external_permission'].includes(args.humanInput))) {
      const assistant = assistantId(room)
      const toId = actor === assistant ? room.admin : assistant ?? room.admin
      const instruction = toId === room.admin && assistant
        ? 'Decide the technical blocker within the delegated scope. Use project_task clarify on this card with your concrete decision for the assistant. Only request user input for a requirement or permission genuinely outside the team.'
        : 'Read the existing card and act on this technical blocker: inspect the candidate, revise the plan or dispatch independent verification. Coordinate with the admin only if a distinct decision is needed. Record a concrete next action or recovery condition.'
      return JSON.stringify({ ...projectCardSummary(card), coordination: { toId, instruction } })
    }
    card.clarification = reason
  } else if (['wait', 'resume', 'takeover'].includes(args.action)) {
    if (!manager || !card || (source?.intakeId && !card.intakes.includes(source.intakeId))) throw new Error('Use the manager chat for this card.')
    dispatchRound = recoverNode(room, card, args, actor, observation, assignment)
    if (dispatchRound) reserveNodePaths(rt, room.id, card, card.rounds[dispatchRound - 1])
  } else if (['plan', 'dispatch', 'approve', 'request_acceptance', 'clarify', 'chat'].includes(args.action)) {
    if (!manager) throw taskError('TASK_ROLE_REQUIRED')
    if (source?.intakeId && (!receipt || (card && linked !== card))) throw new Error('Use the manager chat for the original intake or its own card.')
    if (args.action === 'clarify' || args.action === 'chat') {
      if (!receipt || linked) throw new Error('Classify an unassigned intake.')
      receipt.reason = field(args.reason, 'the classification reason or clarification question', 2000)
      receipt.status = args.action === 'chat' ? 'chat' : 'clarify'
      return JSON.stringify(receipt)
    }
    if (args.action === 'plan') {
      if (id && !card) throw new Error('No such card in this group.')
      card ??= linked || undefined
      if (!card && (!receipt || id)) throw new Error('Create the first plan from its original intake.')
      if (card && !card.plans) throw new Error('This card uses the original handoff workflow.')
      const title = field(args.title ?? card?.title, 'a title', 200)
      const acceptance = field(args.acceptance ?? card?.acceptance, 'acceptance conditions', 2000)
      if (card && card.plans?.length && (card.title !== title || card.acceptance?.trim() !== acceptance)) throw new Error('This card has different details.')
      card ??= { id: randomUUID(), title, acceptance, intakes: [receipt.id], rounds: [] }
      if (!card.plans?.length) {
        if (card.goal === undefined && args.plan?.trim()) {
          card.goal = field(args.plan, 'the clarified requirement', 4000)
          card.requirementSources = projectSources(rt, room, card.intakes, card.id, source?.intakeSeq).map(line => line.seq)
        }
        card.title = title
        card.acceptance = acceptance
        delete card.clarification
      }
      if (args.humanAcceptanceRequired !== undefined && typeof args.humanAcceptanceRequired !== 'boolean') throw new Error('Choose a valid human acceptance setting.')
      if (card.humanAcceptanceRequired === undefined) card.humanAcceptanceRequired = args.humanAcceptanceRequired === true || Boolean(card.humanReview)
      card.classificationReason ??= args.classificationReason || acceptance
      savePlan(card, args, room, actor)
      ;(room.projectCards ??= {})[card.id] = card
      if (receipt) { receipt.status = 'accepted'; delete receipt.reason }
    } else {
      if (!card?.plans?.length) throw new Error('Choose a planned card in this group.')
      if (args.action === 'dispatch') {
        dispatchRound = dispatchNode(card, args, room, actor, assignment)
        reserveNodePaths(rt, room.id, card, card.rounds[dispatchRound - 1])
      }
      else if (args.action === 'request_acceptance') {
        if (card.humanAcceptanceRequired === false) throw new Error('Human acceptance is disabled for this task.')
        requestAcceptance(card, args)
      }
      else {
        const review = card.humanReview
        if (card.clarification) throw new Error('Wait for the requested clarification before approval.')
        if ((!review || review.version !== args.version) && card.humanAcceptanceRequired && nodeViews(card, card.plans.at(-1)).every(n => ['verified', 'omitted'].includes(n.status) || (n.no === args.node && n.status === 'review'))) {
          requestAcceptance(card, args)
          return JSON.stringify(projectCardSummary(card))
        }
        if (review && review.status !== 'approved' && (review.round === args.round ||
            nodeViews(card, card.plans.at(-1)).every(n => ['verified', 'omitted'].includes(n.status) || (n.no === args.node && n.status === 'review'))))
          throw new Error('This artifact requires the requested human decision. Revise the plan for returned work.')
        const reused = card.plans.at(-1).nodes[args.node - 1]?.reuseRound
        if (reused && reused === args.round && args.version === card.plans.at(-1).version) {
          const original = card.rounds[reused - 1]
          if (!original.planNode?.acceptedAt || args.artifact !== original.planNode.artifact || (codeDelivery(card, original) && !original.mainReview))
            throw new Error('Verify the same approved artifact before reusing its delivery commit.')
        } else approveRound(card, args, actor)
      }
    }
  } else if (args.action === 'assign' || args.action === 'attach') {
    if (!manager || !source?.intakeId || !intakeLines(rt, room, source.intakeId).length) throw new Error('Use the manager chat handling the original group intake.')
    if (args.action === 'attach') {
      if (!card || (linked && linked !== card)) throw new Error('Intake and card must belong to the same project and agree.')
      if (!linked) {
        card.intakes.push(source.intakeId)
        delete card.clarification
      }
      if (receipt && receipt.status !== 'accepted') { receipt.status = 'attached'; delete receipt.reason }
    } else {
      if ((receipt && !linked) || linked?.plans) throw new Error('Save a complete plan before dispatching nodes.')
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
    const round = Number.isSafeInteger(args.round) && card.rounds[args.round - 1]
    // A late submission may finish its own historical record. Only a current
    // node can start work, be approved or release downstream dispatches.
    const eligible = card.plans
      ? round?.planNode?.version === card.plans.at(-1).version || (args.action === 'submit' && round?.startedAt)
      : args.round === card.rounds.length
    if (!round || !eligible) throw new Error('Read the current card round.')
    if (args.action === 'handoff') {
      if (card.plans) throw new Error('Approve the artifact and dispatch the next planned node.')
      if (!manager || !round.result || (source?.intakeId && !card.intakes.includes(source.intakeId))) throw new Error('The manager can hand off a submitted result.')
      checkOwner(room, actor, args.ownerId)
      const next = assignment(args.ownerId, field(args.plan, 'a handoff plan', 4000))
      if (card.workspace) next.workspace = card.workspace
      card.rounds.push(next)
    } else {
      if (!round.dispatchId || actor !== round.ownerId || source?.exchangeId !== round.dispatchId || (card.plans && source.taskId !== card.id)) throw new Error('Only the owner in the dispatched execution can confirm or submit it.')
      const binding = round.planNode
      if (binding && (card.completedWithTaskId || binding.supersededBy || binding.block)) {
        if (args.action === 'block' && !binding.supersededBy && args.reason === binding.block.reason) return JSON.stringify(projectCardSummary(card))
        if (args.action !== 'submit') throw new Error('This execution is blocked or superseded. Read its recovery decision.')
        const result = field(args.result, 'the late result', 4000)
        if (binding.lateResult && binding.lateResult !== result) throw new Error('This round already has a different late receipt.')
        binding.lateResult = result
        binding.lateAt ??= Date.now()
        return JSON.stringify({ ...projectCardSummary(card), lateReceiptRound: args.round, advanced: false })
      }
      if (args.action === 'start') {
        if (binding && !round.startedAt) {
          beginValidation(card, round)
          binding.session = session
          const dir = rt.sessionFolder?.(executionSession)
          if (dir) binding.workDir = dir
        }
        round.startedAt ??= Date.now()
      } else if (args.action === 'record_merge') {
        if (!binding || !round.startedAt || !currentBinding(card, round) || !round.mergeReceipt) throw new Error('Record the merge from the assigned independent test round.')
      } else if (args.action === 'checkpoint' && binding && round.startedAt && !round.result) {
        if (args.checking !== undefined || args.passedCheck !== undefined || args.checksComplete === true || args.cleanupEvidence !== undefined) {
          if (!round.validation) throw new Error('Record named checks in a read-only feature validation round.')
          checkpointValidation(round.validation, args)
        } else {
          binding.completed = field(args.completed, 'finished checks', 4000)
          binding.remaining = field(args.remaining, 'remaining checks', 4000)
        }
        if (args.artifact) binding.checkpointArtifact = field(args.artifact, 'checkpoint artifact', 2000)
        binding.checkpointAt = Math.max(Date.now(), (binding.checkpointAt ?? 0) + 1)
      } else if (args.action === 'block' && binding && !round.result) {
        const node = card.plans.at(-1).nodes[binding.node - 1]
        if (node.independentReview && node.writePaths?.length === 0 && args.feedback != null) binding.feedback = field(args.feedback, 'actionable test feedback for the developer', 4000)
        blockRound(round, { by: actor, cause: 'reported', reason: field(args.reason, 'the blocker', 2000),
          waitingFor: field(args.waitingFor, 'the recovery condition', 2000), evidence: field(args.evidence, 'observed evidence', 2000) })
      } else if (args.action === 'submit' && round.startedAt) {
        if (binding && currentBinding(card, round) && card.plans.at(-1).nodes[binding.node - 1].mergeToDev && !round.integration)
          throw new Error('Verify the independently tested candidate on dev before submitting.')
        if ((!binding || currentBinding(card, round)) && codeDelivery(card, round) && !round.mainReview)
          throw new Error('Verify the delivery commit on its assigned branch before submitting this round.')
        const result = round.validation ? validationReceipt(round.validation, args) : field(args.result, 'the verified result', 4000)
        if (round.result && result !== round.result) throw new Error('This round already has a different result.')
        round.result = result
        round.submittedAt ??= Date.now()
      } else throw new Error('Confirm the start before submitting the result.')
    }
  }
  const reply = projectCardSummary(card)
  if (dispatchRound) reply.dispatchRound = dispatchRound
  if (card.plans && (args.action === 'start' || args.action === 'submit')) {
    const round = card.rounds[args.round - 1]
    reply.execution = { round: args.round, version: round.planNode.version, node: round.planNode.node, status: projectStatus(round) }
  }
  return JSON.stringify(reply)
}

function assignment(ownerId, plan) {
  return { ownerId, plan, assignedAt: Date.now(), dispatchId: randomUUID() }
}

function requestAcceptance(card, args) {
  const plan = card.plans.at(-1)
  const nodes = nodeViews(card, plan)
  const node = nodes.find(n => n.no === args.node)
  if (plan.version !== args.version || !node || node.round !== args.round || node.status !== 'review' ||
      nodes.some(n => n !== node && !['verified', 'omitted'].includes(n.status))) throw new Error('Request human acceptance for the final submitted node.')
  const artifact = field(args.artifact, 'the artifact to review', 2000)
  const current = card.humanReview
  if (current?.version === args.version && current.round === args.round) {
    if (current.artifact === artifact && current.status === 'pending') return
    throw new Error('Revise the plan before requesting acceptance of a different delivery.')
  }
  if (current) (card.previousReviews ??= []).push(current)
  card.humanReview = { id: randomUUID(), version: args.version, node: args.node, round: args.round,
    artifact, requestedAt: Date.now(), status: 'pending' }
}

export async function decideAcceptance(rt, room, args) {
  if (!['approve', 'return'].includes(args.decision)) throw new Error('Choose an acceptance decision.')
  const approved = args.decision === 'approve'
  const feedback = approved ? undefined : field(args.feedback, 'the requested changes', 2000)
  const status = approved ? 'approved' : 'returned'
  let review
  await rt.save({ required: true, mutate() {
    if (!room) throw taskError('GROUP_CONTEXT_REQUIRED')
    if (!taskRoom(room)) throw taskError('TASK_MANAGEMENT_DISABLED')
    const original = room?.projectCards?.[args.taskId]
    review = original?.humanReview
    if (!room || rt.roomOf(room.id) !== room || !review || review.id !== args.reviewId ||
        review.version !== original.plans.at(-1).version) throw new Error('This acceptance request is no longer current.')
    if (review.status === status && review.feedback === feedback) return
    if (original.completedWithTaskId) throw new Error('This task was completed with its primary task.')
    if (review.status !== 'pending' || original.clarification) throw new Error('This task is not awaiting that decision.')
    const card = structuredClone(original)
    if (approved) approveRound(card, review, 'user')
    card.humanReview = { ...review, status, decidedAt: Date.now(), ...(feedback ? { feedback } : {}) }
    const previous = room.projectCards
    const cards = { ...previous, [args.taskId]: card }
    if (approved) completeRelatedCards(cards)
    room.projectCards = cards
    return () => { room.projectCards = previous }
  } })
  if (approved && assistantId(room)) await projectNotice(rt, room, room.admin, { taskId: args.taskId },
    'accepted:' + review.id, 'Human final acceptance passed. Read the card and use project_task report to tell the user the result.')
  if (!approved) {
    const manager = assistantId(room) ?? room.members.find(id => rt.isAdminOf(room, id))
    if (!manager) throw new Error('No project manager is available for the returned work.')
    const key = rt.requestIdentity({ caller: manager, context: 'project-acceptance:' + args.taskId, name: review.id, payload: { feedback } })
    const outcome = await rt.admitRequest(key, async () => rt.deliver({ toId: manager, sessionId: await rt.memberSession(room, manager), roomId: room.id, taskId: args.taskId,
      role: 'request', audience: 'user', recordExchange: false,
      text: 'The user returned the final artifact. Revise the plan to address their feedback: ' + feedback }))
    if (!['sent', 'replay', 'expired'].includes(outcome.status)) throw new Error('Changes saved; delivery to the manager needs verification.')
  }
  return true
}

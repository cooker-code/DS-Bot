import { assistantId } from './project-assistant.js'
import { workspacePolicyOf, usesGitWorkspace } from '../shared/project-workspace.js'
import { isDeepStrictEqual } from 'node:util'
import { codeDelivery, projectStatus, taskPhase } from './project-status.js'

export function field(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Supply ' + label + ' (up to ' + max + ' characters).')
  return value.trim()
}
export function checkOwner(room, manager, owner) {
  if (owner === manager || (assistantId(room) && owner === room.admin) || !room.members.includes(owner)) throw new Error('Pick an executing Bot from this group other than the dispatching manager.')
}
const contextFields = ['repository', 'baseRef', 'workRef', 'workDir', 'environment', 'contextGap']
export const planParameters = {
  workspaceMode: { type: 'string', enum: ['current', 'worktree'], description: 'Choose one checkout for the entire task. All Git steps inherit it.' },
  workspaceReason: { type: 'string', description: 'Explain the task checkout choice to the user.' },
  version: { type: 'integer', description: 'Plan version: first is 1, revisions increment by one. Dispatch and approve must name the current version.' },
  node: { type: 'integer', description: 'Node number, starting at 1.' },
  reason: { type: 'string', description: 'Reason for a revision, clarification or chat classification.' },
  artifact: { type: 'string', description: 'Verified immutable commit or identifiable deliverable for downstream workers.' },
  nodes: { type: 'array', description: 'Complete plan in topological order. Node numbers are their one-based positions. Only explicit dependsOn edges constrain parallel work.',
    items: { type: 'object', additionalProperties: false, properties: {
      ...Object.fromEntries(['title', 'ownerId', 'instructions', 'deliverable', 'acceptance'].map(key => [key, { type: 'string', required: true }])),
      dependsOn: { type: 'array', items: { type: 'integer' }, description: 'Earlier node numbers whose approved artifacts this node needs.' },
      ...Object.fromEntries(contextFields.map(key => [key, { type: 'string' }])),
      workspaceMode: { type: 'string', enum: ['current', 'worktree', 'none'], description: 'Required in Git projects: current checkout, a separate prepared worktree, or none for non-repository work.' },
      workspaceReason: { type: 'string', description: 'Brief user-facing reason for this Git workspace choice, required when the group lets the Main Bot decide.' },
      writePaths: { type: 'array', items: { type: 'string' }, description: 'Exclusive files or directory subtrees relative to workDir. Use [] for read-only work. Include generated files.' },
      fixedOwner: { type: 'boolean', description: 'Require the planned owner across recoveries when the requirement names that person.' },
      independentReview: { type: 'boolean', description: 'The executor must not have produced any direct input.' },
      mergeToDev: { type: 'boolean', description: 'Independent test and integration node. After passing, merge the exact candidate into local dev, then submit the report with commit. On failed tests use return_for_changes with evidence and feedback.' },
      candidateCommit: { type: 'string', description: 'Only for testing an existing candidate from an older round without a verified code receipt. Pin its full commit in the revised plan.' },
      reuseRound: { type: 'integer', description: 'Revision only: reuse the identified, already approved output from this card.' },
    } } },
}

// Files and directory subtrees share the same repository-relative spelling.
export function pathsOverlap(left, right) {
  const key = path => path.normalize('NFC').toLowerCase()
  const covers = (a, b) => a === b || a.startsWith(b + '/')
  return left.some(a => right.some(b => covers(key(a), key(b)) || covers(key(b), key(a))))
}

function checkParallelScopes(nodes) {
  const ancestors = []
  for (const node of nodes) {
    const inputs = new Set(node.dependsOn.flatMap(no => [no, ...ancestors[no - 1]]))
    ancestors.push(inputs)
    if (!node.writePaths?.length || node.reuseRound) continue
    for (const earlier of nodes.slice(0, node.no - 1)) {
      if (earlier.workDir === node.workDir && earlier.writePaths?.length && !earlier.reuseRound && !inputs.has(earlier.no) &&
          pathsOverlap(earlier.writePaths, node.writePaths)) throw new Error('Nodes ' + earlier.no + ' and ' + node.no +
          ' have overlapping write paths. Add a dependency or divide the files.')
    }
  }
}

function checkoutOf(node) {
  if (!node || (!node.workDir && !node.workRef)) return
  const { repository, workRef, workDir, workspaceMode } = node
  return { repository, workRef, workDir, workspaceMode }
}

// Older cards kept the checkout on individual steps. Prefer a dispatched step
// over a tentative entry. Never substitute the project root for a missing tree.
export function plannedCheckout(card) {
  if (card.plannedWorkspace) return card.plannedWorkspace
  const plan = card.plans?.at(-1)
  for (const round of (card.rounds ?? []).toReversed()) {
    const binding = round.planNode
    if (binding && binding.version !== plan?.version) continue
    const node = binding && plan.nodes[binding.node - 1]
    if (node?.workspaceMode === 'none') continue
    if (round.workspace) return round.workspace
    if (binding?.workDir && binding.workDir !== node?.workDir) return { workDir: binding.workDir }
    const assigned = checkoutOf(node)
    if (assigned) return assigned
  }
  return checkoutOf(plan?.nodes.find(n => n.workspaceMode !== 'none' && (n.workDir || n.workRef)))
}

export function taskCheckout(card) {
  return card.workspace ?? plannedCheckout(card)
}

export function sameCheckout(a, b) {
  return a?.repository === b?.repository && a?.workRef === b?.workRef && a?.workDir === b?.workDir
}

export function savePlan(card, args, room, actor) {
  const latest = card.plans?.at(-1)
  const v = args.version
  if (!Number.isSafeInteger(v) || v < 1 || (v !== (latest?.version ?? 0) + 1 && v !== latest?.version)) throw new Error('Read the current plan version before planning.')
  if (!Array.isArray(args.nodes) || !args.nodes.length || args.nodes.length > 100) throw new Error('Provide a complete plan of 1 to 100 nodes.')
  const reason = v > 1 ? field(args.reason, 'the reason for changing the plan', 2000) : undefined
  const nodes = args.nodes.map((raw, i) => {
    const no = i + 1
    checkOwner(room, actor, raw.ownerId)
    const dependsOn = raw.dependsOn ?? []
    if (!Array.isArray(dependsOn) || new Set(dependsOn).size !== dependsOn.length ||
        dependsOn.some(n => !Number.isSafeInteger(n) || n < 1 || n >= no)) throw new Error('Each dependency must name a distinct earlier node in this plan.')
    const node = { no, ownerId: raw.ownerId, dependsOn: [...dependsOn].sort((a, b) => a - b) }
    for (const key of ['title', 'instructions', 'deliverable', 'acceptance']) node[key] = field(raw[key], key, key === 'title' ? 200 : 4000)
    const prior = latest?.nodes[i]
    if (prior?.fixedOwner && raw.ownerId !== prior.ownerId) throw new Error('This node requires its designated owner.')
    for (const key of ['fixedOwner', 'independentReview']) {
      if (prior?.[key] && raw[key] === false) throw new Error('A plan revision must preserve the existing node constraints.')
      if (raw[key] === true || prior?.[key]) node[key] = 1
    }
    for (const key of contextFields) if (raw[key] != null) node[key] = field(raw[key], key, 2000)
    if (raw.workspaceReason != null) node.workspaceReason = field(raw.workspaceReason, 'the reason for the workspace choice', 500)
    if (raw.workspaceMode) node.workspaceMode = raw.workspaceMode
    if (raw.writePaths) node.writePaths = raw.writePaths
    if (raw.mergeToDev) {
      if (!node.independentReview || !usesGitWorkspace(node) || node.writePaths?.length !== 0 || ['dev', 'main', 'master'].includes(node.workRef))
        throw new Error('Test and merge requires independent review on a read-only candidate feature checkout.')
      if (raw.candidateCommit) {
        if (!latest || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(raw.candidateCommit) ||
            dependsOn.some(no => args.nodes[no - 1]?.writePaths?.length))
          throw new Error('Pin an existing candidate from a previous developer round.')
        node.candidateCommit = raw.candidateCommit
      } else if (!dependsOn.length) throw new Error('Depend on the developer candidate round.')
      node.mergeToDev = 1
    }
    if (raw.reuseRound != null) {
      const previous = card.rounds[raw.reuseRound - 1]?.planNode
      if (!Number.isSafeInteger(raw.reuseRound) || !previous?.acceptedAt || previous.version >= v) throw new Error('Reuse an approved artifact from an earlier plan of this card.')
      node.reuseRound = raw.reuseRound
    }
    return node
  })
  if (latest?.nodes.slice(nodes.length).some(node => (node.fixedOwner || node.independentReview) && !(card.finishAfterIntegration?.version === latest.version && node.no > card.finishAfterIntegration.node)))
    throw new Error('A plan revision must preserve the existing constrained nodes.')
  for (const node of nodes.filter(n => n.reuseRound)) {
    const reused = card.rounds[node.reuseRound - 1]
    if (node.fixedOwner && reused.ownerId !== node.ownerId) throw new Error('This node requires its designated owner.')
    if (node.independentReview && reused.planNode.inputs.some(input => card.rounds[input.round - 1].ownerId === reused.ownerId))
      throw new Error('The review must be independent of upstream producers.')
    const previousInputs = card.rounds[node.reuseRound - 1].planNode.inputs.map(input => input.round).sort((a, b) => a - b)
    const currentInputs = node.dependsOn.map(no => nodes[no - 1].reuseRound).sort((a, b) => a - b)
    if (node.contextGap || !isDeepStrictEqual(previousInputs, currentInputs)) throw new Error('Reused output must have the same approved inputs and no unresolved context gap.')
  }
  if (latest?.version === v) {
    if (latest.reason !== reason || !isDeepStrictEqual(nodes, latest.nodes)) throw new Error('That plan version already has different details.')
    return
  }
  const policy = workspacePolicyOf(room)
  const gitNodes = nodes.filter(usesGitWorkspace)
  if (card.workspace && policy !== 'auto' && card.workspace.workspaceMode !== policy && nodes.some(n => taskWorkspaceFor(card, n)))
    throw new Error('Select a task workspace that matches the group policy before revising the plan.')
  for (const node of gitNodes) {
    if (policy !== 'auto' && node.workspaceMode !== policy) throw new Error('This group requires workspaceMode=' + policy + ' for new Git plans.')
    if (!card.workspace && policy === 'auto' && !node.workspaceReason) throw new Error('Supply workspaceReason to explain this Git workspace choice to the user.')
  }
  const first = gitNodes[0]
  const previous = taskCheckout(card)
  const changesTree = first && previous?.workDir && (first.workDir !== previous.workDir ||
    (usesGitWorkspace(previous) && !sameCheckout(first, previous)))
  if (changesTree || gitNodes.some(n => !sameCheckout(n, first)))
    throw new Error('Use the same task worktree and branch for every Git step.')
  checkParallelScopes(nodes)
  if (latest && nodeViews(card, latest).every(node => ['verified','omitted'].includes(node.status))) throw new Error('This task is complete.')
  if ((card.humanAcceptanceRequired || (card.humanReview && card.humanReview.status !== 'approved')) && nodes.every(node => node.reuseRound))
    throw new Error('Keep a final deliverable for the requested human acceptance.')
  const at = Date.now()
  if (latest) for (const round of card.rounds) {
    const b = round.planNode
    if (b?.version === latest.version && b.block && !b.block.resolvedAt) {
      b.block.resolvedAt = at
      b.block.decisions.push({ action: 'replan', at, by: actor, reason })
    }
  }
  if (first && !card.plannedWorkspace) card.plannedWorkspace = checkoutOf(first)
  ;(card.plans ??= []).push({ version: v, at, by: actor, ...(gitNodes.length && { workspacePolicy: policy }), ...(reason ? { reason } : {}), nodes })
}

export function nodeViews(card, plan) {
  const dispatched = new Map()
  card.rounds.forEach((round, i) => {
    if (round.planNode?.version === plan.version) dispatched.set(round.planNode.node, i + 1)
  })
  const numberOf = node => node.reuseRound ?? dispatched.get(node.no)
  return plan.nodes.map(node => {
    const number = numberOf(node)
    const round = card.rounds[number - 1]
    const waiting = node.dependsOn.filter(no => !card.rounds[numberOf(plan.nodes[no - 1]) - 1]?.planNode?.acceptedAt)
    const omitted = card.finishAfterIntegration?.version === plan.version && node.no > card.finishAfterIntegration.node
    const needsReceipt = card.finishAfterIntegration?.version === plan.version && node.no === card.finishAfterIntegration.node && card.finishAfterIntegration.needsReceiptRound
    const status = omitted ? 'omitted' : needsReceipt ? 'blocked' : round?.planNode?.acceptedAt ? 'verified' : projectStatus(round) ?? (node.contextGap ? 'blocked' : waiting.length ? 'waiting' : 'ready')
    const workspace = round ? round.workspace : plan === card.plans.at(-1) ? taskWorkspaceFor(card, node) : undefined
    return { ...node, ...workspace, ownerId: round?.ownerId ?? node.ownerId, status, round: number || undefined, waiting }
  })
}

// Already dispatched rounds retain their snapshot. Pending Git steps share the task checkout.
export function taskWorkspaceFor(card, node) {
  if (!node || node.workspaceMode === 'none') return
  const pick = taskCheckout(card)
  if (!pick?.repository || !pick.workRef || !pick.workDir || !usesGitWorkspace(pick)) return
  return pick
}

// Replace changed cards so the caller can roll the entire room mutation back.
export function completeRelatedCards(cards) {
  const children = new Map()
  for (const [id, card] of Object.entries(cards ?? {})) {
    if (!card.parentTaskId) continue
    if (!children.has(card.parentTaskId)) children.set(card.parentTaskId, [])
    children.get(card.parentTaskId).push(id)
  }
  const done = new Set()
  for (const id of children.keys()) {
    const card = cards[id]
    if (card?.completedWithTaskId || (card?.plans?.length && plannedSummary(card).status === 'done')) done.add(id)
  }
  let changed = false
  for (const parent of done) {
    for (const id of children.get(parent) ?? []) {
      const card = cards[id]
      if (!card.completedWithTaskId) {
        cards[id] = { ...card, completedWithTaskId: parent }
        changed = true
      }
      done.add(id)
    }
  }
  return changed
}

export function planStage(views) {
  views = views.filter(n => n.status !== 'omitted')
  return ['active', 'blocked', 'failed', 'review', 'delivered', 'assigned'].find(s => views.some(n => n.status === s))
    ?? (views.every(n => n.status === 'verified') ? 'verified' : views.some(n => n.status === 'ready') ? 'planned' : 'blocked')
}

export function plannedSummary(card) {
  const plan = card.plans.at(-1)
  const views = nodeViews(card, plan)
  const status = planStage(views)
  const current = views.filter(n => n.status === status && n.round).map(n => card.rounds[n.round - 1])
  const round = current.length === 1 ? current[0] : undefined
  const started = current.filter(r => Number.isFinite(r.startedAt))
  const submissions = current.map(r => r.submittedAt).filter(Number.isFinite)
  const stops = (started.length ? started : current).map(r => r.planNode?.block?.at ?? r.failedAt).filter(Number.isFinite)
  const updatedAt = card.rounds.reduce((time, r) => Math.max(time, r.planNode?.acceptedAt ?? 0, r.mergeReceipt?.at ?? 0, r.submittedAt ?? 0, r.failedAt ?? 0, r.planNode?.checkpointAt ?? 0, r.planNode?.lateAt ?? 0, r.planNode?.block?.at ?? 0, r.planNode?.block?.decisions.at(-1)?.at ?? 0, r.startedAt ?? 0, r.sentAt ?? 0, r.assignedAt ?? 0), plan.at)
  const awaitingCode = status === 'review' && views.some(node => {
    const run = card.rounds[node.round - 1]
    return codeDelivery(card, run, node) && !run?.mainReview
  })
  const validating = status === 'active' && current.find(r => r.mergeReceipt && !r.submittedAt)
  return { ...(validating && { validatingMerge: validating.mergeReceipt }), status: taskPhase(card, status, awaitingCode), version: plan.version, owners: [...new Set(current.map(r => r.ownerId))], ownerId: round?.ownerId,
    startedAt: started.length ? Math.min(...started.map(r => r.startedAt)) : undefined,
    submittedAt: submissions.length && submissions.length === current.length ? Math.max(...submissions) : undefined,
    stoppedAt: stops.length ? Math.max(...stops) : undefined, updatedAt }
}

export function dispatchNode(card, args, room, actor, assignment) {
  const plan = card.plans.at(-1)
  if (args.version !== plan.version) throw new Error('Read the current plan version before dispatch.')
  const views = nodeViews(card, plan)
  const node = views.find(n => n.no === args.node)
  if (!node || node.reuseRound) throw new Error('Choose an executable node in the current plan.')
  if (node.round) {
    if (card.rounds[node.round - 1].planNode.block) throw new Error('Inspect the blocked node and choose a recovery decision before dispatch.')
    return node.round
  }
  if (node.status !== 'ready') throw new Error('Dispatch requires all direct predecessor artifacts to be approved and the context gap to be resolved.')
  checkOwner(room, actor, node.ownerId)
  const inputs = node.dependsOn.map(no => ({ node: no, round: views[no - 1].round }))
  if (node.independentReview && inputs.some(i => card.rounds[i.round - 1].ownerId === node.ownerId)) throw new Error('The review must be independent of upstream producers. Revise the plan before dispatch.')
  if (node.mergeToDev && !node.candidateCommit && inputs.filter(i => card.rounds[i.round - 1].mainReview?.commit).length !== 1)
    throw new Error('Test and merge requires one approved code candidate.')
  const round = assignment(node.ownerId, node.instructions)
  const workspace = taskWorkspaceFor(card, plan.nodes[node.no - 1])
  if (workspace) round.workspace = workspace
  round.planNode = { version: plan.version, node: node.no, inputs }
  card.rounds.push(round)
  return card.rounds.length
}

export function approveRound(card, args, actor) {
  const round = card.rounds[args.round - 1]
  const binding = round?.planNode
  if (!binding || binding.supersededBy || binding.block || binding.version !== args.version || binding.node !== args.node || binding.version !== card.plans.at(-1).version || !round.result) throw new Error('Approve a submitted round of this node in the current plan.')
  const artifact = field(args.artifact, 'the verified artifact reference', 2000)
  if (binding.acceptedAt) {
    if (binding.artifact !== artifact) throw new Error('That round already has a different approved artifact.')
    return
  }
  Object.assign(binding, { acceptedAt: Date.now(), acceptedBy: actor, artifact })
}

export function nodeHandoff(card, round) {
  const binding = round.planNode
  const node = { ...card.plans.at(-1).nodes[binding.node - 1], ...round.workspace }
  const old = card.rounds[binding.previousRound - 1]
  const decision = old?.planNode.block.decisions.at(-1)
  return [
    ...(decision ? ['Resume from round ' + binding.previousRound, 'Reviewed artifact: ' + decision.artifact,
      'Completed checks: ' + (old.planNode.completed || 'No checks recorded'), 'Remaining checks: ' + decision.remaining,
      'Verified working folder: ' + decision.targetTree.dir, 'Worktree review: ' + decision.worktreeReview,
      ...(decision.targetTree.commit ? ['Expected commit: ' + decision.targetTree.commit] : [])] : []),
    ...(card.rounds.some(r => r.ownershipTransfer?.version === binding.version && r.ownershipTransfer.node === node.no && r.ownershipTransfer.retainedChanges)
      ? ['Continue with the existing uncommitted changes in this checkout. Inspect the diff against the revised requirement and preserve the previous work.'] : []),
    'Plan v' + binding.version + ' · Node ' + node.no + ': ' + node.title,
    'Deliverable: ' + node.deliverable, 'Node acceptance: ' + node.acceptance,
    ...contextFields.filter(k => node[k] && !(decision && ['workDir', 'workRef'].includes(k))).map(k => k + ': ' + node[k]),
    ...(node.writePaths || round.workspace ? ['Before starting, use working_directory to enter the assigned working folder above. Confirm the branch and run project_task start before editing.'] : []),
    ...(node.writePaths ? [node.writePaths.length ? 'Edit only these files or subtrees (including generated output): ' + node.writePaths.join(', ') + '. Stage and commit only your own paths. Supply the full delivery commit on submit. The host verifies it on your assigned branch. Leave integration to the independent tester.' : node.mergeToDev ? 'Keep the candidate checkout read-only.' : 'Read-only assignment. Do not edit files.'] : []),
    ...(node.mergeToDev ? ['Test the exact candidate ' + (node.candidateCommit ?? binding.inputs.map(i => card.rounds[i.round - 1].mainReview?.commit).filter(Boolean).join(', ')) +
      ' using the assigned checkout. After passing, merge that immutable commit into local dev in its verified checkout, preserve other work, and immediately call record_merge with commit and mergeCommit. Then verify the integrated result. The candidate checkout remains read-only. Submit the test report, candidate commit and exact testedCommit on dev. Later changes to dev do not invalidate that snapshot. If tests fail, call return_for_changes with evidence and concrete feedback for the developer. Use block for an environment impediment.'] : []),
    ...binding.inputs.map(input => {
      const prev = card.rounds[input.round - 1]
      return 'Approved input from node ' + input.node + ', round ' + input.round + ': ' + prev.planNode.artifact + '\n' + prev.result
    }),
  ].join('\n')
}

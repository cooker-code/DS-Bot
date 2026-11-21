// Per-round evidence used by node details and recovery.
export function projectStatus(round) {
  if (!round) return null
  if (round.planNode?.supersededBy) return 'superseded'
  if (round.planNode?.block) return round.planNode.block.cause === 'failure' ? 'failed' : 'blocked'
  if (round.result) return 'review'
  if (round.failedAt) return 'failed'
  if (round.startedAt) return 'active'
  return round.sentAt ? 'delivered' : 'assigned'
}

// Dispatch snapshots take precedence over a later change of the task checkout.
export function codeDelivery(card, round, node) {
  const binding = round?.planNode
  node ??= binding && card.plans?.find(p => p.version === binding.version)?.nodes[binding.node - 1]
  if (node?.workspaceMode === 'none' || node?.writePaths?.length === 0) return
  const workspace = round?.workspace ?? node ?? card.workspace
  if (workspace?.repository) return { repository: workspace.repository, branch: workspace.workRef, writePaths: node?.writePaths }
}

// Only task-level phases are exposed on the board and in tasks.status.
export function taskPhase(card, phase, awaitingCode = false) {
  if (card.completedWithTaskId || phase === 'verified') return 'done'
  if (card.clarification) return 'clarify'
  if (Array.isArray(card.plans) && !card.plans.length) return 'planning'
  const version = card.plans?.at(-1)?.version
  if (card.humanReview && card.humanReview.version === version) {
    if (card.humanReview.status === 'pending') return 'human_review'
    if (card.humanReview.status === 'returned') return 'planning'
  }
  if (!phase || ['planned', 'assigned', 'delivered'].includes(phase)) {
    const started = card.rounds?.some(round => (!version || round.planNode?.version === version) && (round.startedAt || round.result))
    return started ? 'active' : 'dispatching'
  }
  if (phase === 'review' && (awaitingCode || (!version && codeDelivery(card, card.rounds?.at(-1)) && !card.rounds?.at(-1)?.mainReview))) return 'active'
  return phase
}

// Room v2 stores the plan separately from the original card and actual rounds.
// The legacy codec still owns the phase-one fields and their null/absent shapes.
export const planTables = {
  project_branches: ['repository', 'branch'],
  project_inbox: ['intake_id'],
  task_plans: ['task_pk', 'plan_version'],
  task_plan_nodes: ['task_pk', 'plan_version', 'node_no'],
  task_plan_dependencies: ['task_pk', 'plan_version', 'predecessor_no', 'successor_no'],
  task_round_plans: ['task_pk', 'round_no'],
  task_round_inputs: ['task_pk', 'round_no', 'predecessor_no'],
  task_node_blocks: ['task_pk', 'round_no'],
  task_recovery_decisions: ['task_pk', 'round_no', 'decision_no'],
}
const nodeFields = {
  mergeToDev: 'merge_to_dev', candidateCommit: 'candidate_commit',
  title: 'title', ownerId: 'owner_bot_id', instructions: 'instructions', deliverable: 'deliverable', acceptance: 'acceptance',
  repository: 'repository', baseRef: 'base_ref', workRef: 'work_ref', workDir: 'work_dir', environment: 'environment',
  workspaceReason: 'workspace_reason', workspaceMode: 'workspace_mode', contextGap: 'context_gap', reuseRound: 'reuse_round', fixedOwner: 'fixed_owner', independentReview: 'independent_review',
}
const branchFields = { repository: 'repository', branch: 'branch', commit: 'tip', commitAt: 'commit_at', refAt: 'ref_at', target: 'target', targetCommit: 'target_commit',
  relation: 'relation', workDir: 'work_dir', purpose: 'purpose', preparedAt: 'prepared_at', observedAt: 'observed_at' }
const roundFields = { feedback: 'test_feedback', version: 'plan_version', node: 'node_no', acceptedAt: 'accepted_at', acceptedBy: 'accepted_by', artifact: 'artifact_ref',
  supersededBy: 'superseded_by', session: 'writer_session', workDir: 'writer_dir', previousRound: 'previous_round', completed: 'completed_checks', remaining: 'remaining_checks', checkpointArtifact: 'checkpoint_artifact', checkpointAt: 'checkpoint_at', lateResult: 'late_result', lateAt: 'late_at',
}
const blockFields = { at: 'blocked_at', cause: 'cause', reason: 'reason', by: 'reported_by', waitingFor: 'waiting_for', evidence: 'evidence', resolvedAt: 'resolved_at' }
const decisionFields = { action: 'action', at: 'decided_at', by: 'decided_by', reason: 'reason', nextRound: 'next_round', ownerId: 'owner_id', artifact: 'artifact', remaining: 'remaining_checks', eligibility: 'eligibility', worktreeReview: 'worktree_review', condition: 'recovery_condition', inspection: 'inspection' }
const planFields = { workspacePolicy: 'workspace_policy', version: 'plan_version', by: 'planned_by', at: 'planned_at', reason: 'change_reason' }
const inboxFields = { id: 'intake_id', seq: 'through_seq', title: 'title', receivedAt: 'received_at', planningAt: 'planning_at', status: 'disposition', reason: 'reason' }
const columns = (fields, obj) => Object.fromEntries(Object.entries(fields).map(([key, col]) => [col, obj[key] ?? null]))
const properties = (fields, row) => Object.fromEntries(Object.entries(fields).filter(([, col]) => row[col] != null).map(([key, col]) => [key, row[col]]))

function extract(row, key, valid) {
  const extra = JSON.parse(row.extra_json)
  const value = extra[key]
  if (!valid(value)) return undefined
  delete extra[key]
  row.extra_json = JSON.stringify(extra)
  return value
}

export function encodePlans(rows) {
  for (const table of Object.keys(planTables)) rows[table] = []
  const populated = value => Array.isArray(value) && value.length > 0
  for (const branch of extract(rows.rooms[0], 'projectBranches', populated) ?? []) rows.project_branches.push({
    ...columns(branchFields, branch), missing: branch.missing ? 1 : null, removed: branch.removed ? 1 : null,
  })
  const plannedTasks = new Set()
  for (const receipt of extract(rows.rooms[0], 'projectInbox', value => populated(value) && value.every(item => typeof item?.id === 'string' && Number.isInteger(item.seq))) ?? []) rows.project_inbox.push(columns(inboxFields, receipt))
  for (const task of rows.tasks.filter(t => t.source_kind === 'project')) {
    const task_pk = task.task_pk
    for (const plan of extract(task, 'plans', value => populated(value) && value.every(plan => Array.isArray(plan?.nodes))) ?? []) {
      plannedTasks.add(task_pk)
      const key = { task_pk, plan_version: plan.version }
      rows.task_plans.push({ task_pk, ...columns(planFields, plan) })
      for (const node of plan.nodes) {
        rows.task_plan_nodes.push({ ...key, node_no: node.no, ...columns(nodeFields, node), write_paths: node.writePaths ? JSON.stringify(node.writePaths) : null })
        for (const pred of node.dependsOn) rows.task_plan_dependencies.push({ ...key, predecessor_no: pred, successor_no: node.no })
      }
    }
  }
  for (const round of rows.task_rounds) {
    if (!plannedTasks.has(round.task_pk)) continue
    const binding = extract(round, 'planNode', value => Array.isArray(value?.inputs))
    if (!binding) continue
    const key = { task_pk: round.task_pk, round_no: round.round_no }
    rows.task_round_plans.push({ ...key, ...columns(roundFields, binding) })
    if (binding.block) {
      const block = binding.block
      rows.task_node_blocks.push({ ...key, ...columns(blockFields, block) })
      for (const [i, decision] of block.decisions.entries()) rows.task_recovery_decisions.push({
        ...key, decision_no: i + 1, ...columns(decisionFields, decision),
        source_tree: decision.sourceTree ? JSON.stringify(decision.sourceTree) : null,
        target_tree: decision.targetTree ? JSON.stringify(decision.targetTree) : null,
      })
    }
    for (const input of binding.inputs) rows.task_round_inputs.push({ ...key, predecessor_no: input.node, source_round: input.round })
  }
}

export function decodePlans(rows) {
  const cards = new Map(rows.tasks.map(row => [row.task_pk, row]))
  const plans = new Map(), nodes = new Map(), bindings = new Map()
  const add = (row, value) => { row.extra_json = JSON.stringify({ ...JSON.parse(row.extra_json), ...value }) }
  if (rows.project_branches.length) add(rows.rooms[0], { projectBranches: rows.project_branches.map(row => ({
    ...properties(branchFields, row), ...(row.missing && { missing: true }), ...(row.removed && { removed: true }),
  })) })
  if (rows.project_inbox.length) add(rows.rooms[0], { projectInbox: rows.project_inbox.map(row => properties(inboxFields, row)) })
  for (const row of rows.task_plan_nodes) {
    const node = { no: row.node_no, ...properties(nodeFields, row), ...(row.write_paths && { writePaths: JSON.parse(row.write_paths) }), dependsOn: [] }
    nodes.set([row.task_pk, row.plan_version, row.node_no].join(), node)
    const key = [row.task_pk, row.plan_version].join()
    if (!plans.has(key)) plans.set(key, [])
    plans.get(key).push(node)
  }
  for (const row of rows.task_plan_dependencies) nodes.get([row.task_pk, row.plan_version, row.successor_no].join()).dependsOn.push(row.predecessor_no)
  const histories = new Map()
  for (const row of rows.task_plans) {
    if (!histories.has(row.task_pk)) histories.set(row.task_pk, [])
    histories.get(row.task_pk).push({ ...properties(planFields, row), nodes: plans.get([row.task_pk, row.plan_version].join()) })
  }
  for (const [pk, history] of histories) add(cards.get(pk), { plans: history })
  for (const row of rows.task_round_plans) bindings.set([row.task_pk, row.round_no].join(), { ...properties(roundFields, row), inputs: [] })
  for (const row of rows.task_node_blocks) bindings.get([row.task_pk, row.round_no].join()).block = { ...properties(blockFields, row), decisions: [] }
  for (const row of rows.task_recovery_decisions) bindings.get([row.task_pk, row.round_no].join()).block.decisions.push({
    ...properties(decisionFields, row),
    ...(row.source_tree ? { sourceTree: JSON.parse(row.source_tree) } : {}),
    ...(row.target_tree ? { targetTree: JSON.parse(row.target_tree) } : {}),
  })
  for (const row of rows.task_round_inputs) bindings.get([row.task_pk, row.round_no].join()).inputs.push({ node: row.predecessor_no, round: row.source_round })
  for (const round of rows.task_rounds) {
    const planNode = bindings.get([round.task_pk, round.round_no].join())
    if (planNode) add(round, { planNode })
  }
}

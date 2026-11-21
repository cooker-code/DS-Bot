// A recovery always consumes a particular blocked dispatch. The next dispatch
// keeps its task and node, but gets a new round and exchange identity.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { existingProjectDir, verifiedTree } from './project-branches.js'
import { field, checkOwner, taskWorkspaceFor, pathsOverlap, nodeViews } from './project-plan.js'

const run = promisify(execFile)
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const recoveryParameters = Object.fromEntries(Object.entries({
  completed: 'Checks already finished, with their observations.',
  remaining: 'Exact next check or unfinished steps for this node.',
  waitingFor: 'What needs to change before execution can resume.',
  evidence: 'Observed error or evidence for the block.',
  eligibility: 'How the candidate meets the required role, access, environment and independence.',
  worktreeReview: 'Review of the old writer, candidate commit and disposition of any local changes.',
  inspection: 'inspection from inspect_recovery, after reviewing its worktree observations.',
  expectedCommit: 'Full commit verified against the selected artifact when resuming in a Git worktree.',
}).map(([key, description]) => [key, { type: 'string', description }]))

export function currentBinding(card, round) {
  const b = round?.planNode
  return Boolean(b && b.version === card.plans?.at(-1)?.version && !b.supersededBy)
}

export function blockRound(round, { at = Date.now(), cause, by, reason, waitingFor, evidence }) {
  const b = round.planNode
  if (!b || b.block || b.supersededBy || b.acceptedAt || round.result) return
  b.block = { at, cause, by, reason, decisions: [], ...(waitingFor && { waitingFor }), ...(evidence && { evidence }) }
}

export function recoveryOf(card, round) {
  const no = round?.planNode?.previousRound
  return no ? card.rounds[no - 1]?.planNode?.block?.decisions.at(-1) : undefined
}

async function worktree(rt, directory) {
  if (!directory) throw new Error('The working folder could not be verified.')
  const dir = await existingProjectDir(directory)
  if (await rt.inData(dir)) throw new Error('Choose a Bot working folder outside protected application data.')
  const git = async (...args) => (await run('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', dir, ...args],
    { timeout: 5000, maxBuffer: 256 * 1024, env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } })).stdout.trimEnd()
  let root
  try { root = await git('rev-parse', '--show-toplevel') } catch (error) {
    if (error.code === 128 && /not a git repository/.test(error.stderr)) return { dir }
    throw new Error('Could not inspect the Bot working folder with Git.')
  }
  const [repo, commit, branch, changes] = await Promise.all([
    git('rev-parse', '--path-format=absolute', '--git-common-dir'), git('rev-parse', '--verify', 'HEAD'),
    git('rev-parse', '--abbrev-ref', 'HEAD'), git('status', '--porcelain=v1', '--untracked-files=all'),
  ])
  const tree = { dir, root, repo, commit, branch, changes }
  if (changes) {
    // Porcelain lists a dirty path only once even when it is edited again.
    // Bind the review to staged blob IDs and the observed working file versions.
    const [staged, files] = await Promise.all([
      git('diff', '--cached', '--no-ext-diff', '--raw', '--no-abbrev', 'HEAD', '--', ':/'),
      git('ls-files', '--full-name', '--modified', '--others', '--exclude-standard', '-z', '--', ':/'),
    ])
    const versions = []
    for (const file of new Set(files.split('\0').filter(Boolean))) {
      const stat = await lstat(join(root, file), { bigint: true }).catch(error => {
        if (error.code !== 'ENOENT') throw error
      })
      versions.push([file, stat && [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)])
    }
    tree.changesRevision = digest([staged, versions])
  }
  return tree
}

async function artifactCommits(tree, refs) {
  const result = {}
  if (!tree.repo) return result
  for (const ref of new Set(refs.filter(Boolean))) {
    // An artifact may instead be a document or an external delivery reference.
    if (ref.includes('\n') || ref.startsWith('-') || !/^[a-zA-Z0-9_./@-]+$/.test(ref)) continue
    try {
      const { stdout } = await run('git', ['-C', tree.dir, 'rev-parse', '--verify', '--quiet', '--end-of-options', ref + '^{commit}'], { timeout: 5000 })
      Object.defineProperty(result, ref, { value: stdout.trim(), enumerable: true })
    } catch (error) { if (error.code !== 1) throw new Error('Could not resolve the artifact in the candidate worktree.') }
  }
  return result
}

function idleWriter(rt, agent, sessionId, exchangeId) {
  if (agent.status !== 'idle' || rt.live.get(sessionId)?.turn !== undefined || rt.hasSubagents?.(sessionId)) return false
  return ![...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])].some(m => m.source?.exchangeId === exchangeId)
}

// A historical blocked writer can hand its clean checkout back to the same developer
// after independent integration. A revision alone never releases a live writer.
export async function inspectIntegratedWriter(rt, card, node) {
  if (!node?.writePaths?.length || node.round) return
  const plan = card.plans.at(-1)
  const views = nodeViews(card, plan)
  const accepted = node.dependsOn.map(no => card.rounds[views[no - 1].round - 1])
    .filter(r => r?.integration?.branch === 'dev' && r.integration.repository === node.repository && r.planNode.acceptedAt)
  if (!accepted.length) return
  for (const [index, prior] of card.rounds.entries()) {
    const b = prior.planNode
    if (!b?.block?.resolvedAt || b.version >= plan.version || prior.result || prior.ownershipTransfer ||
        prior.ownerId !== node.ownerId || prior.workspace?.workDir !== node.workDir || prior.workspace.workRef !== node.workRef) continue
    const oldNode = card.plans.find(p => p.version === b.version)?.nodes[b.node - 1]
    if (!oldNode?.writePaths?.length || !pathsOverlap(oldNode.writePaths, node.writePaths)) continue
    const session = b.session ?? prior.executionSession
    if (!session) continue
    const writer = await rt.resolveAgent(session)
    const idle = () => idleWriter(rt, writer, session, prior.dispatchId)
    if (!idle()) continue
    const tree = await worktree(rt, node.workDir)
    const receipt = accepted.find(r => r.integration.commit === tree.commit)
    if (tree.changes || tree.branch !== node.workRef || !receipt) continue
    return { apply(fresh) {
      const original = fresh.rounds[index]
      if (!idle() || fresh.plans.at(-1).version !== plan.version || original.dispatchId !== prior.dispatchId)
        throw new Error('The original writer or plan changed before dispatch.')
      original.ownershipTransfer = { version: plan.version, node: node.no, commit: tree.commit, integrationRound: card.rounds.indexOf(receipt) + 1 }
    } }
  }
}

function checkTarget(card, args) {
  const round = Number.isSafeInteger(args.round) && card?.rounds[args.round - 1]
  const b = round?.planNode
  if (!b?.block || b.node !== args.node || b.version !== args.version || b.version !== card.plans.at(-1).version) throw new Error('Identify the blocked node in the current plan and its exact round.')
  return round
}

const requirements = (card, node, round, owner) => {
  if (node.fixedOwner && owner !== node.ownerId) throw new Error('This node requires its designated owner.')
  if (node.independentReview && round.planNode.inputs.some(input => card.rounds[input.round - 1].ownerId === owner)) throw new Error('Choose a reviewer independent of the upstream producer.')
}

export async function inspectRecovery(rt, room, card, args, actor) {
  const round = checkTarget(card, args)
  const b = round.planNode
  if (b.supersededBy) throw new Error('This round has already been replaced.')
  checkOwner(room, actor, args.ownerId)
  const node = card.plans.at(-1).nodes[b.node - 1]
  requirements(card, node, round, args.ownerId)
  const oldSession = b.session ?? round.executionSession ?? rt.chatOf(round.ownerId)
  const nextSession = await rt.memberSession(room, args.ownerId)
  const [old, next] = await Promise.all([rt.resolveAgent(oldSession), rt.resolveAgent(nextSession)])
  const sourceDir = b.workDir ?? rt.sessionFolder(old.session)
  const targetDir = rt.sessionFolder(next.session)
  const sourceTree = await worktree(rt, sourceDir)
  const targetTree = sourceDir === targetDir ? sourceTree : await worktree(rt, targetDir)
  const stopped = () => idleWriter(rt, old, oldSession, round.dispatchId)
  const artifacts = round.planNode.inputs.map(input => card.rounds[input.round - 1].planNode.artifact)
  const commits = await artifactCommits(targetTree, [...artifacts, b.checkpointArtifact])
  const facts = { taskId: card.id, version: b.version, node: b.node, round: args.round, originalOwner: round.ownerId,
    ownerId: args.ownerId, writerStopped: stopped(), sourceTree, targetTree,
    artifacts, commits,
    completed: b.completed, remaining: b.remaining, checkpointArtifact: b.checkpointArtifact }
  return { facts: { ...facts, inspection: digest(facts) }, validate() {
    if (!stopped() || rt.roomOf(room.id)?.sessions?.[args.ownerId] !== nextSession || rt.sessionFolder(next.session) !== targetDir) throw new Error('The original execution or candidate folder changed. Inspect the worktrees again.')
  } }
}

export async function checkProjectStart(rt, card, round, session) {
  const decision = recoveryOf(card, round)
  const node = { ...card.plans.at(-1).nodes[round.planNode.node - 1], ...round.workspace }
  if (!decision && !node.workDir && !node.workRef && !node.repository) return
  const agent = await rt.resolveAgent(session)
  const dir = rt.sessionFolder(agent.session)
  if (node.writePaths || round.workspace) {
    if (await verifiedTree(rt, node.repository, node.workRef, dir) !== node.workDir) throw new Error('Enter the assigned working folder before starting this Git node.')
    if (!decision) return
  }
  const actual = await worktree(rt, dir)
  if (decision) {
    if (digest(actual) !== digest(decision.targetTree)) throw new Error('The working tree differs from the approved recovery.')
    const previous = card.rounds[round.planNode.previousRound - 1]
    const writerSession = previous.planNode.session ?? previous.executionSession ?? rt.chatOf(previous.ownerId)
    if (writerSession !== session && (actual.root ?? actual.dir) === (decision.sourceTree.root ?? decision.sourceTree.dir)) {
      const writer = await rt.resolveAgent(writerSession)
      if (!idleWriter(rt, writer, writerSession, previous.dispatchId)) throw new Error('The original writer is not confirmed idle in the shared worktree.')
    }
  } else {
    if (node.workDir && await existingProjectDir(node.workDir) !== actual.dir) throw new Error('The executing folder differs from the planned worktree.')
    if ((node.repository || node.workRef) && !actual.commit) throw new Error('The executing folder is not a Git worktree.')
    if (node.workRef) {
      const revisions = await artifactCommits(actual, [node.workRef])
      if (actual.commit !== revisions[node.workRef]) throw new Error('The checked-out commit differs from the planned working revision.')
    }
  }
}

export function recoverNode(room, card, args, actor, observation, assignment) {
  const old = checkTarget(card, args), b = old.planNode, block = b.block
  const reason = field(args.reason, 'the recovery decision reason', 2000)
  if (args.action === 'wait') {
    if (b.supersededBy) throw new Error('That round has been replaced.')
    const condition = field(args.waitingFor, 'the recovery condition', 2000)
    const last = block.decisions.at(-1)
    if (last?.action !== 'wait' || last.reason !== reason || last.condition !== condition)
      block.decisions.push({ action: 'wait', at: Date.now(), by: actor, reason, condition })
    return
  }
  const ownerId = args.ownerId
  const artifact = field(args.artifact, 'the reviewed artifact reference', 2000)
  const remaining = field(args.remaining ?? b.remaining, 'the checks still to perform', 4000)
  const eligibility = field(args.eligibility, 'the eligibility review', 2000)
  const worktreeReview = field(args.worktreeReview, 'the worktree review and disposition of local changes', 2000)
  const action = ownerId === old.ownerId ? 'resume' : 'takeover'
  if (action !== args.action) throw new Error('Use resume for the same owner and takeover for a replacement Bot.')
  const details = { action, ownerId, artifact, reason, remaining, eligibility, worktreeReview }
  if (b.supersededBy) {
    const decision = block.decisions.at(-1)
    if (Object.keys(details).some(k => decision[k] !== details[k]) || decision.inspection !== args.inspection || (decision.targetTree.commit ?? undefined) !== args.expectedCommit) throw new Error('This round already has a different recovery decision.')
    return b.supersededBy
  }
  observation?.validate()
  const facts = observation?.facts
  if (!facts?.writerStopped || args.inspection !== facts.inspection) throw new Error('Inspect the stopped execution and current worktrees before recovery.')
  const { sourceTree, targetTree } = facts
  const step = card.plans.at(-1).nodes[b.node - 1]
  const checkout = taskWorkspaceFor(card, step) ?? old.workspace
  const node = { ...step, ...checkout }
  checkOwner(room, actor, ownerId)
  requirements(card, node, old, ownerId)
  if ((node.writePaths || checkout) && (targetTree.branch !== node.workRef || targetTree.dir !== node.workDir)) throw new Error('Resume in the assigned working tree and branch, or revise the plan.')
  const known = [...facts.artifacts, b.checkpointArtifact].filter(Boolean)
  if (known.length && !known.includes(artifact)) throw new Error('Select a reviewed input or the saved checkpoint artifact.')
  if ((node.repository || node.workRef || node.baseRef || sourceTree.repo || targetTree.repo) &&
      (!targetTree.repo || sourceTree.repo !== targetTree.repo || targetTree.commit !== args.expectedCommit ||
       (Object.hasOwn(facts.commits, artifact) && targetTree.commit !== facts.commits[artifact]) ||
       (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(artifact) && targetTree.commit !== artifact.toLowerCase())))
    throw new Error('Verify the artifact commit and the target repository before recovery.')
  if (sourceTree.root !== targetTree.root && sourceTree.changes) throw new Error('Preserve the original worktree changes before switching trees.')
  const replacement = assignment(ownerId, old.plan)
  if (old.reviewBase) replacement.reviewBase = old.reviewBase
  if (checkout) replacement.workspace = checkout
  // A second interruption before the successor's first checkpoint must still
  // carry the last completed checks and the reviewed recovery artifact.
  replacement.planNode = {
    version: b.version, node: b.node, previousRound: args.round, inputs: structuredClone(b.inputs),
    ...(b.completed && { completed: b.completed }), remaining, checkpointArtifact: artifact,
  }
  const number = card.rounds.push(replacement)
  const at = Date.now()
  b.supersededBy = number
  block.resolvedAt = at
  block.decisions.push({ ...details, at, by: actor, nextRound: number, inspection: facts.inspection, sourceTree, targetTree })
  return number
}

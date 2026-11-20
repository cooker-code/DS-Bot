import { taskManagementEnabled, taskError } from '../shared/task-settings.js'
import { assistantId } from './project-assistant.js'
// The room owns its branch observations. Git owns the refs and checkouts.
import { execFile } from 'node:child_process'
import { lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import { usesGitWorkspace, workspacePolicies, workspacePolicyOf } from '../shared/project-workspace.js'
import { within } from './folders.js'
import { plannedCheckout, sameCheckout, taskCheckout, field, nodeViews, pathsOverlap } from './project-plan.js'

const run = promisify(execFile)
const pending = new Map()

async function git(dir, ...args) {
  return (await run('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', dir, ...args],
    { timeout: 30000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } })).stdout
}

async function checkedFolder(rt, path) {
  await rt.workFolder(path)
  if (await rt.privateClash(path)) throw new Error('Choose a project outside private Bot folders.')
}

const projectFolder = (rt, room) => room.workDir ?? rt.workDirOf({ botId: room.admin }) ?? rt.teamFolder()

export async function projectRepository(rt, room, input, optional = false) {
  const configured = projectFolder(rt, room)
  if (!configured && optional && !input) return
  if (!configured) throw new Error('Set the project group working folder before choosing a repository.')
  const allowed = await realpath(configured).catch(() => { throw new Error('The configured project working folder is missing: ' + configured) })
  if (input && !isAbsolute(input)) throw new Error('Supply the absolute path of a local project repository.')
  const dir = input ? await realpath(field(input, 'a local repository path', 2000)) : allowed
  if (!within(dir, allowed)) throw new Error('Choose a repository inside the project working folder.')
  await checkedFolder(rt, dir)
  let root
  try { root = await realpath((await git(dir, 'rev-parse', '--show-toplevel')).trimEnd()) }
  catch (error) {
    if (optional && error.code === 128 && /not a git repository/.test(error.stderr)) return
    throw new Error('The project working folder must contain a Git checkout.')
  }
  if (!within(root, allowed)) {
    if (optional) return
    throw new Error('Set the project working folder to the repository root to manage its branches.')
  }
  const common = await realpath((await git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trimEnd())
  await checkedFolder(rt, common)
  return root
}

async function localBranch(repo, value) {
  const name = field(value, 'a local branch name', 240)
  try {
    if (name.startsWith('-') || name === 'HEAD' || name.startsWith('refs/')) throw Error()
    if ((await git(repo, 'check-ref-format', '--branch', name)).trimEnd() !== name) throw Error()
  } catch { throw new Error('Supply a literal local Git branch name.') }
  return name
}

async function checkedBranch(repo) {
  try { return (await git(repo, 'symbolic-ref', '--quiet', 'HEAD')).trimEnd().slice('refs/heads/'.length) }
  catch { throw new Error('The project checkout has detached HEAD. Select a local base branch.') }
}

async function checkouts(repo) {
  const output = await git(repo, 'worktree', 'list', '--porcelain', '-z')
  const trees = new Map()
  for (const record of output.split('\0\0')) {
    const lines = record.split('\0')
    const branch = lines.find(line => line.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length)
    if (branch) trees.set(branch, { workDir: resolve(lines[0].slice('worktree '.length)), prunable: lines.some(l => /^prunable( |$)/.test(l)) })
  }
  return trees
}

export async function existingProjectDir(path) {
  if (!path) throw new Error('The branch has no working tree. The Main Bot must prepare it before planning.')
  const dir = await realpath(path).catch(() => { throw new Error('The planned working tree is missing at ' + path + '. Inspect the branch and its Git registration before dispatch.') })
  if (!(await lstat(dir)).isDirectory()) throw new Error('The assigned working folder must be a directory: ' + path)
  return dir
}

export async function verifiedTree(rt, repo, branch, path) {
  const dir = await existingProjectDir(path)
  await checkedFolder(rt, dir)
  const [actual, common, expected, root] = await Promise.all([
    checkedBranch(dir), git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), git(dir, 'rev-parse', '--show-toplevel'),
  ])
  if (actual !== branch || await realpath(common.trimEnd()) !== await realpath(expected.trimEnd()) || await realpath(root.trimEnd()) !== dir)
    throw new Error('The working tree no longer matches the assigned repository and branch.')
  return dir
}

async function mergeRelation(repo, branch, tip, target, targetCommit) {
  if (branch === target) return 'target'
  if (tip === targetCommit) return 'same_tip'
  try { await git(repo, 'merge-base', '--is-ancestor', tip, targetCommit); return 'contained' }
  catch (error) {
    if (error.code === 1) return 'unmerged'
    if (error.code === 128 && /Not a valid commit name|bad object/.test(error.stderr)) return 'unknown'
    throw error
  }
}

export async function verifyReviewCommit(rt, room, repository, value, { writePaths, base } = {}) {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value))
    throw new Error('Supply the full commit ID of this delivery to enter review.')
  const repo = await projectRepository(rt, room, repository)
  const commit = value.toLowerCase()
  if ((await git(repo, 'cat-file', '-t', commit).catch(() => '')).trim() !== 'commit')
    throw new Error('The delivery commit does not exist in the task repository.')
  if (base) {
    const alreadyPresent = await git(repo, 'merge-base', '--is-ancestor', commit, base).then(() => true, error => {
      if (error.code === 1) return false
      throw error
    })
    if (alreadyPresent) throw new Error('Supply a delivery commit after the start of this task.')
  }
  if (writePaths?.length) {
    const touched = await git(repo, '--literal-pathspecs', 'diff-tree', '--root', '-m', '--no-commit-id', '-r', '--name-only', commit, '--', ...writePaths)
    if (!touched.trim()) throw new Error('The delivery commit must include a change to the assigned files.')
  }
  const refs = await git(repo, 'for-each-ref', '--contains=' + commit, '--format=%(refname) %(objectname)', 'refs/heads/main', 'refs/heads/master')
  for (const line of refs.trim().split('\n')) {
    const [ref, tip] = line.split(' ')
    if (ref === 'refs/heads/main' || ref === 'refs/heads/master')
      return { repository: repo, branch: ref.slice('refs/heads/'.length), commit, tip }
  }
  throw new Error('The delivery commit is not on local main or master. It cannot enter review yet.')
}

export async function reviewBaseline(rt, room, repository, branch) {
  const repo = await projectRepository(rt, room, repository)
  const ref = branch ? 'refs/heads/' + await localBranch(repo, branch) : 'HEAD'
  return (await git(repo, 'rev-parse', '--verify', ref + '^{commit}')).trim()
}

async function inventory(repo, target, previous) {
  const ref = 'refs/heads/' + target
  const targetCommit = (await git(repo, 'rev-parse', '--verify', ref + '^{commit}')).trim()
  const format = '%(refname:lstrip=2)%00%(objectname)%00%(committerdate:unix)'
  const [all, trees] = await Promise.all([git(repo, 'for-each-ref', '--format=' + format, 'refs/heads/'), checkouts(repo)])
  const prior = new Map(previous.map(b => [b.branch, b]))
  const observedAt = Date.now()
  const rows = all.trimEnd().split('\n').map(line => {
    const [branch, commit, seconds] = line.split('\0')
    const tree = trees.get(branch)
    const old = prior.get(branch)
    prior.delete(branch)
    return { ...(old?.purpose && !old.removed && { purpose: old.purpose, ...(old.preparedAt && { preparedAt: old.preparedAt }) }), repository: repo, branch, commit, target, targetCommit, observedAt, commitAt: Number(seconds) * 1000,
      ...(tree && { workDir: tree.workDir, ...(tree.prunable && { missing: true }) }) }
  })
  for (const old of prior.values()) rows.push({ ...old, target, targetCommit, observedAt, removed: true })
  // A new branch may point to a years-old commit. Its local reflog dates
  // the actual ref update, including resets, independently of the commit date.
  for (let start = 0; start < rows.length; start += 8) {
    await Promise.all(rows.slice(start, start + 8).map(async row => {
      row.relation = await mergeRelation(repo, row.branch, row.commit, target, targetCommit)
      if (row.removed) return
      if (row.workDir && !row.missing) {
        try { if (!(await stat(row.workDir)).isDirectory()) row.missing = true }
        catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error
          row.missing = true
        }
      }
      const log = await git(repo, 'reflog', 'show', '-1', '--format=%gD', '--date=raw', 'refs/heads/' + row.branch)
      const date = /@\{(\d+) [+-]\d{4}\}/.exec(log)
      if (date) row.refAt = Number(date[1]) * 1000
    }))
  }
  return rows
}

async function prepare(rt, repo, args, target, exec) {
  const branch = await localBranch(repo, args.workRef)
  const trees = await checkouts(repo)
  if (trees.has(branch)) {
    await verifiedTree(rt, repo, branch, trees.get(branch).workDir)
    return false
  }
  const policy = exec && rt.ctx.get?.('sandboxPolicy')?.resolve({ session: exec.agent.session })
  if (policy?.mode === 'read-only') throw new Error('A read-only session cannot create a Git working tree.')
  const path = join(repo, '.worktrees', encodeURIComponent(branch))
  if (policy?.mode === 'workspace-write') {
    const folder = rt.sessionFolder(exec.agent.session)
    if (!folder || !within(repo, await realpath(folder))) {
      await rt.approveFolder(exec, { path: repo, sessions: [exec.agent.id], who: { en: 'the project Main Bot', zh: '项目主 Bot' } })
    }
  }
  if (await rt.realBeyond(path) !== path) throw new Error('Choose a worktree path without symbolic links.')
  await checkedFolder(rt, path)
  if (await lstat(path).catch(e => { if (e.code !== 'ENOENT') throw e })) throw new Error('The worktree destination already exists. Inspect it before proceeding.')
  const refs = (await git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/' + branch)).split('\n')
  const exists = refs.includes('refs/heads/' + branch)
  if (exists) await git(repo, 'worktree', 'add', '--', path, branch)
  else {
    if (!exec) throw new Error('Choose an existing local branch.')
    const base = (await git(repo, 'rev-parse', '--verify', 'refs/heads/' + target + '^{commit}')).trim()
    await git(repo, 'worktree', 'add', '-b', branch, '--', path, base)
  }
  await verifiedTree(rt, repo, branch, path)
  return true
}

function taskCard(rt, roomId, taskId) {
  const room = rt.roomOf(roomId)
  if (typeof taskId !== 'string' || !Object.hasOwn(room?.projectCards ?? {}, taskId))
    throw Object.assign(new Error('No such task'), { code: 'bot/not-found' })
  return { room, card: room.projectCards[taskId] }
}

export async function taskWorkspaceChoices(rt, roomId, taskId) {
  const { room, card } = taskCard(rt, roomId, taskId)
  const plan = card.plans?.at(-1)
  const recorded = taskCheckout(card)
  const repos = recorded?.repository ? new Set([recorded.repository]) : new Set(plan?.nodes.map(n => n.repository).filter(Boolean))
  const root = await projectRepository(rt, room, undefined, true)
  if (root && !repos.size) repos.add(root)
  if (!repos.size) for (const row of room.projectBranches ?? []) if (!row.removed) repos.add(row.repository)
  const choices = []
  const byDirectory = new Map()
  const policy = workspacePolicyOf(room)
  for (const input of repos) {
    // A task may predate a move of the group's working folder. Old assignments
    // still describe their rounds; only repositories in the current project are selectable.
    const repo = input === root ? root : await projectRepository(rt, room, input).catch(() => null)
    if (!repo) continue
    const [refs, trees] = await Promise.all([git(repo, 'for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/'), checkouts(repo)])
    for (const workRef of refs.trimEnd().split('\n').filter(Boolean)) {
      const tree = trees.get(workRef)
      const workDir = tree?.workDir ?? null
      const workspaceMode = workDir === repo ? 'current' : 'worktree'
      if (tree?.prunable || (workDir && !await stat(workDir).then(s => s.isDirectory(), () => false))) continue
      const row = { repository: repo, workRef, workDir, workspaceMode }
      if (workDir) byDirectory.set(workDir, row)
      if (policy === 'auto' || workspaceMode === policy) choices.push(row)
    }
  }
  const actual = byDirectory.get(recorded?.workDir)
  // A directory-only legacy assignment can be resolved from Git. A recorded
  // branch that disappeared must stay visible as unavailable.
  const available = !!actual && (!recorded.repository || actual.repository === recorded.repository) &&
    (!recorded.workRef || actual.workRef === recorded.workRef)
  const effective = available ? actual : recorded
  return { selected: card.workspace ?? null, effective: effective ?? null, available,
    hasRepository: repos.size > 0, choices, policy }
}

export async function selectTaskWorkspace(rt, args) {
  const { roomId, taskId, previous, selection } = args
  if (!taskManagementEnabled(rt.roomOf(roomId))) throw taskError(rt.roomOf(roomId) ? 'TASK_MANAGEMENT_DISABLED' : 'GROUP_CONTEXT_REQUIRED')
  const { room, card } = taskCard(rt, roomId, taskId)
  const folder = projectFolder(rt, room)
  const matches = workspace => selection === null ? workspace == null : workspace && selection &&
    workspace.repository === selection.repository && workspace.workRef === selection.workRef &&
    (selection.workDir === null || workspace.workDir === selection.workDir)
  const checkActiveRounds = current => {
    const target = selection ?? plannedCheckout(current)
    for (const round of current.rounds ?? []) {
      if (round.result || round.failedAt || round.planNode?.block || round.planNode?.supersededBy || round.planNode?.lateResult) continue
      const binding = round.planNode
      const node = current.plans?.find(plan => plan.version === binding?.version)?.nodes[binding.node - 1]
      if (node?.workspaceMode === 'none' || (binding && !round.startedAt && binding.version !== current.plans?.at(-1)?.version)) continue
      const assigned = round.workspace ?? node
      const dir = binding?.workDir ?? assigned?.workDir
      if ((dir && dir !== target?.workDir) || (assigned?.workRef && assigned.workRef !== target?.workRef))
        throw new Error('Finish the dispatched work before changing the task worktree.')
    }
  }
  const assertCurrent = () => {
    const current = taskCard(rt, roomId, taskId)
    if (!taskManagementEnabled(current.room)) throw taskError('TASK_MANAGEMENT_DISABLED')
    if (current.room !== room || projectFolder(rt, room) !== folder || (!matches(current.card.workspace) && !isDeepStrictEqual(current.card.workspace ?? null, previous)) ||
        current.card.plans?.at(-1)?.version !== card.plans?.at(-1)?.version)
      throw new Error('The task workspace changed. Reopen the selector.')
    if (!matches(current.card.workspace)) checkActiveRounds(current.card)
    return current.card
  }
  if (matches(assertCurrent().workspace)) return card.workspace ?? null
  let selected = null, planned
  if (selection !== null) {
    const { choices, policy, effective, available } = await taskWorkspaceChoices(rt, roomId, taskId)
    if (!card.workspace && available) planned = effective
    const choice = choices.find(row => row.repository === selection?.repository && row.workRef === selection?.workRef && row.workDir === selection?.workDir)
    if (!choice) throw new Error('This branch or worktree is no longer available.')
    const previousOperation = pending.get(choice.repository) ?? Promise.resolve()
    const operation = previousOperation.catch(() => {}).then(async () => {
      assertCurrent()
      if (workspacePolicyOf(room) !== policy) throw new Error('The task workspace changed. Reopen the selector.')
      if (!choice.workDir) await prepare(rt, choice.repository, choice, undefined)
      const tree = (await checkouts(choice.repository)).get(choice.workRef)
      if (!tree || (choice.workDir && choice.workDir !== tree.workDir)) throw new Error('This branch or worktree is no longer available.')
      const workDir = await verifiedTree(rt, choice.repository, choice.workRef, tree.workDir)
      return { ...choice, workDir, workspaceMode: workDir === choice.repository ? 'current' : 'worktree' }
    })
    pending.set(choice.repository, operation)
    try { selected = await operation } finally { if (pending.get(choice.repository) === operation) pending.delete(choice.repository) }
  }
  await rt.save({ required: true, mutate() {
    const current = assertCurrent()
    if (matches(current.workspace)) return
    const policy = workspacePolicyOf(room)
    if (selected && policy !== 'auto' && policy !== selected.workspaceMode) throw new Error('The task workspace changed. Reopen the selector.')
    const next = { ...current, updatedAt: Math.max(Date.now(), (current.updatedAt ?? 0) + 1) }
    if (!next.plannedWorkspace && planned) next.plannedWorkspace = planned
    if (selected) next.workspace = selected
    else delete next.workspace
    room.projectCards[taskId] = next
    return () => { room.projectCards[taskId] = current }
  } })
  return selected
}

export function branchReport(room, repository) {
  const rows = (room.projectBranches ?? []).filter(b => !repository || b.repository === repository)
  const now = Date.now()
  const activity = new Map()
  for (const card of Object.values(room.projectCards ?? {})) for (const plan of card.plans ?? []) {
    const views = nodeViews(card, plan)
    for (const node of views) {
      if (!node.repository || !node.workRef) continue
      const key = JSON.stringify([node.repository, node.workRef])
      const usage = activity.get(key) ?? { tasks: [], taskAt: 0 }
      activity.set(key, usage)
      usage.taskAt = Math.max(usage.taskAt, plan.at)
      for (const r of card.rounds.filter(r => r.planNode?.version === plan.version && r.planNode.node === node.no)) {
        usage.taskAt = Math.max(usage.taskAt, ...[r.assignedAt, r.sentAt, r.startedAt, r.submittedAt, r.failedAt,
          r.planNode.checkpointAt, r.planNode.acceptedAt, r.planNode.block?.at, r.planNode.block?.resolvedAt].filter(Number.isFinite))
      }
      if (plan === card.plans.at(-1)) usage.tasks.push({ taskId: card.id, title: card.title, node: node.no,
        work: node.title, ownerId: node.ownerId, writePaths: node.writePaths, status: node.status })
    }
  }
  const branches = rows.map(row => {
    const { tasks, taskAt } = activity.get(JSON.stringify([row.repository, row.branch])) ?? { tasks: [], taskAt: 0 }
    const lastActivityAt = Math.max(row.commitAt, row.refAt ?? 0, row.preparedAt ?? 0, taskAt)
    return { ...row, tasks, taskAt: taskAt || null, lastActivityAt, idleMs: Math.max(0, now - lastActivityAt) }
  })
  return { count: rows.length ? branches.filter(b => !b.removed).length : null,
    observedAt: rows.reduce((latest, row) => Math.max(latest, row.observedAt), 0) || null, branches }
}

export async function setProjectWorkspacePolicy(rt, roomId, policy) {
  if (typeof policy !== 'string' || !Object.hasOwn(workspacePolicies, policy)) throw new Error('Choose a supported Git workspace policy.')
  await rt.save({ required: true, mutate() {
    const room = rt.roomOf(roomId)
    if (!room) throw taskError('GROUP_CONTEXT_REQUIRED')
    if (!taskManagementEnabled(room)) throw taskError('TASK_MANAGEMENT_DISABLED')
    const previous = room.projectWorkspacePolicy
    if (workspacePolicyOf(room) === policy) return
    if (policy === 'auto') delete room.projectWorkspacePolicy
    else room.projectWorkspacePolicy = policy
    return () => {
      if (previous === undefined) delete room.projectWorkspacePolicy
      else room.projectWorkspacePolicy = previous
    }
  } })
  return policy
}

export function workspaceSummary(card, room) {
  const checkout = taskCheckout(card)
  if (!checkout) return
  if (usesGitWorkspace(checkout)) return { mode: checkout.workspaceMode, branch: checkout.workRef }
  const known = room?.projectBranches?.find(row => !row.removed && row.workDir === checkout.workDir &&
    (!checkout.workRef || row.branch === checkout.workRef))
  if (known) return { mode: known.workDir === known.repository ? 'current' : 'worktree', branch: known.branch }
  if (checkout.workRef && checkout.workDir) return { branch: checkout.workRef }
}

export function workspaceDecisions(card) {
  const plan = card.plans?.at(-1)
  const checkout = taskCheckout(card)
  const reason = plan?.nodes.find(n => sameCheckout(n, checkout) && n.workspaceReason)?.workspaceReason
  return { version: plan?.version, policy: plan?.workspacePolicy, directory: checkout?.workDir,
    ...(card.workspace ? { userSelected: true } : { reason }) }
}

export async function manageBranches(rt, room, args, actor, exec) {
  const session = exec.agent.id
  const check = () => {
    if (rt.roomOf(room.id) !== room || !room.members.includes(actor) || (!rt.isMain(actor) && actor !== assistantId(room)) || room.sessions?.[actor] !== session)
      throw new Error('Manage project branches from a Main Bot chat in this group.')
    if (rt.readOnly() !== undefined) throw new Error('This host cannot write the Bot team.')
  }
  check()
  const repo = await projectRepository(rt, room, args.repository)
  const previous = pending.get(repo) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(async () => {
    check()
    const target = await localBranch(repo, args.baseRef ?? await checkedBranch(repo))
    const preparing = args.action === 'prepare_worktree'
    if (preparing && workspacePolicyOf(room) === 'current') throw new Error('This group uses the current branch. Plan in the project checkout.')
    const name = args.action === 'branches' ? undefined : await localBranch(repo, args.workRef)
    const purpose = name ? field(args.reason, 'the purpose of this branch', 2000) : undefined
    const created = preparing && await prepare(rt, repo, args, target, exec)
    const fresh = await inventory(repo, target, (room.projectBranches ?? []).filter(b => b.repository === repo))
    if (name) {
      const row = fresh.find(b => b.branch === name && !b.removed)
      if (!row) throw new Error('Choose an existing local branch.')
      if (created || (preparing && !row.preparedAt)) row.preparedAt = Date.now()
      row.purpose = purpose
    }
    await rt.save({ required: true, mutate() {
      check()
      const old = room.projectBranches
      room.projectBranches = [...(old ?? []).filter(b => b.repository !== repo), ...fresh]
        .sort((a, b) => Buffer.compare(Buffer.from(a.repository), Buffer.from(b.repository)) || Buffer.compare(Buffer.from(a.branch), Buffer.from(b.branch)))
      return () => { if (old) room.projectBranches = old; else delete room.projectBranches }
    } })
    return branchReport(room, repo)
  })
  pending.set(repo, operation)
  try { return await operation } finally { if (pending.get(repo) === operation) pending.delete(repo) }
}

export async function resolveNodeWorkspace(rt, room, raw, selection) {
  const repo = await projectRepository(rt, room, raw.repository)
  const branch = await localBranch(repo, raw.workRef)
  const registered = room.projectBranches?.find(b => b.repository === repo && b.branch === branch && !b.removed)
  const record = selection ? { workDir: selection.workDir, target: registered?.target ?? branch } : registered
  if (!record) throw new Error('Refresh branches or prepare_worktree before assigning a branch.')
  const dir = await verifiedTree(rt, repo, branch, record.workDir)
  if (raw.workDir && await realpath(raw.workDir).catch(() => null) !== dir) throw new Error('The supplied directory differs from the registered branch worktree.')
  if ((raw.workspaceMode === 'current') !== (dir === repo)) throw new Error('Choose current for the project checkout or worktree for a separate checkout.')
  if (!Array.isArray(raw.writePaths) || raw.writePaths.length > 200) throw new Error('List repository-relative writePaths, or [] for read-only work.')
  const baseRef = await localBranch(repo, raw.baseRef ?? record.target)
  await git(repo, 'rev-parse', '--verify', 'refs/heads/' + baseRef + '^{commit}')
  const paths = []
  for (const path of raw.writePaths) {
    if (typeof path !== 'string' || !path || path !== path.trim() || isAbsolute(path) || Array.from(path).some(c => c < ' ' || '\\:*?[]'.includes(c)) ||
        path.split('/').some(p => !p || ['.','..','.git','.worktrees'].includes(p.toLowerCase())) || await rt.realBeyond(resolve(dir, path)) !== resolve(dir, path))
      throw new Error('Write paths must be literal relative files or directories inside the assigned working tree.')
    paths.push(path)
  }
  return { ...raw, repository: repo, workRef: branch, workDir: dir, baseRef, writePaths: [...new Set(paths)].sort() }
}

export async function resolvePlanWorkspaces(rt, room, args, actor, card) {
  const { nodes } = args
  const latest = card?.plans?.at(-1)
  const previous = card && taskCheckout(card)
  const shared = Object.fromEntries(['workspaceMode', 'workRef', 'repository', 'baseRef', 'workspaceReason']
    .filter(key => args[key] !== undefined).map(key => [key, args[key]]))
  if (!nodes.length || nodes.length > 100) throw new Error('Provide a complete plan of 1 to 100 nodes.')
  let project
  const resolved = []
  for (const input of nodes) {
    if (!input || typeof input !== 'object') throw new Error('Provide the details for each node.')
    let node = input
    if (input.workspaceMode !== 'none') {
      if (args.workspaceMode) node = { ...shared, ...input }
      else if (!input.workspaceMode && input.writePaths && previous && usesGitWorkspace(previous)) {
        const source = latest?.nodes.find(n => sameCheckout(n, previous))
        node = { ...previous, workspaceReason: source?.workspaceReason, ...input }
      }
    }
    if (args.workspaceMode && node.workspaceMode !== 'none' && ['workspaceMode','workRef','repository'].some(k => shared[k] && node[k] !== shared[k]))
      throw new Error('Use the same task worktree and branch for every Git step.')
    if (node.workspaceMode === 'none') {
      if (node.workDir || node.workRef || node.repository || node.writePaths || node.baseRef) throw new Error('Remove Git assignment fields for non-repository work.')
    } else if (['current', 'worktree'].includes(node.workspaceMode)) {
      if (!rt.isMain(actor) && actor !== assistantId(room)) throw new Error('The Main Bot must plan Git assignments.')
      const selected = previous?.repository && previous.workRef === node.workRef &&
        (!node.repository || previous.repository === node.repository) ? previous : undefined
      resolved.push(await resolveNodeWorkspace(rt, room, node, selected))
      continue
    } else if (!node.contextGap) {
      project ??= await projectRepository(rt, room, undefined, true) ?? false
      if (project || node.repository || node.writePaths || node.workspaceMode || (!node.workDir && (node.workRef || node.baseRef))) throw new Error('Choose workspaceMode, workRef and writePaths for each Git node, or none for non-repository work.')
      if (node.workDir) await existingProjectDir(node.workDir)
    } else if (node.writePaths || node.workspaceMode) throw new Error('Resolve the working context before assigning file ownership.')
    resolved.push(node)
  }
  return resolved
}

export function reserveNodePaths(rt, roomId, card, round) {
  if (round.result || round.planNode?.supersededBy) return
  const node = { ...card.plans?.find(p => p.version === round.planNode?.version)?.nodes[round.planNode.node - 1], ...round.workspace }
  if (!node?.workDir || node.writePaths?.length === 0) return
  for (const room of Object.values(rt.state.rooms)) for (const saved of Object.values(room.projectCards ?? {})) {
    const other = room.id === roomId && saved.id === card.id ? card : saved
    for (const r of other.rounds ?? []) {
      const b = r.planNode
      if (!b || round.dispatchId === r.dispatchId || b.supersededBy || r.result || b.lateResult) continue
      if (b.version !== other.plans.at(-1).version && !r.startedAt) continue
      const n = { ...other.plans.find(p => p.version === b.version)?.nodes[b.node - 1], ...r.workspace }
      if (n?.workDir !== node.workDir) continue
      if (n.writePaths?.length === 0 || (!node.writePaths && !n.writePaths)) continue
      if (!n.writePaths || !node.writePaths || pathsOverlap(n.writePaths, node.writePaths))
        throw new Error('Another dispatched node owns overlapping files in this working tree. Wait for its delivery, revise the paths, or use a separate worktree.')
    }
  }
}

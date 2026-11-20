// Values are stored on the group and copied onto each new Git plan.
export const workspacePolicies = {
  auto: 'Main Bot decides',
  current: 'Current branch only',
  worktree: 'Separate worktree only',
}

export const workspacePolicyOf = room => room.projectWorkspacePolicy ?? 'auto'
export const usesGitWorkspace = node => node.workspaceMode === 'current' || node.workspaceMode === 'worktree'

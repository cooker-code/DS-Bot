export const taskManagementEnabled = room => Boolean(room) && room.taskManagementEnabled !== false

export const TASK_STATUS = {
  pending: 'Awaiting intake', clarify: 'Needs clarification', planning: 'Planning', dispatching: 'Dispatching',
  active: 'In progress', review: 'Awaiting review', human_review: 'Human acceptance', blocked: 'Blocked',
  failed: 'Failed', done: 'Done', cancelled: 'Cancelled',
}

export const editableProjectStatuses = Object.keys(TASK_STATUS).filter(status => !['pending', 'human_review'].includes(status))

export const taskErrors = {
  GROUP_CONTEXT_REQUIRED: 'Choose a group or open this action from a group chat.',
  TASK_MANAGEMENT_DISABLED: 'Task management is off. Open group settings to enable it.',
  NOT_GROUP_MEMBER: 'Only current group members can perform this action.',
  GROUP_CONTEXT_MISMATCH: 'This execution belongs to another group. Switch to its group chat.',
  TASK_ROLE_REQUIRED: 'Use the group admin or appointed task assistant session.',
  TASK_ASSISTANT_INVALID: 'The task assistant binding is invalid. Select a member in group settings.',
}

export function taskError(code) {
  return Object.assign(new Error(code + ': ' + taskErrors[code]), { code })
}

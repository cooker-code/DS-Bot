import { createElement as h } from 'react'
import { TASK_STATUS } from './task-board.js'
import { t } from './i18n.js'

export function TaskExecutionStatus({ detail, onAnswer }) {
  const nodes = detail.plans?.at(-1)?.nodes ?? []
  const blocked = nodes.filter(node => ['blocked', 'failed'].includes(node.status)).map(node => ({
    key: node.no, title: node.title, block: detail.rounds?.[node.round - 1]?.planNode?.block,
    contextGap: node.contextGap,
  }))
  return h('div', { className: 'bt-task-execution-status', 'data-status': detail.status, role: 'status' },
    TASK_STATUS[detail.status] && h('strong', null, t(TASK_STATUS[detail.status])),
    detail.clarification && h('button', { type: 'button', className: 'bt-mini', onClick: onAnswer }, t('{count} questions need your answer', { count: detail.questions?.filter(question => !question.answer && !question.withdrawnAt).length || 1 })),
    blocked.map(({ key, title, block, contextGap }) => h('div', { key, className: 'bt-task-blocker' },
      h('strong', null, title),
      (block?.reason || contextGap) && h('p', null, block?.reason || contextGap),
      block?.waitingFor && h('p', null, t('Waiting for'), ': ', block.waitingFor))))
}

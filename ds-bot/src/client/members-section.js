import { createElement as h, useId, useState } from 'react'
import { ChevronDownIcon, ChevronRightIcon } from './icons.js'

export function MembersSection({ title, controls, children }) {
  const [expanded, setExpanded] = useState(true)
  const id = useId()
  return h('div', null,
    h('div', { className: 'bt-members-head' },
      h('button', {
        type: 'button', className: 'bt-section-title bt-members-toggle',
        'aria-expanded': expanded, 'aria-controls': id,
        onClick: () => setExpanded(value => !value),
      }, title, h(expanded ? ChevronDownIcon : ChevronRightIcon)),
      controls),
    h('div', { id, hidden: !expanded, style: expanded ? undefined : { display: 'none' } }, children))
}

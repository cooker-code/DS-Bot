import { createElement as h } from 'react'
import { CheckIcon } from './icons.js'
import { t } from './i18n.js'

const titleOf = (reason) => {
  switch (reason) {
    case 'login': return t('Sign-in needed')
    case 'payment': return t('Payment needed')
    case 'captcha': return t('Verification needed')
    default: return t('Help needed in the browser')
  }
}

// The answered card the transcript keeps: the title and how it ended, read-only.
export function SettledHandoff({ handoff }) {
  const skipped = handoff.outcome === 'skipped'
  const returned = handoff.outcome === 'returned'
  const title = titleOf(handoff.reason)
  return h('div', { className: 'bt-q-inline' },
    h('div', { className: skipped ? 'bt-q bt-q-settled bt-q-dismissed' : 'bt-q bt-q-settled', role: 'group', 'aria-label': title },
      h('div', { className: 'bt-q-head' },
        h('div', { className: 'bt-q-text' }, h('p', { className: 'bt-q-title' }, title)),
        skipped || returned
          ? h('span', { className: 'bt-q-badge' }, t(skipped ? 'Skipped' : 'Returned'))
          : h('span', { className: 'bt-q-check', title: t('Done') }, h(CheckIcon)))))
}

export const HANDOFF_CSS = `
.bt-handoff .bt-q-detail{overflow-wrap:anywhere}
.bt-handoff-state{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:13px;line-height:18px;color:var(--bt-ink-2)}
.bt-handoff-dot{flex:none;width:6px;height:6px;border-radius:50%;corner-shape:round;background:var(--bt-green)}
.bt-handoff.bt-q-raised .bt-q-head{padding-bottom:12px}
.bt-handoff .bt-q-foot{flex-wrap:wrap}
`

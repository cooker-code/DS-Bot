import { createElement as h } from 'react'
import { DEFAULT_TASK_EXPLANATION_PROMPT, TASK_EXPLANATION_PROMPT_LIMIT } from '../shared/task-explanation-prompt.js'
import { MarkdownSetting } from './markdown-field.js'
import { t } from './i18n.js'

export function PromptsPage({ roster, actions, run, Section, Row }) {
  const custom = roster.prefs?.taskExplanationPrompt
  return h(Section, { title: t('Task message explanations') },
    h(Row, { label: t('Model selection'),
      hint: t('Uses the sender Bot’s base model, ignoring group member overrides. If that Bot is missing, uses the recipient or group admin. Standard models may fall back to the host default; local agents stay on their own CLI.') },
      h('span', null, t('Message sender’s Bot model'))),
    h(MarkdownSetting, { key: custom ? 'custom' : 'default', settings: true, title: t('Plain-language prompt'),
      hint: t('Saved changes apply the next time you open Plain language and refresh earlier explanations.'),
      value: custom || DEFAULT_TASK_EXPLANATION_PROMPT, maxLength: TASK_EXPLANATION_PROMPT_LIMIT,
      readOnly: Boolean(roster.readOnly), onSave: value => actions.setPrefs({ taskExplanationPrompt: value || null }),
      headerControl: custom && !roster.readOnly ? h('button', { type: 'button', className: 'bt-mini',
        onClick: () => run(actions.setPrefs({ taskExplanationPrompt: null })) }, t('Restore default')) : null }))
}

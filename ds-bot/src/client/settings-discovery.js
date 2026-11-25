import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import { BotAvatar } from './mark.js'
import { SearchIcon, ChevronRightIcon } from './icons.js'
import { flatWidthOf, layoutOf, thinkingShown, widthOf } from './themes.js'
import { useEscape } from './overlay-hooks.js'
import { t } from './i18n.js'

export const SETTINGS_SEARCH_EVENT = 'ds-bot:settings-search'
const KEYWORDS = {
  overview: 'overview team attention 概览 团队 待处理',
  general: 'appearance theme accent layout width motion font 外观 主题 颜色 布局 宽度 字体 动效',
  models: 'provider model api key 模型 服务商 密钥',
  'local-agents': 'cli codex claude 本地 智能体',
  bots: 'bot instructions role work folder 机器人 简介 角色 工作目录',
  'bot-models': 'batch models 批量 模型',
  prompts: 'prompt task plain language explanation 提示词 任务 人话 解释',
  groups: 'group members project task room 群 成员 项目 任务',
  connectors: 'connector github mcp mail 连接器 邮箱',
  im: 'wechat wecom qq telegram discord slack 即时通信 微信 企微 企业微信 飞书 钉钉',
  capabilities: 'skills pack tools 能力 技能 工具',
  browser: 'browser 浏览器', computer: 'computer permissions 电脑 操控 权限',
  schedules: 'schedule automation recurring 定时 自动化 周期',
  usage: 'usage tokens cost 用量 费用', secrets: 'secret 密钥',
  feedback: 'feedback issue bug diagnostics 反馈 缺陷 诊断 报告', about: 'about version 关于 版本',
}

export function settingsSearchRows(pages, extra, roster) {
  return [
    ...pages.map(([page, label]) => ({ key: `page:${page}`, page, label: t(label), words: KEYWORDS[page] ?? '' })),
    ...extra.map(item => ({ key: `dsh:${item.id}`, page: 'dsh', id: item.id, label: item.label, words: item.id })),
    ...(roster.bots ?? []).map(bot => ({ key: `bot:${bot.id}`, page: 'bots', id: bot.id, label: bot.name, words: `${t('Bots')} ${bot.role ?? ''} Bot 机器人` })),
    ...(roster.rooms ?? []).map(room => ({ key: `room:${room.id}`, page: 'groups', id: room.id, label: room.name, words: `${t('Group chats')} 群 项目` })),
  ]
}

export function filterSettings(rows, query) {
  const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase()
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean)
  return rows.filter(row => {
    const haystack = normalize(`${row.label} ${row.words}`).replace(/\s+/g, '')
    return terms.every(term => haystack.includes(term))
  })
}

export function installSettingsShortcut(target, active, open) {
  const onKey = event => {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey)
      || event.key?.toLowerCase() !== 'k' || !active()) return
    event.preventDefault()
    event.stopPropagation()
    open()
  }
  target.addEventListener('keydown', onKey, { capture: true })
  return () => target.removeEventListener('keydown', onKey, { capture: true })
}

export function SettingsSearch({ rows, onPick, close }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef(null)
  const listId = useId()
  const matches = filterSettings(rows, query)
  const selected = matches.length ? Math.min(active, matches.length - 1) : -1
  useEscape(close)
  useEffect(() => {
    const previous = document.activeElement
    input.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  const keys = event => {
    if (event.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (matches.length) setActive((selected + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length)
    } else if (event.key === 'Enter' && selected >= 0) {
      event.preventDefault()
      onPick(matches[selected])
    }
  }
  return h('section', { className: 'bt-settings-find', 'aria-label': t('Search settings') },
    h('div', { className: 'bt-set-row' }, h(SearchIcon),
      h('input', { ref: input, className: 'bt-input', role: 'combobox', 'aria-label': t('Search settings'),
        'aria-controls': listId, 'aria-expanded': true, 'aria-autocomplete': 'list',
        'aria-activedescendant': selected < 0 ? undefined : `${listId}-${selected}`, value: query,
        onChange: event => { setQuery(event.target.value); setActive(0) }, onKeyDown: keys }),
      h('button', { type: 'button', className: 'bt-mini', onClick: close }, t('Close'))),
    h('div', { id: listId, role: 'listbox', 'aria-label': t('Settings results'), className: 'bt-settings-find-list' },
      matches.map((item, at) => h('button', { id: `${listId}-${at}`, key: item.key, type: 'button', role: 'option',
        'aria-selected': at === selected, className: 'bt-set-row bt-bs-row', onClick: () => onPick(item) },
      h('span', { className: 'bt-set-copy' }, item.label), h(ChevronRightIcon))),
      matches.length ? null : h('p', { className: 'bt-set-hint', role: 'status' }, t('No matching settings'))))
}

export function SettingsOverview({ roster, actions, pages, Section, Row }) {
  const bots = roster.bots ?? []
  const rooms = roster.rooms ?? []
  const pending = Object.keys(roster.questions ?? {}).length + Object.keys(roster.views ?? {}).length
  return [
    h(Section, { key: 'attention', title: t('Needs your attention') },
      h(Row, { label: t('Pending questions and views'), hint: String(pending) },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openSettings('bots') }, t('Bots')))),
    h(Section, { key: 'team', title: t('Team') },
      bots.length ? bots.map(bot => h('button', { key: bot.id, type: 'button', className: 'bt-set-row bt-bs-row', onClick: () => actions.openSettings('bots', bot.id) },
        h(BotAvatar, { bot, size: 28, badge: true, live: false }), h('span', { className: 'bt-set-copy' }, bot.name,
          h('span', { className: 'bt-set-hint' }, bot.role)), h(ChevronRightIcon)))
        : h(Row, { label: t('Create your first Bot') }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openSettings('bots') }, t('Bots'))),
      rooms.map(room => h('button', { key: room.id, type: 'button', className: 'bt-set-row bt-bs-row', onClick: () => actions.openSettings('groups', room.id) },
        h('span', { className: 'bt-set-copy' }, room.name, h('span', { className: 'bt-set-hint' }, t('Group chats'))), h(ChevronRightIcon)))),
    h(Section, { key: 'settings', title: t('Settings') }, pages.filter(([key]) => ['general', 'models', 'prompts', 'schedules', 'usage', 'feedback'].includes(key))
      .map(([page, label]) => h('button', { key: page, type: 'button', className: 'bt-set-row bt-bs-row', onClick: () => actions.openSettings(page) },
        h('span', { className: 'bt-set-copy' }, t(label)), h(ChevronRightIcon)))),
  ]
}

export function AppearancePreview({ roster }) {
  const prefs = roster.prefs ?? {}
  const flat = layoutOf(prefs) === 'flat'
  return h('section', { className: 'bt-set-section', 'aria-label': t('Appearance preview') },
    h('h3', null, t('Preview')),
    h('div', { className: 'bt-look', 'aria-hidden': true, 'data-flat': flat || undefined },
      h('div', { className: 'bt-look-side' }, (roster.bots ?? []).slice(0, 3).map(bot => h('span', { key: bot.id, className: 'bt-look-row' },
        h(BotAvatar, { bot, size: 22, badge: false, live: false }), h('span', { className: 'bt-look-name' }, bot.name)))),
      h('div', { className: 'bt-look-chat' },
        h('div', { className: 'bt-look-user', style: { maxWidth: `${widthOf(prefs)}%` } }, t('Summarize the next steps.')),
        thinkingShown(prefs) ? h('div', { className: 'bt-look-think' }, t('Thought for a moment')) : null,
        h('div', { className: 'bt-look-bot', style: { maxWidth: `${flat ? flatWidthOf(prefs) : widthOf(prefs)}%` } }, t('Review the result, run the checks, and share the evidence.')))))
}

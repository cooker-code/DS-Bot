import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import { BotAvatar } from './mark.js'
import { SearchIcon, ChevronRightIcon } from './icons.js'
import { flatWidthOf, layoutOf, thinkingShown, widthOf } from './themes.js'
import { useEscape } from './overlay-hooks.js'
import { t } from './i18n.js'
import { OverviewStatus } from './settings-overview.js'
import { isLocalRoute } from './agent-routes.js'

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

export const SETTINGS_FIELDS = [
  ['default-model', 'Default model', 'general', '默认 新建 模型'],
  ['enter-send', 'Enter sends message', 'general', '回车 发送 输入'],
  ['theme', 'Theme', 'general', '主题 深色 浅色'],
  ['accent', 'Accent', 'general', '强调色 自定义 颜色'],
  ['layout', 'Message layout', 'general', '气泡 平铺 布局 正文 宽度'],
  ['width', 'Bubble width', 'general', '气泡 宽度'],
  ['flat-width', 'Text width', 'general', '正文 宽度 平铺'],
  ['effects', 'Interface motion', 'general', '界面 动效'],
  ['thinking', 'Show thinking', 'general', '思考 过程'],
  ['memory', 'Memory', 'general', '记忆 额度 自动召回'],
  ['locations', 'Locations', 'general', '总工作区 数据 位置 目录'],
]

export function focusSettingsTarget(root, page, id) {
  if (!root) return false
  const field = typeof id === 'string' && id.startsWith('setting:') ? id.slice(8) : null
  const candidates = root.querySelectorAll(field ? '[data-setting]' : '[data-settings-page]')
  const target = (!field && root.getAttribute?.('data-settings-page') === page ? root : null) ?? [...candidates].find(node => node.getAttribute(field ? 'data-setting' : 'data-settings-page') === (field ?? page))
  if (!target) return false
  target.scrollIntoView?.({ block: 'start' })
  if (field) (target.querySelector('input,select,button,textarea') ?? target).focus?.({ preventScroll: true })
  return true
}

export function settingsSearchRows(pages, extra, roster) {
  return [
    ...pages.map(([page, label]) => ({ key: `page:${page}`, page, label: t(label), words: KEYWORDS[page] ?? '' })),
    ...SETTINGS_FIELDS.filter(([id, , page]) => (id !== 'flat-width' || roster.prefs?.layout === 'flat') && pages.some(([key]) => key === page)).map(([id, label, page, words]) => ({ key: `field:${id}`, page, id: `setting:${id}`, label: t(label), words })),
    ...(pages.some(([key]) => key === 'models') ? (roster.models ?? []).filter(model => !isLocalRoute(model.ref)).flatMap(model => [
      { key: `model:${model.ref}`, page: 'models', id: `provider:${model.provider ?? model.ref.split('/')[0]}`, label: model.name ?? model.ref, words: `${model.ref} ${model.providerName ?? ''} Models 模型` },
      ...(model.needsKey !== true && pages.some(([key]) => key === 'bot-models') && (roster.bots ?? []).some(bot => !isLocalRoute(bot.model ?? bot.appliedModel) && (bot.model ?? bot.appliedModel) !== model.ref) ? [{ key: `switch:${model.ref}`, page: 'bot-models', id: model.ref, label: t('Switch Bots to {model}…', { model: model.name ?? model.ref }), words: `${model.ref} batch 批量 切换 模型` }] : []),
    ]) : []),
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
  }).sort((a, b) => {
    const score = row => {
      if (!terms.length) return 0
      const label = normalize(row.label).replace(/\s+/g, ''), words = normalize(row.words).replace(/\s+/g, ''), joined = terms.join('')
      return label === joined ? 4 : terms.every(term => label.includes(term)) ? 3 : words.startsWith(joined) ? 2 : words.includes(joined) ? 1 : 0
    }
    return score(b) - score(a)
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
  const list = useRef(null)
  const picked = useRef(false)
  const listId = useId()
  const matches = filterSettings(rows, query)
  const selected = matches.length ? Math.min(active, matches.length - 1) : -1
  useEscape(close)
  useEffect(() => { list.current?.querySelector('[aria-selected=true]')?.scrollIntoView?.({ block: 'nearest' }) }, [selected, query])
  useEffect(() => {
    const previous = document.activeElement
    input.current?.focus()
    return () => { if (!picked.current && previous?.isConnected) previous.focus() }
  }, [])
  const keys = event => {
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (matches.length) setActive((selected + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length)
    } else if (event.key === 'Enter' && selected >= 0) {
      event.preventDefault()
      picked.current = true
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
    h('div', { ref: list, id: listId, role: 'listbox', 'aria-label': t('Settings results'), className: 'bt-settings-find-list' },
      matches.map((item, at) => h('button', { id: `${listId}-${at}`, key: item.key, type: 'button', role: 'option',
        'aria-selected': at === selected, className: 'bt-set-row bt-bs-row', onClick: () => { picked.current = true;onPick(item) } },
      h('span', { className: 'bt-set-copy' }, item.label), h(ChevronRightIcon))),
      matches.length ? null : h('p', { className: 'bt-set-hint', role: 'status' }, t('No matching settings'))))
}

export function SettingsOverview({ roster, actions, run, pages, Section, Row }) {
  const bots = roster.bots ?? []
  const rooms = roster.rooms ?? []
  const pending = Object.keys(roster.questions ?? {}).length + Object.keys(roster.views ?? {}).length
  return [
    h(OverviewStatus, { key: 'full-status', roster, actions, run, Section, Row }),
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

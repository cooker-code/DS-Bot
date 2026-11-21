import { createElement as h, Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { isMainOf } from './sources.js'
import { HEADER, currentPart, runStatsOf, stripHeader, usageOf } from './text.js'
import { AlertIcon, PlusIcon, PlugIcon, ShareIcon, CloseIcon, ChevronLeftIcon, GearIcon } from './icons.js'
import { botState, BotMark, BotAvatar } from './mark.js'
import { GlobeIcon, Favicon, PanelMenu, menuItemFor } from './browser-pane.js'
import { useEscape } from './overlay-hooks.js'
import { MemberContext, useGroupContext } from './group-context.js'
import { BotSettingsForm, InlineText } from './bot-settings.js'
import { GroupSettingsForm, GroupTodos, ROOM_MODES, roomSubtitle, shownMode } from './group-settings.js'
import { ModelMenu, modelOf } from './model-menu.js'
import { FolderMenu } from './folder-menu.js'
import { MemoryRow } from './memory-panel.js'
import { ScheduleSummary } from './schedules.js'
import { useGlide } from './motion.js'
import { MemberApprovals, MemberState, StopMemberWork, StopRoomWork, useMemberWork, workState } from './member-status.js'
import { canSetGoal, goalView, hasGoalAdmin } from './goal.js'
import { PermissionPicker, presetDanger, presetName } from './permission-picker.js'
import { MemberHistory } from './member-history.js'
import { MembersSection } from './members-section.js'
import { ProjectTaskDetail } from './project-task-detail.js'
import { TaskBoard } from './task-board.js'
import { BotConnectors } from './connectors.js'
import { ComputerView } from './computer.js'
import { MarkdownSetting } from './markdown-field.js'
import { dateLocale, t } from './i18n.js'

function transcriptOf(list, id, name, hiddenTurns = []) {
  const outline = list.projectionsBySession?.[id]?.values?.turnOutline ?? list.byId[id]?.projectionValues?.turnOutline
  if (!Array.isArray(outline)) return ''
  const lines = []
  for (const entry of outline) {
    if (hiddenTurns.includes(entry.turn)) continue
    if (entry.prompt && !HEADER.test(entry.prompt)) lines.push(`**${t('You')}:** ${entry.prompt.trim()}`)
    if (entry.response) lines.push(`**${name}:** ${stripHeader(entry.response).trim()}`)
  }
  return lines.join('\n\n')
}

const TAB_LABELS = { details: 'Details', browser: 'Browser', computer: 'Computer' }

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' } }
const shortUrl = url => String(url ?? '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '')
const emptyGuide = []
const noGuide = { getSnapshot: () => emptyGuide, subscribe: () => () => {} }
const EMPTY_TABS = { ids: [], active: null }

// The Bot's permission preset, from the presets DeepSeek Harness offers.
function PermissionRow({ bot, roster, actions, run }) {
  const catalog = roster.permissions
  if (!catalog?.options?.length) return null
  return h('div', { className: 'bt-drawer-permission' },
    h('div', { className: 'bt-section-title' }, t('Permissions')),
    // A Bot without its own preset may run on another one set in DSH, so its first pick always applies.
    h(PermissionPicker, { catalog, saved: bot.permission ?? catalog.defaultPreset, repick: bot.permission === undefined, onPick: permission => run(actions.updateBot(bot.id, { permission })) }))
}

// The current part's turns, speed, cache hits and context, refreshed when a turn starts or ends.
export function RunStats({ bot, part, running, actions }) {
  const scope = `${bot.id}:${part ?? ''}`
  const [read, setRead] = useState(null)
  useEffect(() => {
    if (!actions.runStats) return undefined
    let current = true
    actions.runStats(bot.id).then(
      (values) => { if (current) setRead({ scope, values }) },
      // The line stays as it was until the next read works.
      () => {},
    )
    return () => { current = false }
  }, [scope, bot.id, running, actions])
  const shown = runStatsOf(read?.scope === scope ? read.values : null)
  if (shown.length === 0) return null
  return h('div', { className: 'bt-run-stats' },
    shown.map((entry, index) => h(Fragment, { key: entry.key },
      index > 0 ? h('span', { className: 'bt-run-sep', 'aria-hidden': true }, '·') : null,
      h('span', { title: entry.title }, entry.text))))
}

// The Bot's browser inside the details page: its tabs as small window cards in the
// DSH Desktop, a pointer there on web.
function BrowserCards({ bot, sessionId, roster, actions, useBrowserTabs, useBrowserPages }) {
  const state = useBrowserTabs(map => map[bot.id] ?? EMPTY_TABS)
  const pages = useBrowserPages(map => map)
  useEffect(() => { actions.browserEnsure?.(bot.id) }, [bot.id])
  if (roster.browser !== true || !actions.browserShow) {
    return h('div', { className: 'bt-muted' }, t('The browser is in DSH Desktop.'))
  }
  if (state.ids.length === 0) {
    return h('div', { className: 'bt-browser-empty-mark' },
      h(BotMark, { bot, size: 40, state: 'idle', live: true }),
      h('div', { className: 'bt-browser-empty-title' }, t("{name}'s browser", { name: bot.name })),
      h('div', { className: 'bt-muted' }, t('Open a page here and {name} can read it with you. Logins and cookies stay with {name}; other Bots never see them.', { name: bot.name })),
      h('button', { type: 'button', className: 'bt-browser-retry', onClick: () => actions.openBrowser(sessionId) }, t('Open browser')))
  }
  return h('div', { className: 'bt-bcards' },
    state.ids.map((tabId, index) => {
      const page = pages[tabId] ?? {}
      const label = page.title || shortUrl(page.url) || t('New tab')
      return h('div', { key: tabId, className: 'bt-bcard', 'data-active': state.active === tabId || undefined, style: { animationDelay: `${index * 30}ms` } },
        h('button', { type: 'button', className: 'bt-bcard-shot', 'aria-label': t('Open {title}', { title: label }), title: page.url, onClick: () => actions.browserPick(sessionId, tabId) },
          page.excerpt
            ? h('span', { className: 'bt-bcard-preview' },
                h('span', { className: 'bt-bcard-ptitle' }, label),
                h('span', { className: 'bt-bcard-excerpt' }, page.excerpt))
            : h('span', { className: 'bt-bcard-blank' }, h(GlobeIcon), h('span', null, label))),
        h('button', {
          type: 'button', className: 'bt-bcard-x', 'aria-label': t('Close tab'), title: t('Close tab'),
          onClick: () => { void actions.browserCloseTab(bot.id, tabId) },
        }, '×'),
        h('div', { className: 'bt-bcard-row' },
          h(Favicon, { src: page.favicon, className: 'bt-bcard-fav' }),
          h('span', { className: 'bt-bcard-title' }, label),
          page.url ? h('span', { className: 'bt-bcard-host' }, hostOf(page.url)) : null))
    }),
    h('button', { type: 'button', className: 'bt-bcard-new', style: { animationDelay: `${state.ids.length * 30}ms` }, onClick: () => actions.browserNewTab(sessionId) }, h(PlusIcon), t('New tab')))
}

// A saved value shows as soon as it is typed and until the host has answered, so the
// old text does not flash back between the blur and the roster update. `save` returns
// the promise of the save.
function useSaved(value, save) {
  const [pending, setPending] = useState(null)
  const commit = (next) => {
    setPending({ next })
    return Promise.resolve(save(next)).then(
      (ok) => { setPending(null); return ok },
      () => { setPending(null); return false },
    )
  }
  return [pending ? pending.next : value, commit]
}

// The Bot's label under its name, a field that reads as plain text until it is hovered.
function BotLabel({ bot, actions, run }) {
  const [role, save] = useSaved(bot.role ?? '', next => run(actions.updateBot(bot.id, { role: next })))
  return h(InlineText, { label: t('Label'), value: role, placeholder: t('Add a label'), maxLength: 24, className: 'bt-drawer-role-input', onSave: save })
}

// A group's face in its details: its first members side by side, each on a disc that
// cuts into the one before, and how many more there are.
const PILE_MAX = 4
function MemberPile({ room, roster }) {
  const members = room.members.map(id => roster.byId[id]).filter(Boolean)
  const shown = members.length > PILE_MAX ? members.slice(0, PILE_MAX - 1) : members
  const more = members.length - shown.length
  return h('span', { className: 'bt-pile', 'aria-hidden': true },
    shown.map((bot, index) => h('span', { key: bot.id, className: 'bt-pile-face', style: { animationDelay: `${index * 40}ms` } }, h(BotMark, { bot, size: 44, live: true }))),
    more > 0 ? h('span', { key: 'more', className: 'bt-pile-face bt-pile-more', style: { animationDelay: `${shown.length * 40}ms` } }, `+${more}`) : null)
}

const markOf = entry => (entry?.state === 'ask' ? 'alert' : entry?.state === 'work' ? workState(entry.doing) : 'idle')

// One member: its mark, name and what it is doing on one surface that opens its chat;
// Stop beside it while it works here, and the approvals it waits on below.
function MemberRow({ member, entry, room, roster, actions, stats }) {
  return h('div', { role: 'listitem', className: 'bt-member' },
    h('div', { className: 'bt-member-row' },
      h('button', { type: 'button', className: 'bt-member-open', title: t("Open {name}'s chat", { name: member.name }), onClick: () => actions.openSession(member.id) },
        h(BotMark, { bot: member, size: 32, state: markOf(entry) }),
        h('span', { className: 'bt-member-text' },
          h('span', { className: 'bt-member-line' },
            h('span', { className: 'bt-member-name' }, member.name),
            room.admin === member.id ? h('span', { className: 'bt-tag' }, t('Admin')) : null),
          h(MemberState, { entry, bot: member, room, roster }), h(MemberContext, { room, member, stats }))),
      h(StopMemberWork, { entry, bot: member, room, actions })),
    h(MemberApprovals, { entry, bot: member, actions }))
}

// A group's overview: what members read, who is in it, who answers, and what it
// remembers. Changes are made in its settings.
function GroupOverview({ room, roster, actions, run, usage, useWork, openTask, returnId, taskFilter: [statuses, onStatusesChange] }) {
  const members = room.members.map(id => roster.byId[id]).filter(Boolean)
  const stats = useGroupContext(room, actions)
  const { entries } = useMemberWork(room, useWork)
  return [
    h(MarkdownSetting, { key: 'notice:' + room.id, title: t('Notice'), value: room.notice, label: t('Group notice'),
      maxLength: 2000, placeholder: t('Group goals, notices and background…'), readOnly: roster.readOnly,
      onSave: notice => run(actions.updateRoom(room.id, { notice })) }),
    h(GroupTodos, { key: 'todos', room, actions }),
    h(MembersSection, { key: 'members:' + room.id,
      title: t('Members · {count}', { count: members.length }),
      controls: h(StopRoomWork, { room, entries, actions }) },
      h('div', { className: 'bt-members', role: 'list' }, members.map(member => h(MemberRow, {
        key: member.id, member, stats: stats[member.id], entry: entries.find(item => item.id === member.id), room, roster, actions,
      })))),
    h('div', { key: 'tasks' }, h(TaskBoard, { key: room.id, room, roster, actions, onOpen: openTask, returnId, statuses, onStatusesChange })),
    h('div', { key: 'goal' }, h('div', { className: 'bt-section-title' }, t('Goal')),
      h('div', { className: 'bt-kv' },
        room.goal
          ? [h('span', { key: 't' }, room.goal.title, ' ', h('span', { className: 'bt-note' }, goalView(room.goal, { roster })?.barLabel ?? '')),
            h('button', {
              key: 's', type: 'button', className: 'bt-soft bt-soft-sm',
              onClick: () => {
                actions.toggleGoal(room.id)
                // On a narrow layout the panel is a drawer over the header: leave it.
                if (typeof document !== 'undefined' && document.querySelector('[data-rightbar-fullscreen]')) actions.closeOverlay()
              },
            }, t('Show'))]
          : h('button', {
            type: 'button', className: 'bt-soft bt-soft-sm', disabled: !canSetGoal(room, roster),
            title: hasGoalAdmin(room, roster) ? undefined : t('This group has no admin'),
            onClick: () => actions.composeGoal(room.id),
          }, t('Set a goal')))),
    h('div', { key: 'mode' }, h('div', { className: 'bt-section-title' }, t('Who answers')),
      h('div', { className: 'bt-kv' }, h('span', null, t(ROOM_MODES.find(([id]) => id === shownMode(room, roster))?.[1] ?? 'Everyone')))),
    room.permission ? h('div', { key: 'permission' }, h('div', { className: 'bt-section-title' }, t('Permissions')),
      h('div', { className: 'bt-kv' }, h('span', { className: presetDanger(room.permission) ? 'bt-perm-danger' : undefined }, presetName(room.permission, roster.permissions)))) : null,
    roster.memory === false ? null : h(MemoryRow, { key: 'memory', owner: { id: room.id, name: room.name, group: true }, actions }),
    usage ? h('div', { key: 'usage' }, h('div', { className: 'bt-section-title' }, t('Usage')),
      h('div', { className: 'bt-kv' }, h('span', null, room.name), h('span', null, usage))) : null,
  ]
}

// DSH list rows carry the last activity time. Archived rows can be absent from
// the shell list, so use the part's saved time until the row is available.
function BotSessions({ bot, part, rooms = [], openMember, run, useSessions, useSessionStatus, actions, running, readOnly }) {
  const [selection, setSelection] = useState(null)
  const [confirmation, setConfirmation] = useState(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const editButton = useRef(null), deleteButton = useRef(null)
  const open = bot.openParts ?? []
  const earlier = [...(bot.parts ?? []), ...open.flatMap(thread => thread.parts ?? [])]
  const groups = rooms.filter(room => room.memberSessions?.[bot.id]?.length)
  const entries = [
    { id: part, current: true, startedAt: bot.sessionStartedAt ?? (part === bot.id ? bot.createdAt : undefined), at: bot.lastAt || bot.sessionStartedAt || bot.createdAt },
    ...open.map(thread => ({ id: thread.sessionId, open: true, startedAt: thread.startedAt, at: thread.startedAt })),
    ...earlier.filter(id => id !== part).reverse().map(id => ({ id, at: bot.partTimes?.[id] })),
    ...groups.flatMap(room => room.memberSessions[bot.id].map(entry => ({ ...entry, roomId: room.id, roomName: room.name }))),
  ]
  const ids = JSON.stringify(entries.map(entry => entry.id))
  const activeIds = useSessionStatus(map => JSON.stringify(entries.filter(({ id }) => map.get(id)?.running ?? running?.[id]).map(({ id }) => id)))
  const activeSessions = new Set(JSON.parse(activeIds))
  const [times, setTimes] = useState({})
  useEffect(() => {
    if (!actions.sessionTimes) return
    let current = true
    actions.sessionTimes(bot.id, JSON.parse(ids)).then(value => { if (current) setTimes(value) }, () => {})
    return () => { current = false }
  }, [actions, bot.id, ids, activeIds])
  const rows = useSessions(list => entries.map(entry => list.byId?.[entry.id]), rowsEqual)
  const sessions = entries.map((entry, index) => {
    const row = rows[index]
    const created = times[entry.id]?.createdAt ?? row?.createdAt ?? entry.startedAt
    const active = row?.updatedAt ?? times[entry.id]?.updatedAt ?? (entry.id === part ? bot.lastAt : undefined)
    return { ...entry, created, active, sortTime: active ?? entry.at ?? created ?? 0, running: activeSessions.has(entry.id) }
  })
  const privateParts = sessions.filter(entry => !entry.roomId)
    .sort((a, b) => (a.created ?? a.at ?? 0) - (b.created ?? b.at ?? 0))
  const privateNumbers = new Map(privateParts.map((entry, index) => [entry.id, index + 1]))
  const ordered = sessions.sort((a, b) => b.sortTime - a.sortTime)
  const format = at => at ? new Date(at).toLocaleString(dateLocale(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
  const timing = entry => h('span', { className: 'bt-session-times' },
    h('span', null, t('Created {time}', { time: format(entry.created) })),
    h('span', null, t('Last active {time}', { time: format(entry.active) })))
  const state = entry => h('span', { key: 'meta', className: 'bt-agent-session-meta' },
    entry.current && h('span', null, t('Current')),
    entry.running && h('span', { className: 'bt-agent-session-run', role: 'status' }, t('Running')))
  const selected = privateParts.filter(entry => !entry.running && selection?.includes(entry.id)).map(entry => entry.id)
  const editing = selection !== null
  const act = async (operation) => {
    if (pending.current) return false
    pending.current = true
    setBusy(true)
    try { return await run(operation()) } finally { pending.current = false; setBusy(false) }
  }
  const remove = async () => {
    if (!confirmation || pending.current) return
    const ok = await act(() => actions.deleteParts(bot.id, confirmation))
    setConfirmation(null)
    if (ok) setSelection(null)
    requestAnimationFrame(() => (ok ? editButton : deleteButton).current?.focus())
  }
  const cancel = () => { setConfirmation(null); requestAnimationFrame(() => deleteButton.current?.focus()) }
  const prompt = confirmation && t('Delete the selected sessions ({count})? DSH will archive their history and stop their scheduled tasks.', { count: confirmation.length })
  return h('div', { className: 'bt-drawer-model' },
    h('div', { className: 'bt-agent-sessions-head' },
      h('div', { className: 'bt-section-title' }, t('Sessions')),
      !readOnly && h('div', { className: 'bt-task-toolbar' },
        editing ? h('button', { type: 'button', ref: deleteButton, className: 'bt-mini bt-task-delete',
          disabled: !selected.length || !!confirmation || busy, onClick: () => setConfirmation(selected) }, t('Delete ({count})', { count: selected.length })) : null,
        h('button', { type: 'button', ref: editButton, className: 'bt-mini', disabled: !!confirmation || busy,
          onClick: () => setSelection(editing ? null : []) }, t(editing ? 'Cancel' : 'Edit')),
        !editing && h('button', { type: 'button', className: 'bt-agent-sessions-new', disabled: busy || undefined,
          onClick: () => act(() => actions.newPart(bot.id)) }, h(PlusIcon), t('New session')))),
    confirmation && h('div', { className: 'bt-task-confirm', role: 'alertdialog', 'aria-label': prompt,
      onKeyDown: e => { if (e.key === 'Escape') { e.stopPropagation(); if (!busy) cancel() } } },
      h('p', null, prompt),
      h('div', { className: 'bt-task-toolbar' },
        h('button', { type: 'button', className: 'bt-mini', autoFocus: true, disabled: busy, onClick: cancel }, t('Cancel')),
        h('button', { type: 'button', className: 'bt-mini bt-task-delete', disabled: busy, onClick: remove }, t('Confirm')))),
    ordered.some(entry => entry.open && entry.running)
      ? h('div', { className: 'bt-agent-sessions-warn', role: 'status' }, h(AlertIcon),
        h('span', null, t('A running session keeps using model calls in the background.'))) : null,
    h('div', { className: 'bt-agent-sessions' }, ordered.map(entry => {
      const label = `${entry.roomName ?? bot.name}-${entry.number ?? privateNumbers.get(entry.id)}`
      const title = entry.current ? t('Current session') : entry.running ? t('Open this running session') : entry.open ? t('Open this session') : t('Open this earlier session')
      const row = [
        h('span', { key: 'name', className: 'bt-agent-session-name' }, label, timing(entry)),
        state(entry),
      ]
      const className = `bt-agent-session${entry.current ? ' is-current' : ''}${entry.running ? ' is-running' : ''}`
      if (entry.roomId) return h('button', { type: 'button', key: entry.id, className: 'bt-agent-session',
        disabled: editing || busy, onClick: () => openMember(entry, label) }, row)
      if (editing) return h('label', { key: entry.id, className },
        h('input', { type: 'checkbox', checked: selected.includes(entry.id), disabled: entry.running || !!confirmation || busy,
          'aria-label': t('Select {name}', { name: label }), onChange: e => {
            const checked = e.target.checked
            setSelection(prev => checked ? [...prev, entry.id] : prev.filter(id => id !== entry.id))
          } }), row)
      return h('button', { key: entry.id, type: 'button', className, title, disabled: entry.current || busy || readOnly,
        onClick: () => act(() => actions.openPart(bot.id, entry.id, entry.running)) }, row)
    })))
}
const rowsEqual = (a, b) => a.length === b.length && a.every((row, index) => row?.updatedAt === b[index]?.updatedAt && row?.createdAt === b[index]?.createdAt)

export function DetailsDrawer({ sessionId, startRenaming, startTab, hasStrip, roster, actions, useSessions, useSessionStatus, useActivity, useWork, useBrowserTabs, useBrowserPages, useComputer }) {
  const owner = roster.byId[sessionId]
  const part = owner ? currentPart(owner) : sessionId
  const isMainBot = isMainOf(roster, owner?.id)
  const [tab, setTab] = useState('details')
  const room = roster.roomsById[sessionId]
  const guide = (room || owner) && actions.sidebarGuide ? actions.sidebarGuide : noGuide
  const entries = useSyncExternalStore(guide.subscribe, guide.getSnapshot)
  // The info pane swaps its overview for the Bot or group settings view in place.
  const [view, setView] = useState(room && startTab?.startsWith('task/') ? { taskId: startTab.slice(5) } : startTab === 'settings' && (owner || room) ? 'settings' : 'overview')
  const [editing, setEditing] = useState(Boolean(startRenaming && (roster.byId[sessionId] || roster.roomsById[sessionId])))
  const [draftName, setDraftName] = useState(roster.byId[sessionId]?.name ?? (roster.roomsById[sessionId]?.named ? roster.roomsById[sessionId].name : ''))
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const returnTask = useRef(null)
  const taskFilter = useState(null)
  const glide = useGlide(tab)
  // The settings view comes in from the right and the overview back from the left; a
  // new tab clears from a blur. The first view arrives with the panel.
  const last = useRef({ view, tab, move: undefined })
  if (last.current.view !== view) last.current = { view, tab, move: view === 'overview' ? 'out' : 'in' }
  else if (last.current.tab !== tab) last.current = { view, tab, move: 'tab' }
  const move = last.current.move
  const side = move === 'tab' ? undefined : move
  const close = () => actions.closeOverlay()
  useEscape(view?.taskId || view?.member ? () => setView('overview') : close)
  const bot = owner
  const running = useSessionStatus(map => map.get(part)?.running === true)
  const doing = useActivity(map => map[bot?.id ?? sessionId])
  const transcript = useSessions(list => transcriptOf(list, part, bot?.name ?? room?.name ?? t('Bot'), roster.exchangeTurns[part]))
  const usage = useSessions(list => usageOf(list, [part, ...(bot?.parts ?? room?.parts ?? [])]))
  const run = promise => Promise.resolve(promise)
    .then(() => { setError(''); return true })
    .catch(failure => { setError(failure?.message ?? String(failure)); return false })
  const share = () => {
    void navigator.clipboard?.writeText(transcript).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }
  const errorLine = error ? h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, error) : null
  if (bot && view?.member) {
    return h(MemberHistory, { key: view.member.id, member: view.member, label: view.label, bot, actions, hasStrip,
      back: () => setView('overview'), close })
  }
  if (room && view?.taskId) {
    const card = room.projectCards?.find(item => item.taskId === view.taskId)
    return h(ProjectTaskDetail, { key: room.id + '/' + view.taskId, room, card, roster, readOnly: !!roster.readOnly, move, hasStrip, onBack: () => setView('overview'), close })
  }
  if ((bot || room) && view === 'settings') {
    return [
      h('div', { key: 'head', className: 'bt-subhead', 'data-move': move },
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back to details'), onClick: () => setView('overview') }, h(ChevronLeftIcon)),
        h('span', { className: 'bt-subhead-title' }, bot ? t('Settings') : t('Group settings')),
        hasStrip ? null : h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close details'), onClick: close }, h(CloseIcon))),
      h('div', { key: 'set-body', className: 'bt-drawer-body bt-set-body', 'data-move': move }, errorLine,
        bot ? h(BotSettingsForm, { bot, roster, actions, run }) : h(GroupSettingsForm, { room, roster, actions, run, onDeleted: close })),
    ]
  }
  const more = []
  if (bot) {
    if (roster.browser === true && actions.openBrowser) {
      more.push({ ...menuItemFor('browser', actions, sessionId), label: t('Bot browser') })
    }
    more.push({ ...menuItemFor('side', actions, sessionId), label: t('Bot side chat') })
    if (entries.length) more.push({ sep: true })
  }
  for (const entry of entries) {
    more.push({
      key: JSON.stringify([entry.providerId ?? entry.kind, entry.id]),
      icon: entry.icon ?? PlugIcon,
      label: entry.title(),
      onPick: () => actions.openConversationTab(entry.kind, room?.id ?? sessionId),
    })
  }
  const top = h('div', { className: 'bt-drawer-top', 'data-move': side },
    bot || room ? h('button', { type: 'button', className: 'bt-round', 'aria-label': bot ? t('Edit Bot') : t('Group settings'), title: bot ? t('Edit Bot') : t('Group settings'), 'data-info-row': 'settings', onClick: () => setView('settings') }, h(GearIcon)) : null,
    more.length > 0 ? h('span', { 'data-info-row': 'more' }, h(PanelMenu, { items: more, className: 'bt-round', 'aria-label': t('More') })) : null,
    bot || room ? h('button', { type: 'button', className: 'bt-round', 'aria-label': copied ? t('Copied conversation') : t('Share conversation'), title: copied ? t('Copied') : t('Copy conversation as Markdown'), onClick: share }, copied ? h('span', { key: 'copied', className: 'bt-pop-in' }, '✓') : h(ShareIcon)) : null,
    hasStrip ? null : h('button', { type: 'button', className: 'bt-round', 'aria-label': t('Close details'), onClick: close }, h(CloseIcon)))
  if (!bot && !room) {
    return [h(Fragment, { key: 'top' }, top),
      h('div', { key: 'body', className: 'bt-drawer-body' }, h('div', { className: 'bt-muted' }, t('This conversation is not part of your Bot team.')))]
  }
  const current = bot?.name ?? room.name
  const saveName = async () => {
    setEditing(false)
    const next = draftName.trim()
    if (next === current || (room && !room.named && next === '')) return
    if (bot && next) await run(actions.updateBot(bot.id, { name: next }))
    // An empty group name goes back to naming the group after its members.
    if (room) await run(actions.updateRoom(room.id, { name: next }))
  }
  const subtitle = bot ? undefined : roomSubtitle(room, roster)
  // Tab sets: a 1:1 Bot has Details and Browser; a group has only Details, so no tab row.
  const tabs = bot ? (roster.computer?.enabled === true ? ['details', 'browser', 'computer'] : ['details', 'browser']) : ['details']
  return [h(Fragment, { key: 'top' }, top),
    h('div', { key: 'id', className: 'bt-drawer-id', 'data-move': side },
      bot ? h(BotAvatar, { bot, size: 64, state: botState(running, doing, roster.questions?.[part] !== undefined), main: isMainBot, badge: false, gaze: true, pokeable: true })
        : h(MemberPile, { room, roster }),
      editing
        ? h('input', {
            className: 'bt-drawer-name-input', autoFocus: true, value: draftName, 'aria-label': bot ? t('Bot name') : t('Group name'),
            placeholder: room ? t('Name after members') : undefined,
            onChange: event => setDraftName(event.target.value), onBlur: saveName,
            onKeyDown: (event) => { if (event.key === 'Enter') void saveName(); if (event.key === 'Escape') { event.stopPropagation(); setEditing(false) } },
          })
        : h('button', { type: 'button', className: 'bt-drawer-name', 'aria-label': t('Rename {name}', { name: current }), title: t('Rename'), onClick: () => { setDraftName(room && !room.named ? '' : current); setEditing(true) } }, current),
      bot
        ? (roster.readOnly
            ? (bot.role ? h('span', { className: 'bt-drawer-role' }, bot.role) : null)
            : h(BotLabel, { key: `role:${bot.id}`, bot, actions, run }))
        : subtitle ? h('span', { className: 'bt-drawer-role' }, subtitle) : null),
    tabs.length > 1 ? h('div', { key: 'tabs', ref: glide.box, className: 'bt-tabs', role: 'tablist', 'data-move': side },
      h('span', { ref: glide.thumb, className: 'bt-thumb', 'aria-hidden': true }),
      tabs.map(key => h('button', { key, type: 'button', role: 'tab', className: 'bt-tab', 'aria-selected': tab === key, onClick: () => setTab(key) }, t(TAB_LABELS[key])))) : null,
    h('div', { key: `body:${tab}`, className: 'bt-drawer-body', 'data-move': move },
      errorLine,
      room && tab === 'details' ? h(GroupOverview, { room, roster, actions, run, usage, useWork, taskFilter, returnId: returnTask.current, openTask: taskId => { returnTask.current = taskId; setView({ taskId }) } }) : null,
      bot && tab === 'computer' ? h(ComputerView, { bot, actions, hooks: { useComputer } }) : null,
      bot && tab === 'details' ? [
        h(RunStats, { key: 'stats', bot, part, running, actions }),
        h('div', { key: 'model', className: 'bt-drawer-model' },
          h('div', { className: 'bt-section-title' }, t('Model')),
          h(ModelMenu, { bot, roster, actions, run, wide: true, inline: true }),
          modelOf(bot, roster) ? null : h('div', { className: 'bt-note' }, t('Pick a model and {name} can start.', { name: bot.name })),
        ),
        h(BotSessions, { key: `sessions:${bot.id}`, bot, part, rooms: roster.rooms, openMember: (member, label) => setView({ member, label }), run, useSessions, useSessionStatus, actions, readOnly: !!roster.readOnly, running: roster.partsRunning }),
        h(PermissionRow, { key: 'permission', bot, roster, actions, run }),
        h(BotConnectors, { key: 'connectors', bot, roster, actions, run }),
        h('div', { key: 'folder', className: 'bt-drawer-model' },
          h('div', { className: 'bt-section-title' }, t('Working folder')),
          h(FolderMenu, { value: bot.workDir, actions, run, wide: true, onPick: workDir => run(actions.updateBot(bot.id, { workDir })) })),
        roster.readOnly
          ? (bot.instructions ? h(MarkdownSetting, { key: `about:${bot.id}`, title: t('About'), value: bot.instructions }) : null)
          : h(MarkdownSetting, {
              key: `about:${bot.id}`, title: t('About'), value: bot.instructions ?? '', label: t('Instructions'), placeholder: t('What this Bot is responsible for…'),
              onSave: instructions => run(actions.updateBot(bot.id, { instructions })),
            }),
        roster.memory === false ? null : h(MemoryRow, { key: 'memory', owner: { id: bot.id, name: bot.name }, actions }),
        usage ? h('div', { key: 'usage' }, h('div', { className: 'bt-section-title' }, t('Usage')),
          h('div', { className: 'bt-kv' }, h('span', null, bot.name), h('span', null, usage))) : null,
        h(ScheduleSummary, { key: 'routines', bot, actions }),
      ] : null,
      bot && tab === 'browser' ? h(BrowserCards, { bot, sessionId, roster, actions, useBrowserTabs, useBrowserPages }) : null)]
}

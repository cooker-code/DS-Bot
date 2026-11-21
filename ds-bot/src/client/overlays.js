import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CommandPalette } from './palette.js'
import { DiscussionArchive } from './discussion-archive.js'
import { GroupSearch } from './group-search.js'
import { MemberHistory } from './member-history.js'
import { NewChat } from './new-chat.js'
import { ExchangeDialog } from './exchange.js'
import { VoiceMode } from './voice.js'
import { SettingsDialog } from './settings.js'
import { ContextMenu } from './context-menu.js'
import { PANEL_LINGER_MS, BotPanel } from './browser-pane.js'
import { frameLayout, FALLBACK_SIDEBAR_WIDTH } from './frame-layout.js'
import { MemoryDialog } from './memory-panel.js'
import { reducedMotion, useLinger } from './motion.js'
import { OpeningCover, openingModel } from './opening.js'

// How long a closing dialog or menu stays for its exit (see their [data-leaving] CSS).
const DIALOG_EXIT_MS = 160
const MENU_EXIT_MS = 120

export function Overlays({ SessionProvider, renderSlot, useRoster, useUi, useSessions, useSessionStatus, useActivity, useWork, useComputer, useRegistry, useBrowserPages, useBrowserTabs, useUpdate, useFrame, useSidebarPref, useSettingsShellHeld, actions }) {
  const roster = useRoster(value => value)
  const ui = useUi(value => value)
  useRegistry(value => value)
  const frameSnap = useFrame ? useFrame(value => value) : { viewport: window.innerWidth, sidebarWidth: FALLBACK_SIDEBAR_WIDTH, collapsedWidth: 0 }
  const pref = useSidebarPref ? useSidebarPref(value => value) : 'open'
  const current = useSessions(list => Object.values(list.byId).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id ?? null)
  const memberRoom = roster.roomsById[ui.memberChat?.roomId]
  const memberBot = roster.byId[ui.memberChat?.botId]
  const parts = memberRoom?.memberSessions?.[memberBot?.id] ?? []
  const member = ui.memberChat?.sessionId ? parts.find(part => part.id === ui.memberChat.sessionId) : parts.find(part => part.current)
  // An open panel follows the conversation in the main view. Only a change of the
  // main view moves it, so opening details for another id (Rename) is not undone.
  const previous = useRef(current)
  useEffect(() => {
    if (previous.current === current) return
    previous.current = current
    if (member && current === member.id) return
    if (ui.memberChat) actions.closeMemberSession()
    if (current) actions.followPanel?.(current)
  }, [current])
  const open = ui.details ? { id: ui.details, view: ui.view ?? 'details', renaming: ui.renaming, tab: ui.tab, side: ui.side } : null
  // A panel that no longer fits folds away: its state stays open, it just is not
  // mounted — the usual exit plays and the webview goes with it — until the room
  // returns and it shows again on its own.
  const layout = frameLayout({
    viewport: frameSnap.viewport, sidebarWidth: frameSnap.sidebarWidth,
    pref, drawer: ui.leftDrawer === true,
    panel: open ? { view: open.view, yielded: ui.panelYield === true } : null,
  })
  const shown = open !== null && layout.panel !== 'folded' ? open : null
  const [kept, setKept] = useState(shown)
  useEffect(() => {
    if (shown) { setKept(shown); return undefined }
    const timer = setTimeout(() => setKept(null), reducedMotion() ? 0 : PANEL_LINGER_MS)
    return () => clearTimeout(timer)
  }, [ui.details, ui.view, ui.renaming, ui.tab, shown === null])
  const pane = shown ?? kept
  const listedMember = useSessions(list => !!member && !!list.byId[member.id])
  const memberRunning = useSessionStatus(map => member && (map.get(member.id)?.running ?? roster.partsRunning?.[member.id]) === true)
  // The settings shell draws the dialog while DS Bot holds the seat.
  const shellHeld = useSettingsShellHeld ? useSettingsShellHeld(value => value) : false
  const [settings, settingsLeaving] = useLinger(shellHeld ? null : ui.settings, DIALOG_EXIT_MS)
  // The memory dialog shows a Bot's memory or a group chat's.
  const memoryOwner = (id) => {
    const bot = roster.byId[id]
    if (bot) return { id: bot.id, name: bot.name }
    const room = roster.roomsById[id]
    return room ? { id: room.id, name: room.name, group: true } : null
  }
  const [memory, memoryLeaving] = useLinger(ui.memory && memoryOwner(ui.memory) ? ui.memory : null, DIALOG_EXIT_MS)
  const owner = memory ? memoryOwner(memory) : null
  const [menu, menuLeaving] = useLinger(ui.menu, MENU_EXIT_MS)
  // A Session the Host made a moment ago is not in the shell's list yet: the asked-for
  // Bot fills the conversation area instead of the chat that was there before.
  const opening = openingModel({ pending: ui.pendingOpen ?? null, current, roster })
  return h(Fragment, null,
    opening ? createPortal(h(OpeningCover, { model: opening, column: layout.column }), document.body) : null,
    // The panel must precede its CSS-anchored transcript, including after reopening it.
    createPortal(h(Fragment, null,
      pane ? h(BotPanel, { pane, SessionProvider, renderSlot, memberChat: ui.memberChat, memberSessionId: member?.id, leaving: shown === null,
        room: layout.room, overlay: layout.panel === 'overlay', roster, actions, useSessions, useSessionStatus,
        useActivity, useWork, useComputer, useBrowserTabs, useBrowserPages }) : null,
      ui.memberChat ? h(MemberHistory, { key: JSON.stringify([ui.memberChat.roomId, ui.memberChat.botId, member?.id]),
        listed: listedMember, SessionProvider, renderSlot, room: memberRoom, bot: memberBot, member,
        running: memberRunning, paneLeft: layout.column, returnSession: ui.memberChat.returnSession ?? current, actions }) : null), document.body),
    ui.newChat ? createPortal(h(NewChat, { key: `${ui.newChat}:${ui.newChatSection ?? ''}`, mode: ui.newChat, sectionId: ui.newChatSection ?? null, paneLeft: layout.column, roster, actions }), document.body) : null,
    ui.palette ? createPortal(h(CommandPalette, { key: ui.palette.token, start: ui.palette.query, token: ui.palette.token, roster, actions, useSessions }), document.body) : null,
    ui.groupArchive && roster.roomsById[ui.groupArchive.roomId] ? createPortal(h(DiscussionArchive, { key: ui.groupArchive.token,
      room: roster.roomsById[ui.groupArchive.roomId], request: ui.groupArchive, actions, roster, useUi }), document.body) : null,
    ui.groupSearch && roster.roomsById[ui.groupSearch.roomId]
      ? createPortal(h(GroupSearch, { key: ui.groupSearch.token, room: roster.roomsById[ui.groupSearch.roomId], roster, token: ui.groupSearch.token, actions }), document.body)
      : null,
    ui.exchange ? createPortal(h(ExchangeDialog, { pair: ui.exchange, paneLeft: layout.column, roster, actions }), document.body) : null,
    ui.voice ? createPortal(h(VoiceMode, { key: ui.voice, sessionId: ui.voice, paneLeft: layout.column, roster, actions, useSessions, useSessionStatus }), document.body) : null,
    menu ? createPortal(h(ContextMenu, { key: `${menu.kind ?? ''}:${menu.id}:${menu.x}:${menu.y}`, menu, roster, actions, useWork, leaving: menuLeaving }), document.body) : null,
    settings ? createPortal(h(SettingsDialog, { page: settings.page, id: settings.id, roster, actions, useUpdate, leaving: settingsLeaving }), document.body) : null,
    owner ? createPortal(h(MemoryDialog, { key: owner.id, owner, actions, leaving: memoryLeaving }), document.body) : null)
}

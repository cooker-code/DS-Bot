// DSH's blank composer needs workspace membership as well as a working directory.
// Attach the private chat being viewed, including one created before its directory
// was registered. Background group sessions need no composer.
export function bindPrivateWorkspace({ sessions, workspaces, roster, mainView, attach, reportError }) {
  if (!workspaces) return
  let attempted
  const sync = () => {
    const id = mainView()
    const row = sessions.list.getSnapshot().byId[id]
    const team = roster.getSnapshot()
    const bot = team.byId[id]
    const registry = workspaces.list.getSnapshot()
    if (row?.blank !== true || !bot || team.readOnly || registry.phase !== 'ready'
      || (bot.sessionId !== id && !bot.openParts?.some(part => part.sessionId === id))
      || registry.archivedSessionIds?.includes(id) || registry.items.some(item => item.sessionIds.includes(id))) {
      attempted = undefined
      return
    }
    if (attempted?.id === id) return
    const attempt = { id }
    attempted = attempt
    void attach(bot.id, id).catch(error => { if (attempted === attempt) reportError(error, 'private-workspace') })
  }
  const offs = [sessions.list, workspaces.list, roster].map(source => source.subscribe(sync))
  sync()
  return () => { attempted = undefined; for (const off of offs) off() }
}

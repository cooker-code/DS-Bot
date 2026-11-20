import { currentSession, foregroundThread, threadOfPart } from './threads.js'

function remainingThreads(bot, selected) {
  const kept = []
  for (const thread of [foregroundThread(bot), ...(bot.openParts ?? [])]) {
    const segments = (thread.segments ?? []).filter(part => !selected.has(part.sessionId))
    if (!selected.has(thread.sessionId)) kept.push({ ...thread, segments })
    else if (segments.length) {
      const last = segments.pop()
      kept.push({ sessionId: last.sessionId, startedAt: last.endedAt, segments })
    }
  }
  return kept
}

// DSH keeps archived transcripts. Retain their ownership for private Bots, and
// finish any archive interrupted after the team database committed the removal.
export async function finishSessionArchives(rt, bot) {
  const pending = Object.entries(bot.removedSessions ?? {}).filter(([, archived]) => !archived)
  if (!pending.length) return
  for (const [id] of pending) {
    await rt.ctx.workspaceRegistry.archiveSession(id, { stopActivity: true })
    bot.removedSessions[id] = true
  }
  await rt.save({ required: true })
}

export async function deleteChatSessions(rt, bot, ids, switches, makeBlankPart) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id))
    throw Object.assign(new Error('Select sessions to delete.'), { code: 'bot/invalid' })
  const selected = new Set(ids)
  const check = () => {
    if (rt.botOf(bot.id) !== bot) throw new Error('Unknown Bot')
    for (const id of selected) {
      if (!threadOfPart(bot, id) && !Object.hasOwn(bot.removedSessions ?? {}, id))
        throw Object.assign(new Error('Unknown part'), { code: 'bot/not-found' })
      if (rt.live.get(id)?.turn !== undefined || switches.has(id) || rt.state.switching[id])
        throw Object.assign(new Error('The Bot is working; wait for it to finish or stop it first'), { code: 'bot/busy' })
    }
  }
  check()
  if ([...selected].every(id => Object.hasOwn(bot.removedSessions ?? {}, id))) {
    await finishSessionArchives(rt, bot)
    return currentSession(bot)
  }

  // Even when every row is selected the Bot needs a destination for its next
  // message. Prepare it before changing the roster, in the same working folder.
  const replacement = remainingThreads(bot, selected).length ? undefined
    : await makeBlankPart(bot, await rt.resolveAgent(currentSession(bot)))
  const promoted = []
  try {
    await rt.save({ required: true, mutate: () => {
      check()
      const kept = remainingThreads(bot, selected)
      if (Boolean(replacement) !== (kept.length === 0)) throw new Error('The session list changed. Please try again.')
      for (const thread of kept) if (rt.pastOwners.has(thread.sessionId)) promoted.push(thread.sessionId)
      const [current, ...open] = kept.length ? kept : [{ sessionId: replacement.freshId, startedAt: Date.now(), segments: [] }]
      const before = { sessionId: bot.sessionId, sessionStartedAt: bot.sessionStartedAt, segments: bot.segments, openParts: bot.openParts, removedSessions: bot.removedSessions }
      bot.sessionId = current.sessionId
      bot.sessionStartedAt = current.startedAt
      bot.segments = current.segments
      bot.openParts = open
      bot.removedSessions = { ...Object.fromEntries([...selected].map(id => [id, false])), ...bot.removedSessions }
      const cards = []
      for (const id of selected) {
        for (const map of [rt.state.questions, rt.state.views, rt.state.closedCards, rt.state.exchangeTurns]) {
          if (!map || !Object.hasOwn(map, id)) continue
          cards.push([map, id, map[id]])
          delete map[id]
        }
      }
      return () => {
        Object.assign(bot, before)
        for (const [map, id, value] of cards) map[id] = value
      }
    } })
  } catch (error) {
    if (replacement) await rt.ctx.workspaceRegistry.archiveSession(replacement.freshId, { stopActivity: true })
    throw error
  }
  rt.indexSessions()
  for (const id of promoted) {
    await rt.ctx.workspaceRegistry.unarchiveSession(id)
    await rt.applyPermission(bot, id)
  }
  if (promoted.length) await rt.applyModel(bot, { force: true })
  await finishSessionArchives(rt, bot)
  return currentSession(bot)
}

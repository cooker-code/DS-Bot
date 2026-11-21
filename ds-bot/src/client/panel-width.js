import { MIN_CHAT } from './frame-layout.js'

export const DEFAULT_WIDTH = 520
export const DETAILS_WIDTH = 320

export function widthRange(view, room) {
  if (view === 'details') return [DETAILS_WIDTH, Math.max(DETAILS_WIDTH, room)]
  if (view === 'browser') return [360, room - MIN_CHAT]
  return [DETAILS_WIDTH, Math.min(DEFAULT_WIDTH, room - MIN_CHAT)]
}
export const fitWidth = (width, [low, high]) => Math.round(Math.max(low, Math.min(width, high)))
export const draggedWidth = (width, startX, x, range) => fitWidth(width + startX - x, range)

// One owner for capture and listeners; cancellation and lost capture may race.
export function trackPanelResize(grip, event, move, finish) {
  let ended = false
  const pointerId = event.pointerId
  const onMove = next => { if (next.pointerId === pointerId) move(next) }
  const ends = ['pointerup', 'pointercancel', 'lostpointercapture']
  const stop = (end) => {
    if (ended || (end && end.pointerId !== pointerId)) return
    ended = true
    if (end?.type === 'pointerup') onMove(end)
    grip.removeEventListener('pointermove', onMove)
    for (const name of ends) grip.removeEventListener(name, stop)
    try { if (grip.hasPointerCapture?.(pointerId)) grip.releasePointerCapture(pointerId) } catch { /* detached grip */ }
    finish()
  }
  grip.addEventListener('pointermove', onMove)
  for (const name of ends) grip.addEventListener(name, stop)
  try { grip.setPointerCapture?.(pointerId) } catch { stop() }
  return ended ? null : stop
}

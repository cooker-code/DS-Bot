/**
 * The longest wait between two state requests while nothing changes. Kept short because
 * the same poll carries cards and approvals: a window that sits still should not pay 1.5 s
 * for them, but nothing may appear minutes late either.
 */
export const POLL_MAX_MS = 5_000

/**
 * How long to wait before asking the host again.
 * @param {number} base the cadence while something is changing (1.5 s visible, 10 s hidden)
 * @param {number} unchanged how many answers in a row said nothing changed
 * @returns {number} milliseconds to wait
 */
export function pollDelay(base, unchanged) {
  const steps = Math.min(Math.max(unchanged, 0), 8)
  return Math.min(base * 2 ** steps, Math.max(base, POLL_MAX_MS))
}

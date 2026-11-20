// Keep new configuration apart from opaque keys in historical JSON. Directory
// values remain in memberDirs for the existing folder and privacy consumers.
const settings = Symbol('room member settings')
const empty = Object.freeze({})
export function memberSettings(room) {
  return room?.[settings] ?? empty
}
export function setMemberSettings(room, values) {
  if (Object.keys(values).length) Object.defineProperty(room, settings, { value: values, configurable: true })
  else delete room[settings]
}
export function teamSnapshot(team) {
  const snapshot = JSON.parse(JSON.stringify(team))
  for (const [id, room] of Object.entries(snapshot.rooms ?? {})) {
    setMemberSettings(room, structuredClone(memberSettings(team.rooms[id])))
  }
  return snapshot
}
export function memberModel(bot, room) {
  return Object.hasOwn(memberSettings(room), bot.id) ? memberSettings(room)[bot.id].model : undefined
}

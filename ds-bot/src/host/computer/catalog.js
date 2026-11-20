// Which computer tools exist and how much each call can touch. `kind` maps onto the
// Bot levels: view allows observe, background adds background, foreground adds
// foreground. A call nothing recognizes counts as foreground: better refused than
// silently let through.
export const PROVIDERS = { cua: 'cua' }
export const KINDS = ['observe', 'background', 'foreground']

// The macOS provider's single `cua` tool dispatches on params.method. Pure reads and
// consent-gated selection need no lease; activate, 0.2.2-rc.1's hover, and mouseMove
// with useSystemPointer raise an app or move the visible pointer, so they are
// foreground; permission UI opens on the user's screen. Everything else stays in the
// app's background.
const CUA_OBSERVE = new Set([
  'getCapabilities', 'listApps', 'findApps', 'getApp', 'listWindows', 'getState', 'listActions',
  'screenshot', 'permissionStatus', 'applicationIcons',
])
const CUA_FOREGROUND = new Set(['activate', 'hover', 'requestPermission', 'openPermissionSettings'])
const CUA_BACKGROUND = new Set([
  'click', 'scroll', 'drag', 'setValue', 'selectText', 'invoke', 'performAction',
  'performSecondaryAction', 'typeText', 'paste', 'pressKey', 'sendKeyEvent', 'show', 'launchApp',
])

// Classify one call. Returns undefined for a tool computer use does not own.
// `args` is the parsed tool-call arguments object (cua: {method, params}).
export function classify(name, args = {}) {
  if (name === 'cua') {
    const method = typeof args?.method === 'string' ? args.method : ''
    const kind = method === 'mouseMove'
      ? (args?.params?.useSystemPointer === true ? 'foreground' : 'background')
      : CUA_OBSERVE.has(method) ? 'observe'
        : CUA_FOREGROUND.has(method) ? 'foreground'
          : CUA_BACKGROUND.has(method) ? 'background' : 'foreground'
    return { provider: PROVIDERS.cua, kind, method }
  }
  return undefined
}

// Whether a tool name belongs to a computer-use provider at all.
export const isComputerTool = name => classify(name, {}) !== undefined

// The kind a level admits. 'off' sees nothing.
export const LEVELS = ['off', 'view', 'background', 'foreground']
export function levelAllows(level, kind) {
  if (kind === 'observe') return LEVELS.indexOf(level) >= 1
  if (kind === 'background') return LEVELS.indexOf(level) >= 2
  return LEVELS.indexOf(level) >= 3
}

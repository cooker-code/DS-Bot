import { createElement as h, useEffect, useState } from 'react'
import { KeyEditor, translated } from './providers-page.js'
import { modelRefOf } from './bot-model-batch.js'
import { isLocalRoute } from './agent-routes.js'
import { RANGES, compact, summarize } from './usage-data.js'
import { t } from './i18n.js'

export function overviewSummary(roster) {
  const models = (roster.models ?? []).filter(entry => !isLocalRoute(entry.ref))
  const connectors = roster.connectors ?? {}
  const apps = connectors.connectors ?? []
  return {
    models: models.filter(entry => entry.needsKey !== true).length,
    keyless: (roster.bots ?? []).filter(bot => models.some(entry => entry.ref === modelRefOf(bot) && entry.needsKey === true)),
    connected: apps.filter(app => app.state === 'ready').length,
    mail: (connectors.mail?.accounts ?? []).length,
    im: (roster.im?.connections ?? []).length,
    imReady: (roster.im?.connections ?? []).filter(conn => roster.imStatus?.[conn.id]?.state === 'ready').length,
    imErrors: (roster.im?.connections ?? []).filter(conn => roster.imStatus?.[conn.id]?.state === 'error'),
    connectionErrors: apps.filter(app => app.state === 'error' || app.state === 'needs-sign-in'),
    capabilities: (roster.capabilities ?? []).length,
    local: (roster.bots ?? []).filter(bot => isLocalRoute(modelRefOf(bot))).length,
  }
}

// A failed or unavailable service stays unknown. In particular it is never shown as zero usage.
function useOverviewRead(read, enabled, refresh, scan = false) {
  const [state, setState] = useState({ pending: enabled, value: null, error: false })
  useEffect(() => {
    let stopped = false, timer, busy = false
    if (!enabled || typeof read !== 'function') { setState({ pending: false, value: null, error: false }); return undefined }
    const load = () => {
      if (stopped || busy || document.hidden) return
      busy = true
      Promise.resolve().then(read).then(value => {
        if (stopped) return
        setState({ pending: false, value, error: false })
        if (scan && value?.scanning) timer = setTimeout(load, 3000)
      }).catch(() => { if (!stopped) setState({ pending: false, value: null, error: true }) })
        .finally(() => { busy = false })
    }
    const visibility = () => { clearTimeout(timer); if (!document.hidden) load() }
    setState({ pending: true, value: null, error: false })
    document.addEventListener('visibilitychange', visibility)
    load()
    return () => { stopped = true;clearTimeout(timer);document.removeEventListener('visibilitychange', visibility) }
  }, [read, enabled, refresh])
  return state
}

export function OverviewStatus({ roster, actions, run, Section, Row }) {
  const [refresh, setRefresh] = useState(0)
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia('(max-width:600px)').matches)
  useEffect(() => {
    const media = window.matchMedia?.('(max-width:600px)')
    const resize = () => setNarrow(media?.matches ?? false)
    media?.addEventListener('change', resize)
    return () => media?.removeEventListener('change', resize)
  }, [])
  const providers = useOverviewRead(actions.providers, true, refresh)
  const schedules = useOverviewRead(actions.schedules, true, refresh)
  const usage = useOverviewRead(actions.usage, !narrow, refresh, true)
  const summary = overviewSummary(roster)
  const missing = (providers.value?.providers ?? []).filter(provider => provider.key?.configured === false)
    .map(provider => ({ provider, bots: (roster.bots ?? []).filter(bot => modelRefOf(bot)?.startsWith(provider.id + '/')) }))
    .filter(entry => entry.bots.length)
  const apply = promise => run(translated(promise).then(next => { if (next?.providers) setRefresh(value => value + 1);void actions.refreshModels?.() }))
  const open = (page, label = 'Open') => h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openSettings(page) }, t(label))
  const labelOf = state => state.pending ? t('Loading…') : state.error ? t('Could not load status') : state.value === null || state.value?.available === false ? t('Not available') : null
  const week = usage.value?.rows ? summarize(usage.value, RANGES.find(range => range.id === '7d')).total.total : null
  const active = schedules.value?.tasks?.filter(task => task.status === 'active')
  const attention = providers.error || missing.length || summary.keyless.length || (!summary.models && !summary.local) || summary.connectionErrors.length || summary.imErrors.length
  return [
    attention ? h(Section, { key: 'configuration', title: t('Needs your attention'), action: h('button', { type: 'button', className: 'bt-mini', onClick: () => setRefresh(value => value + 1) }, t('Refresh')) },
      providers.error ? h(Row, { label: t('Models'), hint: t('Could not load status') }, open('models')) : null,
      missing.map(({ provider, bots }) => h(Row, { key: provider.id, label: t('{provider} needs an API key', { provider: provider.name }), hint: bots.map(bot => bot.name).join(', ') },
        provider.key.writable && !roster.readOnly && typeof actions.setProviderKey === 'function'
          ? h(KeyEditor, { provider, actions, apply }) : open('models'))),
      !missing.length && summary.keyless.length ? h(Row, { label: t('Needs an API key'), hint: summary.keyless.map(bot => bot.name).join(', ') }, open(actions.providers ? 'models' : 'bot-models')) : null,
      !summary.models && !summary.local ? h(Row, { label: t('Add a model provider') }, open(actions.providers ? 'models' : 'bot-models', 'Set up')) : null,
      summary.connectionErrors.map(app => h(Row, { key: app.id, label: app.name ?? app.id, hint: app.error ?? t('Sign in again') }, open('connectors'))),
      summary.imErrors.map(conn => h(Row, { key: conn.id, label: conn.name ?? conn.platform, hint: roster.imStatus?.[conn.id]?.error ?? t('Sign in again') }, open('im')))) : null,
    h(Section, { key: 'status', title: t('Overview') },
      h(Row, { label: t('Models'), hint: `${summary.models} · ${t('Local agents')} ${summary.local}` }, open(actions.providers ? 'models' : 'bot-models')),
      h(Row, { label: t('Connectors'), hint: `${summary.connected} · ${t('Connected')}` }, open('connectors')),
      h(Row, { label: t('Mail'), hint: String(summary.mail) }, open('connectors')),
      h(Row, { label: t('IM'), hint: `${summary.imReady}/${summary.im} · ${t('Connected')}` }, open('im')),
      h(Row, { label: t('Browser'), hint: roster.browser ? t('Enabled') : t('Disabled') }, open('browser')),
      h(Row, { label: t('Computer use'), hint: roster.computer?.enabled ? t('Enabled') : t('Disabled') }, open('computer')),
      h(Row, { label: t('Capabilities'), hint: String(summary.capabilities) }, open('capabilities')),
      h(Row, { label: t('Secrets'), hint: String((roster.secrets ?? []).length) }, open('secrets')),
      h(Row, { label: t('Scheduled tasks'), hint: labelOf(schedules) ?? (active ? String(active.length) : t('Not available')) }, open('schedules')),
      narrow ? null : h(Row, { label: t('Last 7 days'), hint: labelOf(usage) ?? (week === null ? t('Not available') : compact(week)) }, open('usage'))),
  ]
}

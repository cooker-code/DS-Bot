'use strict'
const $ = id => document.getElementById(id)
const filters = ['q', 'status', 'wanted', 'group', 'category', 'min', 'max', 'sort', 'stale']
let offset = 0, total = 0, selected = null, generation = 0, meta
const element = (tag, text, attrs = {}) => {
  const node = document.createElement(tag)
  if (text !== undefined && text !== null) node.textContent = text
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  return node
}
const clean = value => String(value ?? '').replace(/<br\s*\/?>/g, '\n').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*`]/g, '')
const message = (text, error = false) => { $('notice').textContent = text; $('notice').toggleAttribute('data-error', error) }
async function request(url, body) {
  const response = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`)
  return data
}
const groupLabel = group => group ? `${group} · ${meta?.groupNames?.[group] || '名称待补齐'}` : '—'
async function loadMeta() {
  meta = await request('/api/meta')
  $('context').textContent = `${meta.branch} · 本地 SQLite · 共 ${meta.total} 个 PR`
  const coverage = meta.coverage, panel = $('coverage')
  panel.replaceChildren()
  const repository = element('p', '上游仓库：')
  repository.append(element('a', meta.source.canonical_url, { href: meta.source.canonical_url, target: '_blank', rel: 'noopener noreferrer' }), document.createTextNode(` · 上游分支：${meta.source.branch}（upstream/${meta.source.branch}）`))
  panel.append(repository)
  const date = value => value ? new Date(value).toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }) : '尚未记录'
  if (coverage) {
    panel.append(element('p', `台账覆盖至：${date(coverage.coveredAt)}（Asia/Taipei） · 提交 ${(coverage.checkpoint || '').slice(0, 8)}`))
    panel.append(element('p', `远端最近核对：${date(coverage.checkedAt)} · 当时上游最新提交时间：${date(coverage.checkedTipAt)}`))
    const state = coverage.error ? `核对异常：${coverage.error}，不能判定当前已同步` : !coverage.checkedAt ? '尚未核对远端，不能判定是否有遗漏。' : coverage.unseenCommits === null ? '无法确认与上游的差距，请重新核对。' : coverage.unseenCommits ? `待同步：${coverage.unseenPRs} 个 PR、${coverage.unseenDirectCommits} 个直接提交（共 ${coverage.unseenCommits} 个主线提交）。已缓存但未评估完整的条目也属于待同步。` : '截至上述核对时间，未同步项为 0；这不是实时检查。'
    panel.append(element('p', state), element('p', '覆盖指功能盘点和来源资料已完整登记，不代表已把这些功能合入本地。'))
  }
  $('counts').textContent = Object.entries(meta.statuses).map(([name, count]) => `${name} ${count}`).join(' / ')
  $('pending').textContent = meta.pendingExport ? `${meta.pendingExport} 次变更待更新记录` : '同步记录已对齐'
  $('export').disabled = !meta.pendingExport
  $('storage').textContent = `来源：${meta.source.canonical_url} / ${meta.source.branch}；完整盘点终点：${meta.source.checkpoint_sha || '尚未建立'}。数据库：${meta.database}。执行工作树：${meta.repo}。`
  if ($('group').options.length === 1) for (const group of meta.groups) $('group').append(element('option', groupLabel(group), { value: group }))
}
function parameters() {
  const query = new URLSearchParams({ offset, limit: 50 })
  for (const key of filters) {
    const input = $(key), value = input.type === 'checkbox' ? (input.checked ? '1' : '') : input.value
    if (value) query.set(key, value)
  }
  return query
}
function timestamp(value) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) return element('span', '待补齐', { class: 'time-cell' })
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(p => [p.type, p.value]))
  return element('time', `${parts.year}-${parts.month}-${parts.day}\n${parts.hour}:${parts.minute}:${parts.second}`, { datetime: value, title: `${value} · Asia/Taipei`, class: 'time-cell' })
}
async function loadRows() {
  const current = ++generation
  $('summary').textContent = '正在筛选…'
  try {
    const data = await request('/api/prs?' + parameters())
    if (current !== generation) return
    total = data.total
    const nodes = data.rows.map(row => {
      const tr = element('tr');tr.toggleAttribute('data-selected', row.number === selected)
      const open = element('button', '#' + row.number, { class: 'pr-open', 'aria-label': `查看 PR ${row.number}` })
      open.addEventListener('click', () => showDetail(row.number, true))
      const number = element('td');number.append(open)
      const title = element('td', row.title);title.append(element('span', row.purpose || '功能说明尚待补齐', { class: 'purpose' }))
      if (row.needs_review) title.append(element('span', '需重新评估', { class: 'stale' }))
      const status = element('td');status.append(element('span', row.status, { class: 'status', 'data-status': row.status }))
      tr.append(number, title, status, element('td', row.wanted === 0 ? '不需要' : row.wanted === 1 ? '需要' : '待评估'), element('td', row.weight), element('td', groupLabel(row.dependency_group), { class: 'dependency-group' }))
      for (const value of [row.pr_created_at, row.pr_merged_at, row.synced_at]) { const cell = element('td');cell.append(timestamp(value));tr.append(cell) }
      return tr
    })
    $('rows').replaceChildren(...nodes)
    $('empty').hidden = !!nodes.length
    $('summary').textContent = `匹配 ${total} 个 PR · 已标记不需要 ${meta?.notWanted ?? 0} 个`
    $('range').textContent = total ? `${offset + 1}–${Math.min(offset + 50, total)} / ${total}` : '0 / 0'
    $('prev').disabled = offset === 0; $('next').disabled = offset + 50 >= total
    const query = parameters();query.delete('offset');query.delete('limit')
    const url = new URL(location.href)
    for (const key of filters) url.searchParams.delete(key)
    for (const [key, value] of query) url.searchParams.set(key, value)
    if (selected) url.hash = 'pr-' + selected
    history.replaceState(null, '', url)
  } catch (error) { if (current === generation) { message(error.message, true); $('summary').textContent = '读取失败，可调整筛选后重试' } }
}
async function showDetail(number, focus = false) {
  selected = number
  try {
    const row = await request('/api/pr/' + number)
    if (selected !== number) return
    const head = element('div', null, { class: 'detail-head' })
    const titles = element('div');titles.append(element('a', `PR #${number} ↗`, { href: row.url, target: '_blank', rel: 'noopener noreferrer' }), element('h2', row.title), element('p', `${row.status} · 权重 ${row.weight} · ${row.dependency_group ? groupLabel(row.dependency_group) : '未分组'}`))
    const close = element('button', '关闭', { class: 'secondary' });close.addEventListener('click', () => { selected = null; $('detail').replaceChildren(element('p', '选择一项 PR，查看功能和本地差异。')); loadRows() })
    const dates = element('p', null, { class: 'detail-dates' });dates.append(element('span', 'PR 创建时间（Asia/Taipei）'), timestamp(row.pr_created_at), element('span', '上游合并时间（Asia/Taipei）'), timestamp(row.pr_merged_at), element('span', '来源同步时间（Asia/Taipei）'), timestamp(row.synced_at));titles.append(dates)
    head.append(titles, close)
    const choice = element('form', null, { class: 'choice' })
    const pickLabel = element('label', '我的选择'), pick = element('select', null, { 'aria-label': '我的选择' })
    for (const [value, text] of [['', '待评估'], ['1', '需要'], ['0', '不需要']]) pick.append(element('option', text, { value }))
    pick.value = row.wanted === null ? '' : String(row.wanted); pickLabel.append(pick)
    const reasonLabel = element('label', '理由（可选）'), reason = element('textarea', row.choice_reason || '', { rows: '2', maxlength: '4000', 'aria-label': '选择理由' });reasonLabel.append(reason)
    const save = element('button', '保存选择', { type: 'submit' })
    choice.append(pickLabel, reasonLabel, save, element('p', '后续增量同步保留你的选择；不会自动回滚已采用代码。'))
    if (row.decided_at) choice.append(element('p', '上次保存：' + row.decided_at))
    choice.addEventListener('submit', async event => {
      event.preventDefault();save.disabled = true;save.textContent = '保存中…'
      try {
        await request('/api/preference', { number, wanted: pick.value === '' ? null : Number(pick.value), reason: reason.value, revision: row.choice_revision || 0 })
        message('选择已保存到 SQLite，重新加载和下次同步后仍保留。')
        await loadMeta();await showDetail(number);await loadRows()
      } catch (error) { message(error.message, true);save.disabled = false;save.textContent = '重试保存' }
    })
    const contents = [head, choice]
    for (const [label, value] of [['功能作用', row.purpose], ['场景与验证方法', row.scenario], ['效果与限制', row.effect], ['原因', row.reason], ['本地差异与历史已落地内容', row.local_difference], ['完整解决方式与通过条件', row.solution], ['已有验证证据', row.verification]]) {
      contents.push(element('h3', label), element('p', clean(value) || '尚未记录，本次评估需要补齐。', { class: 'detail-copy' }))
    }
    const source = JSON.parse(row.upstream_json || '{}')
    contents.push(renderPRDesigns(row, source))
    const files = element('details');files.append(element('summary', '上游来源和涉及文件'), element('p', source.sha || '尚待核对', { class: 'detail-copy' }), element('p', (source.files || []).join('\n'), { class: 'detail-copy' }), element('p', source.body || '', { class: 'detail-copy' }))
    contents.push(files, element('h3', '最近记录'))
    const events = element('ol', null, { class: 'history' })
    for (const item of row.history.slice(0, 20)) events.append(element('li', `${item.recorded_at} · ${item.actor} · ${item.kind}`))
    contents.push(events)
    $('detail').replaceChildren(...contents)
    $('detail').scrollTop = 0
    if (focus && matchMedia('(max-width:1000px)').matches) $('detail').scrollIntoView({ block: 'start', behavior: 'smooth' })
    await loadRows()
  } catch (error) { message(error.message, true) }
}
let timer
for (const key of filters) $(key).addEventListener(key === 'q' ? 'input' : 'change', () => { offset = 0; clearTimeout(timer);timer = setTimeout(loadRows, key === 'q' ? 180 : 0) })
$('clear').addEventListener('click', () => { for (const key of filters) { $(key).value = key === 'min' ? '1' : key === 'max' ? '10' : key === 'sort' ? 'status' : '';if ($(key).type === 'checkbox') $(key).checked = false } offset = 0;loadRows() })
$('prev').addEventListener('click', () => { offset = Math.max(0, offset - 50);loadRows() })
$('next').addEventListener('click', () => { offset += 50;loadRows() })
$('export').addEventListener('click', async () => { $('export').disabled = true;try { const out = await request('/api/export', {});message(`已更新 ${out.changed} 项同步记录，没有提交或合并代码。`);await loadMeta() } catch (error) { message(error.message, true);$('export').disabled = false } })
async function start() {
  try {
    await loadMeta()
    const saved = new URLSearchParams(location.search)
    for (const key of filters) if (saved.has(key)) { if ($(key).type === 'checkbox') $(key).checked = saved.get(key) === '1';else $(key).value = saved.get(key) }
    const number = /^#pr-(\d+)$/.exec(location.hash)?.[1]
    await loadRows()
    if (number) await showDetail(Number(number))
  } catch (error) { message(error.message, true) }
}
void start()

const helpPopovers = [...document.querySelectorAll('.help-popover')]
let helpPopover
const helpTriggers = [...document.querySelectorAll('[data-help]')]
let helpAnchor, helpPinned = false, helpTimer
function positionHelp() {
  if (!helpPopover || helpPopover.hidden || !helpAnchor) return
  const anchor = helpAnchor.getBoundingClientRect(), box = helpPopover.getBoundingClientRect()
  helpPopover.style.left = Math.max(12, Math.min(anchor.left, innerWidth - box.width - 12)) + 'px'
  helpPopover.style.top = Math.max(12, Math.min(anchor.bottom + 8, innerHeight - box.height - 12)) + 'px'
}
function closeHelp() {
  clearTimeout(helpTimer)
  for (const popover of helpPopovers) popover.hidden = true
  for (const trigger of helpTriggers) trigger.setAttribute('aria-expanded', 'false')
  helpAnchor = null; helpPinned = false
}
function showHelp(trigger) {
  clearTimeout(helpTimer)
  if (helpAnchor !== trigger) helpPinned = false
  for (const popover of helpPopovers) popover.hidden = true
  helpPopover = $(trigger.dataset.help)
  helpAnchor = trigger
  for (const other of helpTriggers) other.setAttribute('aria-expanded', String(other === trigger))
  helpPopover.hidden = false
  positionHelp()
}
function leaveHelp() {
  clearTimeout(helpTimer)
  helpTimer = setTimeout(() => {
    if (!helpPinned && !helpPopover?.matches(':hover') && document.activeElement !== helpAnchor) closeHelp()
  }, 100)
}
for (const trigger of helpTriggers) {
  trigger.addEventListener('pointerenter', () => { if (!helpPinned) showHelp(trigger) })
  trigger.addEventListener('pointerleave', leaveHelp)
  trigger.addEventListener('focus', () => showHelp(trigger))
  trigger.addEventListener('click', () => {
    if (helpPinned && helpAnchor === trigger) closeHelp()
    else { showHelp(trigger);helpPinned = true }
  })
}
for (const popover of helpPopovers) {
  popover.addEventListener('pointerenter', () => clearTimeout(helpTimer))
  popover.addEventListener('pointerleave', leaveHelp)
}
document.addEventListener('click', event => {
  if (!event.target.closest('[data-help]') && !helpPopover?.contains(event.target)) closeHelp()
})
document.addEventListener('focusin', event => {
  if (helpAnchor && event.target !== helpAnchor && !helpPopover?.contains(event.target)) closeHelp()
})
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeHelp() })
window.addEventListener('resize', positionHelp)
window.addEventListener('scroll', positionHelp, true)

const communityFilters = ['q', 'kind', 'stage', 'status', 'scope', 'recent']
const communityState = { offset: 0, total: 0, rows: [], selected: null, generation: 0 }
function setView(view) {
  $('community-view').hidden = view !== 'community';$('pr-view').hidden = view === 'community'
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === view))
  const url = new URL(location.href);url.searchParams.set('view', view);history.replaceState(null, '', url)
}
function sourceLink(label, url) {
  return element('a', label, { href: url, target: '_blank', rel: 'noopener noreferrer' })
}
function copySection(parent, title, value) {
  parent.append(element('h3', title), element('p', clean(value) || '说明待补齐，暂不能据此作采用判断。', { class: 'detail-copy' }))
}
function rawSource(label, body) {
  const section = element('details', null, { class: 'source-panel' });section.append(element('summary', label), element('pre', body || '未缓存此版本原文。', { class: 'source-text' }));return section
}
function countsLabel(row) {
  const rejected = row.relatedPRs?.filter(pr => pr.wanted === 0).length || 0
  const label = Object.entries(row.counts || {}).filter(([, count]) => count).map(([status, count]) => `${status} ${count}`).join(' / ') || '尚无已关联的实现 PR'
  return label + (rejected ? ` · 已标不需要 ${rejected}` : '')
}
async function openPRFromCommunity(number) {
  setView('prs')
  for (const key of filters) { const input = $(key);if (input.type === 'checkbox') input.checked = false;else input.value = key === 'min' ? '1' : key === 'max' ? '10' : key === 'sort' ? 'status' : '' }
  $('q').value = String(number);offset = 0
  await loadRows();await showDetail(number, true)
}
function relationSection(title, rows, empty) {
  const section = element('section');section.append(element('h3', title))
  if (!rows?.length) { section.append(element('p', empty, { class: 'detail-copy' }));return section }
  for (const row of rows) {
    const item = element('details', null, { class: 'related-pr' })
    item.append(element('summary', `#${row.number} ${row.title} · ${row.status} · 权重 ${row.weight}`))
    const links = element('div', null, { class: 'source-links' }), local = element('button', '查看本地 PR 与选择', { class: 'secondary', type: 'button' })
    local.addEventListener('click', () => openPRFromCommunity(row.number));links.append(sourceLink('上游 PR ↗', row.url), local);item.append(links)
    if (row.wanted === 0) item.append(element('p', '我的选择：不需要，后续不再推荐采用。', { class: 'stale' }))
    copySection(item, '这项 PR 做什么', row.purpose)
    copySection(item, '本地原因', row.reason)
    copySection(item, '双方差异和影响', row.local_difference)
    copySection(item, '解决方式与通过条件', row.solution)
    section.append(item)
  }
  return section
}
function renderPRDesigns(row, source) {
  const section = element('section', null, { class: 'pr-designs' });section.append(element('h3', '相关设计说明'))
  const designs = row.designs || []
  if (!designs.length) section.append(element('p', source.planFiles?.length ? '设计关系尚未补齐；请先通过同步技能更新设计资料。' : '本 PR 没有直接修改设计文档，也尚无已登记关联设计；功能说明和本地判断仍见上方。', { class: 'detail-copy' }))
  for (const design of designs) {
    const item = element('section', null, { class: 'design-reference' })
    item.append(element('h3', design.title), element('p', `上游阶段：${design.effective_stage}${design.needs_review ? ' · 说明基于旧版本，待重审' : ''}`))
    copySection(item, '用途', design.purpose);copySection(item, '使用场景', design.scenario)
    copySection(item, '阶段依据与限制', `${design.stage_evidence || ''}\n${design.limitations || ''}`)
    copySection(item, '本地适配注意事项', design.local_notes)
    const links = element('div', null, { class: 'source-links' }), open = element('button', '查看功能全貌与相关 PR', { class: 'secondary', type: 'button' })
    open.addEventListener('click', () => openDesign(design.id))
    links.append(sourceLink('固定版本设计原文 ↗', design.url), open)
    if (design.pr_url) links.append(sourceLink(design.change_kind === 'related' ? '关联设计版本 ↗' : '本 PR 对应设计版本 ↗', design.pr_url))
    item.append(links)
    if (design.change_kind === 'related') item.append(element('p', '这是后续综合设计或关联说明，不表示本 PR 原补丁包含其全部行为。', { class: 'detail-copy' }))
    item.append(rawSource('阅读关联版本原文（本地缓存）', design.pr_body));section.append(item)
  }
  if (source.designDiff) section.append(rawSource('查看本 PR 的设计差异（原始变更）', source.designDiff))
  return section
}
function communityParameters() {
  const query = new URLSearchParams({ offset: communityState.offset, limit: 50 })
  for (const key of communityFilters) { const input = $('community-' + key);const value = input.type === 'checkbox' ? input.checked ? '1' : '' : input.value;if (value) query.set(key, value) }
  return query
}
async function loadCommunity() {
  const generation = ++communityState.generation
  try {
    const query = communityParameters(), data = await request('/api/community?' + query)
    if (generation !== communityState.generation) return
    $('community-notice').textContent = ''
    communityState.rows = data.rows;communityState.total = data.total
    const update = data.lastUpdate || {}, historical = update.kind === '历史补齐'
    $('community-update').textContent = `${data.designCount} 项设计主题。${historical ? '当前为既有来源的历史补齐，不代表本次新增这些功能。' : update.kind ? '最近变化批次：' + update.kind + '。' : '设计资料尚未完成首次补齐。'}${update.sourceSHA ? ' 固定来源 ' + update.sourceSHA.slice(0, 8) + '。' : ''}${update.complete === false ? ' 新资料已缓存，完整盘点仍待补评估。' : ''}`
    $('community-standalone').textContent = `查看没有设计文件的单项变更（${data.standaloneCount || 0}）`
    $('community-summary').textContent = `匹配 ${data.total} 项 · 上游阶段与本地采用分别判断`
    $('community-rows').replaceChildren(...data.rows.map(row => {
      const tr = element('tr');tr.dataset.entryKey = row.key;tr.toggleAttribute('data-selected', row.key === communityState.selected)
      const name = element('td'), button = element('button', row.title, { type: 'button', class: 'pr-open entry-open' })
      button.addEventListener('click', () => showCommunityEntry(row));name.append(button, element('span', row.purpose || '说明待补齐', { class: 'purpose' }), element('span', row.entry_kind === 'design' ? '功能设计 · ' + row.change_label : '单项功能 / 修复 #' + row.number, { class: 'entry-kind' }))
      const phase = element('td', row.effective_stage)
      if (row.needs_review) phase.append(element('span', '待补说明 / 重审', { class: 'stale' }))
      if (row.scope === 'excluded') phase.append(element('span', '本地长期排除', { class: 'stale' }))
      const time = element('td');time.append(timestamp(row.changed_at))
      tr.append(name, phase, element('td', countsLabel(row), { class: 'local-counts' }), element('td', row.weight), time);return tr
    }))
    $('community-empty').hidden = data.total !== 0
    $('community-range').textContent = data.total ? `${communityState.offset + 1}–${Math.min(communityState.offset + 50, data.total)} / ${data.total}` : '0 / 0'
    $('community-prev').disabled = communityState.offset === 0;$('community-next').disabled = communityState.offset + 50 >= data.total
    const url = new URL(location.href)
    for (const key of communityFilters) url.searchParams.delete('community-' + key)
    for (const [key, value] of query) if (communityFilters.includes(key)) url.searchParams.set('community-' + key, value)
    history.replaceState(null, '', url)
  } catch (error) { $('community-notice').textContent = error.message;$('community-summary').textContent = '读取失败，已有 PR 清单仍可查看。' }
}
async function openDesign(id) {
  for (const key of communityFilters) { const input = $('community-' + key);if (input.type === 'checkbox') input.checked = false;else input.value = key === 'kind' ? 'design' : '' }
  communityState.offset = 0;setView('community');await loadCommunity()
  await showCommunityEntry({ entry_kind: 'design', id, key: 'design:' + id })
}
async function showCommunityEntry(entry) {
  const key = entry.key;communityState.selected = key
  try {
    const row = entry.entry_kind === 'design' ? await request('/api/design/' + entry.id) : { ...entry, ...(await request('/api/pr/' + entry.number)) }
    if (communityState.selected !== key) return
    const section = $('community-detail');section.replaceChildren()
    const head = element('div', null, { class: 'detail-head' }), titles = element('div'), close = element('button', '关闭', { class: 'secondary' })
    close.addEventListener('click', () => { communityState.selected = null;section.replaceChildren(element('p', '选择一项功能，比较本地差异和来源。'));const url = new URL(location.href);url.searchParams.delete('entry');history.replaceState(null, '', url) })
    titles.append(element('h2', row.title), element('p', `上游实现阶段：${row.effective_stage || '待核实'}${row.needs_review ? ' · 说明待重审' : ''}`), element('p', '本地相关实现 PR：' + countsLabel(row)))
    if (row.document_state === 'deleted') titles.append(element('p', '此设计已从上游删除，以下保留最后版本供核对。', { class: 'stale' }))
    if (row.scope === 'excluded') titles.append(element('p', '本地长期排除范围，保留社区信息供了解。', { class: 'stale' }))
    head.append(titles, close);section.append(head)
    copySection(section, '这一来源区间改了什么', row.change_summary)
    copySection(section, '这项功能有什么用', row.purpose);copySection(section, '具体使用场景', row.scenario)
    copySection(section, '上游阶段的依据', row.stage_evidence);copySection(section, '使用条件与限制', row.limitations)
    copySection(section, '本地适配与判断建议', row.local_notes || row.local_difference)
    if (entry.entry_kind === 'design') {
      const links = element('div', null, { class: 'source-links' });links.append(sourceLink('固定版本设计原文 ↗', row.url));section.append(links)
      section.append(relationSection('相关实现 PR：采用状态、原因和解决方式', row.relatedPRs, '尚未关联已登记实现 PR；不能根据设计文档本身认定本地采用。'))
      section.append(relationSection('设计更新 PR：用于核对文档变化', row.designChanges, '没有已登记的设计变更 PR。'))
      section.append(rawSource('阅读设计原文（本地缓存）', row.body))
    } else {
      section.append(relationSection('本地 PR 判断与选择入口', [row], '暂无记录'), renderPRDesigns(row, JSON.parse(row.upstream_json || '{}')))
    }
    section.scrollTop = 0
    if (innerWidth <= 1000) section.scrollIntoView({ block: 'start' })
    const url = new URL(location.href);url.searchParams.set('entry', key);history.replaceState(null, '', url)
    for (const tr of $('community-rows').children) tr.toggleAttribute('data-selected', tr.dataset.entryKey === key)
  } catch (error) { $('community-notice').textContent = error.message }
}
async function startCommunity() {
  const saved = new URLSearchParams(location.search)
  for (const key of communityFilters) if (saved.has('community-' + key)) { const input = $('community-' + key);if (input.type === 'checkbox') input.checked = saved.get('community-' + key) === '1';else input.value = saved.get('community-' + key) }
  setView(saved.get('view') || (/^#pr-/.test(location.hash) ? 'prs' : 'community'))
  await loadCommunity()
  const entry = saved.get('entry'), found = communityState.rows.find(row => row.key === entry)
  if (found) await showCommunityEntry(found)
  else if (/^design:\d+$/.test(entry || '')) await showCommunityEntry({ key: entry, id: Number(entry.split(':')[1]), entry_kind: 'design' })
}
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => setView(button.dataset.view))
let communityTimer
for (const key of communityFilters) $('community-' + key).addEventListener(key === 'q' ? 'input' : 'change', () => { clearTimeout(communityTimer);communityState.offset = 0;communityTimer = setTimeout(loadCommunity, key === 'q' ? 180 : 0) })
$('community-clear').addEventListener('click', () => { for (const key of communityFilters) { const input = $('community-' + key);if (input.type === 'checkbox') input.checked = false;else input.value = '' }communityState.offset = 0;loadCommunity() })
$('community-prev').addEventListener('click', () => { communityState.offset = Math.max(0, communityState.offset - 50);loadCommunity() })
$('community-next').addEventListener('click', () => { communityState.offset += 50;loadCommunity() })
void startCommunity()

$('community-standalone').addEventListener('click', () => { $('community-kind').value = 'pr';$('community-q').value = '';communityState.offset = 0;loadCommunity() })

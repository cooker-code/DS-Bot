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
async function loadMeta() {
  meta = await request('/api/meta')
  $('context').textContent = `${meta.branch} · 本地 SQLite · 共 ${meta.total} 个 PR`
  $('counts').textContent = Object.entries(meta.statuses).map(([name, count]) => `${name} ${count}`).join(' / ')
  $('pending').textContent = meta.pendingExport ? `${meta.pendingExport} 次变更待更新记录` : '同步记录已对齐'
  $('export').disabled = !meta.pendingExport
  $('storage').textContent = `来源：${meta.source.canonical_url} / ${meta.source.branch}；完整盘点终点：${meta.source.checkpoint_sha || '尚未建立'}。数据库：${meta.database}。执行工作树：${meta.repo}。`
  if ($('group').options.length === 1) for (const group of meta.groups) $('group').append(element('option', group, { value: group }))
}
function parameters() {
  const query = new URLSearchParams({ offset, limit: 50 })
  for (const key of filters) {
    const input = $(key), value = input.type === 'checkbox' ? (input.checked ? '1' : '') : input.value
    if (value) query.set(key, value)
  }
  return query
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
      tr.append(number, title, status, element('td', row.wanted === 0 ? '不需要' : row.wanted === 1 ? '需要' : '待评估'), element('td', row.weight), element('td', row.dependency_group || '—'))
      return tr
    })
    $('rows').replaceChildren(...nodes)
    $('empty').hidden = !!nodes.length
    $('summary').textContent = `匹配 ${total} 个 PR · 已标记不需要 ${meta?.notWanted ?? 0} 个`
    $('range').textContent = total ? `${offset + 1}–${Math.min(offset + 50, total)} / ${total}` : '0 / 0'
    $('prev').disabled = offset === 0; $('next').disabled = offset + 50 >= total
    const query = parameters();query.delete('offset');query.delete('limit')
    history.replaceState(null, '', '?' + query + (selected ? '#pr-' + selected : ''))
  } catch (error) { if (current === generation) { message(error.message, true); $('summary').textContent = '读取失败，可调整筛选后重试' } }
}
async function showDetail(number, focus = false) {
  selected = number
  try {
    const row = await request('/api/pr/' + number)
    if (selected !== number) return
    const head = element('div', null, { class: 'detail-head' })
    const titles = element('div');titles.append(element('a', `PR #${number} ↗`, { href: row.url, target: '_blank', rel: 'noopener noreferrer' }), element('h2', row.title), element('p', `${row.status} · 权重 ${row.weight} · ${row.dependency_group || '未分组'}`))
    const close = element('button', '关闭', { class: 'secondary' });close.addEventListener('click', () => { selected = null; $('detail').replaceChildren(element('p', '选择一项 PR，查看功能和本地差异。')); loadRows() })
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
    const files = element('details');files.append(element('summary', '上游来源和涉及文件'), element('p', source.sha || '尚待核对', { class: 'detail-copy' }), element('p', (source.files || []).join('\n'), { class: 'detail-copy' }), element('p', source.body || '', { class: 'detail-copy' }))
    contents.push(files, element('h3', '最近记录'))
    const events = element('ol', null, { class: 'history' })
    for (const item of row.history.slice(0, 20)) events.append(element('li', `${item.recorded_at} · ${item.actor} · ${item.kind}`))
    contents.push(events)
    $('detail').replaceChildren(...contents)
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

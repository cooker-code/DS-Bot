// Old receipts name the report once and then list screenshots in that directory.
// Only serve files named by the saved round and inside its recorded working folder.
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { within } from './folders.js'

const types = { '.md': 'text/markdown', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const unavailable = () => Object.assign(new Error('Result file unavailable'), { code: 'bot/not-found' })

function receiptFiles(room, card, round, number) {
  const binding = round.planNode
  const node = binding && card.plans?.find(plan => plan.version === binding.version)?.nodes[binding.node - 1]
  const root = round.workspace?.workDir || binding?.workDir || node?.workDir || card.workspace?.workDir || room.workDir
  if (!root) return []
  const receipt = [round.result, binding?.feedback, binding?.block?.evidence, ...(round.validation?.passed ?? []).map(check => check.evidence)].filter(Boolean).join('\n')
  const names = [...receipt.matchAll(/(?:<([^<>\n]+?\.(?:md|png|jpe?g|gif|webp))>|`([^`\n]+?\.(?:md|png|jpe?g|gif|webp))`|([^\s<>()`"'，、；：。,【】]+?\.(?:md|png|jpe?g|gif|webp))(?=$|[\s)>,;:，、；：。】]))/gi)]
    .map(match => match[1] ?? match[2] ?? match[3]).filter(path => !path.includes('://'))
  const reports = [...new Set(names.filter(path => extname(path).toLowerCase() === '.md').map(path => dirname(resolve(root, path))))]
  const files = new Map()
  for (const name of names) {
    const mime = types[extname(name).toLowerCase()]
    const base = mime !== 'text/markdown' && name === basename(name) && reports.length === 1 ? reports[0] : root
    const path = resolve(base, name)
    if (!within(path, root)) continue
    const id = number + '-' + createHash('sha256').update(path).digest('hex')
    files.set(id, { id, root, path, name: basename(path), mime, kind: mime === 'text/markdown' ? 'markdown' : 'image' })
  }
  return [...files.values()]
}

async function readBytes(rt, file, limit) {
  const root = await realpath(file.root)
  const path = await realpath(file.path)
  if (!within(path, root) || await rt.inData(path) || await rt.privateClash(path)) throw unavailable()
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 25 * 1024 * 1024) throw unavailable()
    const bytes = Buffer.alloc(Math.min(limit, stat.size))
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) throw unavailable()
      offset += bytesRead
    }
    return bytes
  } finally { await handle.close() }
}

export async function readReceiptFile(rt, room, card, id) {
  const number = Number(String(id).split('-')[0])
  const round = card.rounds?.[number - 1]
  const file = round && receiptFiles(room, card, round, number).find(file => file.id === id)
  if (!file) throw unavailable()
  try {
    const bytes = await readBytes(rt, file, Infinity)
    return file.kind === 'image' ? 'data:' + file.mime + ';base64,' + bytes.toString('base64') : bytes.toString('utf8')
  } catch { throw unavailable() }
}

function reportChecks(text) {
  const section = text.split(/^#{1,6}\s+(?:验收结果|Acceptance results)\s*$/im)[1]?.split(/^#{1,6}\s/m)[0]
  if (!section) return []
  const rows = section.split('\n').filter(line => line.trim().startsWith('|')).map(line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()))
  const header = rows.findIndex(cells => cells.some(cell => /^(结果|result|status)$/i.test(cell)))
  if (header < 0) return []
  const column = rows[header].findIndex(cell => /^(结果|result|status)$/i.test(cell))
  return rows.slice(header + 2).filter(cells => cells[0] && cells[column]).map(cells => cells[0] + ' · ' + cells[column])
}

function briefChecks(round) {
  if (round.planNode?.feedback) return [round.planNode.feedback]
  if (round.validation?.passed?.length) return round.validation.passed.map(check => check.name)
  const text = round.result ?? ''
  const items = text.split(/\r?\n/).filter(line => /^\s*(?:\d+[.)、]|[-*])\s*/.test(line))
  if (items.length) return items.map(line => line.replace(/^\s*(?:\d+[.)、]|[-*])\s*/, ''))
  return [text.split(/[；;。\n]|\.\s/)[0]].filter(Boolean)
}

export async function taskResultView(rt, room, card, detail) {
  const nodes = detail.plans?.at(-1)?.nodes ?? []
  const reviews = nodes.filter(node => node.independentReview || node.mergeToDev)
  const numbers = reviews.length ? reviews.filter(node => node.status !== 'omitted').map(node => node.round)
    : nodes.length ? nodes.filter(node => node.status !== 'omitted').map(node => node.round) : detail.rounds.map((_, index) => index + 1)
  const groups = []
  for (const number of new Set(numbers)) {
    const round = detail.rounds[number - 1]
    if (!round?.result && !round?.planNode?.feedback) continue
    const stored = round.resultFiles ?? []
    const files = receiptFiles(room, card, round, number).filter(file => !stored.some(saved => saved.name === file.name))
    let items = []
    if (!round.planNode?.feedback) {
      for (const file of files.filter(file => file.kind === 'markdown')) {
        try { items = reportChecks((await readBytes(rt, file, 65536)).toString('utf8')) } catch { continue }
        if (items.length) break
      }
    }
    groups.push({ items: items.length ? items : briefChecks(round), files: [...stored,
      ...files.map(({ id, name, kind }) => ({ receiptFile: id, name, kind }))] })
  }
  return groups
}

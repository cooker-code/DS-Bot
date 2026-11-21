import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { within } from './folders.js'

const images = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
const maxBytes = 25 * 1024 * 1024

export async function snapshotResultFiles(rt, directory, paths) {
  if (!directory || !Array.isArray(paths) || paths.length > 16 || new Set(paths).size !== paths.length || paths.some(path => typeof path !== 'string' || !path.trim()))
    throw new Error('Choose up to 16 distinct result files in the assigned working folder.')
  const root = await realpath(directory)
  const files = []
  const attachments = rt.ctx.get('attachments')
  for (const path of paths) {
    const file = await realpath(resolve(root, path))
    const extension = extname(path).toLowerCase()
    if (!within(file, root) || await rt.inData(file) || await rt.privateClash(file) ||
        (!Object.hasOwn(images, extension) && extension !== '.md'))
      throw new Error('Choose a Markdown document or screenshot in the assigned project folder.')
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > maxBytes) throw new Error('Choose a regular result file up to 25 MB.')
      const chunks = []
      let size = 0
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        size += chunk.length
        if (size > maxBytes) throw new Error('Choose a result file up to 25 MB.')
        chunks.push(chunk)
      }
      const name = basename(path)
      const payload = { name, data: Buffer.concat(chunks), mediaType: images[extension] ?? 'text/markdown' }
      const ref = images[extension] ? await attachments.saveImage(payload) : await attachments.saveFile(payload)
      files.push({ path, name, kind: images[extension] ? 'image' : 'markdown', ref })
    } finally { await handle.close() }
  }
  return files
}

export async function readResultDocument(rt, card, id, signal) {
  const document = card.rounds?.flatMap(round => round.resultFiles ?? []).find(file => file.kind === 'markdown' && file.ref.attachmentId === id)
  if (!document) throw Object.assign(new Error('Document unavailable'), { code: 'bot/not-found' })
  const chunks = []
  for await (const chunk of rt.ctx.get('attachments').readFileStream(document.ref, signal)) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

import { open, readFile, stat } from 'node:fs/promises'
import { HISTORY_TIMEOUT_MS } from './constants.js'

const mediaOf = attachment => attachment?.mediaType ?? attachment?.mime ?? attachment?.mimeType
const FILE_DOWNLOAD_MAX = 16 * 1024 * 1024 // Compatibility for older, whole-file clients.
const FILE_CHUNK_BYTES = 512 * 1024
const FILE_MIMES = { pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp3: 'audio/mpeg', mp4: 'video/mp4' }
const nameOf = value => String(value).split(/[\\/]/).pop() || 'file'
const mimeOf = value => FILE_MIMES[(nameOf(value).split('.').pop() ?? '').toLowerCase()] ?? 'application/octet-stream'
const tooLarge = () => Object.assign(new Error('This file is too large to save here (over 16 MB)'), { code: 'bot/refused' })
const unavailable = () => Object.assign(new Error('This file is no longer available'), { code: 'bot/not-found' })

export async function fileDownload(rt, body) {
  const { ctx } = rt
  const chunked = body.offset !== undefined
  const offset = chunked ? body.offset : 0
  if (!Number.isSafeInteger(offset) || offset < 0) throw Object.assign(new Error('Invalid file offset'), { code: 'bot/invalid' })
  const attachments = ctx.get?.('attachments')
  if (attachments === undefined) throw Object.assign(new Error('Attachments unavailable'), { code: 'bot/refused' })
  const attachmentId = typeof body.attachmentId === 'string' ? body.attachmentId : undefined
  const presentedSeq = Number.isInteger(body.seq) ? body.seq : undefined
  const presentedIndex = Number.isInteger(body.index) ? body.index : 0
  if (attachmentId === undefined && presentedSeq === undefined) throw Object.assign(new Error('No file named'), { code: 'bot/invalid' })
  const sessionId = String(body.sessionId ?? '')
  const groupOwner = rt.groupOwners?.get(sessionId)
  const pastOwner = rt.pastOwners.get(sessionId)
  const memberBotId = groupOwner?.botId ?? (pastOwner?.roomId !== undefined ? pastOwner.botId : undefined)
  const room = rt.roomOf(sessionId) ?? rt.roomOf(groupOwner?.roomId ?? pastOwner?.roomId)
  const botId = memberBotId ?? (room === undefined
    ? rt.chatOwners.get(sessionId) ?? pastOwner?.botId ?? rt.botOf(sessionId)?.id
    : undefined)
  if (botId === undefined && room === undefined) throw Object.assign(new Error('Unknown session'), { code: 'bot/not-found' })
  const owned = new Set([
    ...(room !== undefined && memberBotId === undefined ? [rt.sessionOfRoom(room)] : []),
    ...(room !== undefined && memberBotId !== undefined && room.sessions?.[memberBotId] ? [room.sessions[memberBotId]] : []),
    ...(room === undefined && botId !== undefined ? [rt.chatOf(botId)] : []),
    ...rt.partsOf(botId, room?.id).map(part => part.sessionId),
  ].filter(Boolean))
  // Presented files keep their own part's sessionId, because seq is local to one Session.
  if (presentedSeq !== undefined && !owned.has(sessionId)) throw unavailable()
  const sessions = presentedSeq !== undefined ? [sessionId] : [...owned].reverse()
  for (const targetId of sessions) {
    let beforeSeq
    for (;;) {
      const page = await ctx.sessionController.page({
        address: { kind: 'session', sessionId: targetId },
        ...(beforeSeq !== undefined ? { beforeSeq } : {}),
        maxMessages: 500,
      }, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
      for (const record of page.records) {
        const event = record.event
        if (presentedSeq !== undefined && event?.type === 'deliverables/presented' && Number(event.seq) === presentedSeq) {
          const file = Array.isArray(event.data?.files) ? event.data.files[presentedIndex] : undefined
          if (typeof file?.path !== 'string') continue
          const realPath = await rt.real?.(file.path)
          if (realPath && await rt.inData?.(realPath)) throw unavailable()
          const info = await stat(realPath ?? file.path).catch(() => undefined)
          if (info?.isFile() !== true) throw unavailable()
          if (chunked) {
            const version = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`
            if (body.version !== undefined && body.version !== version) throw unavailable()
            if (offset > info.size) throw unavailable()
            const handle = await open(realPath ?? file.path, 'r')
            try {
              const bytes = Buffer.alloc(Math.min(FILE_CHUNK_BYTES, info.size - offset))
              const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset)
              if (bytesRead !== bytes.length) throw unavailable()
              return { name: file.name || nameOf(file.path), mime: mimeOf(file.path), bytes: bytes.toString('base64'), size: info.size, version, nextOffset: offset + bytesRead, done: offset + bytesRead === info.size }
            } finally { await handle.close() }
          }
          if (info.size > FILE_DOWNLOAD_MAX) throw tooLarge()
          const bytes = await readFile(realPath ?? file.path)
          return { name: typeof file.name === 'string' && file.name !== '' ? file.name : nameOf(file.path), mime: mimeOf(file.path), bytes: bytes.toString('base64'), size: bytes.length }
        }
        if (attachmentId === undefined) continue
        const content = Array.isArray(event?.data?.content) ? event.data.content : []
        for (const block of content) {
          if (block?.type !== 'file' || String(block.attachment?.attachmentId) !== attachmentId) continue
          if (chunked) {
            // Attachment ids are content hashes. Stream only as far as this chunk needs.
            const chunks = []
            let seen = 0
            let length = 0
            for await (const chunk of attachments.readFileStream(block.attachment, AbortSignal.timeout(HISTORY_TIMEOUT_MS))) {
              const start = Math.max(0, offset - seen)
              seen += chunk.length
              const data = Buffer.from(chunk).subarray(start, start + FILE_CHUNK_BYTES - length)
              if (data.length > 0) { chunks.push(data); length += data.length }
              if (length === FILE_CHUNK_BYTES) break
            }
            const size = block.attachment.bytes
            if (offset > size || (length === 0 && offset < size)) throw unavailable()
            const nextOffset = offset + length
            return { name: nameOf(block.attachment.name), mime: mediaOf(block.attachment) ?? mimeOf(block.attachment.name), bytes: Buffer.concat(chunks).toString('base64'), size, version: attachmentId, nextOffset, done: nextOffset >= size }
          }
          const chunks = []
          let size = 0
          for await (const chunk of attachments.readFileStream(block.attachment, AbortSignal.timeout(HISTORY_TIMEOUT_MS))) {
            size += chunk.length
            if (size > FILE_DOWNLOAD_MAX) throw tooLarge()
            chunks.push(Buffer.from(chunk))
          }
          const bytes = Buffer.concat(chunks)
          return { name: nameOf(block.attachment.name ?? 'file'), mime: mediaOf(block.attachment) ?? mimeOf(block.attachment.name ?? ''), bytes: bytes.toString('base64'), size: bytes.length }
        }
      }
      if (page.hasMore !== true) break
      beforeSeq = page.records[0]?.event?.seq
      if (beforeSeq === undefined) break
    }
  }
  throw unavailable()
}

// An import is published in the team catalog only after the whole folder is on disk.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parse } from 'yaml'

export const folderRoot = (home, id) => {
  if (!/^import-[a-zA-Z0-9]{6}$/.test(id)) throw new Error('Invalid imported skill folder.')
  return join(home, 'skill-folders', id)
}

export async function importSkillFiles(home, files, validateName) {
  if (!Array.isArray(files) || !files.length) throw new Error('Choose a folder containing SKILL.md.')
  const manifest = files.find(file => file?.path === 'SKILL.md')
  if (!manifest || manifest.directory === true || typeof manifest.bytes !== 'string') throw new Error('The selected folder needs a SKILL.md at its root.')
  const raw = Buffer.from(manifest.bytes, 'base64').toString('utf8')
  const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(raw)
  if (!header) throw new Error('SKILL.md needs a name and description in its YAML header.')
  let metadata
  try { metadata = parse(header[1], { maxAliasCount: 0 }) } catch { throw new Error('Invalid YAML header in SKILL.md.') }
  if (typeof metadata?.name !== 'string') throw new Error('Enter a name in SKILL.md.')
  const name = validateName(metadata.name)
  if (typeof metadata.description !== 'string' || !metadata.description.trim()) throw new Error('Enter a description in SKILL.md.')
  const parent = join(home, 'skill-folders')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, 'import-'))
  try {
    for (const file of files) {
      const path = file?.path
      if (typeof path !== 'string' || /[\\:\p{Cc}]/u.test(path)
        || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
          || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Invalid file path in skill folder.')
      const target = join(root, name, path)
      if (file.directory === true) {
        await mkdir(target, { recursive: true })
        continue
      }
      if (typeof file.bytes !== 'string') throw new Error('Invalid file in skill folder.')
      const bytes = Buffer.from(file.bytes, 'base64')
      if (bytes.toString('base64') !== file.bytes) throw new Error('Incomplete file in skill folder.')
      await mkdir(dirname(target), { recursive: true })
      const executable = path.startsWith('scripts/') || path.startsWith('bin/') || bytes.subarray(0, 2).toString() === '#!'
      await writeFile(target, bytes, { flag: 'wx', mode: executable ? 0o700 : 0o600 })
    }
    return { name, kind: 'skill', description: metadata.description.trim(), content: raw.slice(header[0].length).trim(), folderId: basename(root) }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export const outlineFile = 'outline.md'
export const maxOutlineBytes = 32 * 1024
const sha256 = content => createHash('sha256').update(content).digest('hex')

function identifier(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(id)) throw new Error('工作目录标识无效')
  return id
}

function privateDirectory(path, create) {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 })
  const stats = lstatSync(path)
  if (!stats.isDirectory() || realpathSync(path) !== path) throw new Error('工单工作目录未通过校验')
  return path
}

function readText(path) {
  let handle
  try {
    handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stats = fstatSync(handle)
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > maxOutlineBytes) throw new Error('提纲须为工作目录内的普通文件')
    return readFileSync(handle, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    if (error.code === 'ELOOP') throw new Error('提纲须为工作目录内的普通文件', { cause: error })
    throw error
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
}

function validate(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > maxOutlineBytes
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) throw new Error('提纲必须为 32 KB 以内的 Markdown 文本')
  const [heading, ...body] = content.trim().split(/\r?\n/)
  if (!/^#{1,6} +\S/.test(heading) || !body.some(line => line.trim())) throw new Error('提纲需要 Markdown 标题和正文')
}

function writeAtomic(path, content, mode) {
  const temporary = `${path}.${randomUUID()}`
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function documentWork({ workRoot, documentRoot, materials = {} }) {
  const configuredRoot = documentRoot ?? (isAbsolute(workRoot ?? '') ? join(workRoot, 'documents') : '')
  if (!isAbsolute(configuredRoot)) throw new Error('提纲交付目录须使用绝对路径')
  mkdirSync(configuredRoot, { recursive: true, mode: 0o700 })
  const root = realpathSync(configuredRoot)
  const directoryFor = id => join(root, identifier(id))
  function workspace(ticket, create = false) {
    const directory = directoryFor(ticket.id)
    if (ticket.execution?.directory !== directory) throw new Error('工单工作目录不匹配')
    return privateDirectory(directory, create)
  }
  function draftPath(directory, assignment, create) {
    const drafts = privateDirectory(join(directory, 'drafts'), create)
    return join(privateDirectory(join(drafts, identifier(assignment)), create), outlineFile)
  }
  function snapshotPath(directory, hash, create) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('交付内容标识无效')
    const deliveries = privateDirectory(join(directory, 'deliveries'), create)
    return join(privateDirectory(join(deliveries, hash), create), outlineFile)
  }
  return {
    root,
    directoryFor,
    prepare(ticket) {
      workspace(ticket, true)
    },
    materials(ids) {
      if (!Array.isArray(ids)) return []
      return [...new Set(ids)].slice(0, 10).flatMap(id => {
        if (typeof id !== 'string' || !Object.hasOwn(materials, id)) return []
        const entry = materials[id]
        if (typeof entry?.name !== 'string' || typeof entry.text !== 'string' || Buffer.byteLength(entry.text) > 16 * 1024) return []
        return [{ id, name: entry.name, text: entry.text }]
      })
    },
    write(ticket, assignment, content) {
      validate(content)
      const path = draftPath(workspace(ticket), assignment, true)
      const markdown = content.endsWith('\n') ? content : content + '\n'
      validate(markdown)
      writeAtomic(path, markdown, 0o600)
      return { file: outlineFile, bytes: Buffer.byteLength(markdown), path }
    },
    verifyRecorded(ticket, hash) {
      const path = snapshotPath(workspace(ticket), hash, false)
      const content = readText(path)
      if (content === undefined || sha256(content) !== hash) throw new Error('已记录的提纲快照无法校验')
      return path
    },
    snapshot(ticket, assignment, previous, recoverFrom = []) {
      const directory = workspace(ticket)
      let content
      for (const attempt of [assignment, ...recoverFrom]) {
        try {
          content = readText(draftPath(directory, attempt, false))
          if (content !== undefined) break
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
      if (content === undefined) throw new Error('本轮尚未写出提纲，请先调用 hnu_write_outline')
      validate(content)
      const hash = sha256(content)
      if (hash === previous?.commit) throw new Error('新版提纲与上一版内容相同，请按修改意见更新')
      const path = snapshotPath(directory, hash, true)
      const existing = readText(path)
      if (existing === undefined) writeAtomic(path, content, 0o400)
      else if (existing !== content) throw new Error('已有交付快照无法校验')
      return {
        ticket: ticket.id, assignment, file: outlineFile, path, base: previous?.commit ?? '', commit: hash, diff: content,
        checks: [
          { command: 'Markdown 文件检查', exitCode: 0, output: `${outlineFile} · ${Buffer.byteLength(content)} 字节` },
          { command: 'SHA-256 内容校验', exitCode: 0, output: hash },
        ],
      }
    },
  }
}

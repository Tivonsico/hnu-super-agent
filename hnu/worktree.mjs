import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, resolve } from 'node:path'

function git(cwd, args, record = false) {
  const result = spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgSign=false', '-c', 'user.name=HNU Local Delivery', '-c', 'user.email=hnu@localhost', ...args], {
    cwd, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  })
  if (result.error) throw result.error
  const output = result.stdout + result.stderr
  if (record) return { command: `git ${args.join(' ')}`, exitCode: result.status, output }
  if (result.status !== 0) throw new Error(output.trim() || 'Git 命令失败')
  return result.stdout
}

export function worktrees({ repository, base, file, buttonId, workRoot }) {
  if (!isAbsolute(repository) || !isAbsolute(workRoot) || !/^[a-f0-9]{40}$/.test(base)
    || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(buttonId ?? '')
    || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(file) || file.split('/').some(part => ['.', '..', '.git'].includes(part.toLowerCase()))) {
    throw new Error('配置需要本地 Git 副本、固定提交和允许编辑的相对文件')
  }
  const noRemotes = () => {
    if (git(repository, ['remote']).trim()) throw new Error('交付仓库必须是已移除远端的独立副本')
  }
  noRemotes()
  const mode = git(repository, ['ls-tree', base, '--', file]).split(' ')[0]
  if (!['100644', '100755'].includes(mode)) {
    throw new Error('允许编辑的文件须为基线中的普通文件')
  }
  mkdirSync(workRoot, { recursive: true, mode: 0o700 })
  const root = realpathSync(workRoot)
  const button = new RegExp('(<button\\b[^<>]*\\sid="' + buttonId + '"[^<>]*>)([^<>&]+)(</button>)', 'g')
  function labelMatch(text) {
    const matches = [...text.matchAll(button)]
    if (matches.length !== 1) throw new Error('配置的按钮文案必须唯一匹配')
    return matches[0]
  }
  const [, , baselineLabel] = labelMatch(git(repository, ['show', `${base}:${file}`]))
  function target(ticket) {
    const directory = ticket.execution?.directory
    if (typeof directory !== 'string' || dirname(directory) !== root || realpathSync(directory) !== directory) {
      throw new Error('工单目录未通过路径校验')
    }
    const path = resolve(directory, file)
    const stats = lstatSync(path)
    if (!stats.isFile() || realpathSync(path) !== path || stats.size > 96 * 1024 || stats.nlink !== 1) {
      throw new Error('文件未通过路径和大小检查')
    }
    return { directory, path, stats }
  }
  return {
    root, file, buttonId, baselineLabel,
    prepare(ticket) {
      noRemotes()
      const directory = ticket.execution?.directory
      if (typeof directory !== 'string' || dirname(directory) !== root) throw new Error('工单目录不在交付根目录内')
      git(repository, ['worktree', 'add', '--detach', '--', directory, base])
      target(ticket)
    },
    read(ticket) {
      const [, , label] = labelMatch(readFileSync(target(ticket).path, 'utf8'))
      return { file, buttonId, label }
    },
    replace(ticket, before, after) {
      if (!before || before === after || !after.trim() || after.length > 120 || /[<>&\p{Cc}]/u.test(after)) {
        throw new Error('只允许替换按钮的纯文本文案')
      }
      const { path, stats } = target(ticket)
      const text = readFileSync(path, 'utf8')
      const match = labelMatch(text)
      if (match[2] !== before) throw new Error('按钮原文已变化，请重新读取')
      const offset = match.index + match[1].length
      const content = text.slice(0, offset) + after + text.slice(offset + before.length)
      if (Buffer.byteLength(content) > 96 * 1024) throw new Error('文件超过大小限制')
      const temporary = path + '.' + randomUUID()
      try {
        writeFileSync(temporary, content, { flag: 'wx', mode: stats.mode & 0o777 })
        renameSync(temporary, path)
      } finally {
        rmSync(temporary, { force: true })
      }
      return { changed: file }
    },
    verifyRecorded(ticket, commit) {
      const { directory } = target(ticket)
      if (git(directory, ['rev-parse', 'HEAD']).trim() !== commit || git(directory, ['status', '--porcelain=v1', '-z'])) {
        throw new Error('恢复中的交付提交与工作目录不一致')
      }
    },
    snapshot(ticket, assignment, previous, recoverFrom = []) {
      const { directory, path } = target(ticket)
      const parent = previous?.commit ?? base
      const head = git(directory, ['rev-parse', 'HEAD']).trim()
      if (head !== parent) {
        const subject = git(directory, ['log', '-1', '--format=%s']).trim()
        if (git(directory, ['rev-list', '--parents', '-n', '1', head]).trim() !== `${head} ${parent}`
          || ![assignment, ...recoverFrom].some(id => subject === `HNU delivery ${id}`)) throw new Error('交付基线已变化')
      }
      const changes = git(directory, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
        .split('\0').filter(Boolean)
      if (changes.some(entry => ![' M ', 'M  ', 'MM '].some(prefix => entry === prefix + file))) {
        throw new Error('工单目录有未授权改动')
      }
      if (head === parent && changes.length === 0) throw new Error('没有可交付的改动')
      if (head !== parent && changes.length) throw new Error('已有交付提交，工作目录又发生改动')
      const original = git(directory, ['show', `${base}:${file}`])
      const current = readFileSync(path, 'utf8')
      const match = labelMatch(current)
      const expected = original.replace(button, (_tag, open, _label, close) => open + match[2] + close)
      if (expected !== current || /[<>&\p{Cc}]/u.test(match[2]) || match[2].length > 120) {
        throw new Error('宿主确认交付只包含指定按钮文案的改动')
      }
      if (head === parent) {
        git(directory, ['add', '--', file])
        git(directory, ['commit', '-m', `HNU delivery ${assignment}`, '--', file])
      }
      const commit = git(directory, ['rev-parse', 'HEAD']).trim()
      const changed = git(directory, ['diff', '--name-status', '--no-renames', '-z', parent, commit])
      if (changed !== `M\0${file}\0` || git(directory, ['ls-tree', commit, '--', file]).split(' ')[0] !== mode
        || git(directory, ['show', `${commit}:${file}`]) !== expected) {
        throw new Error('交付提交包含未授权改动')
      }
      const checks = [git(directory, ['diff', '--check', base, commit], true)]
      const diff = git(directory, ['diff', '--no-ext-diff', '--no-textconv', base, commit])
      return { ticket: ticket.id, assignment, base, commit, diff, checks }
    },
  }
}

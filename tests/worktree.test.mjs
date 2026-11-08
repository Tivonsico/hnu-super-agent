import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { worktrees } from '../hnu/worktree.mjs'
import { denyManagedTool } from '../plugins/hnu-companion/guard.mjs'

test('the host commits only one configured button label in a detached worktree', t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hnu-worktree-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const repository = join(dir, 'local')
  const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', repository)
  const file = 'index.html'
  writeFileSync(join(repository, file), '<p>保存</p>\n<button id="save">保存</button>\n')
  git('-C', repository, 'add', file)
  git('-C', repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgSign=false', 'commit', '-qm', 'baseline')
  const base = git('-C', repository, 'rev-parse', 'HEAD')
  const work = worktrees({ repository, base, file, buttonId: 'save', workRoot: join(dir, 'work') })
  const ticket = { id: 'fixture', execution: { directory: join(work.root, 'one') } }
  work.prepare(ticket)
  assert.throws(() => work.replace(ticket, '保存', '<script>'), /纯文本/)
  work.replace(ticket, '保存', '保存设置')
  const delivery = work.snapshot(ticket, 'first')
  assert.equal(delivery.checks[0].exitCode, 0)
  assert.match(delivery.diff, /\+<button id="save">保存设置<\/button>/)
  assert.equal(work.snapshot(ticket, 'first').commit, delivery.commit)
  assert.equal(git('-C', repository, 'rev-parse', 'HEAD'), base)
  writeFileSync(join(ticket.execution.directory, file), '<script>unexpected</script>\n<button id="save">保存设置</button>\n')
  assert.throws(() => work.snapshot(ticket, 'second', delivery), /指定按钮/)
})

test('DSSA managed agent tools deny shell, network and arbitrary file reads', () => {
  for (const id of ['orchestrator-fixture', 'worker-fixture']) {
    for (const name of ['bash', 'web', 'read', 'run_code', 'hnu_approve']) {
      assert.match(denyManagedTool({ agent: { id }, name }), /cannot use/)
    }
    for (const resource of ['github/issue/1', 'feishu/test/messages']) {
      assert.match(denyManagedTool({ agent: { id }, name: 'orchestrator_read', arguments: { resource } }), /external source/)
    }
    assert.equal(denyManagedTool({ agent: { id }, name: 'orchestrator_read', arguments: { resource: 'ticket/test' } }), undefined)
  }
  assert.equal(denyManagedTool({ agent: { id: 'worker-fixture' }, name: 'hnu_write_outline' }), undefined)
})

test('the router can only accept or ignore explicitly confirmed QQ requests', () => {
  const agent = { id: 'orchestrator-fixture' }
  const route = (kind, trigger_id) => denyManagedTool({
    agent, name: 'orchestrator_route', arguments: { decisions: [{ kind, trigger_id }] },
  })
  assert.equal(route('accept', 'hnu-qq:100:200:123:manual'), undefined)
  assert.match(route('accept', 'hnu-qq:100:200:123'), /operator-confirmed/)
  assert.match(route('attach', 'hnu-qq:100:200:123:manual'), /operator-confirmed/)
  assert.match(route('stop', 'hnu-qq:100:200:123:manual'), /operator-confirmed/)
})

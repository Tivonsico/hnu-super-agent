import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { documentWork } from '../hnu/document-work.mjs'

test('the worker can deliver and revise one scoped Markdown file with immutable snapshots', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hnu-documents-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const work = documentWork({ workRoot: dir, materials: { approved: { name: '要求', text: '三段式' } } })
  const ticket = { id: 'ticket1', execution: { directory: work.directoryFor('ticket1') } }
  work.prepare(ticket)
  assert.deepEqual(work.materials(['unknown', 'approved']), [{ id: 'approved', name: '要求', text: '三段式' }])
  assert.throws(() => work.snapshot(ticket, 'round1'), /尚未/)
  assert.throws(() => work.write(ticket, 'round1', '这是空标题的内容。'), /标题/)
  const original = '# 征文提纲\n\n- 引入志愿活动经历\n'
  work.write(ticket, 'round1', original)
  const first = work.snapshot(ticket, 'round1')
  assert.match(first.commit, /^[0-9a-f]{64}$/)
  assert.equal(first.file, 'outline.md')
  assert.equal(readFileSync(first.path, 'utf8'), original)
  assert.equal(first.diff, original)
  assert.throws(() => work.snapshot(ticket, 'round2', first), /尚未/)
  work.write(ticket, 'round2', '# 征文提纲\n\n- 加入一次图书馆经历\n')
  const second = work.snapshot(ticket, 'round2', first)
  assert.notEqual(second.commit, first.commit)
  assert.equal(second.base, first.commit)
  assert.equal(readFileSync(first.path, 'utf8'), original)
  assert.equal(work.verifyRecorded(ticket, first.commit), first.path)
})

test('the Worker workspace cannot read a symlink or write to another ticket', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hnu-documents-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const work = documentWork({ workRoot: dir })
  const ticket = { id: 'ticket1', execution: { directory: work.directoryFor('ticket1') } }
  work.prepare(ticket)
  const other = { id: 'ticket2', execution: { directory: ticket.execution.directory } }
  assert.throws(() => work.write(other, 'round1', '# 不可写\n\n- 内容'), /工作目录/)
  assert.throws(() => work.directoryFor('../other'), /标识/)
  const draft = work.write(ticket, 'round1', '# 提纲\n\n- 一项内容')
  const outside = join(dir, 'outside.md')
  writeFileSync(outside, '# 外部材料\n\n- 内容')
  rmSync(draft.path)
  symlinkSync(outside, draft.path)
  assert.throws(() => work.snapshot(ticket, 'round1'), /普通文件/)
})

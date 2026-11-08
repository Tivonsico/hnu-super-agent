import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openReviews } from '../hnu/reviews.mjs'

test('a revision supersedes the old commit and repeated approval is idempotent after restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hnu-review-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'reviews.sqlite')
  let reviews = openReviews(path)
  const delivery = {
    ticket: 'qq-ticket', assignment: 'round-1', base: 'a'.repeat(40), commit: 'b'.repeat(40),
    diff: 'first diff', checks: [{ command: 'git diff --check', exitCode: 0, output: '' }],
  }
  const first = reviews.deliver(delivery)
  assert.equal(reviews.deliver(delivery).version, 1)
  assert.equal(first.status, 'pending')
  reviews.close()
  reviews = openReviews(path)
  assert.equal(reviews.current('qq-ticket').status, 'pending')
  const revision = { ticket: first.ticket, version: first.version, commit: first.commit, action: 'revise', note: 'Shorten the label' }
  assert.equal(reviews.decide(revision).status, 'revise')
  assert.equal(reviews.decide(revision).status, 'revise')
  const second = reviews.deliver({ ...delivery, assignment: 'round-2', commit: 'c'.repeat(40), diff: 'updated diff' })
  assert.equal(second.version, 2)
  assert.throws(() => reviews.decide({ ...revision, action: 'approve' }), { status: 409 })
  const approve = { ticket: second.ticket, version: 2, commit: second.commit, action: 'approve' }
  assert.equal(reviews.decide(approve).status, 'approve')
  assert.equal(reviews.decide(approve).status, 'approve')
  assert.throws(() => reviews.decide({ ...approve, action: 'reject' }), { status: 409 })
  reviews.close()
})

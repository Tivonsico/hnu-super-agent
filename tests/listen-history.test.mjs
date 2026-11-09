import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { listenHistory } from '../plugins/hnu-companion/napcat.mjs'
import { assessable } from '../plugins/hnu-companion/index.mjs'

test('history assessment requires a selected snapshot, active listening and sender permission', () => {
  const event = { id: '100:200:1', actor: '101', received_at: 10, sent_at: 1,
    message_id: '1', status: 'verified', text: '写提纲', attachments: [], role: 'owner' }
  const group = { enabled: true, enabledAt: 20, roles: ['owner'], senders: [], historyEventIds: [event.id] }
  assert.equal(assessable(event, group), true)
  assert.equal(assessable(event, { ...group, historyEventIds: [] }), false)
  assert.equal(assessable(event, { ...group, enabled: false }), false)
  assert.equal(assessable(event, { ...group, roles: [] }), false)
  assert.equal(assessable({ ...event, status: 'conflict' }, group), false)
  assert.equal(assessable(event, { ...group, enabled: false }, true), true)
  assert.equal(assessable(event, { ...group, enabled: false, roles: [] }, true), false)
})

test('QQ snapshot is bounded by start time, count and account checks', async t => {
  let account = 100
  let switchAccount = false
  const message = (id, time, extra = {}) => ({ self_id: 100, message_type: 'group', group_id: 200,
    user_id: 101, message_id: id, time, message: [], ...extra })
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { /* drain */ }
    const data = req.url === '/get_login_info' ? { user_id: account } : { messages: [
      message(1, 1), message(2, 2), message(3, 3), message(4, 4),
      message(5, 2, { self_id: 900 }), message(6, 2, { group_id: 201 }),
    ] }
    if (switchAccount && req.url !== '/get_login_info') account = 900
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data }))
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const config = { napcatRead: { url: `http://127.0.0.1:${server.address().port}/`, token: 'a'.repeat(64) } }
  assert.deepEqual((await listenHistory(config, '100', '200', 2, 3000)).map(row => row.message_id), [2, 3])
  switchAccount = true
  await assert.rejects(listenHistory(config, '100', '200', 2, 3000), { status: 409 })
})

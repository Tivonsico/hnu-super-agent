import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'
import { openQueue, receiver } from '../qq-ingest/receiver.mjs'

test('signed group reports are acknowledged empty and deduplicated across a restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hnu-onebot-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const options = { token: 'fixture-only', account: '100', groups: ['200'] }
  const event = {
    post_type: 'message', message_type: 'group', self_id: 100, group_id: 200,
    user_id: 101, message_id: -77, time: Math.floor(Date.now() / 1000),
    message: [{ type: 'text', data: { text: '把按钮文案改成保存' } }],
  }
  async function run(sendReports) {
    const queue = openQueue(join(dir, 'queue.sqlite'))
    const server = receiver(queue, options).listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      await sendReports(async (payload, token = options.token, path = '/onebot/event') => {
        const body = JSON.stringify(payload)
        return fetch(`http://127.0.0.1:${server.address().port}${path}`, {
          method: 'POST', body, headers: { 'X-Signature': 'sha1=' + createHmac('sha1', token).update(body).digest('hex') },
        })
      }, queue)
    } finally {
      await new Promise(resolve => server.close(resolve))
      queue.close()
    }
  }
  await run(async (send, queue) => {
    assert.equal((await send(event, 'forged')).status, 401)
    assert.equal((await send(event, options.token, '/send_group_msg')).status, 404)
    assert.equal((await send({ ...event, group_id: 201 })).status, 204)
    assert.equal((await send({ ...event, user_id: 100 })).status, 204)
    assert.equal(queue.events().length, 0)
    const response = await send(event)
    assert.equal(response.status, 204)
    assert.equal(await response.text(), '')
    assert.equal(queue.events()[0].actor, '101')
  })
  await run(async (send, queue) => {
    await send(event)
    assert.equal(queue.events().length, 1)
    await send({ ...event, user_id: 999 })
    assert.equal(queue.events()[0].status, 'conflict')
  })
})

test('saved group settings gate new messages and keep the signed sender role and attachment hint', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const dir = mkdtempSync(join(tmpdir(), 'hnu-onebot-groups-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const writer = openQueue(join(dir, 'queue.sqlite'))
  const queue = openQueue(join(dir, 'queue.sqlite'))
  const server = receiver(queue, { token: 'test', account: '100', dynamicGroups: true }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    writer.close()
    queue.close()
  })
  async function report(id, sender, self = 100, actor = 101, postType = 'message') {
    const body = JSON.stringify({
      post_type: postType, message_type: 'group', self_id: self, group_id: 200, user_id: actor, message_id: id,
      time: Math.floor(Date.now() / 1000), sender, message: [{ type: 'text', data: { text: '征文要求' } },
        { type: 'file', data: { name: '要求.pdf', url: 'https://not-used.invalid/private' } }],
    })
    const response = await fetch(`http://127.0.0.1:${server.address().port}/onebot/event`, {
      method: 'POST', body, headers: { 'X-Signature': 'sha1=' + createHmac('sha1', 'test').update(body).digest('hex') },
    })
    assert.equal(response.status, 204)
  }
  await report('1', { user_id: 101, role: 'owner' })
  assert.equal(queue.events().length, 0)
  const form = { id: '200', name: '群设置', version: 0, enabled: true, wasEnabled: false, mode: 'auto', roles: ['owner'], senders: [] }
  const group = writer.saveGroup(form)
  assert.equal(group.mode, 'observe')
  assert.equal(group.ttlMinutes, 30)
  assert.equal(group.expiresAt, now + 30 * 60_000)
  assert.throws(() => writer.saveGroup(form), { status: 409 })
  await report('2', { user_id: 101, role: 'owner', card: '成员甲' })
  await report('3', { user_id: 999, role: 'owner' })
  await report('7', { user_id: 100, role: 'owner' }, 100, 100, 'message_sent')
  await report('8', { user_id: 101, role: 'owner' }, 100, 101, 'message_sent')
  assert.deepEqual(queue.events().map(item => item.message_id), ['2', '3', '7'])
  assert.deepEqual(queue.unsent().map(item => item.id), ['100:200:2', '100:200:3', '100:200:7'])
  now += 60_000
  const updated = writer.saveGroup({ ...group, wasEnabled: true, ttlMinutes: 5 })
  assert.equal(updated.enabledAt, group.enabledAt)
  assert.equal(updated.expiresAt, now + 5 * 60_000)
  now += 60_000
  const renamed = writer.saveGroup({ ...updated, wasEnabled: true, name: '新群名' })
  assert.equal(renamed.expiresAt, updated.expiresAt)
  now = renamed.expiresAt
  assert.equal(queue.groups()[0].enabled, false)
  assert.throws(() => writer.saveGroup({ ...renamed, wasEnabled: true, name: '旧页面保存' }), { status: 409 })
  await report('4', { user_id: 101, role: 'owner' })
  await report('9', { user_id: 100, role: 'owner' }, 100, 100, 'message_sent')
  assert.deepEqual(queue.events().map(item => [item.message_id, item.role]), [['2', 'owner'], ['3', null], ['7', 'owner']])
  assert.equal(queue.events()[0].name, '成员甲')
  assert.deepEqual(queue.events()[0].attachments, [{ type: 'file', name: '要求.pdf' }])

  writer.selectAccount('900')
  assert.deepEqual(queue.events(), [])
  assert.deepEqual(queue.groups(), [])
  assert.deepEqual(queue.page(100, null, 10), [])
  await report('5', { user_id: 101, role: 'owner' })
  assert.equal(queue.events().length, 0)
  writer.saveGroup(form)
  await report('6', { user_id: 101, role: 'owner' }, 900)
  assert.deepEqual(queue.events().map(item => item.message_id), ['6'])

  writer.selectAccount('100')
  assert.equal(queue.group('200').enabled, false)
  assert.deepEqual(queue.events().map(item => item.message_id), ['2', '3', '7'])
  const renewed = writer.saveGroup({ ...renamed, enabled: true, wasEnabled: false })
  assert.equal(renewed.enabledAt, now)
  assert.equal(renewed.expiresAt, now + 5 * 60_000)
})

test('signed private messages create evidence only for an opted-in conversation', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hnu-onebot-private-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const queue = openQueue(join(dir, 'queue.sqlite'))
  const server = receiver(queue, { token: 'test', account: '100', dynamicGroups: true }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    queue.close()
  })
  const time = Math.floor(Date.now() / 1000)
  async function send(id, actor, extra = {}) {
    const body = JSON.stringify({ post_type: 'message', message_type: 'private', self_id: 100,
      user_id: actor, message_id: id, time, message: [{ type: 'text', data: { text: '请列出提纲' } }], ...extra })
    const response = await fetch(`http://127.0.0.1:${server.address().port}/onebot/event`, {
      method: 'POST', body, headers: { 'X-Signature': 'sha1=' + createHmac('sha1', 'test').update(body).digest('hex') },
    })
    assert.equal(response.status, 204)
  }
  await send(1, 101)
  assert.deepEqual(queue.events(), [])
  assert.equal(queue.activity()['private:101'], time)
  queue.saveGroup({ id: 'private:101', name: '联系人', enabled: true, wasEnabled: false, mode: 'observe',
    senders: ['101'], roles: [], version: 0 })
  await send(2, 101)
  await send(3, 102)
  await send(4, 100, { post_type: 'message_sent', target_id: 101 })
  assert.deepEqual(queue.events().map(item => item.id), ['100:private:101:2', '100:private:101:4'])
  assert.deepEqual(queue.unsent(), [])
})


test('starting listening imports only the requested snapshot and resets it on the next start', t => {
  let now = 1800000000000
  t.mock.method(Date, 'now', () => now)
  const queue = openQueue(':memory:')
  t.after(() => queue.close())
  queue.selectAccount('100')
  const form = { id: '200', name: '群', version: 0, enabled: true, wasEnabled: false,
    mode: 'observe', roles: ['owner'], senders: [], historyCount: 2 }
  const message = (id, extra = {}) => ({ self_id: 100, message_type: 'group', group_id: 200,
    user_id: 101, message_id: id, time: now / 1000 - 10,
    sender: { user_id: 101, role: 'owner' }, message: [{ type: 'text', data: { text: '请写提纲' } }], ...extra })
  const group = queue.saveGroup(form, [message(1), message(2), message(3), message(4, { group_id: 201 }),
    message(5, { self_id: 900 }), message(6, { time: now / 1000 + 1 })], now)
  assert.deepEqual(group.historyEventIds, ['100:200:2', '100:200:3'])
  assert.deepEqual(queue.events().map(row => row.message_id), ['2', '3'])
  assert.equal(queue.events()[0].role, 'owner')
  const saved = queue.saveGroup({ ...group, wasEnabled: true }, [message(7)], now)
  assert.deepEqual(saved.historyEventIds, group.historyEventIds)
  now += 31 * 60_000
  const next = queue.saveGroup({ ...saved, wasEnabled: false, historyCount: 0 }, [], now)
  assert.deepEqual(next.historyEventIds, [])
  assert.equal(next.historyCount, 0)
  assert.throws(() => queue.saveGroup({ ...next, wasEnabled: true, historyCount: 101 }), { status: 400 })
})

test('private snapshot preserves incoming and own messages in the selected conversation', t => {
  const queue = openQueue(':memory:')
  t.after(() => queue.close())
  queue.selectAccount('100')
  const time = Math.floor(Date.now() / 1000) - 10
  const messages = [101, 100].map((user_id, i) => ({ self_id: 100, user_id, message_id: i + 1,
    post_type: user_id === 100 ? 'message_sent' : 'message', message_type: 'private', time,
    message: [{ type: 'text', data: { text: '提纲要求' } }] }))
  const group = queue.saveGroup({ id: 'private:101', name: '会话', version: 0, enabled: true,
    wasEnabled: false, roles: [], senders: ['101'], historyCount: 20 }, messages)
  assert.deepEqual(group.historyEventIds, ['100:private:101:1', '100:private:101:2'])
})

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
  const form = { id: '200', name: '群设置', version: 0, enabled: true, mode: 'auto', roles: ['owner'], senders: [], keywords: [] }
  const group = writer.saveGroup(form)
  assert.equal(group.mode, 'observe')
  assert.throws(() => writer.saveGroup(form), { status: 409 })
  await report('2', { user_id: 101, role: 'owner', card: '成员甲' })
  await report('3', { user_id: 999, role: 'owner' })
  await report('7', { user_id: 100, role: 'owner' }, 100, 100, 'message_sent')
  await report('8', { user_id: 101, role: 'owner' }, 100, 101, 'message_sent')
  assert.deepEqual(queue.events().map(item => item.message_id), ['2', '3', '7'])
  assert.deepEqual(queue.unsent().map(item => item.id), ['100:200:2', '100:200:3', '100:200:7'])
  writer.saveGroup({ ...group, enabled: false })
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

})

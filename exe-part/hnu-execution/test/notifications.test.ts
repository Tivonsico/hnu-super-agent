import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Files } from "../src/files.ts"
import { Notifications } from "../src/notifications.ts"
import type { Notification, NotificationOutcome } from "../src/io.ts"

const setup = async () => {
  const files = new Files(await mkdtemp(join(tmpdir(), "hnu-")))
  const got: NotificationOutcome[] = []
  const n = new Notifications(files, { worker: async o => { got.push(o); return { code: "OK" } } })
  return { n, got }
}
const dl: Notification = {
  notification_id: "notice-dl-020", origin: "worker", code: "INPUT_NEEDED",
  occurred_at: "2026-11-17T20:55:01+08:00", ticket_id: "C", node_id: "C/3",
  content: "允许下载《活动名单.xlsx》吗？",
  options: [{ value: "allow", label: "允许下载" }, { value: "decline", label: "暂不下载" }],
}

test("登记去重：首次 OK，重放 REPLAYED，异内容 CONFLICT，未登记来源 INVALID_INPUT", async () => {
  const { n } = await setup()
  assert.deepEqual(await n.record(dl), { code: "OK" })
  assert.deepEqual(await n.record(dl), { code: "REPLAYED" })
  assert.deepEqual(await n.record({ ...dl, content: "别的" }), { code: "CONFLICT" })
  assert.deepEqual(await n.record({ ...dl, notification_id: "x", origin: "ghost" }), { code: "INVALID_INPUT" })
})

test("列表项用 id，去掉 notification_id，默认 pending", async () => {
  const { n } = await setup()
  await n.record(dl)
  const [item] = await n.list("pending")
  assert.equal(item.id, "notice-dl-020")
  assert.equal(item.state, "pending")
  assert.ok(!("notification_id" in item))
})

test("处理带选项通知：校验答复、置 handled、投递回执", async () => {
  const { n, got } = await setup()
  await n.record(dl)
  assert.deepEqual(await n.handle("notice-dl-020", "nope"), { code: "INVALID_INPUT" })
  assert.deepEqual(await n.handle("notice-dl-020", "allow"), { code: "OK", id: "notice-dl-020", state: "handled" })
  assert.deepEqual(got, [{ notification_id: "notice-dl-020", state: "handled", answer: "allow" }])
  // 重放同答复返回 REPLAYED 并再次投递；异答复 CONFLICT
  assert.deepEqual(await n.handle("notice-dl-020", "allow"), { code: "REPLAYED", id: "notice-dl-020", state: "handled" })
  assert.deepEqual(await n.handle("notice-dl-020", "decline"), { code: "CONFLICT" })
  assert.equal((await n.get("notice-dl-020"))!.answer, "allow")
})

test("纯告知无选项：只收空对象，回执不带 answer", async () => {
  const { n, got } = await setup()
  const info: Notification = { notification_id: "notice-017", origin: "worker", code: "RESULT_READY", occurred_at: "2026-11-17T20:34:00+08:00", ticket_id: "B", content: "第一版已做好。" }
  await n.record(info)
  assert.deepEqual(await n.handle("notice-017", "x"), { code: "INVALID_INPUT" })
  assert.deepEqual(await n.handle("notice-017"), { code: "OK", id: "notice-017", state: "handled" })
  assert.deepEqual(got, [{ notification_id: "notice-017", state: "handled" }])
})

test("无选项 INPUT_NEEDED 须非空答复", async () => {
  const { n } = await setup()
  const q: Notification = { notification_id: "notice-place-023", origin: "worker", code: "INPUT_NEEDED", occurred_at: "2026-11-17T21:15:00+08:00", ticket_id: "B", node_id: "B/3", content: "在哪里集合？" }
  await n.record(q)
  assert.deepEqual(await n.handle("notice-place-023"), { code: "INVALID_INPUT" })
  assert.deepEqual(await n.handle("notice-place-023", "图书馆南门。"), { code: "OK", id: "notice-place-023", state: "handled" })
})

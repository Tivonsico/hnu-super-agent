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
  // 重放同答复返回 REPLAYED，已确认接收的回执不再投递；异答复 CONFLICT
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

test("来源暂不可用时保留待处理及原答复，重试成功后只投递一次", async () => {
  const { n } = await setup()
  let attempts = 0
  n.register("worker", async () => {
    if (++attempts === 1) throw new Error("暂不可用")
    return { code: "OK" }
  })
  await n.record(dl)
  await assert.rejects(n.handle(dl.notification_id, "allow"))
  assert.equal((await n.list("pending")).length, 1)
  assert.equal((await n.handle(dl.notification_id, "decline")).code, "CONFLICT")
  assert.equal((await n.handle(dl.notification_id, "allow")).code, "OK")
  assert.equal((await n.handle(dl.notification_id, "allow")).code, "REPLAYED")
  assert.equal(attempts, 2)
  assert.equal((await n.record(dl)).code, "REPLAYED")
})

test("无选项的审批需要非空回答", async () => {
  const { n } = await setup()
  const prompt = { ...dl, code: "APPROVAL_REQUIRED", options: undefined }
  await n.record(prompt)
  assert.equal((await n.handle(dl.notification_id)).code, "INVALID_INPUT")
  assert.equal((await n.handle(dl.notification_id, "   ")).code, "INVALID_INPUT")
  assert.equal((await n.handle(dl.notification_id, "明天提交")).code, "OK")
})

test("同一成果的多次提醒合并展示；旧链接仍可标记同一成果已读", async () => {
  const dot = new Files(await mkdtemp(join(tmpdir(), "hnu-duplicate-")))
  const n = new Notifications(dot, { worker: async () => ({code: "OK"}) })
  const stamp = "2026-11-28T00:00:00Z"
  await dot.create({ ticket_id: "A", title: "计划", description: {text: "说明"}, created_at: stamp },
    { node_id: "A/2", kind: "result", text: "完成", created_at: stamp, refs: [] })
  for (const id of ["first", "repeat"]) {
    await n.record({notification_id: id, code: "RESULT_READY", ticket_id: "A", node_id: "A/2", content: "完成", origin: "worker", occurred_at: stamp})
  }
  assert.deepEqual((await n.list("pending")).map(notice => notice.id), ["first"])
  assert.equal((await n.handle("repeat")).state, "pending")
  assert.equal((await n.list("pending"))[0].read, true)
})

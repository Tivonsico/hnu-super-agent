import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Files } from "../src/files.ts"
import { MessageTools } from "../src/message-tools.ts"
import { Orchestrator } from "../src/orchestrator.ts"
import { Http, route } from "../src/http.ts"
import { newTicketId, routerSessionId, workerSessionId } from "../src/ids.ts"
import { FakeLoop, type Turn } from "./fake-loop.ts"
import type { MessageStore } from "../src/ports.ts"

const store: MessageStore = {
  readPackage: async () => ({ code: "OK", records: [], missing_refs: [] }),
  readRawInBatch: async () => ({ code: "OK", records: [], missing_refs: [] }),
  download: async r => `/dl/${r}`,
}
let tick = 0
const setup = async () => {
  tick = 0
  const dot = await mkdtemp(join(tmpdir(), "hnu-"))
  const pkg = "pkg-017", tid = newTicketId(pkg)
  const create: Turn = async ({ binding, tool }) => {
    await tool("readCandidateTickets", {})
    await tool("createTicket", { package_id: binding.package_id, ticket_id: tid, title: "标题", description: "简述。", requirement: "要求。" })
  }
  const loop = new FakeLoop({ [routerSessionId(pkg)]: [create], [workerSessionId(tid)]: [async () => {}, async () => {}] })
  const files = new Files(dot)
  const o = new Orchestrator({ superdot: dot, files, loop, store: new MessageTools(store), prompts: { router: "R", worker: "W" }, clock: () => `2026-11-17T20:30:${String(tick++).padStart(2, "0")}+08:00` })
  return { o, files, http: new Http(o), pkg, tid }
}
const call = (http: Http, method: string, path: string, body: unknown = {}, query: Record<string, string> = {}) =>
  route(http, method, path.split("/").filter(Boolean), query, () => body)!

test("notify 200 OK，重投 200 REPLAYED", async () => {
  const { http, pkg } = await setup()
  assert.deepEqual(await call(http, "POST", "/router/notify", { package_ref: { id: pkg } }), { status: 200, body: { code: "OK", package_ref: { id: pkg } } })
  assert.equal((await call(http, "POST", "/router/notify", { package_ref: { id: pkg } })).body.code, "REPLAYED")
})

test("notify 缺字段 400", async () => {
  const { http } = await setup()
  assert.equal((await call(http, "POST", "/router/notify", {})).status, 400)
})

test("actions supplement 首次 202，重投 200 REPLAYED，异内容 409", async () => {
  const { http, o, pkg, tid } = await setup()
  await o.notify({ id: pkg })
  await o.waitForPackageWork()
  const first = await call(http, "POST", "/tickets/actions", { operation: "supplement", operation_id: "u-1", ticket_id: tid, text: "补充。" })
  assert.equal(first.status, 202)
  assert.equal(first.body.code, "ACCEPTED")
  assert.equal((await call(http, "POST", "/tickets/actions", { operation: "supplement", operation_id: "u-1", ticket_id: tid, text: "补充。" })).status, 200)
  assert.equal((await call(http, "POST", "/tickets/actions", { operation: "supplement", operation_id: "u-1", ticket_id: tid, text: "改了。" })).status, 409)
})

test("actions confirm 走同一入口，返回 200 与新 node_id", async () => {
  const { http, o, files, pkg, tid } = await setup()
  await o.notify({ id: pkg })
  await o.waitForPackageWork()
  await files.append(tid, { node_id: tid + "/result", kind: "result", text: "成果", refs: [], created_at: new Date().toISOString() })
  const r = await call(http, "POST", "/tickets/actions", { operation: "confirm", operation_id: "u-9", ticket_id: tid, node_id: `${tid}/result` })
  assert.equal(r.status, 200)
  assert.equal(r.body.code, "OK")
  assert.equal(r.body.node_id, `${tid}/operation-u-9`)
})

test("GET 单工单 / 列表 / 未知工单 404", async () => {
  const { http, o, pkg, tid } = await setup()
  await o.notify({ id: pkg })
  await o.waitForPackageWork()
  const one = await call(http, "GET", `/tickets/${tid}`)
  assert.equal(one.status, 200)
  assert.equal(one.body.ticket.ticket_id, tid)
  assert.equal((await call(http, "GET", "/tickets")).body.items.length, 1)
  assert.equal((await call(http, "GET", "/tickets/none")).status, 404)
})

test("通知列表按 state 过滤，handle 投递回执", async () => {
  const { http, o, pkg, tid } = await setup()
  await o.notify({ id: pkg })
  await o.waitForPackageWork()
  await o.notices.record({ notification_id: "n-1", origin: "worker", code: "RESULT_READY", content: "好了。", occurred_at: "2026-11-17T20:34:00+08:00", ticket_id: tid })
  assert.equal((await call(http, "GET", "/notifications", {}, { state: "pending" })).body.items.length, 1)
  const h = await call(http, "POST", "/notifications/n-1/handle", {})
  assert.deepEqual(h, { status: 200, body: { code: "OK", id: "n-1", state: "handled" } })
  assert.equal((await call(http, "GET", "/notifications", {}, { state: "pending" })).body.items.length, 0)
})

test("未知路由返回 undefined", async () => {
  const { http } = await setup()
  assert.equal(route(http, "DELETE", ["tickets", "x"], {}, () => ({})), undefined)
})

test("失败的补充和确认操作重复提交仍返回 404", async () => {
  const { http } = await setup()
  for (const operation of ["supplement", "confirm"]) {
    const body = { operation, operation_id: operation, ticket_id: "missing", node_id: "missing/1", text: "补充" }
    for (let attempt = 0; attempt < 2; attempt++)
      assert.equal((await call(http, "POST", "/tickets/actions", body)).status, 404)
  }
})

test("并发确认保留每个节点，同一操作只确认一次", async () => {
  const { http, o, files, pkg, tid } = await setup()
  await o.notify({ id: pkg })
  await o.waitForPackageWork()
  await files.append(tid, { node_id: tid + "/result", kind: "result", text: "成果", refs: [], created_at: new Date().toISOString() })
  const ids = ["a", "b", "a", "c"]
  const replies = await Promise.all(ids.map(operation_id => call(http, "POST", "/tickets/actions", {
    operation: "confirm", operation_id, ticket_id: tid, node_id: tid + "/result",
  })))
  assert.equal(replies.filter(r => r.body.code === "OK").length, 1)
  assert.ok(replies.every(r => ["OK", "REPLAYED", "CONFLICT"].includes(r.body.code)))
  const nodes = (await o.getTicket(tid)).nodes.filter(n => n.kind === "confirm")
  assert.equal(nodes.length, 1)
})

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Files } from "../src/files.ts"
import { Tickets } from "../src/tickets.ts"
import { Notifications } from "../src/notifications.ts"
import { MessageTools } from "../src/message-tools.ts"
import { routerTools, workerTools, NATIVE_TOOLS } from "../src/tools.ts"
import type { MessageStore } from "../src/ports.ts"
import type { Tool } from "../src/ports.ts"

const store: MessageStore = {
  readPackage: async () => ({ code: "OK", records: [], missing_refs: [] }),
  readRawInBatch: async () => ({ code: "OK", records: [], missing_refs: [] }),
  download: async id => `/dl/${id}`,
}
const setup = async () => {
  const files = new Files(await mkdtemp(join(tmpdir(), "hnu-")))
  let t = 0
  const tickets = new Tickets(files, () => `2026-11-17T20:30:${String(t++).padStart(2, "0")}+08:00`)
  const notices = new Notifications(files, { router: async () => ({ code: "OK" }), worker: async () => ({ code: "OK" }) })
  return { files, tickets, notices, msg: new MessageTools(store) }
}
const byName = (tools: Tool[], name: string): Tool => tools.find(t => t.name === name)!

test("Router 工具集与 06 contract.agentTools 一致（HNU 自有工具）", async () => {
  const s = await setup()
  const names = routerTools({ ...s, packageId: "pkg-017", routerSessionId: "r-017" }).map(t => t.name)
  assert.deepEqual(names, ["readPackage", "readRawInBatch", "readCandidateTickets", "createTicket", "recordNotification"])
})

test("Worker 工具集与 06 contract.agentTools 一致（HNU 自有工具）", async () => {
  const s = await setup()
  const names = workerTools({ ...s, ticketId: "B", workspace: "/w", authorizeDownload: () => true }).map(t => t.name)
  assert.deepEqual(names, ["readPackage", "readRawInBatch", "askDownloadFile", "appendTicketNote", "mergeTickets", "recordNotification"])
})

test("createTicket 工具落盘并带 Router Session 引用", async () => {
  const s = await setup()
  const tools = routerTools({ ...s, packageId: "pkg-017", routerSessionId: "r-017" })
  const r = await byName(tools, "createTicket").execute(
    { package_id: "pkg-017", ticket_id: "B", title: "标题", description: "简述。", requirement: "要求。" })
  assert.deepEqual(r, { code: "OK", ticket_id: "B" })
  const t0 = (await s.tickets.ticket("B"))!
  assert.ok(t0.nodes[0].refs.some(ref => ref.kind === "session" && ref.id === "r-017"))
})

test("recordNotification 自动补 origin=worker 并落盘", async () => {
  const s = await setup()
  const tools = workerTools({ ...s, ticketId: "B", workspace: "/w", authorizeDownload: () => true })
  await byName(tools, "recordNotification").execute(
    { notification_id: "notice-1", code: "RESULT_READY", content: "好了。", occurred_at: "2026-11-17T20:34:00+08:00", ticket_id: "B" })
  const [item] = await s.notices.list()
  assert.equal(item.origin, "worker")
  assert.equal(item.id, "notice-1")
})

test("askDownloadFile 未授权返回 AUTHORIZATION_REQUIRED，授权后返回路径", async () => {
  const s = await setup()
  const denied = workerTools({ ...s, ticketId: "B", workspace: "/w", authorizeDownload: () => false })
  assert.deepEqual(await byName(denied, "askDownloadFile").execute({ raw_id: "raw-020" }), { code: "AUTHORIZATION_REQUIRED" })
  const ok = workerTools({ ...s, ticketId: "B", workspace: "/w", authorizeDownload: () => true })
  assert.equal(await byName(ok, "askDownloadFile").execute({ raw_id: "raw-020" }), "/dl/raw-020")
})

test("原生工具名单符合 06 约定", () => {
  assert.deepEqual([...NATIVE_TOOLS.router], ["read", "skill", "bash", "job_output"])
  assert.deepEqual([...NATIVE_TOOLS.worker], ["read", "glob", "grep", "skill", "write", "edit", "bash", "job_output"])
})

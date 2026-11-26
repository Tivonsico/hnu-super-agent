import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Files } from "../src/files.ts"
import { Tickets } from "../src/tickets.ts"
import { Notifications } from "../src/notifications.ts"
import { MessageTools } from "../src/message-tools.ts"
import { routerTools, workerTools, NATIVE_TOOLS } from "../src/tools.ts"
import { routerBashGuard } from "../src/dsh/loop.ts"
import type { MessageStore, Tool } from "../src/ports.ts"

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
type S = Awaited<ReturnType<typeof setup>>
const router = (s: S) => routerTools({ ...s, packageId: "pkg-017", routerSessionId: "r-017", newTicketId: "B", searched: { value: false } })
const worker = (s: S, workspace = "/w", allow = true) =>
  workerTools({ ...s, ticketId: "B", workspace, superdot: "/dot", noteId: "n-017", sessionId: "worker-B", authorizeDownload: () => allow })
const byName = (tools: Tool[], name: string): Tool => tools.find(t => t.name === name)!
const make = (s: S) => s.tickets.create({ package_id: "pkg-017", ticket_id: "B", title: "标题", description: "简述。", requirement: "要求。" }, "r-017")

test("Router 工具集与 06 contract.agentTools 一致（HNU 自有工具）", async () => {
  assert.deepEqual(router(await setup()).map(t => t.name), ["readPackage", "readRawInBatch", "readCandidateTickets", "createTicket", "recordNotification"])
})

test("Worker 工具集与 06 contract.agentTools 一致（HNU 自有工具）", async () => {
  assert.deepEqual(worker(await setup()).map(t => t.name), ["readPackage", "readRawInBatch", "askDownloadFile", "appendTicketNote", "mergeTickets", "recordNotification"])
})

test("createTicket：先查候选再建单，带 Router Session 引用；未查候选或号不符回 INVALID_INPUT", async () => {
  const s = await setup()
  const tools = router(s)
  const args = { package_id: "pkg-017", ticket_id: "B", title: "标题", description: "简述。", requirement: "要求。" }
  assert.deepEqual(await byName(tools, "createTicket").execute(args), { code: "INVALID_INPUT" })
  await byName(tools, "readCandidateTickets").execute({})
  assert.deepEqual(await byName(tools, "createTicket").execute({ ...args, ticket_id: "X" }), { code: "INVALID_INPUT" })
  assert.deepEqual(await byName(tools, "createTicket").execute(args), { code: "OK", ticket_id: "B" })
  assert.ok((await s.tickets.ticket("B"))!.nodes[0].refs.some(r => r.kind === "session" && r.id === "r-017"))
})

test("appendTicketNote：别单号、自造 ref、缺包引用的 input 回 INVALID_INPUT", async () => {
  const s = await setup()
  await make(s)
  const append = byName(worker(s), "appendTicketNote")
  const node = (n: object) => ({ ticket_id: "B", node: { node_id: "B/2", kind: "result", text: "x", refs: [], ...n } })
  assert.equal((await append.execute({ ...node({}), ticket_id: "C" }) as { code: string }).code, "INVALID_INPUT")
  assert.equal((await append.execute(node({ refs: [{ kind: "file", path: "a.svg" }] })) as { code: string }).code, "INVALID_INPUT")
  assert.equal((await append.execute(node({ kind: "input", refs: [{ kind: "message", id: "m-1" }] })) as { code: string }).code, "INVALID_INPUT")
  assert.deepEqual(await append.execute(node({ kind: "input", refs: [{ kind: "package", id: "pkg-021" }] })), { code: "OK" })
})

test("appendTicketNote：成果须在 workspace/artifacts，note 须有当轮草稿", async () => {
  const s = await setup()
  await make(s)
  const work = await mkdtemp(join(tmpdir(), "hnu-work-"))
  const append = byName(worker(s, work), "appendTicketNote")
  const result = { ticket_id: "B", node: { node_id: "B/3", kind: "result", text: "v1", refs: [{ kind: "artifact", id: "B/v1.svg" }] } }
  assert.equal((await append.execute(result) as { code: string }).code, "REF_NOT_FOUND")
  await mkdir(join(work, "artifacts"), { recursive: true })
  await writeFile(join(work, "artifacts", "v1.svg"), "<svg/>")
  assert.deepEqual(await append.execute(result), { code: "OK" })
  const note = { ticket_id: "B", node: { node_id: "B/4", kind: "note", text: "已保存。", refs: [{ kind: "note", id: "n-017" }] } }
  assert.equal((await append.execute(note) as { code: string }).code, "REF_NOT_FOUND")
  await mkdir(join(work, "notes"), { recursive: true })
  await writeFile(join(work, "notes", "n-017.json"), JSON.stringify({ note_id: "n-017", ticket_id: "B", session_id: "worker-B", content: "做了第一版。", evidence_refs: [{ kind: "node", id: "B/3" }], created_at: "2026-11-17T20:34:01+08:00" }))
  assert.deepEqual(await append.execute(note), { code: "OK" })
})

test("mergeTickets：只有目标单 Worker 能调用，参数须与原操作一致", async () => {
  const s = await setup()
  await make(s)
  await s.tickets.create({ package_id: "pkg-001", ticket_id: "A", title: "旧单", description: "旧。", requirement: "旧。" }, "r-001")
  await s.files.saveOperation({ operation: "merge", operation_id: "u-024", source_ticket_id: "A", target_ticket_id: "B" })
  const merge = byName(worker(s), "mergeTickets")
  assert.equal((await merge.execute({ source_ticket_id: "B", target_ticket_id: "A", operation_id: "u-024" }) as { code: string }).code, "INVALID_INPUT")
  assert.deepEqual(await merge.execute({ source_ticket_id: "A", target_ticket_id: "B", operation_id: "u-024" }), { code: "OK", ticket_id: "B" })
})

test("recordNotification 自动补 origin=worker 并落盘", async () => {
  const s = await setup()
  await byName(worker(s), "recordNotification").execute(
    { notification_id: "notice-1", code: "RESULT_READY", content: "好了。", occurred_at: "2026-11-17T20:34:00+08:00", ticket_id: "B" })
  const [item] = await s.notices.list()
  assert.equal(item.origin, "worker")
  assert.equal(item.id, "notice-1")
})

test("askDownloadFile 未授权返回 AUTHORIZATION_REQUIRED，授权后返回路径", async () => {
  const s = await setup()
  assert.deepEqual(await byName(worker(s, "/w", false), "askDownloadFile").execute({ raw_id: "raw-020" }), { code: "AUTHORIZATION_REQUIRED" })
  assert.equal(await byName(worker(s), "askDownloadFile").execute({ raw_id: "raw-020" }), "/dl/raw-020")
})

test("原生工具名单符合 06 约定；Router 的 bash 拒绝写入", () => {
  assert.deepEqual([...NATIVE_TOOLS.router], ["read", "skill", "bash", "job_output"])
  assert.deepEqual([...NATIVE_TOOLS.worker], ["read", "glob", "grep", "skill", "write", "edit", "bash", "job_output"])
  assert.equal(routerBashGuard({ name: "bash", arguments: { command: "cat /dot/tickets/B.jsonl" } }), undefined)
  assert.ok(routerBashGuard({ name: "bash", arguments: { command: "echo x >> /dot/tickets/B.jsonl" } }))
})

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Files } from "../src/files.ts"
import { MessageTools } from "../src/message-tools.ts"
import { Orchestrator } from "../src/orchestrator.ts"
import { newTicketId, routerSessionId, workerSessionId } from "../src/ids.ts"
import { FakeLoop, type Turn } from "./fake-loop.ts"
import type { MessageStore } from "../src/ports.ts"

const store: MessageStore = {
  readPackage: async () => ({ code: "OK", records: [], missing_refs: [] }),
  readRawInBatch: async () => ({ code: "OK", records: [], missing_refs: [] }),
  download: async raw => `/dl/${raw}/f`,
}
let tick = 0
const setup = (script: Record<string, Turn[]> = {}) => {
  tick = 0
  return mkdtemp(join(tmpdir(), "hnu-")).then(dot => {
    const files = new Files(dot)
    const loop = new FakeLoop(script)
    const o = new Orchestrator({
      superdot: dot, files, loop, store: new MessageTools(store),
      prompts: { router: "R", worker: "W" }, clock: () => `2026-11-17T20:30:${String(tick++).padStart(2, "0")}+08:00`,
    })
    return { dot, files, loop, o }
  })
}
// Router 脚本：建新单
const createTurn = (ticketId: string): Turn => async ({ binding, tool }) => {
  await tool("readCandidateTickets", {})
  await tool("createTicket", { package_id: binding.package_id, ticket_id: ticketId, title: "志愿活动 PPT", description: "按学校模板。", requirement: "做 PPT。" })
}

test("notify 新建工单：接管、建单、启动 Worker（session 节点 + package 交付）", async () => {
  const pkg = "pkg-017", ticketId = newTicketId(pkg)
  const { o, loop } = await setup({ [routerSessionId(pkg)]: [createTurn(ticketId)], [workerSessionId(ticketId)]: [async () => {}] })
  assert.deepEqual(await o.notify({ id: pkg }), { code: "OK", package_ref: { id: pkg } })
  const t = (await o.getTicket(ticketId))!
  assert.equal(t.nodes[0].kind, "requirement")
  assert.equal(t.nodes[1].kind, "session")
  const workerDelivery = loop.deliveries.find(d => d.sessionId === workerSessionId(ticketId))!
  assert.equal(JSON.parse(workerDelivery.text).input.kind, "package")
  assert.equal(workerDelivery.mode, "queue")
})

test("notify 去重：同包第二次返回 REPLAYED，不再启动 Router", async () => {
  const pkg = "pkg-017", ticketId = newTicketId(pkg)
  const { o, loop } = await setup({ [routerSessionId(pkg)]: [createTurn(ticketId)], [workerSessionId(ticketId)]: [async () => {}] })
  await o.notify({ id: pkg })
  const before = loop.deliveries.length
  assert.deepEqual(await o.notify({ id: pkg }), { code: "REPLAYED", package_ref: { id: pkg } })
  assert.equal(loop.deliveries.length, before)
})

test("notify 归入：Router 回复目标工单，宿主把包以 steer 交付目标 Worker", async () => {
  const pkg1 = "pkg-017", tid = newTicketId(pkg1), pkg2 = "pkg-021"
  const attachTurn: Turn = async () => ({ text: JSON.stringify({ ticket_id: tid, package_ref: { id: pkg2 } }) })
  const { o, loop } = await setup({
    [routerSessionId(pkg1)]: [createTurn(tid)],
    [routerSessionId(pkg2)]: [attachTurn],
    [workerSessionId(tid)]: [async () => {}, async ({ binding, tool }) => {
      await tool("appendTicketNote", { ticket_id: tid, node: { node_id: binding.input.input_node_id, kind: "input", text: "补充要求。", refs: [{ kind: "package", id: pkg2 }] } })
    }],
  })
  await o.notify({ id: pkg1 })
  await o.notify({ id: pkg2 })
  const t = (await o.getTicket(tid))!
  const input = t.nodes.find(n => n.node_id === `${tid}/package-${pkg2}`)!
  assert.equal(input.kind, "input")
  assert.deepEqual(t.package_refs, [{ id: pkg1 }, { id: pkg2 }])
  assert.equal(loop.deliveries.find(d => d.text.includes(`package-${pkg2}`))!.mode, "steer")
})

test("用户 supplement：写 input 节点并 steer 交付；去重返回 REPLAYED", async () => {
  const pkg = "pkg-017", tid = newTicketId(pkg)
  const { o, loop } = await setup({ [routerSessionId(pkg)]: [createTurn(tid)], [workerSessionId(tid)]: [async () => {}, async () => {}] })
  await o.notify({ id: pkg })
  const r = await o.action({ operation: "supplement", operation_id: "u-019", ticket_id: tid, text: "补一张路线图。" })
  assert.deepEqual(r, { code: "ACCEPTED", operation_id: "u-019", ticket_id: tid })
  const node = (await o.getTicket(tid))!.nodes.find(n => n.node_id === `${tid}/operation-u-019`)!
  assert.equal(node.kind, "input")
  const steer = loop.deliveries.find(d => d.text.includes("u-019") && d.mode === "steer")
  assert.ok(steer, "operation 应以 steer 交付")
  assert.deepEqual(await o.action({ operation: "supplement", operation_id: "u-019", ticket_id: tid, text: "补一张路线图。" }), { code: "REPLAYED", operation_id: "u-019", ticket_id: tid })
})

test("用户 stop：写 stop 节点、取消 Worker、工单隐藏", async () => {
  const pkg = "pkg-017", tid = newTicketId(pkg)
  const { o, loop } = await setup({ [routerSessionId(pkg)]: [createTurn(tid)], [workerSessionId(tid)]: [async () => {}, async () => {}] })
  await o.notify({ id: pkg })
  loop.sessions.add(workerSessionId(tid))
  await o.action({ operation: "stop", operation_id: "u-021", ticket_id: tid })
  const t = (await o.getTicket(tid))!
  assert.equal(t.description.visible, 0)
  assert.equal(t.nodes.at(-1)!.kind, "stop")
  assert.ok(loop.cancelled.includes(workerSessionId(tid)))
})

test("confirm：宿主直接写 confirm 节点，返回新 node_id", async () => {
  const pkg = "pkg-017", tid = newTicketId(pkg)
  const { o } = await setup({ [routerSessionId(pkg)]: [createTurn(tid)], [workerSessionId(tid)]: [async () => {}] })
  await o.notify({ id: pkg })
  const r = await o.confirm({ operation: "confirm", operation_id: "u-026", ticket_id: tid, node_id: `${tid}/1` })
  assert.equal((r as any).code, "OK")
  assert.equal((await o.getTicket(tid))!.nodes.at(-1)!.kind, "confirm")
})

test("用户 merge：暂停源单、交目标 Worker 调 mergeTickets，源单移出候选", async () => {
  const pkgA = "pkg-001", a = newTicketId(pkgA), pkgB = "pkg-017", b = newTicketId(pkgB)
  const create = (tid: string): Turn => async ({ binding, tool }) => {
    await tool("readCandidateTickets", {})
    await tool("createTicket", { package_id: binding.package_id, ticket_id: tid, title: "单" + tid, description: "简述。", requirement: "要求。" })
  }
  const { o, loop } = await setup({
    [routerSessionId(pkgA)]: [create(a)], [routerSessionId(pkgB)]: [create(b)],
    [workerSessionId(a)]: [async () => {}],
    [workerSessionId(b)]: [async () => {}, async ({ binding, tool }) => {
      assert.equal(binding.input.operation_id, "u-024")
      await tool("mergeTickets", { source_ticket_id: a, target_ticket_id: b, operation_id: "u-024" })
    }],
  })
  await o.notify({ id: pkgA })
  await o.notify({ id: pkgB })
  loop.sessions.add(workerSessionId(a))
  const r = await o.action({ operation: "merge", operation_id: "u-024", source_ticket_id: a, target_ticket_id: b })
  assert.deepEqual(r, { code: "ACCEPTED", operation_id: "u-024", ticket_id: b })
  assert.ok(loop.cancelled.includes(workerSessionId(a)), "合并前应取消源单 Worker")
  assert.equal((await o.getTicket(a))!.description.visible, 0)
  assert.deepEqual((await o.listTickets()).filter(t => t.description.visible === 1).map(t => t.ticket_id), [b])
})

test("下载授权流程：blocked→通知→allow→下载→download 输入交付 Worker", async () => {
  const pkg = "pkg-017", tid = newTicketId(pkg)
  const workerTurns: Turn[] = [
    // 首轮：建卡点节点 + 登记 INPUT_NEEDED 通知
    async ({ tool }) => {
      await tool("appendTicketNote", { ticket_id: tid, node: { node_id: `${tid}/3`, kind: "blocked", text: "需要名单。", refs: [{ kind: "attachment", id: "raw-020" }] } })
      await tool("recordNotification", { notification_id: "notice-dl", code: "INPUT_NEEDED", content: "允许下载吗？", occurred_at: "2026-11-17T20:55:00+08:00", ticket_id: tid, node_id: `${tid}/3`, options: [{ value: "allow", label: "允许" }, { value: "decline", label: "不" }] })
    },
    // 第二轮：收到 download 输入后解除卡点
    async ({ binding, tool }) => {
      assert.equal(binding.input.kind, "download")
      await tool("appendTicketNote", { ticket_id: tid, node: { node_id: `${tid}/5`, kind: "unblocked", text: "名单可用。", refs: [{ kind: "node", id: `${tid}/3` }] } })
    },
  ]
  const { o, loop } = await setup({ [routerSessionId(pkg)]: [createTurn(tid)], [workerSessionId(tid)]: workerTurns })
  await o.notify({ id: pkg })
  await o.handleNotification("notice-dl", "allow")
  const t = (await o.getTicket(tid))!
  const dl = loop.deliveries.find(d => { try { return JSON.parse(d.text).input?.kind === "download" } catch { return false } })!
  assert.equal(JSON.parse(dl.text).input.file_path, "/dl/raw-020/f")
  assert.ok(t.nodes.some(n => n.kind === "unblocked"))
})

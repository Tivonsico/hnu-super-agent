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
  await o.waitForPackageWork()
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
  await o.waitForPackageWork()
  const before = loop.deliveries.length
  assert.deepEqual(await o.notify({ id: pkg }), { code: "REPLAYED", package_ref: { id: pkg } })
  await o.waitForPackageWork()
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
  await o.waitForPackageWork()
  await o.notify({ id: pkg2 })
  await o.waitForPackageWork()
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
  await o.waitForPackageWork()
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
  await o.waitForPackageWork()
  loop.sessions.add(workerSessionId(tid))
  await o.action({ operation: "stop", operation_id: "u-021", ticket_id: tid })
  const t = (await o.getTicket(tid))!
  assert.equal(t.description.visible, 0)
  assert.equal(t.nodes.at(-1)!.kind, "stop")
  assert.ok(loop.cancelled.includes(workerSessionId(tid)))
})

test("confirm：宿主直接写 confirm 节点，返回新 node_id", async () => {
  const pkg = "pkg-017", tid = newTicketId(pkg)
  const { o, files } = await setup({ [routerSessionId(pkg)]: [createTurn(tid)], [workerSessionId(tid)]: [async () => {}] })
  await o.notify({ id: pkg })
  await o.waitForPackageWork()
  await files.append(tid, { node_id: tid + "/result", kind: "result", text: "成果", refs: [], created_at: new Date().toISOString() })
  const r = await o.confirm({ operation: "confirm", operation_id: "u-026", ticket_id: tid, node_id: `${tid}/result` })
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
  await o.waitForPackageWork()
  await o.notify({ id: pkgB })
  await o.waitForPackageWork()
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
  await o.waitForPackageWork()
  await o.handleNotification("notice-dl", "allow")
  const t = (await o.getTicket(tid))!
  const dl = loop.deliveries.find(d => { try { return JSON.parse(d.text).input?.kind === "download" } catch { return false } })!
  assert.equal(JSON.parse(dl.text).input.file_path, "/dl/raw-020/f")
  assert.ok(t.nodes.some(n => n.kind === "unblocked"))
})

test("持久接管立即回执，重复唤醒只派一次，失败后重启继续处理", async () => {
  const pkg = "pkg-resume"
  let release!: () => void
  const slow = new Promise<void>(resolve => { release = resolve })
  const { o, files, dot, loop } = await setup({
    router: [async () => { await slow; return { ok: false } }, async () => ({ text: "ignore" })],
  })
  const receipts = await Promise.all([o.notify({ id: pkg }), o.notify({ id: pkg })])
  assert.deepEqual(receipts.map(r => r.code), ["OK", "REPLAYED"])
  assert.equal(await files.getRecord("package-done", pkg), undefined)
  release()
  await o.waitForPackageWork()
  await o.stopPackages()
  assert.equal(loop.deliveries.length, 1)
  const resumed = new Orchestrator({ superdot: dot, files, loop, store: new MessageTools(store), prompts: { router: "R", worker: "W" } })
  await resumed.resumePackages()
  await resumed.waitForPackageWork()
  assert.deepEqual(await files.getRecord("package-done", pkg), { package_id: pkg })
  assert.equal(loop.deliveries.length, 2)
  assert.notEqual(loop.deliveries[0].requestId, loop.deliveries[1].requestId)
  await resumed.resumePackages()
  await resumed.waitForPackageWork()
  assert.equal(loop.deliveries.length, 2)
})

test("拒绝归入已隐藏的工单，也拒绝交付与当次唤醒不符的包号", async () => {
  const tid = newTicketId("base")
  const attach = (pkg: string): Turn => async () => ({ text: JSON.stringify({ ticket_id: tid, package_ref: { id: pkg } }) })
  const { o, files, loop } = await setup({
    [routerSessionId("base")]: [createTurn(tid)],
    [routerSessionId("mismatch")]: [attach("another-package")],
    [routerSessionId("hidden")]: [attach("hidden")],
  })
  await o.notify({ id: "base" })
  await o.waitForPackageWork()
  await o.notify({ id: "mismatch" })
  await o.waitForPackageWork()
  await o.action({ operation_id: "stop-1", operation: "stop", ticket_id: tid })
  await o.notify({ id: "hidden" })
  await o.waitForPackageWork()
  await o.stopPackages()
  assert.equal(await files.getRecord("package-done", "mismatch"), undefined)
  assert.equal(await files.getRecord("package-done", "hidden"), undefined)
  assert.equal(loop.deliveries.filter(d => d.sessionId === workerSessionId(tid)).length, 1)
})

test("后台派发失败后无需看门狗重投即可自动恢复", async () => {
  let finish!: () => void
  const retried = new Promise<void>(resolve => { finish = resolve })
  const { o, files, loop } = await setup({
    router: [async () => { throw new Error("temporary outage") }, async () => { finish(); return { text: "ignore" } }],
  })
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    assert.equal((await o.notify({ id: "retry" })).code, "OK")
    await Promise.race([retried, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("missing retry")), 10000)
    })])
    await o.waitForPackageWork()
    assert.deepEqual(await files.getRecord("package-done", "retry"), { package_id: "retry" })
    assert.equal(loop.deliveries.length, 2)
  } finally {
    clearTimeout(timeout)
    await o.stopPackages()
  }
})

test("同一成果已读仍待审；确认、反馈、后续材料只关闭当时的成果", async () => {
  const { files, o } = await setup()
  const tid = "Review"
  await files.create({ ticket_id: tid, title: "周报", description: { text: "汇总" }, created_at: "2026-11-01T00:00:00Z" },
    { node_id: "Review/1", kind: "requirement", text: "汇总", created_at: "2026-11-01T00:00:00Z", refs: [] })
  const result = (n: number) => files.append(tid, { node_id: tid + "/" + n, kind: "result", text: "版本" + n,
    created_at: "2026-11-01T00:00:00Z", refs: [] })
  const confirm = (n: number) => o.confirm({ operation: "confirm", operation_id: "confirm-" + n, ticket_id: tid, node_id: tid + "/" + n })
  await result(2)
  const [first] = await o.listNotifications("pending")
  assert.equal(first.node_id, "Review/2")
  assert.deepEqual(await o.handleNotification(first.id), { code: "OK", id: first.id, state: "pending", read: true })
  assert.equal((await o.listNotifications("pending"))[0].read, true)
  await result(3)
  assert.deepEqual(await confirm(2), { code: "CONFLICT" })
  assert.deepEqual(await o.handleNotification(first.id), { code: "CONFLICT" })
  assert.equal((await confirm(3)).code, "OK")
  assert.equal((await confirm(3)).code, "REPLAYED")
  assert.equal((await o.listNotifications("pending")).length, 0)
  await result(4)
  await o.action({ operation: "feedback", operation_id: "feedback", ticket_id: tid, node_id: "Review/4", text: "请修订" })
  assert.equal((await o.getTicket(tid))?.review.result_node_id, null)
  assert.equal((await o.listNotifications("handled")).find(n => n.node_id === "Review/4")?.resolution, "feedback")
  await result(5)
  await o.action({ operation: "supplement", operation_id: "extra", ticket_id: tid, text: "新数据" })
  assert.equal((await confirm(5)).code, "CONFLICT")
})

test("历史成果已读回到待审，精确解除一个卡点后另一个审批仍然可答", async () => {
  const { files, o } = await setup()
  const at = "2026-11-01T00:00:00Z"
  const base = { occurred_at: at, ticket_id: "B", content: "请检查", origin: "worker" }
  await files.create({ ticket_id: "B", title: "物料", description: { text: "清点" }, created_at: at },
    { node_id: "B/res", kind: "result", text: "物料清单", created_at: at, refs: [] })
  await files.putRecord("notice", "legacy", { ...base, id: "legacy", code: "RESULT_READY", state: "handled" })
  for (const name of ["first", "second"]) {
    await files.append("B", { node_id: "B/" + name, kind: "blocked", text: name, created_at: at, refs: [] })
    await o.notices.record({ ...base, code: "INPUT_NEEDED", notification_id: name, node_id: "B/" + name })
  }
  await files.append("B", { node_id: "B/clear", kind: "unblocked", text: "已补齐一项", created_at: at, refs: [{ kind: "node", id: "B/first" }] })
  const pending = await o.listNotifications("pending")
  assert.deepEqual(pending.map(n => n.id).sort(), ["legacy", "second"])
  assert.equal(pending.find(n => n.id === "legacy")?.read, true)
  assert.equal((await o.handleNotification("first", "迟到的答复")).code, "CONFLICT")
  assert.equal((await o.getTicket("B"))?.review.blocked_node_ids.join(), "B/second")
})

test("同一工单的归入包依次执行，其他工单可以同时交付", { timeout: 3000 }, async () => {
  const original = "original", other = "independent"
  const tid = newTicketId(original), otherId = newTicketId(other)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const finishedOther = Promise.withResolvers<void>()
  const packages = ["extra-a", "extra-b", "extra-c", "extra-d"]
  const attach: Turn = async ({ binding }) => ({
    text: JSON.stringify({ ticket_id: tid, package_ref: { id: binding.package_id } }),
  })
  const { o, loop } = await setup({
    [routerSessionId(original)]: [createTurn(tid)],
    [routerSessionId(other)]: [createTurn(otherId)],
    [workerSessionId(tid)]: [async () => { entered.resolve(); await release.promise }],
    [workerSessionId(otherId)]: [async () => { finishedOther.resolve() }],
    router: [attach],
  })
  await o.notify({ id: original })
  await entered.promise
  for (const id of [...packages, other]) await o.notify({ id })
  try {
    await finishedOther.promise
    assert.equal(loop.deliveries.filter(d => d.sessionId === workerSessionId(tid)).length, 1)
  } finally {
    release.resolve()
  }
  await o.waitForPackageWork()
  assert.equal(loop.deliveries.filter(d => d.sessionId === workerSessionId(tid)).length, 5)
})

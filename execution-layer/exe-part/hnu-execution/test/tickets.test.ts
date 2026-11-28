import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Files } from "../src/files.ts"
import { Tickets } from "../src/tickets.ts"

let t = 0
const clock = () => `2026-11-17T20:30:${String(t++).padStart(2, "0")}+08:00`
const setup = async () => {
  const dot = await mkdtemp(join(tmpdir(), "hnu-"))
  const work = await mkdtemp(join(tmpdir(), "hnu-work-"))
  return { dot, work, tk: new Tickets(new Files(dot), clock) }
}
const make = (tk: Tickets) => tk.create(
  { package_id: "pkg-017", ticket_id: "B", title: "志愿活动 PPT", description: "按学校模板制作活动说明。", requirement: "请按学校模板做志愿活动 PPT。" }, "r-017")

test("建单写头与首节点，去重返回 REPLAYED", async () => {
  const { tk } = await setup()
  assert.deepEqual(await make(tk), { code: "OK", ticket_id: "B" })
  assert.deepEqual(await make(tk), { code: "REPLAYED", ticket_id: "B" })
  const t0 = (await tk.ticket("B"))!
  assert.equal(t0.nodes[0].node_id, "B/1")
  assert.equal(t0.nodes[0].kind, "requirement")
  assert.deepEqual(t0.nodes[0].refs, [{ kind: "package", id: "pkg-017" }, { kind: "session", id: "r-017", role: "router" }])
})

test("追加纯文字 result 不需要文件", async () => {
  const { tk } = await setup()
  await make(tk)
  const r = await tk.append({ ticket_id: "B", node: { node_id: "B/3", kind: "result", text: "第一版完成。", refs: [] } }, "/nowhere")
  assert.deepEqual(r, { code: "OK" })
})

test("result 发布工作区成果文件到 superdot/artifacts", async () => {
  const { dot, work, tk } = await setup()
  await make(tk)
  await mkdir(join(work, "artifacts"), { recursive: true })
  await writeFile(join(work, "artifacts", "v1.pptx"), "PPTX-BYTES")
  const r = await tk.append({ ticket_id: "B", node: { node_id: "B/3", kind: "result", text: "第一版完成。", refs: [{ kind: "artifact", id: "B/v1.pptx" }] } }, work)
  assert.deepEqual(r, { code: "OK" })
  const published = await new Files(dot).exists(join(dot, "artifacts", "B/v1.pptx"))
  assert.equal(published, true)
})

test("追加前工单不存在返回 REF_NOT_FOUND；node_id 不属本单 INVALID_INPUT", async () => {
  const { tk } = await setup()
  assert.deepEqual(await tk.append({ ticket_id: "Z", node: { node_id: "Z/1", kind: "result", text: "x", refs: [] } }, "/x"), { code: "REF_NOT_FOUND" })
  await make(tk)
  assert.deepEqual(await tk.append({ ticket_id: "B", node: { node_id: "C/1", kind: "result", text: "x", refs: [] } }, "/x"), { code: "INVALID_INPUT" })
})

test("候选只列 visible==1，stop 后移出", async () => {
  const { tk } = await setup()
  await make(tk)
  assert.deepEqual((await tk.candidates()).map(c => c.ticket_id), ["B"])
  await tk.append({ ticket_id: "B", node: { node_id: "B/7", kind: "stop", text: "用户终止。", refs: [{ kind: "operation", id: "u-021" }] } }, "/x")
  assert.deepEqual(await tk.candidates(), [])
})

test("合并：目标 merge_in、源 merge_out，源单移出候选，返回目标单 ID", async () => {
  const { tk } = await setup()
  await make(tk)
  await tk.create({ package_id: "pkg-001", ticket_id: "A", title: "旧单", description: "旧描述。", requirement: "旧要求。" }, "r-001")
  const r = await tk.merge({ source_ticket_id: "A", target_ticket_id: "B", operation_id: "u-024" })
  assert.deepEqual(r, { code: "OK", ticket_id: "B" })
  const a = (await tk.ticket("A"))!, b = (await tk.ticket("B"))!
  assert.equal(a.description.visible, 0)
  assert.equal(a.nodes.at(-1)!.kind, "merge_out")
  assert.equal(b.nodes.at(-1)!.kind, "merge_in")
  assert.deepEqual((await tk.candidates()).map(c => c.ticket_id), ["B"])
})

test("新材料解除指定卡点，保留原记录，重复解除不能生成第二条", async () => {
  const { tk, work } = await setup()
  await make(tk)
  const append = (node: Parameters<Tickets["append"]>[0]["node"]) => tk.append({ ticket_id: "B", node }, work)
  await append({ node_id: "B/2", kind: "blocked", text: "缺开放时间", refs: [] })
  await append({ node_id: "B/3", kind: "input", text: "收到官方公告", refs: [{kind: "package", id: "announcement"}] })
  const before = (await tk.ticket("B"))!.nodes
  const clear = { node_id: "B/4", kind: "unblocked" as const, text: "公告已确认开放时间。", refs: [
    {kind: "node" as const, id: "B/2"}, {kind: "package" as const, id: "announcement"},
  ] }
  assert.equal((await append(clear)).code, "OK")
  assert.equal((await append(clear)).code, "REPLAYED")
  assert.equal((await append({...clear, node_id: "B/5"})).code, "CONFLICT")
  assert.deepEqual((await tk.ticket("B"))!.nodes.slice(0, -1), before)
})

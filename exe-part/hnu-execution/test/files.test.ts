import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Files, view, Conflict } from "../src/files.ts"
import type { Node, TicketHeader } from "../src/types.ts"

const dot = () => mkdtemp(join(tmpdir(), "hnu-"))
const header: TicketHeader = { ticket_id: "B", title: "志愿活动 PPT", description: { text: "按学校模板制作活动说明。" }, created_at: "2026-11-17T20:30:02+08:00" }
const node = (o: Partial<Node> & Pick<Node, "node_id" | "kind">): Node =>
  ({ created_at: "2026-11-17T20:30:02+08:00", text: "x", refs: [], ...o })

test("建单后按原字节前缀追加节点", async () => {
  const f = new Files(await dot())
  assert.equal(await f.create(header, node({ node_id: "B/1", kind: "requirement", refs: [{ kind: "package", id: "pkg-017" }] })), true)
  await f.append("B", node({ node_id: "B/2", kind: "session", refs: [{ kind: "session", id: "worker-B", role: "worker" }] }))
  const raw = (await readFile(f.ticketPath("B"), "utf8")).split("\n").filter(Boolean)
  assert.equal(raw.length, 3)
  assert.equal(JSON.parse(raw[0]).ticket_id, "B")
  assert.equal(JSON.parse(raw[2]).node_id, "B/2")
})

test("重放：同内容建单/追加返回 false，异内容抛 Conflict", async () => {
  const f = new Files(await dot())
  const first = node({ node_id: "B/1", kind: "requirement", refs: [{ kind: "package", id: "pkg-017" }] })
  await f.create(header, first)
  assert.equal(await f.create(header, first), false)
  await assert.rejects(f.create({ ...header, title: "别的" }, first), Conflict)
  await f.append("B", node({ node_id: "B/3", kind: "result", text: "v1" }))
  assert.equal(await f.append("B", node({ node_id: "B/3", kind: "result", text: "v1" })), false)
  await assert.rejects(f.append("B", node({ node_id: "B/3", kind: "result", text: "v2" })), Conflict)
})

test("视图：可见性随 stop/resume/merge_out 变化，索引按首次引用去重", () => {
  const nodes: Node[] = [
    node({ node_id: "B/1", kind: "requirement", refs: [{ kind: "package", id: "pkg-017" }] }),
    node({ node_id: "B/3", kind: "result", refs: [{ kind: "artifact", id: "B/v1" }] }),
    node({ node_id: "B/4", kind: "note", refs: [{ kind: "note", id: "n-017" }] }),
    node({ node_id: "B/5", kind: "stop", refs: [{ kind: "operation", id: "u-021" }] }),
  ]
  assert.equal(view([header, ...nodes]).description.visible, 0)
  assert.equal(view([header, ...nodes, node({ node_id: "B/6", kind: "resume", refs: [] })]).description.visible, 1)
  const t = view([header, ...nodes])
  assert.deepEqual(t.package_refs, [{ id: "pkg-017" }])
  assert.deepEqual(t.note_refs, [{ id: "n-017" }])
})

test("宿主记录：幂等保存与冲突", async () => {
  const f = new Files(await dot())
  assert.equal((await f.saveRecord("takeover", "pkg-1", { a: 1 })).state, "fresh")
  assert.equal((await f.saveRecord("takeover", "pkg-1", { a: 1 })).state, "replay")
  assert.equal((await f.saveRecord("takeover", "pkg-1", { a: 2 })).state, "conflict")
  assert.deepEqual(await f.getRecord("takeover", "pkg-1"), { a: 1 })
})

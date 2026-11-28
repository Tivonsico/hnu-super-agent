import { test } from "node:test"
import assert from "node:assert/strict"
import { MessageTools, orderBatch } from "../src/message-tools.ts"
import type { MessageStore } from "../src/ports.ts"
import type { RawBatch, RawRecord } from "../src/types.ts"

const rec = (id: string, sent_at: string): RawRecord =>
  ({ ref: { id }, type: "text", source: "qq", account_id: "qq-1", conversation_id: "v-1", message_id: "m-" + id, sender_id: "liu", sent_at, reply_to_message_id: null, content: id })

const store = (recs: RawRecord[]): MessageStore => ({
  readPackage: async () => ({ code: "OK", records: recs, missing_refs: [] }) as RawBatch,
  readRawInBatch: async ids => ({ code: "OK", records: recs.filter(r => ids.includes(r.ref.id)), missing_refs: [] }) as RawBatch,
  download: async id => (id === "raw-gone" ? { code: "REF_NOT_FOUND" } : `/dl/${id}/f`),
})

test("orderBatch：按 sent_at 升序，去重，缺项单列，同序保留首次顺序", () => {
  const b = orderBatch(
    [rec("c", "2026-11-17T20:30:02+08:00"), rec("a", "2026-11-17T20:30:00+08:00"), rec("c", "2026-11-17T20:30:02+08:00")],
    ["raw-404", "c", "a", "c"])
  assert.deepEqual(b.records.map(r => r.ref.id), ["a", "c"])
  assert.deepEqual(b.missing_refs, [{ id: "raw-404" }])
})

test("readRawInBatch：空数组直接 OK，非法参数 INVALID_INPUT", async () => {
  const mt = new MessageTools(store([]))
  assert.deepEqual(await mt.readRawInBatch({ raw_ids: [] }), { code: "OK", records: [], missing_refs: [] })
  assert.deepEqual(await mt.readRawInBatch({ raw_ids: [" "] }), { code: "INVALID_INPUT" })
})

test("readRawInBatch：部分命中，按发送时刻排序", async () => {
  const mt = new MessageTools(store([rec("raw-018", "2026-11-17T20:30:01+08:00"), rec("raw-017", "2026-11-17T20:30:00+08:00")]))
  const b = await mt.readRawInBatch({ raw_ids: ["raw-404", "raw-018", "raw-017"] }) as RawBatch
  assert.deepEqual(b.records.map(r => r.ref.id), ["raw-017", "raw-018"])
  assert.deepEqual(b.missing_refs, [{ id: "raw-404" }])
})

test("readPackage 校验空 ID；askDownloadFile 返回路径或透传错误", async () => {
  const mt = new MessageTools(store([]))
  assert.deepEqual(await mt.readPackage({ package_id: "" }), { code: "INVALID_INPUT" })
  assert.equal(await mt.askDownloadFile({ raw_id: "raw-018" }), "/dl/raw-018/f")
  assert.deepEqual(await mt.askDownloadFile({ raw_id: "raw-gone" }), { code: "REF_NOT_FOUND" })
})

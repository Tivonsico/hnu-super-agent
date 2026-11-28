import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { HttpMessageStore } from "../src/http-message-store.ts"

test("消息层 HTTP 读取消息包、批读原文和授权下载", async t => {
  const calls: unknown[] = []
  const batch = { code: "OK", records: [], missing_refs: [{ id: "raw-1" }] }
  const original = { ref: { id: "raw-2" }, sent_at: "2026-11-27T08:01:00+08:00",
    type: "text", source: "qq", account_id: "1", conversation_id: "2", message_id: "3",
    sender_id: "4", reply_to_message_id: null, content: "交实验报告" }
  const packageBatch = { ...batch, records: [{ ...original, package_role: "trigger" }] }
  const server = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk.toString()
    calls.push([req.method, req.url, req.headers["x-token"], req.headers.authorization, body && JSON.parse(body)])
    res.setHeader("Content-Type", "application/json")
    if (req.url === "/api/packages/missing") {
      res.statusCode = 404
      res.end(JSON.stringify({ code: "REF_NOT_FOUND" }))
    } else if (req.url?.startsWith("/api/packages/") && req.url !== "/api/packages/legacy") {
      res.end(JSON.stringify(packageBatch))
    } else {
      res.end(JSON.stringify(req.url === "/api/raw/download" ? { code: "OK", file_path: "/tmp/file" } : batch))
    }
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => server.close())
  const store = new HttpMessageStore("http://127.0.0.1:" + (server.address() as AddressInfo).port, "test-token", "fixture")
  assert.deepEqual(await store.readPackage("中文包"), packageBatch)
  assert.deepEqual(await store.readPackage("legacy"), batch)
  assert.deepEqual(await store.readRawInBatch(["raw-1"]), batch)
  assert.equal(await store.download("raw-1"), "/tmp/file")
  assert.deepEqual(await store.readPackage("missing"), { code: "REF_NOT_FOUND" })
  assert.deepEqual(calls, [
    ["GET", "/api/packages/" + encodeURIComponent("中文包"), "fixture", undefined, ""],
    ["GET", "/api/packages/legacy", "fixture", undefined, ""],
    ["POST", "/api/raw/batch", "fixture", undefined, { raw_ids: ["raw-1"] }],
    ["POST", "/api/raw/download", "fixture", "Bearer test-token", { raw_id: "raw-1", authorized: true }],
    ["GET", "/api/packages/missing", "fixture", undefined, ""],
  ])
})

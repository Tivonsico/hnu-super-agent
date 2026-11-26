import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadPrompts } from "../src/prompts.ts"

test("加载角色模板，命名真实工具与节点", async () => {
  const p = await loadPrompts(await mkdtemp(join(tmpdir(), "hnu-")))
  assert.match(p.router, /readCandidateTickets|createTicket/)
  assert.match(p.worker, /appendTicketNote|askDownloadFile/)
  assert.ok(!p.router.includes("## 用户记忆（MEMORY.md）"), "无 MEMORY.md 时不加记忆段")
})

test("有 MEMORY.md 时注入到两个角色", async () => {
  const dot = await mkdtemp(join(tmpdir(), "hnu-"))
  await writeFile(join(dot, "MEMORY.md"), "用户偏好：回复简短。")
  const p = await loadPrompts(dot)
  assert.match(p.router, /回复简短/)
  assert.match(p.worker, /回复简短/)
})

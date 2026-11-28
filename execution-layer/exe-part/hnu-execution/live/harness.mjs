// 真实 API 场景测试台：真实 DSH 栈 + 真实模型 + 真实 Orchestrator，MessageStore 用内存假件。
// 手动跑（需网络与 key），不进 node --test。
import { readFileSync } from "node:fs"
import { mkdtemp, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import AgentLoop from "@deepseek-ai/dsh-agent-loop"
import { mountAgentLoopTestDependencies } from "@deepseek-ai/dsh-agent-loop-testkit"
import * as Jsonl from "@deepseek-ai/dsh-session-persistence-jsonl"
import * as DeepSeekApiKey from "@deepseek-ai/dsh-llm-deepseek-api-key"
import * as ToolPresent from "@deepseek-ai/dsh-tool-present"
import * as ToolFs from "@deepseek-ai/dsh-tool-fs"
import * as ToolFsSearch from "@deepseek-ai/dsh-tool-fs-search"
import { Files } from "../src/files.ts"
import { MessageTools } from "../src/message-tools.ts"
import { Orchestrator } from "../src/orchestrator.ts"
import { DshAgentLoop } from "../src/dsh/loop.ts"
import { loadPrompts } from "../src/prompts.ts"

// 环境变量配置优先；已有联调配置文件继续可用。
const raw = process.env.DEEPSEEK_API_KEY ? "" : readFileSync(new URL("../../../API_KEY.txt", import.meta.url), "utf8")
const conf = raw ? JSON.parse(raw.split("\n")[0]) : {}
export const MODEL = process.env.DEEPSEEK_MODEL || /model_name\s*:\s*"([^"]+)"/.exec(raw)?.[1] || "deepseek-flash"
process.env.DEEPSEEK_API_KEY ||= conf.key
const endpoint = process.env.DEEPSEEK_BASE_URL || conf.url || "https://api.deepseek.com"
process.env.DEEPSEEK_BASE_URL = endpoint.replace(/\/$/, "") === "https://api.deepseek.com"
  ? "https://api.deepseek.com/anthropic"
  : endpoint

// 内存 MessageStore：按包/原件 ID 供数据，download 返回本地副本路径。
export class FakeStore {
  constructor({ packages = {}, records = {}, downloads = {} } = {}) {
    this.packages = packages; this.records = records; this.downloads = downloads
  }
  async readPackage(id) {
    const p = this.packages[id]
    if (!p) return { code: "REF_NOT_FOUND" }
    return { code: "OK", records: p.map(r => this.records[r]).filter(Boolean), missing_refs: [] }
  }
  async readRawInBatch(ids) {
    return { code: "OK", records: ids.map(i => this.records[i]).filter(Boolean), missing_refs: [] }
  }
  async download(rawId) { return this.downloads[rawId] ?? { code: "REF_NOT_FOUND" } }
}

// 建一套完整执行层：返回 { o, root, superdot, ctx, dispose }。
export async function makeOrchestrator(store) {
  const root = await mkdtemp(join(tmpdir(), "hnu-live-"))
  const superdot = join(root, "superdot")
  await mkdir(superdot, { recursive: true })
  const ctx = new Context()
  await ctx.plugin(Jsonl, { root: join(root, "session-logs"), compression: "none" })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(DeepSeekApiKey, {})
  await ctx.plugin(ToolFs, {})
  await ctx.plugin(ToolPresent, {})
  await ctx.plugin(ToolFsSearch, {})
  await ctx.plugin(AgentLoop, { agents: [] })

  const loop = new DshAgentLoop(ctx, { provider: "deepseek-official", model: MODEL })
  const files = new Files(superdot)
  const prompts = await loadPrompts(superdot)
  const o = new Orchestrator({ superdot, files, loop, store: new MessageTools(store), prompts })
  return { o, root, superdot, files, ctx, dispose: async () => { await ctx.fiber._unload() } }
}

// 一条文字原件记录。
export const textRecord = (id, content, sent_at = "2026-11-26T10:00:00+08:00", extra = {}) =>
  ({ ref: { id }, type: "text", source: "qq", content, sent_at, ...extra })
export const fileRecord = (id, name, sent_at = "2026-11-26T10:00:00+08:00") =>
  ({ ref: { id }, type: "file", source: "qq", content: name, sent_at, download_state: "NOT_DOWNLOADED" })

let passed = 0, failed = 0
export function check(label, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}${detail ? " — " + detail : ""}`) }
}
export function report() {
  console.log(`\n=== ${passed} 通过, ${failed} 失败 ===`)
  return failed === 0
}

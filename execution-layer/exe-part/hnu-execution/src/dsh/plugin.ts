// HNU 执行层 Cordis 插件：把执行宿主挂到 DSH。消息层与数据库由外部注入或配置。
import type { Context } from "@deepseek-ai/cordis"
import type { IncomingMessage, ServerResponse } from "node:http"
import { apply as installSessionLink } from "./session-link.mjs"
import { installSessionDirectory } from "./session-directory.mjs"
import { installNativeInput } from "./native-input.ts"
import { Files } from "../files.ts"
import { HttpMessageStore } from "../http-message-store.ts"
import { MessageTools } from "../message-tools.ts"
import { Orchestrator } from "../orchestrator.ts"
import { Http, route } from "../http.ts"
import { DshAgentLoop } from "./loop.ts"
import { loadPrompts } from "../prompts.ts"
import type { MessageStore } from "../ports.ts"
import type { Prompts } from "../orchestrator.ts"

// prompts 省略时从 prompts/ 加载角色模板并注入 MEMORY.md。
export type HnuConfig = { superdot: string; store?: MessageStore; messageServiceUrl?: string; executionToken?: string; webToken?: string; prompts?: Prompts }

export const name = "hnu-execution"
export const inject = ["agents", "sessionPersistence", "tools", "systemPrompt", "webServer", "connection", "workspaceRegistry", "sessionTitle", "sessionProjectionCache"]

export async function apply(ctx: Context, config: HnuConfig): Promise<void> {
  await installSessionDirectory(ctx, config.superdot)
  installSessionLink(ctx, config)
  const messageOrigin = new URL(config.messageServiceUrl ?? process.env.SUPERDOT_MESSAGE_SERVICE_URL ?? "http://127.0.0.1:8766").origin
  ctx.effect(() => ctx.webServer.register({
    kind: "exact", path: "/superdot-workbench",
    handler(req: IncomingMessage, res: ServerResponse) {
      const ticket = new URL(req.url ?? "/", "http://localhost").searchParams.get("ticket") ?? ""
      const suffix = /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(ticket) ? "?ticket_id=" + encodeURIComponent(ticket) : ""
      res.writeHead(302, { location: messageOrigin + "/#tasks" + suffix, "cache-control": "no-store" })
      res.end()
    },
  }))
  const files = new Files(config.superdot)
  installNativeInput(ctx, files)
  const prompts = config.prompts ?? await loadPrompts(config.superdot)
  const store = config.store ?? new HttpMessageStore(
    config.messageServiceUrl ?? process.env.SUPERDOT_MESSAGE_SERVICE_URL ?? "http://127.0.0.1:8766",
    config.executionToken ?? process.env.NOTICEHUB_EXECUTION_TOKEN,
    config.webToken ?? process.env.NOTICEHUB_WEB_TOKEN,
    process.env.SUPERDOT_CALLBACK_TOKEN_FILE,
  )
  const loop = new DshAgentLoop(ctx)
  const o = new Orchestrator({
    superdot: config.superdot, files, loop,
    store: new MessageTools(store), prompts,
  })
  await loop.restoreNativeWorkers(id => o.nativeWorkerSpec(id))
  await o.resumePackages()
  ctx.effect(() => () => o.stopPackages())
  if (process.env.SUPERDOT_RUNTIME_ID) {
    ctx.effect(() => ctx.webServer.register({
      kind: "exact", path: "/superdot-runtime",
      handler(_req: IncomingMessage, res: ServerResponse) {
        json(res, 200, { id: process.env.SUPERDOT_RUNTIME_ID, messageServiceUrl: config.messageServiceUrl })
      },
    }))
  }
  const http = new Http(o)
  // 对外接口只在回环 Web 服务上提供。
  const disposers = ["/api/tickets", "/api/notifications", "/api/router"].map(path => ctx.webServer.register({
    kind: "prefix", path,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost")
      const segments = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent)
      const query = Object.fromEntries(url.searchParams)
      const method = req.method ?? "GET"
      const body = method === "GET" || method === "HEAD" ? {} : await readBody(req)
      const reply = route(http, method, segments, query, () => body)
      if (!reply) { res.writeHead(404); res.end(); return }
      try { const r = await reply; json(res, r.status, r.body) }
      catch { json(res, 503, { code: "STORE_UNAVAILABLE" }) }
    },
  }))
  ctx.effect(() => () => disposers.forEach(dispose => dispose()))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString("utf8").trim()
  return text ? JSON.parse(text) : {}
}
const json = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(text)
}

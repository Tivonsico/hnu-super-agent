// HNU 执行层 Cordis 插件：把执行宿主挂到 DSH。消息层与数据库由外部注入或配置。
import type { Context } from "@deepseek-ai/cordis"
import type { IncomingMessage, ServerResponse } from "node:http"
import { Files } from "../files.ts"
import { MessageTools } from "../message-tools.ts"
import { Orchestrator } from "../orchestrator.ts"
import { Http, route } from "../http.ts"
import { DshAgentLoop } from "./loop.ts"
import type { MessageStore } from "../ports.ts"
import type { Prompts } from "../orchestrator.ts"

export type HnuConfig = { superdot: string; prompts: Prompts; store: MessageStore }

export const name = "hnu-execution"
export const inject = ["agents", "sessionPersistence", "tools", "systemPrompt", "webServer"]

export function apply(ctx: Context, config: HnuConfig): void {
  const files = new Files(config.superdot)
  const o = new Orchestrator({
    superdot: config.superdot, files, loop: new DshAgentLoop(ctx),
    store: new MessageTools(config.store), prompts: config.prompts,
  })
  const http = new Http(o)
  // 对外接口只在回环 Web 服务上提供。
  const dispose = ctx.webServer.register({
    kind: "prefix", path: "/api",
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
  })
  ctx.effect(() => dispose)
  ;(ctx as { orchestrator?: Orchestrator }).orchestrator = o
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

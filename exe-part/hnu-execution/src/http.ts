// 对外 HTTP 接口。与框架无关：返回 {status, body}，由适配层挂到 DSH webServer。
import type { Orchestrator } from "./orchestrator.ts"
import type { ConfirmRequest, NotifyRequest, SteerRequest } from "./io.ts"

export type Reply = { status: number; body: unknown }
const errStatus: Record<string, number> = { INVALID_INPUT: 400, REF_NOT_FOUND: 404, TICKET_HIDDEN: 404, CONFLICT: 409, AUTHORIZATION_REQUIRED: 403, STORE_UNAVAILABLE: 503 }
const isErr = (v: unknown): v is { code: string } => !!v && typeof v === "object" && "code" in v && (v as { code: string }).code in errStatus

export class Http {
  private o: Orchestrator
  constructor(o: Orchestrator) { this.o = o }

  // POST /api/router/notify
  async notify(body: NotifyRequest): Promise<Reply> {
    const r = await this.o.notify(body?.package_ref)
    return isErr(r) ? err(r) : { status: 200, body: r }
  }

  // POST /api/tickets/actions —— SteerRequest 或 ConfirmRequest 共用入口
  async actions(body: SteerRequest | ConfirmRequest): Promise<Reply> {
    if (body?.operation === "confirm") {
      const r = await this.o.confirm(body)
      return isErr(r) ? err(r) : { status: 200, body: r }
    }
    const r = await this.o.action(body as SteerRequest)
    if (isErr(r)) return err(r)
    return { status: r.code === "ACCEPTED" ? 202 : 200, body: r }
  }

  // GET /api/tickets/{id}
  async ticket(id: string): Promise<Reply> {
    const t = await this.o.getTicket(id).catch(() => undefined)
    if (t === undefined) return { status: 404, body: { code: "REF_NOT_FOUND" } }
    return { status: 200, body: { code: "OK", ticket: t } }
  }

  // GET /api/tickets
  async tickets(): Promise<Reply> {
    return { status: 200, body: { code: "OK", items: (await this.o.listTickets()).map(ticket => ({ ticket })) } }
  }

  // GET /api/notifications?state=
  async notifications(state?: "pending" | "handled"): Promise<Reply> {
    return { status: 200, body: { code: "OK", items: await this.o.listNotifications(state) } }
  }

  // POST /api/notifications/{id}/handle
  async handle(id: string, body: { answer?: string }): Promise<Reply> {
    const r = await this.o.handleNotification(id, body?.answer)
    return isErr(r) ? err(r) : { status: 200, body: r }
  }
}

const err = (r: { code: string }): Reply => ({ status: errStatus[r.code] ?? 500, body: { code: r.code } })

// 把方法与路径映射到处理函数。路径段已解码。
export function route(http: Http, method: string, segments: string[], query: Record<string, string>, body: () => unknown): Promise<Reply> | undefined {
  const at = (i: number): string => segments[i] ?? ""
  if (method === "POST" && segments.length === 2 && at(0) === "router" && at(1) === "notify") return http.notify(body() as NotifyRequest)
  if (method === "POST" && segments.length === 2 && at(0) === "tickets" && at(1) === "actions") return http.actions(body() as SteerRequest)
  if (method === "GET" && segments.length === 1 && at(0) === "tickets") return http.tickets()
  if (method === "GET" && segments.length === 2 && at(0) === "tickets") return http.ticket(at(1))
  if (method === "GET" && segments.length === 1 && at(0) === "notifications") return http.notifications(query.state as "pending" | "handled" | undefined)
  if (method === "POST" && segments.length === 3 && at(0) === "notifications" && at(2) === "handle") return http.handle(at(1), body() as { answer?: string })
  return undefined
}

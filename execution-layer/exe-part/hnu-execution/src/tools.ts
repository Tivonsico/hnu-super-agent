// 构造 Router / Worker 的 HNU 工具定义。原生工具（read/bash/skill 等）由 DSH 预设提供，
// 适配层只做工具名限制。此处注册的是执行层自有工具，绑定到当轮上下文。
import type { MessageTools } from "./message-tools.ts"
import type { Notifications } from "./notifications.ts"
import type { Tickets } from "./tickets.ts"
import type { Tool } from "./ports.ts"
import type { Notification } from "./io.ts"
import type { StoreError } from "./types.ts"
import { checkAppend, checkCreate, checkMerge, explain, type AppendCtx } from "./validate.ts"

const str = { type: "string", minLength: 1, pattern: "\\S" }
const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" }
const obj = (properties: object, required: string[]): object =>
  ({ type: "object", properties, required, additionalProperties: false })

// 当轮上下文：Router 侧有包与 Router Session；Worker 侧有工单、工作区与下载授权核验。
export type RouterCtx = { msg: MessageTools; tickets: Tickets; notices: Notifications; packageId: string; routerSessionId: string; newTicketId: string; searched: { value: boolean } }
export type WorkerCtx = {
  msg: MessageTools; tickets: Tickets; notices: Notifications
  ticketId: string; workspace: string; superdot: string; noteId: string; sessionId: string
  authorizeDownload(rawId: string): boolean
}

const readPackage = (ctx: { msg: MessageTools }): Tool => ({
  name: "readPackage",
  description: "按包 ID 读取原文和附件。package_role 区分触发消息、后续消息和历史上下文。",
  parameters: obj({ package_id: str }, ["package_id"]),
  execute: a => ctx.msg.readPackage(a as { package_id: string }),
})
const readRawInBatch = (ctx: { msg: MessageTools }): Tool => ({
  name: "readRawInBatch",
  description: "按原件 ID 批量读取记录，按发送时刻升序返回，缺失项单列。",
  parameters: obj({ raw_ids: { type: "array", items: str } }, ["raw_ids"]),
  execute: a => ctx.msg.readRawInBatch(a as { raw_ids: string[] }),
})
const recordNotification = (ctx: RouterCtx | WorkerCtx, origin: string): Tool => ({
  name: "recordNotification",
  description: "向前端登记一条待处理通知。用户处理后回执投递回本模块。",
  parameters: obj({
    notification_id: id, code: str, content: str, occurred_at: { type: "string", format: "date-time" },
    options: { type: "array", items: obj({ value: str, label: str }, ["value", "label"]), minItems: 1 },
    package_ref: obj({ id: str }, ["id"]), ticket_id: str, session_id: str, node_id: str,
  }, ["notification_id", "code", "content", "occurred_at"]),
  execute: async a => {
    const n = a as Notification
    if ("ticketId" in ctx) {
      if (n.ticket_id && n.ticket_id !== ctx.ticketId) return { code: "INVALID_INPUT" }
      if (n.code === "RESULT_READY" || ["INPUT_NEEDED", "APPROVAL_REQUIRED", "APPROVAL_NEEDED"].includes(n.code)) {
        const ticket = await ctx.tickets.ticket(ctx.ticketId)
        const valid = n.code === "RESULT_READY" ? n.node_id === ticket?.review.result_node_id
          : !!n.node_id && ticket?.review.blocked_node_ids.includes(n.node_id)
        if (!n.node_id || !valid) return { code: "INVALID_INPUT" }
      }
      return ctx.notices.record({ ...n, ticket_id: ctx.ticketId, origin })
    }
    if (n.code === "ROUTE_REVIEW" && n.package_ref?.id !== ctx.packageId) return { code: "INVALID_INPUT" }
    return ctx.notices.record({ ...n, origin })
  },
})

export function routerTools(ctx: RouterCtx): Tool[] {
  return [
    readPackage(ctx), readRawInBatch(ctx),
    {
      name: "readCandidateTickets",
      description: "列出全部可见工单的标题与简述，供判断新建或归入。",
      parameters: obj({}, []),
      execute: async () => { ctx.searched.value = true; return ctx.tickets.candidates() },
    },
    {
      name: "createTicket",
      description: "确认需要新建工单后，按字段建单并写入首个 requirement 节点。",
      parameters: obj({ package_id: str, ticket_id: id, title: str, description: str, requirement: str },
        ["package_id", "ticket_id", "title", "description", "requirement"]),
      execute: a => {
        const args = a as never
        const bad = checkCreate(args, { packageId: ctx.packageId, ticketId: ctx.newTicketId, searched: ctx.searched.value })
        return bad ? Promise.resolve(bad) : ctx.tickets.create(args, ctx.routerSessionId)
      },
    },
    recordNotification(ctx, "router"),
  ]
}

export function workerTools(ctx: WorkerCtx): Tool[] {
  return [
    readPackage(ctx), readRawInBatch(ctx),
    {
      name: "askDownloadFile",
      description: "按文件记录 ID 获取已授权文件的本地绝对路径。",
      parameters: obj({ raw_id: str }, ["raw_id"]),
      execute: async a => {
        const { raw_id } = a as { raw_id: string }
        if (!ctx.authorizeDownload(raw_id)) return { code: "AUTHORIZATION_REQUIRED" } as StoreError<"AUTHORIZATION_REQUIRED">
        return ctx.msg.askDownloadFile({ raw_id })
      },
    },
    {
      name: "appendTicketNote",
      description: "给本单追加一个 Worker 节点（input/result/blocked/unblocked/note）。",
      parameters: obj({
        ticket_id: id,
        node: obj({
          node_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*/[A-Za-z0-9][A-Za-z0-9_-]*$" },
          kind: { enum: ["input", "result", "blocked", "unblocked", "note"] },
          text: str,
          refs: { type: "array" },
        }, ["node_id", "kind", "text", "refs"]),
      }, ["ticket_id", "node"]),
      execute: async a => {
        const args = a as never
        const checked = await checkAppend(args, ctx as AppendCtx)
        if ("code" in checked) return { ...checked, detail: explain(checked) }
        const r = await ctx.tickets.append({ ticket_id: ctx.ticketId, node: checked.node }, ctx.workspace)
        return r.code === "OK" || r.code === "REPLAYED" ? r : { ...r, detail: explain(r) }
      },
    },
    {
      name: "mergeTickets",
      description: "把一张工单并入另一张，写 merge_in 与 merge_out 两侧节点。",
      parameters: obj({ source_ticket_id: id, target_ticket_id: id, operation_id: str },
        ["source_ticket_id", "target_ticket_id", "operation_id"]),
      execute: async a => {
        const args = a as { source_ticket_id: string; target_ticket_id: string; operation_id: string }
        const saved = await ctx.tickets.operation(args.operation_id)
        const bad = checkMerge(args, { ticketId: ctx.ticketId, saved })
        return bad ? { ...bad, detail: explain(bad) } : ctx.tickets.merge(args)
      },
    },
    recordNotification(ctx, "worker"),
  ]
}

// 06 contract.agentTools：原生工具名由适配层按角色放行。
export const NATIVE_TOOLS = {
  router: ["read", "skill", "bash", "job_output"],
  worker: ["read", "glob", "grep", "skill", "write", "edit", "bash", "job_output", "present"],
} as const

// 执行宿主：Router / Worker 的生命周期、工单操作、通知处理与下载流程。
// 单写者：宿主写固定头、session 及用户操作节点；Worker 用工具写 input/result/blocked/unblocked/note。
import { join } from "node:path"
import { Conflict, Files } from "./files.ts"
import { Tickets } from "./tickets.ts"
import { Notifications } from "./notifications.ts"
import { MessageTools } from "./message-tools.ts"
import { routerTools, workerTools, NATIVE_TOOLS } from "./tools.ts"
import { deliveryRequestId, downloadOperationId, newTicketId, routerSessionId, workerSessionId } from "./ids.ts"
import type { AgentLoop, AgentSpec, Tool } from "./ports.ts"
import type {
  ActionReceipt, ConfirmReceipt, ConfirmRequest, NotificationOutcome, NotificationReplyInput,
  NotifyReceipt, RouterBinding, RouterPackageDelivery, SteerRequest, WorkerBinding, WorkerInput,
} from "./io.ts"
import type { EvidenceRef, Node, StoreError } from "./types.ts"

export type Prompts = { router: string; worker: string }
export type OrchestratorDeps = {
  superdot: string
  files: Files
  loop: AgentLoop
  store: MessageTools
  prompts: Prompts
  clock?: () => string
}
type Err = StoreError
const ok = <T>(v: T | Err): v is T => !(v && typeof v === "object" && "code" in v && isErrCode((v as Err).code))
const isErrCode = (c: string): boolean =>
  ["INVALID_INPUT", "REF_NOT_FOUND", "CONFLICT", "STORE_UNAVAILABLE", "AUTHORIZATION_REQUIRED", "TICKET_HIDDEN"].includes(c)

export class Orchestrator {
  private superdot: string
  private files: Files
  private loop: AgentLoop
  private store: MessageTools
  private prompts: Prompts
  private clock: () => string
  private tickets: Tickets
  readonly notices: Notifications
  private allowed = new Set<string>() // 已授权下载的 raw_id

  constructor(deps: OrchestratorDeps) {
    this.superdot = deps.superdot
    this.files = deps.files
    this.loop = deps.loop
    this.store = deps.store
    this.prompts = deps.prompts
    this.clock = deps.clock ?? (() => new Date().toISOString())
    this.tickets = new Tickets(this.files, this.clock)
    this.notices = new Notifications(this.files, {
      router: o => this.onRouterReceipt(o),
      worker: o => this.onWorkerReceipt(o),
    })
  }

  // —— Router：看门狗唤醒，判断并派发 ——
  async notify(packageRef: { id: string }, notification?: NotificationReplyInput): Promise<NotifyReceipt | StoreError<"INVALID_INPUT" | "STORE_UNAVAILABLE">> {
    const packageId = packageRef?.id
    if (!packageId || !/\S/.test(packageId)) return { code: "INVALID_INPUT" }
    const taken = await this.files.saveRecord("takeover", packageId, { package_id: packageId })
    if (taken.state === "conflict") return { code: "INVALID_INPUT" }
    if (taken.state === "replay") return { code: "REPLAYED", package_ref: packageRef }
    try {
      await this.runRouter(packageId, notification)
      return { code: "OK", package_ref: packageRef }
    } catch { return { code: "STORE_UNAVAILABLE" } }
  }

  private async runRouter(packageId: string, notification?: NotificationReplyInput): Promise<void> {
    const sessionId = routerSessionId(packageId)
    const ticketId = newTicketId(packageId)
    const binding: RouterBinding = { package_id: packageId, session_id: sessionId, superdot: this.superdot, new_ticket_id: ticketId, ...(notification ? { notification } : {}) }
    const tools = routerTools({ msg: this.store, tickets: this.tickets, notices: this.notices, packageId, routerSessionId: sessionId })
    const agent = await this.spawn({ sessionId, role: "router", cwd: this.superdot, prompt: this.prompts.router, tools })
    await agent.send(deliveryRequestId(sessionId, "package", packageId), JSON.stringify(binding), "queue")
    const end = await agent.idle()
    await agent.dispose()
    // 新建：Router 用 createTicket 落盘后，宿主启动 Worker。
    if (await this.files.ticket(ticketId)) { await this.launchPackage(ticketId, packageId, sessionId); return }
    // 归入：最终回复给出目标工单，宿主把包交付目标 Worker。
    const attach = parseDelivery(end.text)
    if (attach && (await this.files.ticket(attach.ticket_id))) await this.attachPackage(attach.ticket_id, attach.package_ref.id)
    // 其余（ignore 或存疑已登记通知）本轮结束。
  }

  // 新建工单后首次启动 Worker：追加 session 节点，交付 package 输入。
  private async launchPackage(ticketId: string, packageId: string, routerSession: string): Promise<void> {
    await this.appendHostNode(ticketId, {
      node_id: `${ticketId}/session`, kind: "session", text: "Worker 开始处理。",
      refs: [{ kind: "session", id: workerSessionId(ticketId), role: "worker" }],
    })
    await this.deliverWorker(ticketId, { kind: "package", package_ref: { id: packageId }, input_node_id: `${ticketId}/1` })
  }

  // 归入已有工单：Worker 自行追加 input 节点，宿主只交付 package 输入。
  private async attachPackage(ticketId: string, packageId: string): Promise<void> {
    await this.deliverWorker(ticketId, { kind: "package", package_ref: { id: packageId }, input_node_id: `${ticketId}/package-${packageId}` })
  }

  // —— 用户对已有工单的操作 ——
  async action(req: SteerRequest): Promise<ActionReceipt | StoreError> {
    if (!req?.operation_id || !/\S/.test(req.operation_id)) return { code: "INVALID_INPUT" }
    const ticketId = req.operation === "merge" ? req.target_ticket_id : req.ticket_id
    const saved = await this.files.saveOperation(req)
    if (saved.state === "conflict") return { code: "CONFLICT" }
    if (saved.state === "replay") return { code: "REPLAYED", operation_id: req.operation_id, ticket_id: ticketId }
    const r = await this.applyOperation(req, ticketId)
    if (!ok(r)) return r
    return { code: "ACCEPTED", operation_id: req.operation_id, ticket_id: ticketId }
  }

  private async applyOperation(req: SteerRequest, ticketId: string): Promise<void | Err> {
    const t = await this.files.ticket(ticketId)
    if (!t) return { code: "REF_NOT_FOUND" }
    const op = req.operation_id
    const nodeId = `${ticketId}/operation-${op}`
    switch (req.operation) {
      case "supplement": {
        await this.appendHostNode(ticketId, { node_id: nodeId, kind: "input", text: supplementText(req), refs: opRefs(op, req.attachment_refs) })
        return this.deliverWorker(ticketId, { kind: "operation", operation_id: op, input_node_id: nodeId })
      }
      case "feedback": {
        await this.appendHostNode(ticketId, { node_id: nodeId, kind: "feedback", text: req.text ?? "（见附件）", refs: [{ kind: "operation", id: op }, { kind: "node", id: req.node_id }, ...(req.attachment_refs ?? []).map(r => ({ kind: "attachment", id: r.id } as EvidenceRef))] })
        return this.deliverWorker(ticketId, { kind: "operation", operation_id: op, input_node_id: nodeId })
      }
      case "stop": {
        await this.appendHostNode(ticketId, { node_id: nodeId, kind: "stop", text: "用户终止了本工单。", refs: [{ kind: "operation", id: op }] })
        await this.cancelWorker(ticketId)
        return
      }
      case "resume": {
        await this.appendHostNode(ticketId, { node_id: nodeId, kind: "resume", text: "用户恢复了本工单。", refs: [{ kind: "operation", id: op }] })
        return this.deliverWorker(ticketId, { kind: "operation", operation_id: op, input_node_id: nodeId })
      }
      case "recover": {
        await this.appendHostNode(ticketId, { node_id: nodeId, kind: "recover", text: "上轮执行中断，按已保存的工单继续。", refs: [{ kind: "operation", id: op }, { kind: "node", id: req.node_id }] })
        return this.deliverWorker(ticketId, { kind: "operation", operation_id: op, input_node_id: nodeId })
      }
      case "merge": {
        // 暂停源单派工并取消旧执行，再把合并操作交付目标 Worker（由其调用 mergeTickets）。
        await this.cancelWorker(req.source_ticket_id)
        return this.deliverWorker(ticketId, { kind: "operation", operation_id: op })
      }
    }
  }

  // 用户确认成果：宿主直接写 confirm 节点，刷新即可见。
  async confirm(req: ConfirmRequest): Promise<ConfirmReceipt | StoreError> {
    if (!req?.operation_id || !/\S/.test(req.operation_id)) return { code: "INVALID_INPUT" }
    const nodeId = `${req.ticket_id}/operation-${req.operation_id}`
    const saved = await this.files.saveOperation(req)
    if (saved.state === "conflict") return { code: "CONFLICT" }
    if (saved.state === "replay") return { code: "REPLAYED", operation_id: req.operation_id, ticket_id: req.ticket_id, node_id: nodeId }
    if (!(await this.files.ticket(req.ticket_id))) return { code: "REF_NOT_FOUND" }
    await this.appendHostNode(req.ticket_id, { node_id: nodeId, kind: "confirm", text: "用户确认成果。", refs: [{ kind: "operation", id: req.operation_id }, { kind: "node", id: req.node_id }] })
    return { code: "OK", operation_id: req.operation_id, ticket_id: req.ticket_id, node_id: nodeId }
  }

  // —— 视图 ——
  getTicket = (id: string) => this.tickets.ticket(id)
  listTickets = () => this.tickets.all()
  listNotifications = (state?: "pending" | "handled") => this.notices.list(state)
  handleNotification = (id: string, answer?: string) => this.notices.handle(id, answer)

  // —— 通知回执：Router 的 ROUTE_REVIEW 结果回流，Worker 的下载授权推进 ——
  private async onRouterReceipt(o: NotificationOutcome): Promise<{ code: "OK" | "REPLAYED" }> {
    const n = await this.notices.get(o.notification_id)
    // 存疑澄清：按原 Router Session 复判，带上用户答复（router_answer 绑定）。
    if (n?.code === "ROUTE_REVIEW" && n.package_ref)
      await this.runRouter(n.package_ref.id, { notification_id: o.notification_id, code: n.code, content: n.content, ...(o.answer ? { answer: o.answer } : {}) })
    return { code: "OK" }
  }

  private async onWorkerReceipt(o: NotificationOutcome): Promise<{ code: "OK" | "REPLAYED" }> {
    const n = await this.notices.get(o.notification_id)
    if (n?.code !== "INPUT_NEEDED" || !n.ticket_id || !n.node_id) return { code: "OK" }
    if (o.answer === "allow") await this.runDownload(n.ticket_id, n.node_id, o.notification_id)
    else await this.deliverWorker(n.ticket_id, { kind: "notification", notification: { notification_id: o.notification_id, code: n.code, content: n.content, node_id: n.node_id, ...(o.answer ? { answer: o.answer } : {}) } })
    return { code: "OK" }
  }

  // 下载授权通过：宿主取附件 raw_id、下载、写 download 输入，交付 Worker 解除卡点。
  private async runDownload(ticketId: string, blockedNodeId: string, notificationId: string): Promise<void> {
    const t = await this.files.ticket(ticketId)
    const blocked = t?.nodes.find(n => n.node_id === blockedNodeId)
    const raw = blocked?.refs.find(r => r.kind === "attachment")?.id
    if (!raw) return
    this.allowed.add(raw)
    const path = await this.store.askDownloadFile({ raw_id: raw })
    if (!ok(path)) return
    const op = downloadOperationId(notificationId)
    const nodeId = `${ticketId}/operation-${op}`
    await this.appendHostNode(ticketId, { node_id: nodeId, kind: "input", text: "已下载所需文件。", refs: [{ kind: "operation", id: op }, { kind: "attachment", id: raw }] })
    await this.deliverWorker(ticketId, { kind: "download", notification_id: notificationId, operation_id: op, input_node_id: nodeId, blocked_node_id: blockedNodeId, raw_id: raw, file_path: path })
  }

  // —— Worker 交付：复用每单固定 Session，package 开新轮，操作用 steer ——
  private async deliverWorker(ticketId: string, input: WorkerInput): Promise<void> {
    const sessionId = workerSessionId(ticketId)
    const original = originalId(input)
    const binding: WorkerBinding = {
      ticket_id: ticketId, session_id: sessionId, superdot: this.superdot,
      ticket_path: this.files.ticketPath(ticketId), workspace: this.workspace(ticketId),
      note_id: noteId(ticketId, input), input,
    }
    const tools = workerTools({
      msg: this.store, tickets: this.tickets, notices: this.notices, ticketId,
      workspace: this.workspace(ticketId), authorizeDownload: raw => this.allowed.has(raw),
    })
    const spec: AgentSpec = { sessionId, role: "worker", cwd: this.workspace(ticketId), prompt: this.prompts.worker, tools }
    const exists = await this.loop.exists(sessionId)
    const agent = exists ? await this.loop.resume(spec) : await this.loop.create(spec)
    await agent.send(deliveryRequestId(sessionId, input.kind, original), JSON.stringify(binding), input.kind === "package" ? "queue" : "steer")
    const end = await agent.idle()
    await (end.ok ? agent.dispose() : this.recordInterrupted(ticketId, agent))
  }

  private async cancelWorker(ticketId: string): Promise<void> {
    const sessionId = workerSessionId(ticketId)
    if (!(await this.loop.exists(sessionId))) return
    const agent = await this.loop.resume({ sessionId, role: "worker", cwd: this.workspace(ticketId), prompt: this.prompts.worker, tools: [] })
    agent.cancel()
    await agent.dispose()
  }

  private async recordInterrupted(ticketId: string, agent: { dispose(): Promise<void> }): Promise<void> {
    await this.appendHostNode(ticketId, {
      node_id: `${ticketId}/interrupted-${workerSessionId(ticketId)}`, kind: "interrupted",
      text: "Worker 异常中断，本次执行已退出。", refs: [{ kind: "session", id: workerSessionId(ticketId), role: "worker" }],
    }).catch(() => undefined)
    await agent.dispose()
  }

  private async spawn(spec: AgentSpec) {
    return (await this.loop.exists(spec.sessionId)) ? this.loop.resume(spec) : this.loop.create(spec)
  }

  private async appendHostNode(ticketId: string, node: Omit<Node, "created_at">): Promise<void> {
    try { await this.files.append(ticketId, { ...node, created_at: this.clock() }) }
    catch (e) { if (!(e instanceof Conflict)) throw e }
  }

  private workspace = (ticketId: string): string => join(this.superdot, "..", "work", ticketId)
  nativeTools = NATIVE_TOOLS
}

const noteId = (ticketId: string, input: WorkerInput): string => `n-${ticketId}-${originalId(input)}`
function originalId(input: WorkerInput): string {
  switch (input.kind) {
    case "package": return input.package_ref.id
    case "operation": return input.operation_id
    case "notification": return input.notification.notification_id
    case "download": return input.notification_id
  }
}
const supplementText = (req: Extract<SteerRequest, { operation: "supplement" }>): string =>
  req.text ?? ((req.attachment_refs ?? []).map(r => r.id).join("、") || "（见附件）")
const opRefs = (op: string, attachments?: { id: string }[]): EvidenceRef[] =>
  [{ kind: "operation", id: op }, ...(attachments ?? []).map(r => ({ kind: "attachment", id: r.id } as EvidenceRef))]

function parseDelivery(text: string): RouterPackageDelivery | undefined {
  try {
    const v = JSON.parse(text.trim())
    if (v && typeof v.ticket_id === "string" && v.package_ref && typeof v.package_ref.id === "string") return v
  } catch { /* 非 JSON（如 ignore） */ }
  return undefined
}

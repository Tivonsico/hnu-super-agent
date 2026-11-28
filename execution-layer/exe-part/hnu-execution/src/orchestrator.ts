import { randomUUID } from "node:crypto"
// 执行宿主：Router / Worker 的生命周期、工单操作、通知处理与下载流程。
// 单写者：宿主写固定头、session 及用户操作节点；Worker 用工具写 input/result/blocked/unblocked/note。
import { join } from "node:path"
import { mkdir } from "node:fs/promises"
import { PackageQueue } from "./package-queue.ts"
import { Conflict, Files, ID } from "./files.ts"
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

// Limits active model turns. A delivery waiting on its ticket takes no worker slot.
class TurnSlots {
  private available: number
  private waiting: Array<() => void> = []
  constructor(limit: number) { this.available = limit }

  async run<T>(turn: () => Promise<T>): Promise<T> {
    if (this.available > 0) this.available--
    else await new Promise<void>(resolve => this.waiting.push(resolve))
    try { return await turn() }
    finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.available++
    }
  }
}

export class Orchestrator {
  private routerSlots = new TurnSlots(4)
  private workerSlots = new TurnSlots(4)
  private workerTurns = new Map<string, Promise<void>>()
  private packages: PackageQueue
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
    this.packages = new PackageQueue(this.files, id => this.runRouter(id))
    this.clock = deps.clock ?? (() => new Date().toISOString())
    this.tickets = new Tickets(this.files, this.clock)
    this.notices = new Notifications(this.files, {
      router: o => this.onRouterReceipt(o),
      worker: o => this.onWorkerReceipt(o),
    })
  }

  // —— Router：看门狗唤醒，判断并派发 ——
  resumePackages = () => this.packages.resume()
  stopPackages = () => this.packages.stop()
  waitForPackageWork = () => this.packages.idle()

  async notify(packageRef: { id: string }): Promise<NotifyReceipt | StoreError<"INVALID_INPUT" | "STORE_UNAVAILABLE">> {
    const id = packageRef?.id
    if (typeof id !== "string" || !id.trim()) return { code: "INVALID_INPUT" }
    try {
      return { code: await this.packages.accept(id), package_ref: { id } }
    } catch { return { code: "STORE_UNAVAILABLE" } }
  }

  private async runRouter(packageId: string, notification?: NotificationReplyInput): Promise<void> {
    const sessionId = routerSessionId(packageId)
    const ticketId = newTicketId(packageId)
    const binding: RouterBinding = { package_id: packageId, session_id: sessionId, superdot: this.superdot, new_ticket_id: ticketId, ...(notification ? { notification } : {}) }
    const tools = routerTools({ msg: this.store, tickets: this.tickets, notices: this.notices, packageId, routerSessionId: sessionId, newTicketId: ticketId, searched: { value: false } })
    const attemptKey = notification ? notification.notification_id : packageId
    const deliveryKind = notification ? "notification" : "package"
    const attempt = await this.files.getRecord<{ n: number }>("router-attempt-" + deliveryKind, attemptKey)
    const requestId = deliveryRequestId(sessionId, deliveryKind, attemptKey)
    const end = await this.routerSlots.run(async () => {
      const agent = await this.spawn({ sessionId, role: "router", cwd: this.superdot, prompt: this.prompts.router, tools })
      try {
        await agent.send(attempt ? requestId + "-" + attempt.n : requestId, JSON.stringify(binding), "queue")
        return await agent.idle()
      } finally { await agent.dispose() }
    })
    if (!end.ok) {
      await this.files.putRecord("router-attempt-" + deliveryKind, attemptKey, { n: (attempt?.n ?? 0) + 1 })
      throw new Error("Router failed")
    }
    // 新建：Router 用 createTicket 落盘后，宿主启动 Worker。
    if (await this.files.ticket(ticketId)) { await this.launchPackage(ticketId, packageId, sessionId); return }
    // 归入：最终回复给出目标工单，宿主把包交付目标 Worker。
    const attach = parseDelivery(end.text)
    if (attach) {
      const target = ID.test(attach.ticket_id) && await this.files.ticket(attach.ticket_id)
      if (!target || !target.description.visible || attach.package_ref.id !== packageId) {
        await this.files.putRecord("router-attempt-" + deliveryKind, attemptKey, { n: (attempt?.n ?? 0) + 1 })
        throw new Error("Router selected an unavailable ticket or a different package")
      }
      await this.attachPackage(attach.ticket_id, packageId)
    }
    // 其余（ignore 或存疑已登记通知）本轮结束。
  }

  // 新建工单后首次启动 Worker：追加 session 节点，交付 package 输入。
  private async launchPackage(ticketId: string, packageId: string, routerSession: string): Promise<void> {
    await this.appendHostNode(ticketId, {
      node_id: `${ticketId}/session`, kind: "session", text: "Worker 开始处理。",
      refs: [{ kind: "session", id: workerSessionId(ticketId), role: "worker" }],
    })
    await this.deliverWorker(ticketId, { kind: "package", package_ref: { id: packageId }, input_node_id: `${ticketId}/1` }, "queue")
  }

  // 归入已有工单：Worker 自行追加 input 节点，宿主只交付 package 输入。
  private async attachPackage(ticketId: string, packageId: string): Promise<void> {
    await this.deliverWorker(ticketId, { kind: "package", package_ref: { id: packageId }, input_node_id: `${ticketId}/package-${packageId}` })
  }

  // —— 用户对已有工单的操作 ——
  async action(req: SteerRequest): Promise<ActionReceipt | StoreError> {
    const ticketId = req?.operation === "merge" ? req.target_ticket_id : req?.ticket_id
    if (!["supplement", "feedback", "stop", "resume", "recover", "merge"].includes(req?.operation)
        || (req.operation === "merge" && (!ID.test(req.source_ticket_id ?? "") || req.source_ticket_id === ticketId)))
      return { code: "INVALID_INPUT" }
    const result = await this.commitOperation(req, ticketId, () => this.applyOperation(req, ticketId))
    if (!ok(result)) return result
    return { code: result.replay ? "REPLAYED" : "ACCEPTED", operation_id: req.operation_id, ticket_id: ticketId }
  }

  private operationLocks = new Map<string, Promise<void>>()

  private async commitOperation(req: SteerRequest | ConfirmRequest, ticketId: string, apply: () => Promise<void | Err>): Promise<{ replay: boolean } | Err> {
    if (typeof req?.operation_id !== "string" || !req.operation_id.trim() || typeof ticketId !== "string" || !ID.test(ticketId))
      return { code: "INVALID_INPUT" }
    const id = req.operation_id
    const previous = this.operationLocks.get(id)
    let release!: () => void
    const lock = new Promise<void>(resolve => { release = resolve })
    this.operationLocks.set(id, lock)
    try {
      await previous
      const saved = await this.files.saveOperation(req)
      if (saved.state === "conflict") return { code: "CONFLICT" }
      if (await this.files.getRecord("completed-operation", id)) return { replay: true }
      const failure = await apply()
      if (failure) return failure
      await this.files.putRecord("completed-operation", id, { operation_id: id })
      return { replay: false }
    } catch (e) {
      return { code: e instanceof Conflict ? "CONFLICT" : "STORE_UNAVAILABLE" }
    } finally {
      release()
      if (this.operationLocks.get(id) === lock) this.operationLocks.delete(id)
    }
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
        if (!(await this.files.ticket(req.source_ticket_id))) return { code: "REF_NOT_FOUND" }
        await this.cancelWorker(req.source_ticket_id)
        return this.deliverWorker(ticketId, { kind: "operation", operation_id: op })
      }
    }
  }

  // 用户确认成果：宿主直接写 confirm 节点，刷新即可见。
  async confirm(req: ConfirmRequest): Promise<ConfirmReceipt | StoreError> {
    const nodeId = `${req.ticket_id}/operation-${req.operation_id}`
    const result = await this.commitOperation(req, req.ticket_id, async () => {
      if (!(await this.files.ticket(req.ticket_id))) return { code: "REF_NOT_FOUND" }
      await this.files.append(req.ticket_id, { node_id: nodeId, created_at: this.clock(), kind: "confirm", text: "用户确认成果。", refs: [{ kind: "operation", id: req.operation_id }, { kind: "node", id: req.node_id }] })
    })
    if (!ok(result)) return result
    return { code: result.replay ? "REPLAYED" : "OK", operation_id: req.operation_id, ticket_id: req.ticket_id, node_id: nodeId }
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
    if (!n || !["INPUT_NEEDED", "APPROVAL_REQUIRED", "APPROVAL_NEEDED"].includes(n.code) || !n.ticket_id || !n.node_id) return { code: "OK" }
    const ticket = await this.files.ticket(n.ticket_id)
    const target = ticket?.nodes.find(node => node.node_id === n.node_id)
    if (target?.kind === "blocked" && !ticket?.review.blocked_node_ids.includes(n.node_id)) return { code: "OK" }
    if (n.code === "INPUT_NEEDED" && o.answer === "allow" && target?.refs.some(ref => ref.kind === "attachment"))
      await this.runDownload(n.ticket_id, n.node_id, o.notification_id)
    else await this.deliverWorker(n.ticket_id, { kind: "notification", notification: { notification_id: o.notification_id, code: n.code, content: n.content, node_id: n.node_id, ...(o.answer ? { answer: o.answer } : {}) } })
    return { code: "OK" }
  }

  // 下载授权通过：宿主取附件 raw_id、下载、写 download 输入，交付 Worker 解除卡点。
  private async runDownload(ticketId: string, blockedNodeId: string, notificationId: string): Promise<void> {
    const t = await this.files.ticket(ticketId)
    const blocked = t?.nodes.find(n => n.node_id === blockedNodeId)
    const raw = blocked?.refs.find(r => r.kind === "attachment")?.id
    if (!raw) return
    const path = await this.store.askDownloadFile({ raw_id: raw })
    if (!ok(path)) throw new Error("attachment download failed")
    this.allowed.add(raw)
    const op = downloadOperationId(notificationId)
    const nodeId = `${ticketId}/operation-${op}`
    await this.appendHostNode(ticketId, { node_id: nodeId, kind: "input", text: "已下载所需文件。", refs: [{ kind: "operation", id: op }, { kind: "attachment", id: raw }] })
    await this.deliverWorker(ticketId, { kind: "download", notification_id: notificationId, operation_id: op, input_node_id: nodeId, blocked_node_id: blockedNodeId, raw_id: raw, file_path: path })
  }

  // —— Worker 交付：复用每单固定 Session。首次派工开新一轮（queue），之后的归入包与用户操作都用 steer ——
  private async deliverWorker(ticketId: string, input: WorkerInput, mode: "queue" | "steer" = "steer"): Promise<void> {
    const previous = this.workerTurns.get(ticketId) ?? Promise.resolve()
    const turn = previous.catch(() => {}).then(() =>
      this.workerSlots.run(() => this.runWorker(ticketId, input, mode)))
    this.workerTurns.set(ticketId, turn)
    try { await turn }
    finally { if (this.workerTurns.get(ticketId) === turn) this.workerTurns.delete(ticketId) }
  }

  private async runWorker(ticketId: string, input: WorkerInput, mode: "queue" | "steer"): Promise<void> {
    if (input.kind === "package" && !(await this.files.ticket(ticketId))?.description.visible)
      throw new Error("Worker ticket is unavailable")
    const sessionId = workerSessionId(ticketId)
    const original = originalId(input)
    await mkdir(this.workspace(ticketId), { recursive: true }) // Worker 以工作区为 cwd，需先建目录
    const binding: WorkerBinding = {
      ticket_id: ticketId, session_id: sessionId, superdot: this.superdot,
      ticket_path: this.files.ticketPath(ticketId), workspace: this.workspace(ticketId),
      note_id: noteId(ticketId, input), input,
    }
    const spec = this.workerSpec(ticketId, binding.note_id)
    const exists = await this.loop.exists(sessionId)
    const agent = exists ? await this.loop.resume(spec) : await this.loop.create(spec)
    try {
      await agent.send(deliveryRequestId(sessionId, input.kind, original), JSON.stringify(binding), mode)
      const end = await agent.idle()
      if (!end.ok) await this.recordInterrupted(ticketId)
    } finally { await agent.dispose() }
  }

  private workerSpec(ticketId: string, boundNoteId: string): AgentSpec {
    const sessionId = workerSessionId(ticketId)
    const tools = workerTools({
      msg: this.store, tickets: this.tickets, notices: this.notices, ticketId,
      workspace: this.workspace(ticketId), superdot: this.superdot, noteId: boundNoteId, sessionId,
      authorizeDownload: raw => this.allowed.has(raw),
    })
    return { sessionId, role: "worker", cwd: this.workspace(ticketId), prompt: this.prompts.worker, tools }
  }

  async nativeWorkerSpec(sessionId: string): Promise<AgentSpec | undefined> {
    if (!sessionId.startsWith("worker-")) return
    const ticketId = sessionId.slice(7)
    if (!ID.test(ticketId)) return
    const ticket = await this.files.ticket(ticketId)
    if (!ticket?.nodes.some(node => node.kind === "session" && node.refs.some(ref =>
      ref.kind === "session" && ref.role === "worker" && ref.id === sessionId))) return
    const boundNoteId = "n-" + ticketId + "-" + randomUUID()
    const spec = this.workerSpec(ticketId, boundNoteId)
    spec.prompt += "\n\n当前工单会话绑定：" + JSON.stringify({
      ticket_id: ticketId, session_id: sessionId, superdot: this.superdot, ticket_path: this.files.ticketPath(ticketId),
      workspace: spec.cwd, note_id: boundNoteId,
    })
    return spec
  }

  private async cancelWorker(ticketId: string): Promise<void> {
    const sessionId = workerSessionId(ticketId)
    if (!(await this.loop.exists(sessionId))) return
    const agent = await this.loop.resume({ sessionId, role: "worker", cwd: this.workspace(ticketId), prompt: this.prompts.worker, tools: [] })
    agent.cancel()
    await agent.dispose()
  }

  private async recordInterrupted(ticketId: string): Promise<void> {
    await this.appendHostNode(ticketId, {
      node_id: `${ticketId}/interrupted-${workerSessionId(ticketId)}`, kind: "interrupted",
      text: "Worker 异常中断，本次执行已退出。", refs: [{ kind: "session", id: workerSessionId(ticketId), role: "worker" }],
    }).catch(() => undefined)
  }

  private async spawn(spec: AgentSpec) {
    return (await this.loop.exists(spec.sessionId)) ? this.loop.resume(spec) : this.loop.create(spec)
  }

  private async appendHostNode(ticketId: string, node: Omit<Node, "created_at">): Promise<void> {
    await this.files.append(ticketId, { ...node, created_at: this.clock() })
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

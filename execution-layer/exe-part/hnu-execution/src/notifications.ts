// 通知服务：登记、查询、处理、回执投递。所有来源（router/worker/Dreamer/DataBase）共用。
import { ID, type Files } from "./files.ts"
import type {
  HandledNotification, NoticeItem, Notification, NotificationOutcome,
  NotificationReceipt, OriginReceiptAck,
} from "./io.ts"
import type { StoreError, Ticket } from "./types.ts"
import { key } from "./ids.ts"
import { reviewNodes } from "./review.ts"

const blockCodes = new Set(["INPUT_NEEDED", "APPROVAL_REQUIRED", "APPROVAL_NEEDED", "BLOCKED"])

function bindNotices(ticket: Ticket, items: NoticeItem[]): NoticeItem[] {
  const { resolutions } = reviewNodes(ticket.nodes)
  const resultNodes = ticket.nodes.filter(node => node.kind === "result")
  const recorded = new Set<string>()
  const byId = new Map(ticket.nodes.map(node => [node.node_id, node]))
  const output = items.map(item => {
    const result = item.code === "RESULT_READY"
    let node = item.node_id ? byId.get(item.node_id) : undefined
    if (result && !item.node_id) {
      // 旧版成果提醒缺少节点引用。按发布时刻回看，不能把旧提醒绑到后来交付的版本。
      const at = Date.parse(item.occurred_at)
      node = resultNodes.filter(n => Date.parse(n.created_at) <= at).at(-1)
    }
    if (!node || !(result && node.kind === "result" || blockCodes.has(item.code) && node.kind === "blocked")) return item
    const resolution = resolutions.get(node.node_id)
    if (!result) return resolution ? { ...item, state: "handled" as const, resolution } : item
    recorded.add(node.node_id)
    return { ...item, node_id: node.node_id, read: item.read === true || item.state === "handled",
      state: resolution ? "handled" as const : "pending" as const, ...(resolution ? { resolution } : {}) }
  })
  for (const node of resultNodes) {
    if (recorded.has(node.node_id)) continue
    const resolution = resolutions.get(node.node_id)
    output.push({ id: "review-" + key(ticket.ticket_id, node.node_id), origin: "worker", code: "RESULT_READY",
      occurred_at: node.created_at, content: node.text, ticket_id: ticket.ticket_id, node_id: node.node_id,
      state: resolution ? "handled" : "pending", read: false, ...(resolution ? { resolution } : {}) })
  }
  return output
}

// 按 origin 投递处理回执。执行宿主为自己的 router/worker 注册，外部来源各自注册。
export type ReceiptReceiver = (outcome: NotificationOutcome) => Promise<OriginReceiptAck>

const answerRequired = (n: NoticeItem): boolean =>
  !!n.options?.length || ["INPUT_NEEDED", "APPROVAL_REQUIRED", "APPROVAL_NEEDED", "ROUTE_REVIEW"].includes(n.code)

export class Notifications {
  private files: Files
  private receivers: Map<string, ReceiptReceiver>
  constructor(files: Files, receivers: Record<string, ReceiptReceiver> = {}) {
    this.files = files
    this.receivers = new Map(Object.entries(receivers))
  }
  register(origin: string, receiver: ReceiptReceiver): void { this.receivers.set(origin, receiver) }

  // host-tool：来源用自分配的 notification_id 发布。首次 pending，同内容重放 REPLAYED，异内容 CONFLICT。
  async record(n: Notification): Promise<NotificationReceipt | StoreError<"INVALID_INPUT" | "CONFLICT" | "STORE_UNAVAILABLE">> {
    if (n.ticket_id && !ID.test(n.ticket_id)) return { code: "INVALID_INPUT" }
    if (n.origin === "execution" || !this.receivers.has(n.origin)) return { code: "INVALID_INPUT" }
    const item: NoticeItem = { ...n, id: n.notification_id, state: "pending" }
    delete (item as { notification_id?: string }).notification_id
    const saved = await this.files.saveRecord("notice", n.notification_id, item)
    if (saved.state === "conflict") {
      const existing = await this.get(item.id)
      if (!existing) return { code: "STORE_UNAVAILABLE" }
      const { answer, read, resolution, ...registered } = existing
      if (JSON.stringify({ ...registered, state: "pending" }) !== JSON.stringify(item)) return { code: "CONFLICT" }
      return { code: "REPLAYED" }
    }
    return { code: saved.state === "replay" ? "REPLAYED" : "OK" }
  }

  async list(state?: "pending" | "handled"): Promise<NoticeItem[]> {
    const all = await this.projectNotices(state)
    const results = new Map<string, NoticeItem>()
    return all.filter(item => {
      if (item.code !== "RESULT_READY" || !item.ticket_id || !item.node_id) return true
      const target = key(item.ticket_id, item.node_id)
      const first = results.get(target)
      if (!first) { results.set(target, item); return true }
      if (item.read) first.read = true
      return false
    })
  }

  private async projectNotices(state?: "pending" | "handled"): Promise<NoticeItem[]> {
    const all = await this.files.listRecords<NoticeItem>("notice")
    const grouped = new Map<string, NoticeItem[]>()
    for (const item of all) {
      const id = item.ticket_id ?? ""
      const group = grouped.get(id) ?? []
      group.push(item)
      grouped.set(id, group)
    }
    const items: NoticeItem[] = []
    for (const id of await this.files.ticketIds()) {
      const ticket = await this.files.ticket(id)
      if (!ticket) continue
      const bound = bindNotices(ticket, grouped.get(id) ?? [])
      for (const item of bound) {
        if (!state || item.state === state) {
          if (item.code === "RESULT_READY" && item.node_id && !item.read)
            item.read = !!(await this.files.getRecord("result-read", key(id, item.node_id)))
          items.push(item)
        }
      }
      grouped.delete(id)
    }
    for (const group of grouped.values()) items.push(...group.filter(item => !state || item.state === state))
    return items.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
  }

  async get(id: string): Promise<NoticeItem | undefined> {
    return this.files.getRecord<NoticeItem>("notice", id)
  }

  // 前端处理一条通知：校验答复，原子置 handled 并投递回执。重复同答复 REPLAYED，异答复 CONFLICT。
  async handle(id: string, answer?: string): Promise<HandledNotification | StoreError<"REF_NOT_FOUND" | "INVALID_INPUT" | "CONFLICT">> {
    const previous = this.handles.get(id) ?? Promise.resolve()
    const result = previous.then(() => this.handleOnce(id, answer))
    const settled = result.then(() => {}, () => {})
    this.handles.set(id, settled)
    try { return await result } finally { if (this.handles.get(id) === settled) this.handles.delete(id) }
  }

  private handles = new Map<string, Promise<void>>()

  private async handleOnce(id: string, answer?: string): Promise<HandledNotification | StoreError<"REF_NOT_FOUND" | "INVALID_INPUT" | "CONFLICT">> {
    const item = (await this.projectNotices()).find(notice => notice.id === id)
    if (!item) return { code: "REF_NOT_FOUND" }
    if (item.resolution) {
      const previous = await this.get(id)
      if (previous?.state === "handled" && previous.answer !== undefined && previous.answer === answer)
        return { code: "REPLAYED", id, state: "handled" }
      return { code: "CONFLICT" }
    }
    if (item.code === "RESULT_READY" && item.ticket_id && item.node_id && item.read !== undefined) {
      if (answer !== undefined) return { code: "INVALID_INPUT" }
      await this.files.putRecord("result-read", key(item.ticket_id, item.node_id), { read: true })
      return { code: item.read ? "REPLAYED" : "OK", id, state: "pending", read: true }
    }
    if (item.options?.length ? !item.options.some(o => o.value === answer) : answerRequired(item) ? typeof answer !== "string" || !answer.trim() : answer !== undefined)
      return { code: "INVALID_INPUT" }
    if (item.state === "handled") {
      if (item.answer === answer) return { code: "REPLAYED", id, state: "handled" }
      return { code: "CONFLICT" }
    }
    // 记住所选答复；来源没收妥时，通知仍可用相同答复重试。
    const outcome: NotificationOutcome = { notification_id: id, state: "handled", ...(answer !== undefined ? { answer } : {}) }
    const saved = await this.files.saveRecord("notice-answer", id, outcome)
    if (saved.state === "conflict") return { code: "CONFLICT" }
    if (!(await this.files.getRecord("notice-delivered", id))) {
      const receiver = this.receivers.get(item.origin)
      if (!receiver) throw new Error("notification receiver unavailable")
      await receiver(outcome)
      await this.files.putRecord("notice-delivered", id, { delivered: true })
    }
    await this.files.putRecord("notice", id, { ...item, state: "handled", ...(answer !== undefined ? { answer } : {}) })
    return { code: "OK", id, state: "handled" }
  }

}

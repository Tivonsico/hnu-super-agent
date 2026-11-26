// 通知服务：登记、查询、处理、回执投递。所有来源（router/worker/Dreamer/DataBase）共用。
import type { Files } from "./files.ts"
import type {
  HandledNotification, NoticeItem, Notification, NotificationOutcome,
  NotificationReceipt, OriginReceiptAck,
} from "./io.ts"
import type { StoreError } from "./types.ts"

// 按 origin 投递处理回执。执行宿主为自己的 router/worker 注册，外部来源各自注册。
export type ReceiptReceiver = (outcome: NotificationOutcome) => Promise<OriginReceiptAck>

const answerRequired = (n: NoticeItem): boolean =>
  !!n.options || n.code === "INPUT_NEEDED" || n.code === "ROUTE_REVIEW"

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
    if (n.origin === "execution" || !this.receivers.has(n.origin)) return { code: "INVALID_INPUT" }
    const item: NoticeItem = { ...n, id: n.notification_id, state: "pending" }
    delete (item as { notification_id?: string }).notification_id
    const saved = await this.files.saveRecord("notice", n.notification_id, item)
    if (saved.state === "conflict") return { code: "CONFLICT" }
    return { code: saved.state === "replay" ? "REPLAYED" : "OK" }
  }

  async list(state?: "pending" | "handled"): Promise<NoticeItem[]> {
    const all = await this.files.listRecords<NoticeItem>("notice")
    const items = state ? all.filter(n => n.state === state) : all
    return items.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
  }

  async get(id: string): Promise<NoticeItem | undefined> {
    return this.files.getRecord<NoticeItem>("notice", id)
  }

  // 前端处理一条通知：校验答复，原子置 handled 并投递回执。重复同答复 REPLAYED，异答复 CONFLICT。
  async handle(id: string, answer?: string): Promise<HandledNotification | StoreError<"REF_NOT_FOUND" | "INVALID_INPUT" | "CONFLICT">> {
    const item = await this.get(id)
    if (!item) return { code: "REF_NOT_FOUND" }
    if (item.options ? !item.options.some(o => o.value === answer) : answerRequired(item) ? !answer : answer !== undefined)
      return { code: "INVALID_INPUT" }
    if (item.state === "handled") {
      if (item.answer === answer) { await this.deliver(id); return { code: "REPLAYED", id, state: "handled" } }
      return { code: "CONFLICT" }
    }
    await this.files.putRecord("notice", id, { ...item, state: "handled", ...(answer !== undefined ? { answer } : {}) })
    await this.deliver(id)
    return { code: "OK", id, state: "handled" }
  }

  // 投递回执给原 origin，收到确认后标记。失败抛出，由调用方重试。
  private async deliver(id: string): Promise<void> {
    const item = await this.get(id)
    if (!item || item.state !== "handled") return
    const receiver = this.receivers.get(item.origin)
    if (!receiver) return
    await receiver({ notification_id: id, state: "handled", ...(item.answer !== undefined ? { answer: item.answer } : {}) })
  }
}

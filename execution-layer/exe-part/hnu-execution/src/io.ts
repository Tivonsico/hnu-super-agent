// 执行层对外输入输出类型：绑定、steer 请求、通知。字段与 06 contract.schema.$defs 一致。
import type { Ref } from "./types.ts"

// —— 宿主交付给 Agent 的绑定 ——
export type NotificationReplyInput = {
  notification_id: string
  code: string
  content: string
  answer?: string
  node_id?: string
}

export type RouterBinding = {
  package_id: string
  session_id: string
  superdot: string
  new_ticket_id: string
  notification?: NotificationReplyInput
}

export type WorkerInput =
  | { kind: "package"; package_ref: Ref; input_node_id: string }
  | { kind: "operation"; operation_id: string; input_node_id?: string }
  | { kind: "notification"; notification: NotificationReplyInput }
  | {
      kind: "download"
      notification_id: string
      operation_id: string
      input_node_id: string
      blocked_node_id: string
      raw_id: string
      file_path: string
    }

export type WorkerBinding = {
  ticket_id: string
  session_id: string
  superdot: string
  ticket_path: string
  workspace: string
  note_id: string
  input: WorkerInput
}

// Router 归入已有工单时，最终回复输出的单个 JSON 对象
export type RouterPackageDelivery = { ticket_id: string; package_ref: Ref }

// —— 前端工单操作 ——
export type SteerRequest =
  | { operation: "supplement"; operation_id: string; ticket_id: string; text?: string; attachment_refs?: Ref[] }
  | { operation: "feedback"; operation_id: string; ticket_id: string; node_id: string; text?: string; attachment_refs?: Ref[] }
  | { operation: "stop"; operation_id: string; ticket_id: string }
  | { operation: "resume"; operation_id: string; ticket_id: string }
  | { operation: "recover"; operation_id: string; ticket_id: string; node_id: string }
  | { operation: "merge"; operation_id: string; source_ticket_id: string; target_ticket_id: string }
export type ConfirmRequest = { operation: "confirm"; operation_id: string; ticket_id: string; node_id: string }

export type NotifyRequest = { package_ref: Ref }
export type NotifyReceipt = { code: "OK" | "REPLAYED"; package_ref: Ref }
export type ActionReceipt = { code: "ACCEPTED" | "REPLAYED"; operation_id: string; ticket_id: string }
export type ConfirmReceipt = { code: "OK" | "REPLAYED"; operation_id: string; ticket_id: string; node_id: string }

// —— 工单写入工具回执 ——
export type TicketWriteReceipt = { code: "OK" | "REPLAYED"; ticket_id: string }
export type CommitAck = { code: "OK" | "REPLAYED" }

export type CreateTicketArgs = { package_id: string; ticket_id: string; title: string; description: string; requirement: string }
export type WorkerTicketNode = {
  node_id: string
  kind: "input" | "result" | "blocked" | "unblocked" | "note"
  text: string
  refs: import("./types.ts").EvidenceRef[]
}
export type AppendTicketNoteArgs = { ticket_id: string; node: WorkerTicketNode }
export type MergeTicketsArgs = { source_ticket_id: string; target_ticket_id: string; operation_id: string }

// —— 通知 ——
export type NotificationOption = { value: string; label: string }
export type Notification = {
  notification_id: string
  origin: string
  code: string
  content: string
  occurred_at: string
  options?: NotificationOption[]
  package_ref?: Ref
  ticket_id?: string
  session_id?: string
  node_id?: string
  state?: "pending"
}
export type NoticeItem = {
  id: string
  origin: string
  code: string
  content: string
  occurred_at: string
  state: "pending" | "handled"
  options?: NotificationOption[]
  package_ref?: Ref
  ticket_id?: string
  session_id?: string
  node_id?: string
  answer?: string
  read?: boolean
  resolution?: string
}
export type NotificationReceipt = { code: "OK" | "REPLAYED" }
export type NotificationOutcome = { notification_id: string; state: "handled"; answer?: string }
export type OriginReceiptAck = { code: "OK" | "REPLAYED" }
export type HandleNotificationRequest = { answer?: string }
export type HandledNotification = { code: "OK" | "REPLAYED"; id: string; state: "handled" | "pending"; read?: boolean }

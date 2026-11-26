// 执行层数据类型。字段与 06 图 contract.schema.$defs 及两份接口文档一致。

export type Ref = { id: string }
export type StoreError<Code extends string = StoreCode> = { code: Code }
export type StoreCode =
  | "INVALID_INPUT" | "REF_NOT_FOUND" | "CONFLICT"
  | "STORE_UNAVAILABLE" | "AUTHORIZATION_REQUIRED" | "TICKET_HIDDEN"

// —— 原始消息记录（消息层存储，执行层按引用读取）——
export type RawRecord = {
  ref: Ref
  source: string
  account_id: string
  conversation_id: string
  message_id: string
  sender_id: string
  sent_at: string                // 带时区 ISO 8601
  reply_to_message_id: string | null
  content: string                // 文字为原话，文件为文件名
} & (
  | { type: "text" }
  | { type: "file"; download_state: "NOT_DOWNLOADED" | "DOWNLOADED" | "UNAVAILABLE" }
)
export type RawBatch = { code: "OK"; records: RawRecord[]; missing_refs: Ref[] }

// —— 证据引用 ——
export type EvidenceRef =
  | { kind: "package" | "message" | "attachment" | "artifact" | "ticket" | "node" | "note" | "operation"; id: string }
  | { kind: "session"; id: string; role: "router" | "worker" }

// —— 工单 ——
export type NodeKind =
  | "requirement" | "session" | "input" | "feedback" | "result" | "blocked" | "unblocked"
  | "stop" | "resume" | "recover" | "merge_in" | "merge_out" | "confirm" | "note" | "interrupted"

export type TicketHeader = {
  ticket_id: string
  title: string
  description: { text: string }
  created_at: string
}
export type Node = {
  node_id: string
  created_at: string
  kind: NodeKind
  text: string
  refs: EvidenceRef[]
}
export type Ticket = TicketHeader & {
  description: { text: string; visible: 0 | 1 }
  package_refs: Ref[]
  note_refs: Ref[]
  nodes: Node[]
}
export type Candidate = { ticket_id: string; title: string; description: { text: string; visible: 1 } }

export type Note = {
  note_id: string
  ticket_id: string
  session_id: string
  created_at: string
  content: string
  evidence_refs: EvidenceRef[]
}

// 工单写入与读取工具的核心逻辑。节点 ID 由调用方给定，宿主补 created_at 并发布引用文件。
import { join } from "node:path"
import { Conflict, Files } from "./files.ts"
import type { AppendTicketNoteArgs, CommitAck, CreateTicketArgs, MergeTicketsArgs, TicketWriteReceipt } from "./io.ts"
import type { Candidate, EvidenceRef, Node, StoreError, Ticket, TicketHeader } from "./types.ts"
import { ID } from "./files.ts"

type WriteErr = StoreError<"INVALID_INPUT" | "REF_NOT_FOUND" | "CONFLICT" | "STORE_UNAVAILABLE">
const nonEmpty = (s: unknown): s is string => typeof s === "string" && /\S/.test(s)

export class Tickets {
  private files: Files
  private clock: () => string
  constructor(files: Files, clock: () => string) { this.files = files; this.clock = clock }

  // Router 建单：写工单头与首个 requirement 节点（宿主固定 <ticket>/1）。按包 ID 去重。
  async create(args: CreateTicketArgs, routerSessionId: string): Promise<TicketWriteReceipt | WriteErr> {
    if (![args.package_id, args.title, args.description, args.requirement].every(nonEmpty) || !ID.test(args.ticket_id))
      return { code: "INVALID_INPUT" }
    const header: TicketHeader = {
      ticket_id: args.ticket_id, title: args.title,
      description: { text: args.description }, created_at: this.clock(),
    }
    const first: Node = {
      node_id: `${args.ticket_id}/1`, created_at: header.created_at, kind: "requirement", text: args.requirement,
      refs: [{ kind: "package", id: args.package_id }, { kind: "session", id: routerSessionId, role: "router" }],
    }
    try {
      const fresh = await this.files.create(header, first)
      return { code: fresh ? "OK" : "REPLAYED", ticket_id: args.ticket_id }
    } catch (e) { return e instanceof Conflict ? { code: "CONFLICT" } : { code: "STORE_UNAVAILABLE" } }
  }

  // 追加 Worker 写的节点。result 发布工作区成果，note 发布 Note 草稿，再追加节点。
  async append(args: AppendTicketNoteArgs, workspace: string): Promise<CommitAck | WriteErr> {
    const n = args.node
    if (!ID.test(args.ticket_id) || !nonEmpty(n.text) || !n.node_id.startsWith(`${args.ticket_id}/`))
      return { code: "INVALID_INPUT" }
    if (!(await this.files.ticket(args.ticket_id))) return { code: "REF_NOT_FOUND" }
    try {
      if (n.kind === "result") await this.publishArtifacts(args.ticket_id, workspace, n.refs)
      if (n.kind === "note") await this.publishNote(workspace, n.refs)
      const fresh = await this.files.append(args.ticket_id, { ...n, created_at: this.clock() })
      return { code: fresh ? "OK" : "REPLAYED" }
    } catch (e) { return mapError(e) }
  }

  // 目标 Worker 合并：源单停写后，目标写 merge_in，源单写 merge_out。节点 ID 由原操作稳定计算。
  async merge(args: MergeTicketsArgs): Promise<TicketWriteReceipt | WriteErr> {
    const { source_ticket_id: src, target_ticket_id: tgt, operation_id: op } = args
    if (!ID.test(src) || !ID.test(tgt) || src === tgt || !nonEmpty(op)) return { code: "INVALID_INPUT" }
    if (!(await this.files.ticket(src)) || !(await this.files.ticket(tgt))) return { code: "REF_NOT_FOUND" }
    const at = this.clock()
    const into: Node = {
      node_id: `${tgt}/operation-${op}`, created_at: at, kind: "merge_in",
      text: `已并入工单 ${src}，原要求和材料见来源工单。`,
      refs: [{ kind: "operation", id: op }, { kind: "ticket", id: src }],
    }
    const out: Node = {
      node_id: `${src}/operation-${op}`, created_at: at, kind: "merge_out",
      text: `本单已并入工单 ${tgt}，后续工作在 ${tgt} 继续。`,
      refs: [{ kind: "operation", id: op }, { kind: "ticket", id: tgt }],
    }
    try {
      await this.files.append(tgt, into)
      await this.files.append(src, out)
      return { code: "OK", ticket_id: tgt }
    } catch (e) { return mapError(e) }
  }

  async candidates(): Promise<Candidate[]> {
    const out: Candidate[] = []
    for (const id of await this.files.ticketIds()) {
      const t = await this.files.ticket(id)
      if (t && t.description.visible === 1) out.push({ ticket_id: t.ticket_id, title: t.title, description: t.description })
    }
    return out
  }

  ticket = (id: string): Promise<Ticket | undefined> => this.files.ticket(id)
  async all(): Promise<Ticket[]> {
    const out: Ticket[] = []
    for (const id of await this.files.ticketIds()) { const t = await this.files.ticket(id); if (t) out.push(t) }
    return out
  }

  private async publishArtifacts(ticketId: string, workspace: string, refs: EvidenceRef[]): Promise<void> {
    for (const ref of refs) {
      if (ref.kind !== "artifact") continue
      const name = ref.id.startsWith(`${ticketId}/`) ? ref.id.slice(ticketId.length + 1) : ref.id
      await this.files.publishFile(join(workspace, "artifacts", name), this.files.artifactPath(ref.id))
    }
  }
  private async publishNote(workspace: string, refs: EvidenceRef[]): Promise<void> {
    for (const ref of refs) {
      if (ref.kind !== "note") continue
      await this.files.publishFile(join(workspace, "notes", `${ref.id}.json`), this.files.notePath(ref.id))
    }
  }
}

function mapError(e: unknown): WriteErr {
  if (e instanceof Conflict) return { code: "CONFLICT" }
  if (e instanceof Error && e.message === "REF_NOT_FOUND") return { code: "REF_NOT_FOUND" }
  return { code: "STORE_UNAVAILABLE" }
}

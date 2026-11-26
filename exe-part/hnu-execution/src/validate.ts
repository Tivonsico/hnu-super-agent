// 工单写入的校验：引用形状、节点约束、调用方绑定。
// 06 的 schema 里 allOf/contains/$ref 这类关键字不在 DSH 的参数校验子集里，
// 所以这些约束放在工具执行时检查，违规回 INVALID_INPUT，引用查不到回 REF_NOT_FOUND。
import { promises as fs } from "node:fs"
import { join } from "node:path"
import type { AppendTicketNoteArgs, CreateTicketArgs, MergeTicketsArgs } from "./io.ts"
import type { EvidenceRef, StoreError } from "./types.ts"

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const REF_KINDS = ["package", "message", "attachment", "artifact", "ticket", "node", "note", "operation"]

export type WriteErr = StoreError<"INVALID_INPUT" | "REF_NOT_FOUND">

// 引用必须是 06 的 EvidenceRef：八种 kind 带 id，session 还要带 role。多出来的字段一律不算。
export function evidenceRef(v: unknown): EvidenceRef | undefined {
  if (!v || typeof v !== "object") return undefined
  const r = v as Record<string, unknown>
  if (typeof r.kind !== "string" || typeof r.id !== "string" || !/\S/.test(r.id)) return undefined
  const keys = Object.keys(r).sort().join(",")
  if (r.kind === "session")
    return keys === "id,kind,role" && (r.role === "router" || r.role === "worker") ? { kind: "session", id: r.id, role: r.role } : undefined
  return REF_KINDS.includes(r.kind) && keys === "id,kind" ? { kind: r.kind as EvidenceRef["kind"], id: r.id } : undefined
}

export type NodeCheck = { node: { node_id: string; kind: AppendTicketNoteArgs["node"]["kind"]; text: string; refs: EvidenceRef[] } } | WriteErr

// 节点形状：id 以本单号开头，kind 在 Worker 可写的五种里，text 非空，refs 逐项合规。
export function nodeShape(ticketId: string, n: unknown): NodeCheck {
  if (!n || typeof n !== "object") return { code: "INVALID_INPUT" }
  const node = n as Record<string, unknown>
  const kinds = ["input", "result", "blocked", "unblocked", "note"]
  if (typeof node.node_id !== "string" || !node.node_id.startsWith(`${ticketId}/`) || !ID.test(node.node_id.split("/")[1] ?? ""))
    return { code: "INVALID_INPUT" }
  if (!kinds.includes(node.kind as string) || typeof node.text !== "string" || !/\S/.test(node.text) || !Array.isArray(node.refs))
    return { code: "INVALID_INPUT" }
  const refs: EvidenceRef[] = []
  for (const r of node.refs) {
    const ref = evidenceRef(r)
    if (!ref) return { code: "INVALID_INPUT" }
    refs.push(ref)
  }
  return { node: { node_id: node.node_id, kind: node.kind as AppendTicketNoteArgs["node"]["kind"], text: node.text, refs } }
}

// 节点约束：input 要引用包或操作，unblocked 要引用节点，note 要引用 Note。
export function nodeRefs(kind: string, refs: EvidenceRef[]): WriteErr | undefined {
  const has = (k: string) => refs.some(r => r.kind === k)
  if (kind === "input" && !has("package") && !has("operation")) return { code: "INVALID_INPUT" }
  if (kind === "unblocked" && !has("node")) return { code: "INVALID_INPUT" }
  if (kind === "note" && !has("note")) return { code: "INVALID_INPUT" }
  return undefined
}

export type AppendCtx = { ticketId: string; workspace: string; superdot: string; noteId: string; sessionId: string }

// 追加节点的完整校验：形状、约束、成果文件在 workspace/artifacts、Note 草稿在 workspace/notes 且字段与当轮绑定一致。
export async function checkAppend(args: AppendTicketNoteArgs, ctx: AppendCtx): Promise<NodeCheck> {
  if (args.ticket_id !== ctx.ticketId) return { code: "INVALID_INPUT" }
  const shape = nodeShape(ctx.ticketId, args.node)
  if ("code" in shape) return shape
  const bad = nodeRefs(shape.node.kind, shape.node.refs)
  if (bad) return bad
  for (const ref of shape.node.refs) {
    if (ref.kind === "artifact" && !(await staged(ctx.workspace, "artifacts", ctx.ticketId, ref.id))) return { code: "REF_NOT_FOUND" }
    if (ref.kind === "note") {
      if (ref.id !== ctx.noteId) return { code: "INVALID_INPUT" }
      if (!(await noteDraft(ctx, ref.id))) return { code: "REF_NOT_FOUND" }
    }
  }
  return shape
}

const staged = (workspace: string, dir: string, ticketId: string, id: string): Promise<boolean> =>
  fs.access(join(workspace, dir, id.startsWith(`${ticketId}/`) ? id.slice(ticketId.length + 1) : id)).then(() => true, () => false)

// Note 草稿是正式 Note 的预览：字段齐全，ticket_id、session_id 与当轮绑定一致。
async function noteDraft(ctx: AppendCtx, noteId: string): Promise<boolean> {
  try {
    const draft = JSON.parse(await fs.readFile(join(ctx.workspace, "notes", `${noteId}.json`), "utf8"))
    return draft.note_id === noteId && draft.ticket_id === ctx.ticketId && draft.session_id === ctx.sessionId
      && typeof draft.content === "string" && /\S/.test(draft.content)
      && Array.isArray(draft.evidence_refs) && draft.evidence_refs.length > 0 && typeof draft.created_at === "string"
  } catch { return false }
}

export type CreateCtx = { packageId: string; ticketId: string; searched: boolean }

// 建单校验：包号与工单号必须是本轮绑定的，且本轮已查过候选。
export function checkCreate(args: CreateTicketArgs, ctx: CreateCtx): WriteErr | undefined {
  if (args.package_id !== ctx.packageId || args.ticket_id !== ctx.ticketId || !ctx.searched) return { code: "INVALID_INPUT" }
  return undefined
}

// 合并校验：调用方是目标单的 Worker，两单号与已保存的原操作一致。
export function checkMerge(args: MergeTicketsArgs, ctx: { ticketId: string; saved?: { source_ticket_id?: string; target_ticket_id?: string } }): WriteErr | undefined {
  if (args.target_ticket_id !== ctx.ticketId) return { code: "INVALID_INPUT" }
  const s = ctx.saved
  if (!s) return { code: "REF_NOT_FOUND" }
  if (s.source_ticket_id !== args.source_ticket_id || s.target_ticket_id !== args.target_ticket_id) return { code: "INVALID_INPUT" }
  return undefined
}

const DETAIL: Record<string, string> = {
  INVALID_INPUT: "参数不符合接口约定",
  REF_NOT_FOUND: "引用的文件或记录不存在",
  CONFLICT: "同一节点号已有不同内容，或同名成果文件内容不同；新版成果要用新文件名",
  STORE_UNAVAILABLE: "存储暂时不可用，稍后重试",
}
export const explain = (e: { code: string }): string => DETAIL[e.code] ?? e.code

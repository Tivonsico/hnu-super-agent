// 消息层读取工具：readPackage、readRawInBatch、askDownloadFile。
// 批读与包读共用排序去重：按 sent_at 升序，同时刻保持输入首次出现顺序，缺项单列。
import type { MessageStore } from "./ports.ts"
import type { RawBatch, RawRecord, Ref, StoreError } from "./types.ts"

const nonEmpty = (s: unknown): s is string => typeof s === "string" && /\S/.test(s)

export function orderBatch(records: RawRecord[], order: string[]): RawBatch {
  const seen = new Map<string, RawRecord>()
  for (const r of records) if (!seen.has(r.ref.id)) seen.set(r.ref.id, r)
  const rank = new Map<string, number>()
  order.forEach((id, i) => { if (!rank.has(id)) rank.set(id, i) })
  const found: RawRecord[] = []
  const missing: Ref[] = []
  const first = [...new Set(order)]
  for (const id of first) { const r = seen.get(id); if (r) found.push(r); else missing.push({ id }) }
  found.sort((a, b) => a.sent_at.localeCompare(b.sent_at) || (rank.get(a.ref.id)! - rank.get(b.ref.id)!))
  return { code: "OK", records: found, missing_refs: missing }
}

export class MessageTools {
  private store: MessageStore
  constructor(store: MessageStore) { this.store = store }

  readPackage = (args: { package_id: string }): Promise<RawBatch | StoreError<"INVALID_INPUT" | "REF_NOT_FOUND" | "STORE_UNAVAILABLE">> =>
    nonEmpty(args.package_id) ? this.store.readPackage(args.package_id) : Promise.resolve({ code: "INVALID_INPUT" })

  async readRawInBatch(args: { raw_ids: string[] }): Promise<RawBatch | StoreError<"INVALID_INPUT" | "STORE_UNAVAILABLE">> {
    if (!Array.isArray(args.raw_ids) || !args.raw_ids.every(nonEmpty)) return { code: "INVALID_INPUT" }
    if (args.raw_ids.length === 0) return { code: "OK", records: [], missing_refs: [] }
    const res = await this.store.readRawInBatch(args.raw_ids)
    return "code" in res && res.code !== "OK" ? res : orderBatch((res as RawBatch).records, args.raw_ids)
  }

  // Worker/宿主下载：授权核验由上层（宿主）完成，这里仅转调消息层并归一化错误。
  async askDownloadFile(args: { raw_id: string }): Promise<string | StoreError<"INVALID_INPUT" | "REF_NOT_FOUND" | "CONFLICT" | "STORE_UNAVAILABLE">> {
    if (!nonEmpty(args.raw_id)) return { code: "INVALID_INPUT" }
    return this.store.download(args.raw_id)
  }
}

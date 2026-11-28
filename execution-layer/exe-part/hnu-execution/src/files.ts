// superdot 下的文件存储：工单 JSONL、原操作、成果与 Note 的发布。
// 写入一律先写同目录临时文件并同步，再 rename 发布并同步父目录。
import { promises as fs } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { reviewNodes } from "./review.ts"
import type { Node, Ticket, TicketHeader } from "./types.ts"

export const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export class Conflict extends Error {}

export type Saved = { state: "fresh" | "replay"; saved: unknown } | { state: "conflict" }

async function publish(path: string, data: Buffer | string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  const file = await fs.open(temp, "w")
  try { await file.writeFile(data); await file.sync() } finally { await file.close() }
  await fs.rename(temp, path)
  const dir = await fs.open(dirname(path), "r")
  try { await dir.sync() } finally { await dir.close() }
}

const read = (path: string): Promise<Buffer | undefined> =>
  fs.readFile(path).catch(e => { if (e.code === "ENOENT") return undefined; throw e })

const sha = (data: Buffer): string => createHash("sha256").update(data).digest("hex")

// 节点比较不含 created_at：重试同一节点对象沿用首次保存的时间
const same = (a: Omit<Node, "created_at">, b: Omit<Node, "created_at">): boolean =>
  JSON.stringify([a.node_id, a.kind, a.text, a.refs]) === JSON.stringify([b.node_id, b.kind, b.text, b.refs])

export class Files {
  readonly superdot: string
  constructor(superdot: string) { this.superdot = superdot }

  ticketPath = (id: string): string => join(this.superdot, "tickets", `${id}.jsonl`)
  operationPath = (id: string): string => join(this.superdot, "operations", `${encodeURIComponent(id)}.json`)
  artifactPath = (id: string): string => join(this.superdot, "artifacts", id)
  notePath = (id: string): string => join(this.superdot, "memory", "notes", `${id}.json`)
  sessionPath = (id: string): string => join(this.superdot, "sessions", `${encodeURIComponent(id)}.jsonl`)

  async lines(id: string): Promise<[TicketHeader, ...Node[]] | undefined> {
    const data = await read(this.ticketPath(id))
    if (!data) return undefined
    return data.toString("utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) as [TicketHeader, ...Node[]]
  }

  // 建单：写固定头与首节点。已存在时内容一致则返回 false（重放），否则冲突。
  async create(header: TicketHeader, first: Node): Promise<boolean> {
    const old = await this.lines(header.ticket_id)
    if (old) {
      const [h, n] = old
      if (h.title === header.title && h.description.text === header.description.text && n && same(n, first)) return false
      throw new Conflict()
    }
    await publish(this.ticketPath(header.ticket_id), `${JSON.stringify(header)}\n${JSON.stringify(first)}\n`)
    return true
  }

  // 追加节点：原有字节保持为前缀。同 ID 同内容返回 false（重放），不同内容冲突。
  async append(ticketId: string, node: Node): Promise<boolean> {
    const previous = this.appends.get(ticketId) ?? Promise.resolve()
    const result = previous.then(() => this.appendNode(ticketId, node))
    const settled = result.then(() => {}, () => {})
    this.appends.set(ticketId, settled)
    try { return await result }
    finally { if (this.appends.get(ticketId) === settled) this.appends.delete(ticketId) }
  }

  private appends = new Map<string, Promise<void>>()

  private async appendNode(ticketId: string, node: Node): Promise<boolean> {
    const path = this.ticketPath(ticketId)
    const data = await read(path)
    if (!data) throw new Error(`ticket ${ticketId} missing`)
    const old = data.toString("utf8").split("\n").filter(Boolean).slice(1).map(l => JSON.parse(l) as Node)
    const hit = old.find(n => n.node_id === node.node_id)
    if (hit) { if (same(hit, node)) return false; throw new Conflict() }
    if (node.kind === "confirm" || node.kind === "feedback") {
      const current = reviewNodes(old).result_node_id
      if (!current || !node.refs.some(ref => ref.kind === "node" && ref.id === current)) throw new Conflict()
    }
    if (node.kind === "unblocked") {
      const targets = node.refs.filter(ref => ref.kind === "node").map(ref => ref.id)
      if (!targets.length || targets.some(id => !old.some(n => n.node_id === id && n.kind === "blocked")))
        throw new Conflict()
      if (old.some(n => n.kind === "unblocked" && n.refs.some(ref => ref.kind === "node" && targets.includes(ref.id))))
        throw new Conflict()
    }
    await publish(path, Buffer.concat([data, Buffer.from(`${JSON.stringify(node)}\n`)]))
    return true
  }

  async ticket(id: string): Promise<Ticket | undefined> {
    const lines = await this.lines(id)
    return lines && view(lines)
  }

  async ticketIds(): Promise<string[]> {
    const names = await fs.readdir(join(this.superdot, "tickets")).catch(e => { if (e.code === "ENOENT") return []; throw e })
    return names.filter(n => n.endsWith(".jsonl")).map(n => n.slice(0, -6)).sort()
  }

  // 原操作按 operation_id 保存一次（Agent 可按路径读取）。
  async saveOperation(op: { operation_id: string }): Promise<Saved> {
    return this.saveJson(this.operationPath(op.operation_id), op)
  }

  async operation(id: string): Promise<Record<string, unknown> | undefined> {
    const data = await read(this.operationPath(id))
    return data && JSON.parse(data.toString("utf8"))
  }

  // 宿主私有状态（接管、待投递、通知）。按 kind/id 幂等保存，不供 Agent 读取。
  private recordPath = (kind: string, id: string): string =>
    join(this.superdot, "host", kind, `${encodeURIComponent(id)}.json`)

  saveRecord = (kind: string, id: string, value: object): Promise<Saved> =>
    this.saveJson(this.recordPath(kind, id), value)

  async getRecord<T>(kind: string, id: string): Promise<T | undefined> {
    const data = await read(this.recordPath(kind, id))
    return data && (JSON.parse(data.toString("utf8")) as T)
  }

  async putRecord(kind: string, id: string, value: object): Promise<void> {
    await publish(this.recordPath(kind, id), `${JSON.stringify(value)}\n`)
  }

  async listRecords<T>(kind: string): Promise<T[]> {
    const dir = join(this.superdot, "host", kind)
    const names = await fs.readdir(dir).catch(e => { if (e.code === "ENOENT") return []; throw e })
    const out: T[] = []
    for (const name of names.filter(name => name.endsWith(".json")).sort()) {
      const data = await read(join(dir, name))
      if (data) out.push(JSON.parse(data.toString("utf8")) as T)
    }
    return out
  }

  // 幂等写入：首次写盘返回 fresh；已存同内容返回 replay；不同内容记 conflict。
  private async saveJson(path: string, value: object): Promise<Saved> {
    const line = `${JSON.stringify(value)}\n`
    const old = await read(path)
    if (old) return old.toString("utf8") === line ? { state: "replay", saved: JSON.parse(old.toString("utf8")) } : { state: "conflict" }
    await publish(path, line)
    return { state: "fresh", saved: value }
  }

  // 发布草稿到目标路径。已有同内容复用，内容不同冲突。返回发布后的绝对路径。
  async publishFile(staged: string, target: string): Promise<string> {
    const data = await read(staged)
    const old = await read(target)
    if (!data) { if (old) return target; throw new Error("REF_NOT_FOUND") }
    if (old) { if (sha(old) === sha(data)) return target; throw new Conflict() }
    await publish(target, data)
    return target
  }

  exists = (path: string): Promise<boolean> => fs.access(path).then(() => true, () => false)

  // 把 superdot/sessions 下的链接指向 DSH 实际日志
  async link(sessionId: string, log: string): Promise<void> {
    if (!(await this.exists(log))) return
    const path = this.sessionPath(sessionId)
    await fs.mkdir(dirname(path), { recursive: true })
    if ((await fs.readlink(path).catch(() => undefined)) === log) return
    await fs.rm(path, { force: true })
    await fs.symlink(log, path)
  }
}

// 从固定头和节点生成工单视图：可见性按节点顺序计算，包与笔记索引按首次引用去重。
export function view([header, ...nodes]: [TicketHeader, ...Node[]]): Ticket {
  let visible: 0 | 1 = 1
  const packages: string[] = []
  const notes: string[] = []
  for (const node of nodes) {
    if (node.kind === "stop" || node.kind === "merge_out") visible = 0
    if (node.kind === "resume") visible = 1
    for (const ref of node.refs) {
      if (ref.kind === "package" && !packages.includes(ref.id)) packages.push(ref.id)
      if (ref.kind === "note" && !notes.includes(ref.id)) notes.push(ref.id)
    }
  }
  const { result_node_id, blocked_node_ids } = reviewNodes(nodes)
  return {
    review: { result_node_id, blocked_node_ids },
    ticket_id: header.ticket_id,
    title: header.title,
    description: { text: header.description.text, visible },
    created_at: header.created_at,
    package_refs: packages.map(id => ({ id })),
    note_refs: notes.map(id => ({ id })),
    nodes,
  }
}

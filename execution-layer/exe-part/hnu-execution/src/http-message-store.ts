import { readFile } from "node:fs/promises"
import { isAbsolute } from "node:path"
import type { MessageStore } from "./ports.ts"
import type { RawBatch } from "./types.ts"

const unavailable = { code: "STORE_UNAVAILABLE" } as const
type Reply = { body: Record<string, unknown>; status: number }

function batch({ body, status }: Reply): RawBatch | typeof unavailable | { code: "INVALID_INPUT" } {
  if (status === 400 && body.code === "INVALID_INPUT") return { code: "INVALID_INPUT" }
  if (status !== 200 || body.code !== "OK" || !Array.isArray(body.records) || !Array.isArray(body.missing_refs)) return unavailable
  if (!body.records.every(r => r && typeof r.ref?.id === "string" && typeof r.sent_at === "string") ||
      !body.missing_refs.every(r => r && typeof r.id === "string")) return unavailable
  return { code: "OK", records: body.records, missing_refs: body.missing_refs }
}

export class HttpMessageStore implements MessageStore {
  private origin: string
  private token: string
  private webToken: string
  private webTokenFile?: string

  constructor(origin: string, token = "", webToken = "", webTokenFile?: string) {
    const url = new URL(origin)
    if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.username || url.password || url.search || url.hash)
      throw new Error("messageServiceUrl 必须是 HTTP(S) 服务源地址")
    this.origin = url.origin
    this.token = token
    this.webToken = webToken
    this.webTokenFile = webTokenFile
  }

  private async request(path: string, payload?: object, authorize = false): Promise<Reply> {
    const headers: Record<string, string> = { Accept: "application/json" }
    if (payload) headers["Content-Type"] = "application/json"
    if (authorize && this.token) headers.Authorization = "Bearer " + this.token
    try {
      const webToken = this.webTokenFile ? await readFile(this.webTokenFile, "utf8") : this.webToken
      if (webToken) headers["X-Token"] = webToken
      const res = await fetch(this.origin + path, {
        method: payload ? "POST" : "GET", headers, body: JSON.stringify(payload),
        redirect: "error", signal: AbortSignal.timeout(authorize ? 60000 : 10000),
      })
      const body = await res.json()
      if (body && typeof body === "object") return { status: res.status, body }
    } catch { /* 连接失败、超时、无效 JSON 统一为可重试的存储错误。 */ }
    return { status: 503, body: unavailable }
  }

  async readPackage(id: string) {
    const reply = await this.request("/api/packages/" + encodeURIComponent(id))
    if (reply.status === 404 && reply.body.code === "REF_NOT_FOUND") return { code: "REF_NOT_FOUND" } as const
    return batch(reply)
  }

  async readRawInBatch(ids: string[]) {
    return batch(await this.request("/api/raw/batch", { raw_ids: ids }))
  }

  async download(rawId: string) {
    if (!this.token) return { code: "AUTHORIZATION_REQUIRED" } as const
    const { status, body } = await this.request("/api/raw/download", { raw_id: rawId, authorized: true }, true)
    if (status === 200 && body.code === "OK" && typeof body.file_path === "string" && isAbsolute(body.file_path)) return body.file_path
    if (status === 403 && body.code === "AUTHORIZATION_REQUIRED") return { code: "AUTHORIZATION_REQUIRED" } as const
    if (status === 404 && body.code === "REF_NOT_FOUND") return { code: "REF_NOT_FOUND" } as const
    if (status === 409 && body.code === "CONFLICT") return { code: "CONFLICT" } as const
    if (status === 400 && body.code === "INVALID_INPUT") return { code: "INVALID_INPUT" } as const
    return unavailable
  }
}

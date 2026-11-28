// DSH Web 的 session/prompt 为真人消息设置 source.kind=user 和稳定的 rpcId。
import type { Context } from "@deepseek-ai/cordis"
import type { UserMessage } from "@deepseek-ai/dsh-llm"
import { key } from "../ids.ts"
import { Files, ID } from "../files.ts"

export function installNativeInput(ctx: Context, files: Files) {
  const pending = new Map<string, Promise<void>>()
  async function record(sessionId: string, message: UserMessage) {
    const ticketId = sessionId.slice("worker-".length)
    const ticket = await files.ticket(ticketId)
    if (!ticket?.nodes.some(n => n.kind === "session" &&
        n.refs.some(r => r.kind === "session" && r.role === "worker" && r.id === sessionId))) return
    const source = message.source
    if (!("rpcId" in source) || typeof source.rpcId !== "string") return
    const parts: string[] = []
    for (const part of message.content) {
      if (part.type === "text" && part.text.trim()) parts.push(part.text)
      if (part.type === "file") parts.push("附件：" + part.attachment.name)
      if (part.type === "image") parts.push("附图")
    }
    if (!parts.length) return
    const nodeId = ticketId + "/dsh-" + key(sessionId, source.rpcId)
    await files.append(ticketId, { node_id: nodeId, kind: "input", text: parts.join("\n"), created_at: new Date().toISOString(),
      refs: [{ kind: "session", id: sessionId, role: "worker" }] })
  }

  function submit(sessionId: string, message: UserMessage) {
    if (!sessionId.startsWith("worker-") || !ID.test(sessionId.slice(7)) ||
        message.source.kind !== "user" || !("rpcId" in message.source) || !message.source.rpcId) return
    // 队列和 pre-step 事件可能先后看到同一条消息，节点号由 RPC 派生，重试仍只写一次。
    const previous = pending.get(sessionId) ?? Promise.resolve()
    const task = previous.then(() => record(sessionId, message))
    const settled = task.catch(() => {}).finally(() => {
      if (pending.get(sessionId) === settled) pending.delete(sessionId)
    })
    pending.set(sessionId, settled)
    return task
  }

  ctx.on("agent/inbox/inserted", ({ agent, message }) => {
    void submit(agent.session.id, message)?.catch(error => console.error("无法登记 DSH 工单补充", error.message))
  })
  ctx.on("agent/pre-step", async ({ agent, messages }, next) => {
    for (const message of messages) await submit(agent.session.id, message)
    return next()
  })
  return { idle: (sessionId: string) => pending.get(sessionId) ?? Promise.resolve() }
}

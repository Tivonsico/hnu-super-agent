// 测试用 AgentLoop 假件：记录交付，按脚本调用工具并给出最终回复。
// 每个 session 的脚本按「收到第 n 次交付」触发一段动作。
import type { Agent, AgentLoop, AgentSpec, RunEnd, Tool } from "../src/ports.ts"

export type Delivery = { sessionId: string; requestId: string; text: string; mode: "queue" | "steer" }
// 脚本：给定本轮绑定与工具表，执行工具并返回最终回复；ok=false 表示异常退出。
export type Turn = (ctx: { binding: any; tool: (name: string, args: unknown) => Promise<unknown>; spec: AgentSpec }) => Promise<Partial<RunEnd> | void>

export class FakeLoop implements AgentLoop {
  deliveries: Delivery[] = []
  sessions = new Set<string>()
  cancelled: string[] = []
  private script: Record<string, Turn[]>
  private seen: Record<string, number> = {}
  constructor(script: Record<string, Turn[]> = {}) { this.script = script }

  exists = async (sessionId: string): Promise<boolean> => this.sessions.has(sessionId)
  create = async (spec: AgentSpec): Promise<Agent> => { this.sessions.add(spec.sessionId); return this.agent(spec) }
  resume = async (spec: AgentSpec): Promise<Agent> => this.agent(spec)

  private agent(spec: AgentSpec): Agent {
    const loop = this
    let pending: { requestId: string; text: string } | undefined
    const tool = (name: string, args: unknown) => {
      const t = spec.tools.find((x: Tool) => x.name === name)
      if (!t) throw new Error(`tool ${name} 未注册到 ${spec.role}`)
      return t.execute(args)
    }
    return {
      async send(requestId, text, mode) { loop.deliveries.push({ sessionId: spec.sessionId, requestId, text, mode }); pending = { requestId, text } },
      cancel() { loop.cancelled.push(spec.sessionId) },
      async idle(): Promise<RunEnd> {
        const turns = loop.script[spec.sessionId] ?? loop.script[spec.role] ?? []
        const n = loop.seen[spec.sessionId] ?? 0
        loop.seen[spec.sessionId] = n + 1
        const turn = turns[n]
        const binding = pending ? JSON.parse(pending.text) : undefined
        const out = turn ? await turn({ binding, tool, spec }) : undefined
        return { ok: out?.ok ?? true, text: out?.text ?? "ignore" }
      },
      async dispose() {},
    }
  }
}

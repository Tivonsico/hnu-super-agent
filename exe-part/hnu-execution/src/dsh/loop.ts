// AgentLoop 的 DSH 实现：把执行层的 AgentSpec 映射到真实的 DSH Agent 生命周期。
// 工具注册、提示词段、工具名限制都在 setup 内完成，投递复用 DSSA 的幂等做法。
import type { Context } from "@deepseek-ai/cordis"
import type { Agent as DshAgent, AgentHandle } from "@deepseek-ai/dsh-agent"
import { freezeMessage, MessageId, type UserMessage } from "@deepseek-ai/dsh-llm"
import type { SessionId } from "@deepseek-ai/dsh-session"
import type { Agent, AgentLoop, AgentSpec, RunEnd, Tool } from "../ports.ts"
import { NATIVE_TOOLS } from "../tools.ts"

export const WORKER_PRESET = "dsh-superagent-worker"
export const ROUTER_PRESET = "dsh-superagent-router"

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap { "hnu-exec": { kind: "hnu-exec"; form: "relay" } }
}

const msgId = (requestId: string): string => MessageId(`hnu-exec:${requestId}`)

export class DshAgentLoop implements AgentLoop {
  private ctx: Context
  constructor(ctx: Context) { this.ctx = ctx }

  async exists(sessionId: string): Promise<boolean> {
    return (await this.ctx.sessionPersistence.stat(SessionId(sessionId))) !== undefined
  }

  async create(spec: AgentSpec): Promise<Agent> {
    const handle = await this.ctx.agents.createAgent(this.ctx, {
      sessionId: SessionId(spec.sessionId),
      meta: { cwd: spec.cwd, agentPreset: spec.role === "worker" ? WORKER_PRESET : ROUTER_PRESET },
      setup: agentCtx => this.setup(agentCtx, spec),
    })
    return this.wrap(handle)
  }

  async resume(spec: AgentSpec): Promise<Agent> {
    const handle = await this.ctx.agents.resume(this.ctx, {
      resumeSessionId: SessionId(spec.sessionId),
      setup: agentCtx => this.setup(agentCtx, spec),
    })
    return this.wrap(handle)
  }

  // 在 Agent 作用域注册角色模板、HNU 工具，并把工具名限制为该角色的原生 + HNU 工具。
  private setup(agentCtx: Context, spec: AgentSpec): void {
    agentCtx.systemPrompt.section({ name: "hnu-exec", order: 9999, interpolate: false, text: () => spec.prompt, ...(spec.role === "router" ? { complete: true } : {}) })
    for (const tool of spec.tools) this.registerTool(agentCtx, tool)
    const allow = [...NATIVE_TOOLS[spec.role], ...spec.tools.map(t => t.name)]
    agentCtx.tools.restrict({ allow })
    if (spec.role === "worker" && spec.cwd) {
      // Worker 的业务写入只在本工单工作区内（原生 write/edit/bash），超出由预设沙盒约束。
    }
  }

  private registerTool(agentCtx: Context, tool: Tool): void {
    agentCtx.tools.register({
      name: tool.name, description: tool.description, parameters: tool.parameters,
      output: { schema: { type: "object", additionalProperties: true }, render: (_a, value) => [{ type: "text", text: JSON.stringify(value) }] },
      execute: args => tool.execute(args),
    })
  }

  private wrap(handle: AgentHandle): Agent {
    const agent = handle.agent
    const ctx = this.ctx
    return {
      async send(requestId, text, mode) {
        if (await holds(ctx, agent, requestId)) { await ctx.sessionPersistence.flush(); return }
        const message = freezeMessage({ id: msgId(requestId), role: "user", content: [{ type: "text", text }], source: { kind: "hnu-exec", form: "relay" } })
        if (mode === "steer") agent.steer(message); else agent.followup(message)
        await ctx.sessionPersistence.flush()
      },
      cancel() { agent.cancel({ kind: "user" }, { keepInbox: false }) },
      async idle(): Promise<RunEnd> {
        await agent.whenIdle()
        await ctx.sessionPersistence.flush()
        return { ok: agent.status !== "error", text: lastAssistantText(agent) }
      },
      dispose: () => handle.dispose(),
    }
  }
}

// 末条 assistant 文本：Router 归入时输出的 JSON，或 Worker 的最终回复。
function lastAssistantText(agent: DshAgent): string {
  const events = agent.session.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type !== "assistant/message") continue
    return e.data.message.content.filter(b => b.type === "text").map(b => (b as { text: string }).text).join("\n").trim()
  }
  return ""
}

// 幂等：同 requestId 已在历史或收件箱则不再投递。
async function holds(ctx: Context, agent: DshAgent, requestId: string): Promise<boolean> {
  const id = msgId(requestId)
  const inInbox = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some((m: UserMessage) => m.id === id)
  if (inInbox) return true
  await ctx.sessionPersistence.flush()
  await using handle = await ctx.sessionPersistence.open(agent.id, "read")
  for (let offset = 0; ;) {
    const { events } = await handle.read(offset, 512)
    if (!events.length) return false
    for (const e of events) if (e.type === "user/message" && e.data.id === id) return true
    offset += events.length
  }
}

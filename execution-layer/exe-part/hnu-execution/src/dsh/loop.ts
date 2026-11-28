// AgentLoop 的 DSH 实现：把执行层的 AgentSpec 映射到真实的 DSH Agent 生命周期。
// 工具注册、提示词段、工具名限制都在 setup 内完成，投递复用 DSSA 的幂等做法。
import type { Context } from "@deepseek-ai/cordis"
import type { Agent as DshAgent, AgentHandle } from "@deepseek-ai/dsh-agent"
import { freezeMessage, MessageId, type UserMessage } from "@deepseek-ai/dsh-llm"
import { SessionId } from "@deepseek-ai/dsh-session"
import type { Agent, AgentLoop, AgentSpec, RunEnd, Tool } from "../ports.ts"
import { NATIVE_TOOLS } from "../tools.ts"

import { routerBashGuard } from "./router-bash-guard.ts"
export { routerBashGuard } from "./router-bash-guard.ts"

export const WORKER_PRESET = "dsh-superagent-worker"
export const ROUTER_PRESET = "dsh-superagent-router"

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap { "hnu-exec": { kind: "hnu-exec"; form: "relay" } }
}

const msgId = (requestId: string): string => MessageId(`hnu-exec:${requestId}`)

export type ModelChoice = { provider?: string; model?: string }

export class DshAgentLoop implements AgentLoop {
  private installed = new WeakMap<object, { spec: AgentSpec }>()
  private ctx: Context
  private model: ModelChoice
  constructor(ctx: Context, model: ModelChoice = {}) { this.ctx = ctx; this.model = model }

  async exists(sessionId: string): Promise<boolean> {
    return (await this.ctx.sessionPersistence.stat(SessionId(sessionId))) !== undefined
  }

  async create(spec: AgentSpec): Promise<Agent> {
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(spec.sessionId),
      meta: { cwd: spec.cwd, agentPreset: spec.role === "worker" ? WORKER_PRESET : ROUTER_PRESET },
      agentOptions: this.model,
      setup: agentCtx => this.setup(agentCtx, spec),
    })
    return this.wrap(handle)
  }

  async resume(spec: AgentSpec): Promise<Agent> {
    const live = this.ctx.agents.get(SessionId(spec.sessionId))
    if (live) {
      if (spec.tools.length) this.setup(live.ctx, spec)
      return this.wrap({ agent: live, dispose: async () => {} })
    }
    const handle = await this.ctx.agents.resume({
      resumeSessionId: SessionId(spec.sessionId),
      setup: agentCtx => this.setup(agentCtx, spec),
    })
    return this.wrap(handle)
  }

  async restoreNativeWorkers(resolveSpec: (id: string) => Promise<AgentSpec | undefined>): Promise<void> {
    const restore = async (agent: DshAgent) => {
      if (this.installed.has(agent.ctx) || !agent.id.startsWith("worker-")) return
      const spec = await resolveSpec(agent.id)
      if (spec) this.setup(agent.ctx, spec)
    }
    this.ctx.on("agent/created", ({ agent }) => restore(agent), { global: true })
    await Promise.all(this.ctx.agents.list().map(restore))
  }

  // 在 Agent 作用域注册角色模板、HNU 工具，并把工具名限制为该角色的原生 + HNU 工具。
  private setup(agentCtx: Context, spec: AgentSpec): void {
    const existing = this.installed.get(agentCtx)
    if (existing) { existing.spec = spec; return }
    const current = { spec }
    this.installed.set(agentCtx, current)
    agentCtx.systemPrompt.section({ name: "hnu-exec", order: 9999, interpolate: false, text: () => current.spec.prompt, ...(spec.role === "router" ? { complete: true } : {}) })
    for (const tool of spec.tools) this.registerTool(agentCtx, {
      ...tool,
      execute: args => {
        const active = current.spec.tools.find(item => item.name === tool.name)
        return active ? active.execute(args) : Promise.resolve({ code: "INVALID_INPUT" })
      },
    })
    // 只限制全局原生工具（同 DSSA 取已装工具的交集）；Agent 作用域注册的 HNU 工具不受限制，无需列入。
    agentCtx.tools.restrict({ allow: NATIVE_TOOLS[spec.role].filter(name => agentCtx.tools.get(name) !== undefined) })
    // Router 只判断去向：bash 仅用于只读查看，写入与改动一律拒绝。
    if (spec.role === "router") agentCtx.tools.guard(execution => routerBashGuard(execution))
  }

  private registerTool(agentCtx: Context, tool: Tool): void {
    agentCtx.tools.register({
      name: tool.name, description: tool.description, parameters: tool.parameters,
      // 空 schema 接受任意 JSON：readCandidateTickets 按接口文档返回数组。
      output: { schema: {}, render: (_a, value) => [{ type: "text", text: JSON.stringify(value) }] },
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
        const end = agent.session.snapshotEvents().findLast(event => event.type === "turn/end")
        return { ok: agent.status !== "error" && end?.data.reason.kind !== "error", text: lastAssistantText(agent) }
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

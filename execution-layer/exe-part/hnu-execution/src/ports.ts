// 执行层依赖的外部能力。MessageStore 由消息层实现，AgentLoop 由 DSH 适配层实现。
import type { RawBatch, StoreError } from "./types.ts"

export interface MessageStore {
  readPackage(packageId: string): Promise<RawBatch | StoreError<"INVALID_INPUT" | "REF_NOT_FOUND" | "STORE_UNAVAILABLE">>
  readRawInBatch(rawIds: string[]): Promise<RawBatch | StoreError<"INVALID_INPUT" | "STORE_UNAVAILABLE">>
  // 宿主核对授权后调用，由消息层下载或返回已有副本的绝对路径
  download(rawId: string): Promise<string | StoreError<"INVALID_INPUT" | "REF_NOT_FOUND" | "AUTHORIZATION_REQUIRED" | "CONFLICT" | "STORE_UNAVAILABLE">>
}

// 一个 HNU 工具：参数 JSON Schema 与执行函数。DSH 适配层把它注册为 ToolDefinition。
export type Tool = {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(args: unknown): Promise<unknown>
}

export type AgentSpec = {
  sessionId: string
  role: "router" | "worker"
  cwd: string
  prompt: string // 角色模板与顶层记忆
  tools: Tool[]
}

export type RunEnd = { ok: boolean; text: string } // ok 为 false 表示异常退出；text 为最终回复

export interface Agent {
  // AgentDelivery.send：同一 requestId 只投递一次
  send(requestId: string, text: string, mode: "queue" | "steer"): Promise<void>
  cancel(): void
  // 等本轮结束，返回最终回复
  idle(): Promise<RunEnd>
  // 等后台工作退出、flush 后释放
  dispose(): Promise<void>
}

export interface AgentLoop {
  exists(sessionId: string): Promise<boolean>
  create(spec: AgentSpec): Promise<Agent>
  resume(spec: AgentSpec): Promise<Agent>
}

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import { createUserMessage } from "@deepseek-ai/dsh-llm"
import { SessionId } from "@deepseek-ai/dsh-session"
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from "@deepseek-ai/dsh-agent-loop-testkit"
import { Files } from "../src/files.ts"
import { Notifications } from "../src/notifications.ts"
import { installNativeInput } from "../src/dsh/native-input.ts"

test("DSH 原生 Worker 队列的人类 RPC 输入结束旧成果待审；内部转发和 RPC 重放不增加节点", async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId("worker-demo"))
  const dot = new Files(await mkdtemp(join(tmpdir(), "hnu-native-")))
  const sync = installNativeInput(ctx, dot)
  const stamp = new Date().toISOString()
  await dot.create({ ticket_id: "demo", title: "校对", description: { text: "初稿" }, created_at: stamp },
    { kind: "session", node_id: "demo/session", text: "Worker", refs: [{ kind: "session", role: "worker", id: "worker-demo" }], created_at: stamp })
  await dot.append("demo", { node_id: "demo/v1", kind: "result", text: "初版", refs: [], created_at: stamp })
  const notices = new Notifications(dot)
  for (const source of [{ kind: "hnu-exec", form: "relay" }, { kind: "retry", rpcId: "retry" }, { kind: "user" }]) {
    agent.inbox.append("next-turn", createUserMessage({ content: [{ type: "text", text: "内部消息" }], source }))
  }
  await sync.idle("worker-demo")
  assert.equal((await notices.list("pending")).length, 1)
  for (let i = 0; i < 2; i++) {
    agent.inbox.append("next-turn", createUserMessage({ content: [{ type: "text", text: "把时间改成周六。" }],
      source: { kind: "user", rpcId: "same-request" } }))
  }
  await sync.idle("worker-demo")
  const ticket = await dot.ticket("demo")
  assert.deepEqual(ticket.nodes.filter(n => n.kind === "input").map(n => n.text), ["把时间改成周六。"])
  assert.equal(ticket.review.result_node_id, null)
  assert.equal((await notices.list("pending")).length, 0)
  assert.equal((await notices.list("handled"))[0].resolution, "input")
})

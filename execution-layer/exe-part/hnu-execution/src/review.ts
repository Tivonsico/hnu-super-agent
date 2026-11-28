// 工单日志是待审状态的依据。通知只负责提醒，读取通知不改变节点状态。
import type { Node } from "./types.ts"

export function reviewNodes(nodes: Node[]) {
  let result: string | null = null
  const blocked = new Set<string>()
  const resolutions = new Map<string, string>()
  for (const node of nodes) {
    const targets = node.refs.filter(ref => ref.kind === "node").map(ref => ref.id)
    const targeted = (node.kind === "confirm" || node.kind === "feedback") && result && targets.includes(result)
    if (result && (targeted || ["input", "merge_in", "result", "stop", "merge_out"].includes(node.kind))) {
      resolutions.set(result, node.kind)
      result = null
    }
    if (node.kind === "result") result = node.node_id
    if (node.kind === "blocked") blocked.add(node.node_id)
    if (node.kind === "unblocked") {
      for (const id of targets) if (blocked.delete(id)) resolutions.set(id, "unblocked")
    }
    if (node.kind === "stop" || node.kind === "merge_out") {
      for (const id of blocked) resolutions.set(id, node.kind)
      blocked.clear()
    }
  }
  return { result_node_id: result, blocked_node_ids: [...blocked], resolutions }
}

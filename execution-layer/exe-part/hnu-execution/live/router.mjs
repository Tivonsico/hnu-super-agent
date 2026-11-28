// Router 三条去向的真实模型测试：新建、归入、忽略。
import { makeOrchestrator, FakeStore, textRecord, check, report } from "./harness.mjs"

// 场景 1：全新任务 → 应新建工单。
async function newTask() {
  console.log("\n[场景1] 全新任务 → 新建")
  const store = new FakeStore({
    packages: { "pkg-1": ["m-1"] },
    records: { "m-1": textRecord("m-1", "帮我做一份社团招新的海报，周五要用") },
  })
  const { o, dispose } = await makeOrchestrator(store)
  try {
    const r = await o.notify({ id: "pkg-1" })
    await o.waitForPackageWork()
    check("notify 回执 OK", r.code === "OK", JSON.stringify(r))
    const tickets = await o.listTickets()
    check("建了 1 张工单", tickets.length === 1, `共 ${tickets.length} 张`)
    const t = tickets[0]
    if (t) {
      check("首节点为 requirement", t.nodes[0]?.kind === "requirement", t.nodes[0]?.kind)
      check("requirement 原文照录未改写", /海报/.test(t.nodes[0]?.text ?? ""), t.nodes[0]?.text)
    }
  } finally { await dispose() }
}

// 场景 2：已有工单的后续消息 → 应归入，不新建。
async function attach() {
  console.log("\n[场景2] 已有工单的后续 → 归入")
  const store = new FakeStore({
    packages: {
      "pkg-1": ["m-1"],
      "pkg-2": ["m-2"],
    },
    records: {
      "m-1": textRecord("m-1", "帮我做一份社团招新的海报，周五要用"),
      "m-2": textRecord("m-2", "刚才那个海报，主题颜色换成蓝色吧", "2026-11-26T11:00:00+08:00"),
    },
  })
  const { o, dispose } = await makeOrchestrator(store)
  try {
    await o.notify({ id: "pkg-1" })      // 先建单
    await o.waitForPackageWork()
    const before = (await o.listTickets()).length
    await o.notify({ id: "pkg-2" })      // 后续消息
    await o.waitForPackageWork()
    const tickets = await o.listTickets()
    check("未新建第二张工单", tickets.length === before, `建单前 ${before}，现 ${tickets.length}`)
    const t = tickets[0]
    console.log("    节点:", (t?.nodes ?? []).map(n => `${n.kind}(${n.node_id})`).join(" "))
    const attached = t?.nodes.some(n => n.kind === "input" && n.refs.some(r => r.kind === "package" && r.id === "pkg-2"))
    check("pkg-2 作为 input 节点归入原单", !!attached, (t?.nodes ?? []).map(n => n.kind).join(","))
  } finally { await dispose() }
}

// 场景 3：与任务无关的闲聊 → 应忽略，不建单。
async function ignore() {
  console.log("\n[场景3] 无关闲聊 → 忽略")
  const store = new FakeStore({
    packages: { "pkg-1": ["m-1"] },
    records: { "m-1": textRecord("m-1", "哈哈哈今天天气真好，晚上一起吃饭吗") },
  })
  const { o, dispose } = await makeOrchestrator(store)
  try {
    await o.notify({ id: "pkg-1" })
    await o.waitForPackageWork()
    const tickets = await o.listTickets()
    check("未建工单", tickets.length === 0, `共 ${tickets.length} 张`)
  } finally { await dispose() }
}

await newTask()
await attach()
await ignore()
process.exit(report() ? 0 : 1)

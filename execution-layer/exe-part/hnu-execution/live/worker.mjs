// Worker 与用户操作的真实模型测试：派工收尾、补充、反馈、下载授权、终止与恢复、合并。
import { makeOrchestrator, FakeStore, textRecord, fileRecord, check, report } from "./harness.mjs"
import { writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"

const REF_KINDS = ["package", "message", "attachment", "artifact", "ticket", "node", "note", "operation", "session"]
const refsOk = t => t.nodes.every(n => n.refs.every(r => REF_KINDS.includes(r.kind) && typeof r.id === "string"))
const kinds = t => t.nodes.map(n => n.kind).join(",")

async function lifecycle() {
  console.log("\n[场景W1] 派工 → 成果 → note；补充；反馈；确认")
  const store = new FakeStore({
    packages: { "pkg-1": ["m-1"] },
    records: { "m-1": textRecord("m-1", "帮我写一段 100 字左右的社团招新文案，发朋友圈用") },
  })
  const { o, dispose } = await makeOrchestrator(store)
  try {
    await o.notify({ id: "pkg-1" })
    await o.waitForPackageWork()
    let t = (await o.listTickets())[0]
    check("首轮有 result", t.nodes.some(n => n.kind === "result"), kinds(t))
    check("首轮有 note 且已发布", t.note_refs.length > 0, kinds(t))
    check("首轮未重复登记 input", !t.nodes.some(n => n.kind === "input"), kinds(t))
    check("引用全部合规", refsOk(t))

    await o.action({ operation: "supplement", operation_id: "u-1", ticket_id: t.ticket_id, text: "结尾加上报名二维码的提示语" })
    t = await o.getTicket(t.ticket_id)
    const results = t.nodes.filter(n => n.kind === "result")
    check("补充后有新 result", results.length >= 2, kinds(t))

    const last = results.at(-1)
    await o.action({ operation: "feedback", operation_id: "u-2", ticket_id: t.ticket_id, node_id: last.node_id, text: "语气再活泼一点" })
    t = await o.getTicket(t.ticket_id)
    check("反馈节点引用原成果", t.nodes.some(n => n.kind === "feedback" && n.refs.some(r => r.kind === "node" && r.id === last.node_id)))
    check("反馈后又有新 result", t.nodes.filter(n => n.kind === "result").length > results.length, kinds(t))

    const final = t.nodes.filter(n => n.kind === "result").at(-1)
    const c = await o.confirm({ operation: "confirm", operation_id: "u-3", ticket_id: t.ticket_id, node_id: final.node_id })
    check("确认成果写 confirm", c.code === "OK" && (await o.getTicket(t.ticket_id)).nodes.at(-1).kind === "confirm")
    check("全程引用合规", refsOk(await o.getTicket(t.ticket_id)))
  } finally { await dispose() }
}

async function download(root) {
  console.log("\n[场景W2] 需要群文件 → blocked + INPUT_NEEDED → allow → unblocked")
  const store = new FakeStore({
    packages: { "pkg-1": ["m-1", "f-1"] },
    records: {
      "m-1": textRecord("m-1", "按群里发的活动名单，统计一下一共多少人报名"),
      "f-1": fileRecord("f-1", "活动名单.csv", "2026-11-26T09:59:00+08:00"),
    },
  })
  const env = await makeOrchestrator(store)
  const csv = join(env.root, "dl", "活动名单.csv")
  await mkdir(join(env.root, "dl"), { recursive: true })
  await writeFile(csv, "姓名,学号\n张三,1\n李四,2\n王五,3\n")
  store.downloads["f-1"] = csv
  const { o, dispose } = env
  try {
    await o.notify({ id: "pkg-1" })
    await o.waitForPackageWork()
    let t = (await o.listTickets())[0]
    const blocked = t.nodes.find(n => n.kind === "blocked")
    check("先写 blocked 并引用附件", !!blocked && blocked.refs.some(r => r.kind === "attachment" && r.id === "f-1"), kinds(t))
    const pending = (await o.listNotifications("pending")).find(n => n.code === "INPUT_NEEDED")
    check("发 INPUT_NEEDED 且挂在卡点上", !!pending && pending.node_id === blocked?.node_id, JSON.stringify(pending))
    if (!pending) return
    await o.handleNotification(pending.id, "allow")
    t = await o.getTicket(t.ticket_id)
    check("下载后 unblocked 引用原卡点", t.nodes.some(n => n.kind === "unblocked" && n.refs.some(r => r.kind === "node" && r.id === blocked.node_id)), kinds(t))
    check("结果里有正确人数 3", t.nodes.some(n => n.kind === "result" && /3/.test(n.text)), t.nodes.filter(n => n.kind === "result").map(n => n.text).join(" | "))
  } finally { await dispose() }
}

async function stopResumeMerge() {
  console.log("\n[场景W3] 终止 → 隐藏；恢复 → 可见；合并 → 源单隐藏")
  const store = new FakeStore({
    packages: { "pkg-a": ["m-a"], "pkg-b": ["m-b"] },
    records: {
      "m-a": textRecord("m-a", "帮我列一份周末去岳麓山的物品清单"),
      "m-b": textRecord("m-b", "帮我查一下湖南大学图书馆周六的开放时间写个提醒", "2026-11-26T10:05:00+08:00"),
    },
  })
  const { o, dispose } = await makeOrchestrator(store)
  try {
    await o.notify({ id: "pkg-a" })
    await o.waitForPackageWork()
    await o.notify({ id: "pkg-b" })
    await o.waitForPackageWork()
    const [a, b] = await o.listTickets()
    check("两包各建一单", !!a && !!b && a.ticket_id !== b.ticket_id)
    if (!a || !b) return
    await o.action({ operation: "stop", operation_id: "u-s", ticket_id: a.ticket_id })
    check("终止后隐藏", (await o.getTicket(a.ticket_id)).description.visible === 0)
    await o.action({ operation: "resume", operation_id: "u-r", ticket_id: a.ticket_id })
    check("恢复后可见", (await o.getTicket(a.ticket_id)).description.visible === 1)
    await o.action({ operation: "merge", operation_id: "u-m", source_ticket_id: a.ticket_id, target_ticket_id: b.ticket_id })
    const ta = await o.getTicket(a.ticket_id), tb = await o.getTicket(b.ticket_id)
    check("目标 Worker 调了 mergeTickets", tb.nodes.some(n => n.kind === "merge_in") && ta.nodes.some(n => n.kind === "merge_out"), `${kinds(ta)} || ${kinds(tb)}`)
    check("源单移出候选", ta.description.visible === 0)
  } finally { await dispose() }
}

await lifecycle()
await download()
await stopResumeMerge()
process.exit(report() ? 0 : 1)

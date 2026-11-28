import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { apply } from "../src/dsh/session-link.mjs"

test("会话入口核对工单和 Worker，以执行凭证换取浏览器入口", async () => {
  const superdot = await mkdtemp(join(tmpdir(), "superdot-session-"))
  await mkdir(join(superdot, "tickets"))
  const worker = "worker-A"
  const rows = [{ticket_id:"A",title:"示例工单"}, {kind:"session",refs:[{kind:"session",role:"worker",id:worker}]}]
  await writeFile(join(superdot, "tickets/A.jsonl"), rows.map(r => JSON.stringify(r)).join("\n"))
  const routes = new Map()
  const ctx = {
    effect: cb => cb(),
    webServer: {port:1234,register: r => routes.set(r.path,r.handler)},
    sessionPersistence:{stat: async id => id === worker ? {} : undefined},
    connection: {authenticatedUrl: url => url + "/?token=example"}
  }
  apply(ctx, {superdot,executionToken:"test",messageServiceUrl:"http://localhost:5678"})
  async function call(method, path, id, bearer = "") {
    let status, body
    await routes.get(path)({method,url:path+"?id="+id,headers:{authorization:bearer}}, {
      writeHead: code => { status=code }, end: result => { body=result }
    })
    return {status,body}
  }
  const path = "/superdot-session/open"
  assert.equal((await call("POST",path,worker)).status,403)
  assert.equal((await call("POST",path,"worker-X","Bearer test")).status,404)
  assert.deepEqual(JSON.parse((await call("POST",path,worker,"Bearer test")).body), {code:"OK",fragment:"token=example"})
  const page = await call("GET","/superdot-session",worker)
  assert.equal(page.status,200)
  assert.match(page.body,/location\.replace\(login.href\)/)
  assert.match(page.body,/dsh.sessions.current/)
  assert.doesNotMatch(page.body,/<iframe|返回 SuperDot 工单|<nav/)
  assert.doesNotMatch(page.body,/token=example/)
})

test("新 Router 按启动时间入组，恢复旧会话保持原位置", async () => {
  const { installSessionDirectory } = await import("../src/dsh/session-directory.mjs")
  const ids: string[] = []
  const folder = {
    title: "router", sessionIds: ids,
    async attachSession(id: string) { ids.unshift(id) },
    async insertSessionBefore(id: string, anchor?: string) {
      ids.splice(ids.indexOf(id), 1)
      ids.splice(anchor ? ids.indexOf(anchor) : ids.length, 0, id)
    },
  }
  let onCreated: Function
  const ctx = {
    workspaceRegistry: { create: async () => folder },
    sessionPersistence: { list: async () => [], flush: async () => {} },
    sessionProjectionCache: { write: async () => {} },
    sessionTitle: { get: (s: {title?: string}) => ({title:s.title}), rename: (s: {title?: string}, title: string) => { s.title = title } },
    on: (_event: string, fn: Function) => { onCreated = fn },
  }
  await installSessionDirectory(ctx, "/project")
  for (const [id, createdAt] of [["r-first", 100], ["r-last", 300], ["r-mid", 200], ["r-first", 100]]) {
    const session = {header:{id, createdAt, cwd:"/project", agentPreset:"dsh-superagent-router"}, title:""}
    await onCreated!({agent:{session}})
    assert.match(session.title, /^Router · /)
  }
  assert.deepEqual(ids, ["r-last","r-mid","r-first"])
})

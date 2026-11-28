import { readFile } from "node:fs/promises"
import { timingSafeEqual } from "node:crypto"
import { join } from "node:path"

export const name = "superdot-session-link"
export const inject = ["webServer", "workspaceRegistry", "sessionPersistence"]

export async function readWorkerTicket(root, sessionId) {
  if (!/^worker-[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId)) return
  const id = sessionId.slice(7)
  let lines
  try {
    lines = (await readFile(join(root, "tickets", id + ".jsonl"), "utf8")).trim().split("\n").map(JSON.parse)
  } catch (error) {
    if (error.code === "ENOENT") return
    throw error
  }
  const [ticket, ...nodes] = lines
  if (ticket.ticket_id === id && nodes.some(node => node.kind === "session" &&
    node.refs.some(ref => ref.kind === "session" && ref.role === "worker" && ref.id === sessionId))) return ticket
}

function launchPage(sessionId) {
  const id = JSON.stringify(sessionId).replaceAll("<", "\u003c")
  return `<!doctype html><meta charset="utf-8"><title>DSH</title><script>
localStorage.setItem("dsh.sessions.current", JSON.stringify({sessionId:${id}}));
const login = new URL("/", location.origin);
const token = new URLSearchParams(location.hash.slice(1).replace(/^\\?/, "")).get("token");
if (token) login.searchParams.set("token", token);
location.replace(login.href);
</script>`
}

export function apply(ctx, config) {
  ctx.effect(() => ctx.webServer.register({
    kind: "exact", path: "/superdot-session/open",
    async handler(req, res) {
      const expected = config.executionToken ?? process.env.NOTICEHUB_EXECUTION_TOKEN
      const supplied = Buffer.from(req.headers.authorization ?? "")
      const auth = Buffer.from("Bearer " + expected)
      if (!expected || supplied.length !== auth.length || !timingSafeEqual(supplied, auth)) {
        res.writeHead(403); res.end(); return
      }
      if (req.method !== "POST") { res.writeHead(405); res.end(); return }
      const id = new URL(req.url, "http://localhost").searchParams.get("id") ?? ""
      if (!await readWorkerTicket(config.superdot, id) || !await ctx.sessionPersistence.stat(id)) {
        res.writeHead(404, {"content-type":"application/json"}); res.end(JSON.stringify({code:"REF_NOT_FOUND"})); return
      }
      const login = new URL(ctx.connection.authenticatedUrl("http://127.0.0.1:" + ctx.webServer.port))
      const loginToken = login.searchParams.get("token")
      if (!loginToken) { res.writeHead(503); res.end(); return }
      res.writeHead(200, {"content-type":"application/json","cache-control":"no-store"})
      res.end(JSON.stringify({code:"OK", fragment:new URLSearchParams({token:loginToken}).toString()}))
    },
  }))
  ctx.effect(() => ctx.webServer.register({
    kind: "exact", path: "/superdot-session",
    async handler(req, res) {
      const id = new URL(req.url, "http://localhost").searchParams.get("id") ?? ""
      if (req.method !== "GET") { res.writeHead(405); res.end(); return }
      const ticket = await readWorkerTicket(config.superdot, id)
      if (!ticket || !await ctx.sessionPersistence.stat(id)) {
        res.writeHead(404); res.end("Worker session not found"); return
      }
      res.writeHead(200, {"content-type":"text/html; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer"})
      res.end(launchPage(id))
    },
  }))
}

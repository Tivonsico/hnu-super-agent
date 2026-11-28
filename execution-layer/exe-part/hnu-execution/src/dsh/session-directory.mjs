import { readWorkerTicket } from "./session-link.mjs"

function isRouter(header, root) {
  return header.agentPreset === "dsh-superagent-router" && header.cwd === root && header.id.startsWith("r-")
}

function routerTitle(createdAt) {
  const date = new Date(createdAt)
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(n => String(n).padStart(2, "0")).join("-")
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, "0")).join(":")
  return "Router · " + day + " " + time
}

export async function installSessionDirectory(ctx, root) {
  const routers = new Map()
  const folder = await ctx.workspaceRegistry.create(root, "router")
  if (folder.title !== "router") await folder.setTitle("router")

  async function register(header, live) {
    const router = isRouter(header, root)
    const owner = router ? undefined : await readWorkerTicket(root, header.id)
    if (!router && !owner) return
    const title = router ? routerTitle(header.createdAt) : owner.title
    if (live) {
      if (ctx.sessionTitle.get(live)?.title !== title) ctx.sessionTitle.rename(live, title)
      await ctx.sessionPersistence.flush()
      await ctx.sessionProjectionCache.write(live)
    } else if (ctx.sessionProjectionCache.cachedSnapshot(header, ["title"])?.values.title !== title) {
      // Startup reconciliation runs before package processing. Claim a writer only
      // for dormant sessions whose durable title needs repair.
      const handle = await ctx.sessionPersistence.open(header.id, "write")
      try {
        const {events} = await handle.read()
        const previous = events.findLast(event => event.type === "session/title")
        let history = events
        if (previous?.data.title !== title) {
          const event = {type:"session/title", seq:events.length, time:Date.now(), data:{title, messageSeqs:[], source:{kind:"user"}}}
          await handle.append([event])
          await handle.flush()
          history = [...events, event]
        }
        ctx.sessionProjectionCache.coldSnapshot(header, handle.inheritedEventCount, history)
      } finally { await handle.close() }
    }
    const workspace = router ? folder : await ctx.workspaceRegistry.create(header.cwd, title)
    if (workspace.title !== (router ? "router" : title)) await workspace.setTitle(title)
    if (!workspace.sessionIds.includes(header.id)) await workspace.attachSession(header.id)
    if (router) {
      routers.set(header.id, header.createdAt)
      const ordered = [...routers.keys()].sort((a,b) => routers.get(b) - routers.get(a) || a.localeCompare(b))
      const index = ordered.indexOf(header.id)
      if (workspace.sessionIds.indexOf(header.id) !== index)
        await workspace.insertSessionBefore(header.id, ordered[index + 1])
    }
  }
  const snapshots = await ctx.sessionPersistence.list()
  for (const {header} of snapshots.sort((a,b) => b.header.createdAt - a.header.createdAt))
    await register(header, ctx.agents.get(header.id)?.session)
  let updates = Promise.resolve()
  ctx.on("agent/created", ({agent}) => {
    const result = updates.then(() => register(agent.session.header, agent.session))
    updates = result.catch(() => {})
    return result
  }, {global:true})
}

// DSH's browser module table provides the same React instance as the host.
window.__ModuleLoader__.load({ id: "hnu-execution", factory: require => {
  const React = require("react")
  const h = React.createElement
  function Icon({ size }) {
    const icon = React.useRef(null)
    React.useLayoutEffect(() => {
      // The DSH panel slot owns the whole sidebar button, including its label.
      const button = icon.current?.closest("button")
      if (!button) return
      function openWorkbench(event) {
        event.stopPropagation()
        window.open("/superdot-workbench", "_blank", "noopener,noreferrer")
      }
      button.addEventListener("click", openWorkbench, true)
      return () => button.removeEventListener("click", openWorkbench, true)
    }, [])
    return h("svg", { ref: icon, width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, "aria-hidden": true },
      h("rect", { x: 4, y: 4, width: 16, height: 16, rx: 3 }),
      h("path", { d: "M8 9h8m-8 4h5" }))
  }
  return {
    inject: ["slots", "uiWorkspace", "workspaces", "sessions"],
    apply(ctx) {
      // DSH's workspace browser otherwise sorts by last activity. Publish the
      // project folder's order through the same view store as native drag/drop.
      let lastOrder = ""
      function updateRouterOrder() {
        const folder = ctx.workspaces.list.getSnapshot().items.find(item =>
          item.title === "router" && item.sessionIds.some(id => id.startsWith("r-")))
        if (!folder) return
        const key = JSON.stringify([folder.workspaceId, folder.sessionIds])
        if (key === lastOrder) return
        lastOrder = key
        let saved = {}
        try { saved = JSON.parse(localStorage.getItem("dsh.workspace.view.v5") || "{}") } catch {}
        ctx.uiWorkspace.view.setSessionOrder(folder.workspaceId, folder.sessionIds, saved.sessionOrderByAccount || {})
      }
      ctx.effect(() => {
        const stop = ctx.workspaces.list.subscribe(updateRouterOrder)
        updateRouterOrder()
        return stop
      })
      ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
        name: "sidebar.panellist", id: "hnu-execution", order: 11, label: () => "SuperDot 工作台"
      }, Icon))
    },
  }
}})

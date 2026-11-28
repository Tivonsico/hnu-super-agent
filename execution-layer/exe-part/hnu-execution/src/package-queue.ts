// A takeover survives process exit. A separate completion record closes it only after dispatch.
import type { Files } from "./files.ts"

export class PackageQueue {
  private files: Files
  private dispatch: (id: string) => Promise<void>
  private accepting: Promise<unknown> = Promise.resolve()
  private work = new Set<Promise<void>>()
  private scheduled = new Set<string>()
  private retries = new Map<string, ReturnType<typeof setTimeout>>()
  private stopped = false

  constructor(files: Files, dispatch: (id: string) => Promise<void>) {
    this.files = files
    this.dispatch = dispatch
  }

  accept(id: string): Promise<"OK" | "REPLAYED"> {
    const result = this.accepting.then(async () => {
      const taken = await this.files.saveRecord("takeover", id, { package_id: id })
      if (taken.state === "conflict") throw new Error("conflicting takeover")
      if (!await this.files.getRecord("package-done", id)) this.schedule(id)
      return taken.state === "fresh" ? "OK" as const : "REPLAYED" as const
    })
    this.accepting = result.catch(() => {})
    return result
  }

  async resume(): Promise<void> {
    for (const { package_id } of await this.files.listRecords<{ package_id: string }>("takeover")) {
      if (!await this.files.getRecord("package-done", package_id)) this.schedule(package_id)
    }
  }

  private schedule(id: string): void {
    if (this.stopped || this.scheduled.has(id) || this.retries.has(id)) return
    this.scheduled.add(id)
    const task = (async () => {
      try {
        if (this.stopped || await this.files.getRecord("package-done", id)) return
        await this.dispatch(id)
        await this.files.putRecord("package-done", id, { package_id: id })
      } catch (error) {
        console.warn("Router dispatch pending", id, error instanceof Error ? error.message : "dispatch failed")
        if (!this.stopped) {
          const timer = setTimeout(() => {
            this.retries.delete(id)
            this.schedule(id)
          }, 5000)
          timer.unref()
          this.retries.set(id, timer)
        }
      } finally {
        this.scheduled.delete(id)
      }
    })()
    this.work.add(task)
    void task.then(() => this.work.delete(task))
  }

  async idle(): Promise<void> {
    await this.accepting
    while (this.work.size) await Promise.all(this.work)
  }

  stop(): Promise<void> {
    this.stopped = true
    for (const timer of this.retries.values()) clearTimeout(timer)
    this.retries.clear()
    return this.idle()
  }
}

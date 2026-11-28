// 角色模板 + 顶层记忆。会议定：每次启动前加载角色模板和 MEMORY.md。
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Prompts } from "./orchestrator.ts"

const here = dirname(fileURLToPath(import.meta.url))
const promptsDir = join(here, "..", "prompts")

const read = async (path: string): Promise<string> => {
  try { return (await readFile(path, "utf8")).trim() } catch { return "" }
}

// memoryPath 指向 superdot 下的 MEMORY.md（用户顶层记忆，可被用户与 Dreamer 编辑）。
export async function loadPrompts(superdot: string): Promise<Prompts> {
  const [router, worker, memory] = await Promise.all([
    read(join(promptsDir, "router.md")),
    read(join(promptsDir, "worker.md")),
    read(join(superdot, "MEMORY.md")),
  ])
  const withMemory = (role: string): string =>
    memory ? `${role}\n\n## 用户记忆（MEMORY.md）\n${memory}` : role
  return { router: withMemory(router), worker: withMemory(worker) }
}

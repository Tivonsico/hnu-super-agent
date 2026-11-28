// 重定向与就地改写会落盘，其余写入命令同理。
const WRITES = /(?:>>?|\btee\b|\bmv\b|\brm\b|\bcp\b|\bmkdir\b|\btouch\b|\bln\b|\bsed\s+-i|\btruncate\b|\bdd\b)/
export const routerBashGuard = (execution: { name: string; arguments: unknown }): string | undefined => {
  if (execution.name !== "bash") return undefined
  const command = (execution.arguments as { command?: unknown })?.command
  return typeof command === "string" && WRITES.test(command) ? "Router 只判断去向，不写文件" : undefined
}

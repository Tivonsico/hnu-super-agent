// 稳定 ID。key() 沿用 DSSA 的做法：sha256(JSON(values)) 取前 32 位十六进制。
import { createHash } from "node:crypto"

export const key = (...values: unknown[]): string =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 32)

// 06 与对外接口文档约定的派生 ID
export const routerSessionId = (packageId: string): string => "r-" + key("router", packageId)
export const newTicketId = (packageId: string): string => key("ticket", packageId)
export const workerSessionId = (ticketId: string): string => "worker-" + ticketId
export const downloadOperationId = (notificationId: string): string => key("download", notificationId)
export const deliveryRequestId = (sessionId: string, inputKind: string, originalId: string): string =>
  key("delivery", sessionId, inputKind, originalId)

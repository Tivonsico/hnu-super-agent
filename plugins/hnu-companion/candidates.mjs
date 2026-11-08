export async function readCandidates({ url, token }, signal) {
  const endpoint = new URL(url)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/api/tasks'
    || endpoint.search || endpoint.hash || endpoint.username || endpoint.password || !token) {
    throw new Error('群务台须配置本机待办接口和访问令牌')
  }
  const response = await fetch(endpoint, {
    headers: { 'X-Token': token }, redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`群务台待办接口 HTTP ${response.status}`)
  }
  const board = await response.json()
  const tasks = new Map()
  for (const key of ['today', 'week', 'later', 'pinned', 'candidates']) {
    if (!Array.isArray(board[key])) continue
    for (const task of board[key]) {
      if (task?.id == null || typeof task.task_key !== 'string') continue
      const match = /^(?:rule:[^:]+:)?(onebot:[1-9][0-9]*:-?[1-9][0-9]*)$/.exec(task.task_key)
      if (match) tasks.set(match[1], { id: String(task.id), summary: String(task.summary ?? ''), updatedAt: task.updated_at })
    }
  }
  return tasks
}

export const sourceId = event => `onebot:${event.group_id}:${event.message_id}`

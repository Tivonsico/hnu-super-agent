import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { forwardPending, openQueue, receiver, syncSubscriptions } from './receiver.mjs'

process.umask(0o077)
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const queue = openQueue(config.queue)
const server = receiver(queue, config).listen(config.port, '127.0.0.1', () => {
  console.log(`OneBot reports: http://127.0.0.1:${server.address().port}/onebot/event`)
})
const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    controller.abort()
    server.close()
  })
}
let appliedGroups
try {
  while (!controller.signal.aborted) {
    try {
      if (config.dynamicGroups) {
        const groups = queue.groups().filter(group => group.enabled).map(group => group.id)
        const version = groups.join(',')
        if (appliedGroups !== version) {
          await syncSubscriptions(groups, config.noticeHubWeb, controller.signal)
          appliedGroups = version
        }
      }
      await forwardPending(queue, config.noticeHubReceiver, controller.signal)
    }
    catch (error) { if (!controller.signal.aborted) console.error(error.message) }
    await delay(1500, undefined, { signal: controller.signal }).catch(() => {})
  }
} finally {
  await new Promise(resolve => server.close(resolve))
  queue.close()
}

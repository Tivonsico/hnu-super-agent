import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [dataArg, service] = process.argv.slice(2)
const data = resolve(dataArg ?? '.local/workspace')
const read = name => JSON.parse(readFileSync(join(data, name + '.json')))
const { profile, home, launcher, noticeData, root } = read('fixture')
const receiver = read('receiver')
const companion = read('companion')
process.umask(0o077)
const services = {
  dsh: [launcher, [profile, '--no-open'], { ...process.env, DSH_HOME: home, HNU_COMPANION_CONFIG: join(data, 'companion.json') }],
  ingest: [process.execPath, [join(root, 'qq-ingest/main.mjs'), join(data, 'receiver.json')], { PATH: process.env.PATH }],
  notice: [process.env.HNU_NOTICE_PYTHON ?? join(data, 'notice-venv/bin/python'),
    [join(root, 'notice-hub/main.py'), '--env', join(data, 'notice.env'), 'run', '--poll', '5'], {
      PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1',
      NOTICEHUB_OFFICIAL_BOT_ENABLED: '0', NOTICEHUB_LLM: '0', NOTICEHUB_GROUPS: receiver.groups.join(','),
      NOTICEHUB_IMMEDIATE_GROUPS: receiver.groups.join(','), NOTICEHUB_ONEBOT_ENABLED: '1',
      NOTICEHUB_ONEBOT_HOST: '127.0.0.1', NOTICEHUB_ONEBOT_PORT: new URL(receiver.noticeHubReceiver.url).port, NOTICEHUB_ONEBOT_TOKEN: receiver.noticeHubReceiver.token,
      NOTICEHUB_WEB: '1', NOTICEHUB_WEB_HOST: '127.0.0.1', NOTICEHUB_WEB_PORT: new URL(companion.noticeHubTasks.url).port, NOTICEHUB_WEB_TOKEN: companion.noticeHubTasks.token,
      NOTICEHUB_CATCHUP_ENABLED: '0', NOTICEHUB_LAB_RULES: '1', NOTICEHUB_ATTACHMENTS: '1',
      NOTICEHUB_DATA_DIR: noticeData, NOTICEHUB_LOG_DIR: join(data, 'notice-log'),
      NOTICEHUB_NAPCAT_API_URL: process.env.HNU_NAPCAT_API_URL ?? companion.napcatRead?.url ?? '',
      NOTICEHUB_NAPCAT_API_TOKEN: process.env.HNU_NAPCAT_API_TOKEN ?? companion.napcatRead?.token ?? '',
    }],
}
const selected = services[service]
if (!selected) throw new Error('Usage: node dsh/run-fixture.mjs <fixture directory> <dsh|ingest|notice>')
const [command, args, env] = selected
const child = spawn(command, args, { env, cwd: data, stdio: 'inherit' })
child.once('error', error => { console.error(error.message); process.exitCode = 1 })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
child.once('exit', code => { process.exitCode = code ?? 1 })

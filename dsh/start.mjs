import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const openBrowser = !args.includes('--no-open')
let data = resolve(args.find(arg => !arg.startsWith('--')) ?? join(root, '.local', 'workspace'))
const scripts = name => join(root, 'dsh', name + '.mjs')
const invoke = (script, args, options = {}) => execFileSync(process.execPath, [scripts(script), ...args], options)
process.umask(0o077)
if (!existsSync(join(data, 'fixture.json'))) invoke('setup-fixture', [data], { stdio: 'inherit' })
data = realpathSync(data)
const read = name => JSON.parse(readFileSync(join(data, name + '.json'), 'utf8'))
const fixture = read('fixture')
const companion = read('companion')
const receiver = read('receiver')
const port = fixture.port ?? 33781
const origin = `http://127.0.0.1:${port}`
const stateDir = join(data, 'dssa-state')
const python = process.env.HNU_NOTICE_PYTHON ?? join(data, 'notice-venv/bin/python')
if (!existsSync(python)) {
  execFileSync('uv', ['venv', '-p', '3.12', join(data, 'notice-venv')], { stdio: 'inherit' })
  execFileSync('uv', ['pip', 'install', '--python', python, '-r', join(root, 'notice-hub', 'requirements.txt'), 'qrcode==8.2'], { stdio: 'inherit' })
}
const processFile = join(data, 'processes.json')
const launchLock = join(data, 'startup.lock')
let lock
try { lock = openSync(launchLock, 'wx') }
catch (error) { if (error.code === 'EEXIST') throw new Error('HNU Agent启动器正在运行'); throw error }
const services = [
  { name: 'notice', port: Number(new URL(companion.noticeHubTasks.url).port) },
  { name: 'ingest', port: receiver.port },
  { name: 'dsh', port },
]
const logPath = service => join(data, service + '.log')

function isPortOpen(number) {
  return new Promise(resolve => {
    const socket = connect(number, '127.0.0.1')
    const finish = result => { socket.destroy(); resolve(result) }
    socket.setTimeout(1000, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}
function matchesProcess(pid, service) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()
    return command.endsWith(`${scripts('run-fixture')} ${data} ${service}`)
  } catch { return false }
}
function start(service) {
  const env = { ...process.env, HNU_NOTICE_PYTHON: python }
  const fd = openSync(logPath(service), 'w', 0o600)
  try {
    const proc = spawn(process.execPath, [scripts('run-fixture'), data, service],
      { cwd: root, env, detached: true, stdio: ['ignore', fd, fd] })
    proc.unref()
    return proc.pid
  } finally { closeSync(fd) }
}
async function waitFor(check, name, seconds = 30) {
  const until = Date.now() + seconds * 1000
  while (Date.now() < until) {
    const result = await check()
    if (result) return result
    await delay(300)
  }
  throw new Error(`${name}未就绪。请查看 ${data} 下的运行日志。`)
}
async function getState() {
  const response = await fetch(origin + '/orchestrator/api/state', {
    headers: { 'x-orchestrator-request': '1' }, signal: AbortSignal.timeout(2000),
  })
  if (!response.ok) return
  const state = await response.json()
  if (state.setup?.machine?.stateDir !== stateDir) throw new Error('端口被另一个 DSH 工作区占用')
  return state
}

try {
  const recorded = existsSync(processFile) ? read('processes') : {}
  for (const { name, port } of services) {
    const running = matchesProcess(recorded[name], name)
    const listening = await isPortOpen(port)
    if (listening && !running) throw new Error(`端口 ${port} 已被其他进程占用`)
    if (!running) {
      recorded[name] = start(name)
      writeFileSync(processFile, JSON.stringify(recorded) + '\n', { mode: 0o600 })
    }
  }
  await Promise.all(services.map(service => waitFor(() => isPortOpen(service.port), service.name)))
  const state = await waitFor(() => getState().catch(() => undefined), 'DSH')
  const configured = join(data, 'configured')
  if (!existsSync(configured) || state.setup.problem) {
    try {
      invoke('configure-fixture', [data], { stdio: 'inherit', timeout: 90000 })
      writeFileSync(configured, '', { mode: 0o600 })
    } catch {
      console.error('DSSA 配置暂未完成。可以打开 HNU Agent 查看收件状态。')
    }
  }
  const token = await waitFor(() => readFileSync(logPath('dsh'), 'utf8')
    .match(new RegExp(`dsh web: http://127\\.0\\.0\\.1:${port}/\\?token=([A-Za-z0-9_-]+)`))?.[1], 'DSH 本机会话', 5)
  const launch = new URL('/hnu/launch', origin)
  launch.searchParams.set('key', companion.reviewerKey)
  launch.searchParams.set('dsh', token)
  if (openBrowser) execFileSync('open', [launch.href])
  console.log(`HNU Agent 已启动 · ${origin}`)
} finally {
  closeSync(lock)
  const { unlinkSync } = await import('node:fs')
  unlinkSync(launchLock)
}

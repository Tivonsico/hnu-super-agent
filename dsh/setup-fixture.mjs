import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const [data = join(root, '.local', 'workspace')] = process.argv.slice(2)
const launcher = process.env.HNU_DSH ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const port = Number(process.env.HNU_PORT ?? 33791)
if (!Number.isInteger(port) || port < 1024 || port > 65531) throw new Error('HNU_PORT must be a valid base port')
if (existsSync(data)) throw new Error('Use a new fixture directory')
if (execFileSync(launcher, ['--version'], { encoding: 'utf8' }).trim() !== '0.2.2-rc.1') {
  throw new Error('This fixture is pinned to DSH 0.2.2-rc.1')
}
const dssa = join(root, 'dsh-superagent-prototype')
if (!existsSync(join(dssa, 'lib', 'index.js')) || !existsSync(join(dssa, 'node_modules', 'zod'))) {
  throw new Error('Install and build the pinned DSSA checkout first')
}
process.umask(0o077)
mkdirSync(data, { recursive: true })
const state = realpathSync(data)
const profile = 'hnu'
const home = join(state, 'dsh-home')
const queue = join(state, 'queue.sqlite')
const stateDir = join(state, 'dssa-state')
const token = () => randomBytes(32).toString('hex')
const noticeHubTasks = { url: `http://127.0.0.1:${port + 3}/api/tasks`, token: token() }
const receiver = {
  token: token(), groups: [], dynamicGroups: true, queue, port: port + 1,
  noticeHubReceiver: { url: `http://127.0.0.1:${port + 2}/onebot/event`, token: token() },
  noticeHubWeb: noticeHubTasks,
}
const companion = {
  queue,
  napcatReport: { url: `http://127.0.0.1:${receiver.port}/onebot/event`, token: receiver.token },
  napcatRead: { url: `http://127.0.0.1:${port + 4}`, token: token() }, reviews: join(state, 'reviews.sqlite'), workRoot: join(state, 'worktrees'),
  reviewerKey: token(), noticeHubTasks,
  ...(process.env.HNU_NAPCAT_LOGIN_URL ? { napcatLoginUrl: process.env.HNU_NAPCAT_LOGIN_URL } : {}),
}
for (const [name, value] of Object.entries({ receiver, companion })) {
  writeFileSync(join(state, name + '.json'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}
execFileSync(launcher, [profile, '--from-default-profile', 'web', '--dump-config'],
  { cwd: state, env: { ...process.env, DSH_HOME: home } })
const credentialSource = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml')
if (existsSync(credentialSource)) {
  const destination = join(home, '.credentials.yaml')
  try {
    copyFileSync(credentialSource, destination, constants.COPYFILE_EXCL)
    chmodSync(destination, 0o600)
  }
  catch (error) { if (error.code !== 'EEXIST') throw error }
}
const profileDir = join(home, 'profiles', profile)
const pkg = join(profileDir, 'package.json')
const spec = JSON.parse(readFileSync(pkg, 'utf8'))
spec.dsh.profile.bundles.push('dsh-superagent', 'hnu-companion')
writeFileSync(pkg, JSON.stringify(spec, null, 2) + '\n')
const modules = join(profileDir, 'node_modules')
mkdirSync(modules, { recursive: true })
symlinkSync(dssa, join(modules, 'dsh-superagent'), 'dir')
const plugin = join(root, 'plugins', 'hnu-companion')
const deps = join(plugin, 'node_modules')
if (!existsSync(deps)) symlinkSync(join(dssa, 'node_modules'), deps, 'dir')
symlinkSync(plugin, join(modules, 'hnu-companion'), 'dir')
writeFileSync(join(profileDir, 'cordis.patch.yml'), `- id: webserver
  config:
    host: 127.0.0.1
    port: ${port}
- id: dsh-superagent
  config:
    stateDir: ${JSON.stringify(stateDir)}
`)
const noticeData = join(state, 'notice-data')
mkdirSync(noticeData)
writeFileSync(join(state, 'notice.env'), '', { mode: 0o600 })
writeFileSync(join(state, 'fixture.json'), JSON.stringify({ port, profile, home, launcher, noticeData, root }, null, 2) + '\n')
console.log(state)

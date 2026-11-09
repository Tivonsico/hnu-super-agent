import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { desktopEntry, desktopMarker, stockEntries } from './qq-entry.mjs'

if (process.platform !== 'darwin') throw new Error('桌面 QQ 接入适用于 macOS')
process.umask(0o077)

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const app = '/Applications/QQ.app'
const binary = join(app, 'Contents/MacOS/QQ')
const resources = join(app, 'Contents/Resources/app')
const loader = join(resources, 'loadNapCat.js')
const data = join(homedir(), 'Library/Containers/com.tencent.qq/Data')
const runtime = join(data, 'Library/Application Support/QQ/NapCat')
const framework = join(data, 'Documents/hnu-napcat-framework-4.18.42')
const downloads = join(root, '.local/qq-desktop')
const verifiedArchive = join(downloads, 'NapCat.Framework.verified.zip')
const archive = existsSync(verifiedArchive) ? verifiedArchive : join(downloads, 'NapCat.Framework.zip')
const frameworkDigest = '118d66bb4849b7fcec05a4cafc9e33ed44f9236d56661f7097aba2ab3081df2e'
const napcatDigest = '19ba6bc8ec3a1a7c705c0d3b7e16c08e09ab9bf17ef5b3639b9ed2fef15cdfa0'
const marker = desktopMarker
if (!existsSync(join(resources, 'package.json'))) throw new Error('请先将 macOS QQ 安装到 /Applications/QQ.app')
const qqVersion = JSON.parse(readFileSync(join(resources, 'package.json'), 'utf8')).version
if (!/^[0-9]+\.[0-9]+\.[0-9]+-[0-9]+$/.test(qqVersion)) throw new Error('无法识别本机 QQ 版本')
mkdirSync(downloads, { recursive: true })
mkdirSync(dirname(framework), { recursive: true })
const { lockSync } = createRequire(join(root, 'dsh-superagent-prototype/package.json'))('proper-lockfile')
let unlock
try {
  unlock = lockSync(dirname(framework), { lockfilePath: join(dirname(framework), '.hnu-desktop-install.lock'), stale: 30 * 60_000 })
} catch (error) {
  if (error.code === 'ELOCKED') throw new Error('QQ 桌面接入正在安装，请在已打开的终端完成操作')
  throw error
}
process.once('exit', () => unlock())
let backup = join(downloads, 'original-loader-' + qqVersion + '.js')
const legacyBackup = join(downloads, 'original-loader.js')
let packageBackup = join(downloads, 'original-package-' + qqVersion + '.json')
const restoreRecord = join(downloads, 'restore-' + qqVersion + '.json')
if (existsSync(restoreRecord)) {
  const saved = JSON.parse(readFileSync(restoreRecord, 'utf8'))
  backup = join(downloads, saved.loader)
  packageBackup = join(downloads, saved.package)
}
const preparedPackage = join(downloads, 'desktop-package.json')
const prepared = join(downloads, 'desktop-loader.js')
const currentLoader = () => existsSync(loader) ? readFileSync(loader, 'utf8') : ''

function prepareLayout() {
  const entry = join(framework, 'napcat.mjs')
  const original = entry + '.hnu-original'
  const current = readFileSync(entry, 'utf8')
  const patchMarker = '    // HNU Agent: read QQ conversation layout.'
  const source = current.includes(patchMarker) ? readFileSync(original, 'utf8') : current
  const anchor = '    const ret = await this.core.apis.UserApi.getRecentContactListSnapShot(+payload.count);\n'
  if (createHash('sha256').update(source).digest('hex') !== napcatDigest || source.split(anchor).length !== 2) {
    throw new Error('NapCat 最近会话接口与此版本不兼容')
  }
  if (!existsSync(original)) writeFileSync(original, source, { mode: 0o600, flag: 'wx' })
  const hook = [patchMarker, '    if (payload.hnu_layout === true) {',
    '      const { readQQLayout } = await import("./hnu-qq-layout.mjs");',
    '      return readQQLayout(ret.info, this.core.apis);', '    }', '',
  ].join('\n')
  for (const [file, value] of [[join(framework, 'hnu-qq-layout.mjs'), readFileSync(join(root, 'dsh/qq-layout.mjs'), 'utf8')],
    [entry, source.replace(anchor, anchor + hook)]]) {
    if (existsSync(file) && readFileSync(file, 'utf8') === value) continue
    const staging = file + '.hnu-next'
    writeFileSync(staging, value, { mode: 0o600 })
    renameSync(staging, file)
  }
}

function prepare() {
  const spec = JSON.parse(readFileSync(join(resources, 'package.json'), 'utf8'))
  const stock = stockEntries.includes(spec.main)
  if ((!stock && spec.main !== './loadNapCat.js') || !existsSync(join(resources, 'app_launcher/index.js'))
    || !existsSync(join(resources, 'major.node'))) {
    throw new Error('当前 QQ 的启动接口与桌面接入不兼容，请更新 HNU Agent 后重试')
  }
  if (existsSync(archive) && createHash('sha256').update(readFileSync(archive)).digest('hex') !== frameworkDigest) rmSync(archive)
  if (!existsSync(archive)) {
    console.log('正在下载 NapCat Framework…')
    const partial = archive + '.download'
    try {
      execFileSync('/usr/bin/curl', ['--fail', '--location', '--retry', '2', '--connect-timeout', '15', '--max-time', '300',
        '--output', partial, 'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.42/NapCat.Framework.zip'], { stdio: 'inherit' })
      if (createHash('sha256').update(readFileSync(partial)).digest('hex') !== frameworkDigest) throw new Error('NapCat 下载校验失败，请重试')
      renameSync(partial, archive)
    } finally { rmSync(partial, { force: true }) }
  }
  if (!existsSync(archive) || createHash('sha256').update(readFileSync(archive)).digest('hex') !== frameworkDigest) {
    throw new Error('NapCat Framework 发行包未下载完成或校验失败')
  }
  if (!existsSync(framework)) {
    const extracted = mkdtempSync(join(dirname(framework), '.hnu-framework-'))
    execFileSync('/usr/bin/ditto', ['-x', '-k', archive, extracted])
    for (const name of ['napcat.cjs', 'napcat.mjs']) {
      if (!existsSync(join(extracted, name))) throw new Error('NapCat Framework 发行包缺少启动文件')
    }
    renameSync(extracted, framework)
  }
  // Read-only session access does not need native packet interception inside signed desktop QQ.
  for (const name of ['packet/MoeHoo', 'napi2native/napi2native']) {
    const module = join(framework, 'native', name + '.darwin.' + process.arch + '.node')
    if (existsSync(module)) renameSync(module, module + '.disabled')
  }
  prepareLayout()
  const current = currentLoader()
  if (!stock && current.startsWith(marker)) return
  const entry = desktopEntry(spec, current, { binary, runtime, framework })
  if (existsSync(backup) && readFileSync(backup, 'utf8') !== current) {
    const revision = createHash('sha256').update(current + JSON.stringify(spec)).digest('hex').slice(0, 16)
    backup = join(downloads, 'original-loader-' + qqVersion + '-' + revision + '.js')
    packageBackup = join(downloads, 'original-package-' + qqVersion + '-' + revision + '.json')
  }
  if (!existsSync(backup)) writeFileSync(backup, current, { mode: 0o600, flag: 'wx' })
  if (!existsSync(packageBackup)) writeFileSync(packageBackup, readFileSync(join(resources, 'package.json')), { mode: 0o600, flag: 'wx' })
  writeFileSync(restoreRecord, JSON.stringify({ loader: backup.slice(downloads.length + 1), package: packageBackup.slice(downloads.length + 1) }), { mode: 0o600 })
  writeFileSync(preparedPackage, JSON.stringify({ ...spec, main: './loadNapCat.js' }, null, 2) + '\n', { mode: 0o600 })
  writeFileSync(prepared, entry, { mode: 0o600 })
}

function install(path, target = loader) {
  console.log('macOS 需要管理员授权更新 QQ 的启动入口。')
  const staging = target + '.hnu-staging-' + process.pid
  execFileSync('/usr/bin/sudo', ['/usr/bin/install', '-o', 'root', '-g', 'wheel', '-m', '0644', path, staging], { stdio: 'inherit' })
  if (readFileSync(staging, 'utf8') !== readFileSync(path, 'utf8')) throw new Error('QQ 启动入口预写入未通过校验')
  execFileSync('/usr/bin/sudo', ['/bin/mv', '-f', staging, target], { stdio: 'inherit' })
  if (readFileSync(target, 'utf8') !== readFileSync(path, 'utf8')) throw new Error('未能确认 QQ 启动入口写入')
}

function restorePackage() {
  if (!existsSync(packageBackup)) return
  const target = join(resources, 'package.json')
  install(packageBackup, target)
}

function qqProcesses() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match || (match[2] !== binary && !match[2].startsWith(binary + ' '))) return []
    return [{ pid: Number(match[1]), shell: match[2].split(' ').includes('--no-sandbox') }]
  })
}

async function desktopReady() {
  try {
    const settings = JSON.parse(readFileSync(join(runtime, 'config/webui.json'), 'utf8'))
    const port = settings.port ?? 6099
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false
    const response = await fetch('http://127.0.0.1:' + port + '/webui/', { signal: AbortSignal.timeout(1500), redirect: 'error' })
    return response.ok && /<title[^>]*>[^<]*NapCat/i.test(await response.text())
  } catch { return false }
}

if (process.argv.includes('--restore')) {
  const current = currentLoader()
  const saved = existsSync(backup) ? backup : qqVersion === '7.0.2-53644' ? legacyBackup : undefined
  if ((!current || current.startsWith(marker)) && saved && existsSync(saved)) {
    install(saved)
    restorePackage()
  } else throw new Error('未找到当前 QQ 入口对应的恢复备份')
  console.log('已恢复此前的 QQ 启动入口。')
} else {
  prepare()
  if (process.argv.includes('--prepare')) {
    console.log(prepared)
  } else {
    const installed = JSON.parse(readFileSync(join(resources, 'package.json'), 'utf8')).main === './loadNapCat.js'
      && currentLoader().startsWith(marker)
    if (!installed) {
      console.log('正在安装桌面 QQ 共用登录入口，完成后会重启 QQ。')
      install(prepared)
      try { install(preparedPackage, join(resources, 'package.json')) }
      catch (error) {
        install(backup)
        throw error
      }
    }
    for (const item of qqProcesses().filter(process => process.shell)) process.kill(item.pid, 'SIGTERM')
    for (let attempt = 0; attempt < 40 && qqProcesses().some(process => process.shell); attempt++) await delay(250)
    if (qqProcesses().some(process => process.shell)) throw new Error('请先退出 NapCat Shell')
    if (qqProcesses().length && (!installed || !await desktopReady())) {
      console.log('正在重启 QQ 以加载桌面接入…')
      execFileSync('/usr/bin/osascript', ['-e', 'tell application "QQ" to quit'])
      for (let attempt = 0; attempt < 20 && qqProcesses().length; attempt++) await delay(250)
      for (const item of qqProcesses()) process.kill(item.pid, 'SIGTERM')
      for (let attempt = 0; attempt < 40 && qqProcesses().length; attempt++) await delay(250)
      if (qqProcesses().length) throw new Error('QQ 尚未退出，请在 QQ 菜单中退出后重试')
    }
    if (qqProcesses().length && await desktopReady()) {
      execFileSync('/usr/bin/open', ['-a', app])
      console.log('桌面 QQ 接入已运行，HNU Agent 将自动检测账号。')
      process.exit(0)
    }
    const log = join(downloads, 'desktop.log')
    writeFileSync(log, '', { mode: 0o600 })
    execFileSync('/usr/bin/open', ['-a', app, '--stdout', log, '--stderr', log])
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await desktopReady()) {
        console.log('桌面 QQ 接入已启动，请在 QQ 登录。HNU Agent 将自动检测账号。')
        process.exit(0)
      }
      await delay(1000)
    }
    throw new Error('当前 QQ 的桌面接入未就绪，请检查 desktop.log 并更新 HNU Agent 后重试')
  }
}

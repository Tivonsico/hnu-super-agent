import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

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
const marker = '// HNU Agent desktop Framework'
const qqVersion = JSON.parse(readFileSync(join(resources, 'package.json'), 'utf8')).version
const backup = join(downloads, 'original-loader-' + qqVersion + '.js')
const legacyBackup = join(downloads, 'original-loader.js')
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
  if (!['7.0.2-53644', '7.0.3-54395'].includes(spec.version) || spec.main !== './loadNapCat.js') {
    throw new Error('请先用 NapCat 安装器配置 QQ 7.0.2-53644 或 7.0.3-54395 的启动入口')
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
  const current = currentLoader() || (existsSync(backup) ? readFileSync(backup, 'utf8') : '')
  if (current.startsWith(marker)) return
  if (!current.includes('const loadNapcat = process.argv.includes(')) throw new Error('QQ 启动入口已经变化')
  if (existsSync(backup) && readFileSync(backup, 'utf8') !== current) throw new Error('QQ 启动入口与备份不一致')
  if (!existsSync(backup)) writeFileSync(backup, current, { mode: 0o600, flag: 'wx' })
  const hook = [
    marker,
    'if (process.execPath === ' + JSON.stringify(binary) + ' && !process.argv.includes("--no-sandbox")) {',
    '  process.env.NAPCAT_WORKDIR = ' + JSON.stringify(runtime) + ';',
    '  process.env.NAPCAT_DISABLE_BYPASS = "1";',
    '  require(' + JSON.stringify(join(framework, 'napcat.cjs')) + ');',
    '}',
    '',
  ].join('\n')
  writeFileSync(prepared, hook + current, { mode: 0o600 })
}

function install(path) {
  console.log('macOS 需要管理员授权更新 QQ 的启动入口。')
  const staging = join(resources, '.hnu-loader-staging-' + process.pid)
  execFileSync('/usr/bin/sudo', ['/usr/bin/install', '-o', 'root', '-g', 'wheel', '-m', '0644', path, staging], { stdio: 'inherit' })
  if (readFileSync(staging, 'utf8') !== readFileSync(path, 'utf8')) throw new Error('QQ 启动入口预写入未通过校验')
  execFileSync('/usr/bin/sudo', ['/bin/mv', '-f', staging, loader], { stdio: 'inherit' })
  if (readFileSync(loader, 'utf8') !== readFileSync(path, 'utf8')) throw new Error('未能确认 QQ 启动入口写入')
}

function qqProcesses() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match || (match[2] !== binary && !match[2].startsWith(binary + ' '))) return []
    return [{ pid: Number(match[1]), shell: match[2].split(' ').includes('--no-sandbox') }]
  })
}

if (process.argv.includes('--restore')) {
  const current = currentLoader()
  const saved = existsSync(backup) ? backup : qqVersion === '7.0.2-53644' ? legacyBackup : undefined
  if ((!current || current.startsWith(marker)) && saved && existsSync(saved)) install(saved)
  console.log('已恢复此前的 QQ 启动入口。')
} else {
  prepare()
  if (process.argv.includes('--prepare')) {
    console.log(prepared)
  } else {
    const installed = currentLoader().startsWith(marker)
    if (!installed && qqProcesses().some(process => !process.shell)) throw new Error('请先退出桌面 QQ，再运行此启动器')
    if (!installed) install(prepared)
    for (const item of qqProcesses().filter(process => process.shell)) process.kill(item.pid, 'SIGTERM')
    for (let attempt = 0; attempt < 40 && qqProcesses().some(process => process.shell); attempt++) await delay(250)
    if (qqProcesses().some(process => process.shell)) throw new Error('请先退出 NapCat Shell')
    const log = join(downloads, 'desktop.log')
    writeFileSync(log, '', { mode: 0o600 })
    execFileSync('/usr/bin/open', ['-a', app, '--stdout', log, '--stderr', log])
  }
}

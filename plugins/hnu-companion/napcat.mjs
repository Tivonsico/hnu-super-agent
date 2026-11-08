import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const installer = 'https://github.com/NapNeko/NapCat-Mac-Installer/releases/latest'
const qqData = join(homedir(), 'Library/Containers/com.tencent.qq/Data')
const macInstall = join(qqData, 'Documents/napcat')
const macRuntime = join(qqData, 'Library/Application Support/QQ/NapCat')
const qqPackage = '/Applications/QQ.app/Contents/Resources/app/package.json'
const routes = new Map([
  ['status', 'GET'],
  ['groups', 'GET'],
  ['conversations', 'GET'],
  ['history', 'GET'],
  ['qrcode', 'GET'],
  ['refresh-qrcode', 'POST'],
  ['webui', 'GET'],
  ['connect', 'POST'],
  ['switch', 'POST'],
  ['setup', 'POST'],
])
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const fail = (status, error, fields = {}) => ({ status, value: { ok: false, error, ...fields } })
const ok = value => ({ status: 200, value: { ok: true, ...value } })

function localUrl(value) {
  if (typeof value !== 'string' || !value) return
  try {
    const url = new URL(value)
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url
  } catch { /* Invalid loopback address. */ }
}

async function readBytes(response, limit = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.length
    if (size > limit) throw new Error('NapCat 响应过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function qrImage(bytes) {
  if (!bytes.subarray(0, png.length).equals(png)) return
  return ok({ qrcode: 'data:image/png;base64,' + bytes.toString('base64') })
}

function publicStatus(data) {
  return {
    ok: true,
    online: data.online === true,
    stage: data.stage,
    user_id: data.user_id == null ? undefined : String(data.user_id),
    nickname: data.nickname,
    napcat_installed: data.napcat_installed,
    napcat_running: data.napcat_running,
    qr_stamp: data.qr_stamp,
    qr_stale: data.qr_stale,
  }
}

async function request(config, path, method = 'GET') {
  const { url, token } = config.noticeHubTasks ?? {}
  const base = localUrl(url)
  if (!base || !token) throw new Error('群务台管理连接未配置')
  const response = await fetch(new URL('/api/napcat/' + path, base), {
    method, redirect: 'error', signal: AbortSignal.timeout(4500),
    headers: { 'X-Token': token, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    body: method === 'POST' ? '{}' : undefined,
  })
  const bytes = await readBytes(response)
  if (path === 'qrcode' && response.ok) return qrImage(bytes) ?? fail(502, '群务台未返回二维码图片')
  return { status: response.status, value: JSON.parse(bytes.toString('utf8')) }
}

const readJson = path => readFile(path, 'utf8').then(JSON.parse).catch(() => undefined)

async function webUiSettings(config) {
  let file, installed, originalEntry
  if (process.platform === 'darwin') {
    const [runtimeConfig, legacyConfig, entry, qq] = await Promise.all([
      readJson(join(macRuntime, 'config/webui.json')),
      readJson(join(macInstall, 'config/webui.json')),
      stat(join(macInstall, 'napcat.mjs')).catch(() => undefined),
      readJson(qqPackage),
    ])
    file = runtimeConfig ?? legacyConfig
    installed = Boolean(entry?.isFile() || file)
    originalEntry = ['./application.asar/app_launcher/index.js', './application/app_launcher/index.js',
      './app_launcher/index.js'].includes(qq?.main)
  }
  const configuredUrl = localUrl(config.napcatLoginUrl)
  const url = configuredUrl ?? new URL(`http://127.0.0.1:${Number.isInteger(file?.port) && file.port > 0 ? file.port : 6099}/webui/`)
  const token = config.napcatWebUiToken ?? configuredUrl?.searchParams.get('token') ?? file?.token
  return { url: new URL('/webui/', url), token, installed, originalEntry }
}

const sessions = new Map()
async function webUiPost(url, route, body, credential, timeout = 1800) {
  const response = await fetch(new URL('/api/' + route, url), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
    headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: 'Bearer ' + credential } : {}) },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error('NapCat WebUI 暂不可用')
  const payload = JSON.parse((await readBytes(response)).toString('utf8'))
  if (payload.code !== 0) throw new Error('NapCat WebUI 请求失败')
  return payload.data
}

async function webUiCredential({ url, token }) {
  if (typeof token !== 'string' || !token) return
  const hash = createHash('sha256').update(token + '.napcat').digest('hex')
  const existing = sessions.get(url.origin)
  if (existing?.hash === hash && existing.expires > Date.now()) return existing.result
  const result = webUiPost(url, 'auth/login', { hash })
    .then(value => value?.Credential)
    .catch(() => undefined)
  sessions.set(url.origin, { hash, result, expires: Date.now() + 30_000 })
  const credential = await result
  if (credential) sessions.set(url.origin, { hash, result, expires: Date.now() + 40 * 60_000 })
  return credential
}

async function webUiStatus(settings) {
  const credential = await webUiCredential(settings)
  if (!credential) return
  try {
    const status = await webUiPost(settings.url, 'QQLogin/CheckLoginStatus', {}, credential)
    const online = status?.isLogin === true
    const account = online ? await webUiPost(settings.url, 'QQLogin/GetQQLoginInfo', {}, credential) : {}
    const duplicateLogin = status?.loginError?.includes('无法重复登录')
    const stage = online ? 'online'
      : status?.isOffline ? 'offline'
        : duplicateLogin ? 'duplicate_login'
          : status?.qrLoginAccepted || status?.loginPhase === 'qrcode_scanned' ? 'waiting_login' : 'waiting_qr'
    return { online, stage, napcat_installed: true, napcat_running: true,
      error: duplicateLogin && !online ? '这个 QQ 已在桌面客户端登录。请先退出原来的桌面 QQ，保留 NapCat 窗口，再点「换一个二维码」。' : undefined,
      user_id: /^[1-9][0-9]*$/.test(String(account?.uin)) ? String(account.uin) : undefined,
      nickname: typeof account?.nick === 'string' ? account.nick.slice(0, 120) : undefined,
      login_url: settings.url.href }
  } catch { sessions.delete(settings.url.origin); return undefined }
}

async function verifyWebUi(settings) {
  try {
    const response = await fetch(settings.url, { redirect: 'error', signal: AbortSignal.timeout(1000) })
    if (!response.ok) return false
    const html = (await readBytes(response, 256 * 1024)).toString('utf8')
    return /<title[^>]*>[^<]*NapCat/i.test(html)
  } catch { return false }
}

const qrLifetime = 60_000
async function nativeQrFile() {
  if (process.platform !== 'darwin') return
  for (const root of [macRuntime, macInstall]) {
    const path = join(root, 'cache', 'qrcode.png')
    try {
      const info = await stat(path)
      if (info.isFile() && info.size < 1024 * 1024) return { path, createdAt: info.mtimeMs }
    } catch { /* Mac launchers may offer the QR only through the WebUI. */ }
  }
}

let renderedQr
function renderQr(value, createdAt) {
  if (typeof value !== 'string' || !value || value.length > 2048) return
  if (renderedQr?.value !== value) renderedQr = { value, createdAt }
  if (Date.now() - renderedQr.createdAt >= qrLifetime) return
  if (renderedQr.image) return renderedQr.image
  if (!process.env.HNU_NOTICE_PYTHON) return
  const render = spawnSync(process.env.HNU_NOTICE_PYTHON, [
    '-c', 'import sys,qrcode; qrcode.make(sys.stdin.read()).save(sys.stdout.buffer, format="PNG")',
  ], { input: value, timeout: 2000, maxBuffer: 256 * 1024 })
  const image = render.status === 0 && qrImage(render.stdout)
  if (image) renderedQr.image = image
  return image
}

const readActions = new Set(['get_login_info', 'get_status', 'get_group_list', 'get_friend_list',
  'get_recent_contact', 'get_group_msg_history', 'get_friend_msg_history'])

function readConfig(config) {
  const { url, token } = config.napcatRead ?? {}
  const base = localUrl(url)
  if (!base || base.hostname !== '127.0.0.1' || base.protocol !== 'http:' || base.pathname !== '/'
    || base.search || base.hash || !base.port || !/^[a-f0-9]{64}$/.test(token ?? '')) return
  return { base, token }
}

async function readOneBot(config, action, body = {}, timeout = 2200) {
  const connection = readConfig(config)
  if (!connection || !readActions.has(action)) throw new Error('NapCat 读取接口未配置')
  const response = await fetch(new URL('/' + action, connection.base), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
    headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error('NapCat 读取接口暂不可用')
  const payload = JSON.parse((await readBytes(response)).toString('utf8'))
  if (payload.retcode !== 0 || payload.status !== 'ok') {
    if (action.endsWith('_msg_history') && /^消息.*不存在$/.test(payload.message ?? payload.wording ?? '')) {
      return { messages: [] }
    }
    throw new Error('NapCat 暂时无法读取 QQ 数据')
  }
  return payload.data
}

function safeId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return
  return /^[1-9][0-9]{0,19}$/.test(String(value)) ? String(value) : undefined
}

async function directStatus(config) {
  const status = await readOneBot(config, 'get_status')
  if (status?.online === false) return { online: false, stage: 'offline', napcat_installed: true, napcat_running: true }
  if (status?.online !== true) return
  const login = await readOneBot(config, 'get_login_info')
  const user_id = safeId(login?.user_id)
  if (user_id) return { online: true, stage: 'online', user_id, nickname: login.nickname,
    napcat_installed: true, napcat_running: true }
}

async function directAccount(config) {
  const login = await readOneBot(config, 'get_login_info')
  const account = safeId(login?.user_id)
  if (!account) throw new Error('无法确认当前 QQ 账号')
  return account
}

class AccountChanged extends Error {}

const historyId = value => /^-?[1-9][0-9]{0,15}$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? String(value) : undefined
const chatName = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : fallback

async function conversations(config) {
  const [recent, groups, friends] = await Promise.all([
    readOneBot(config, 'get_recent_contact', { count: 60 }, 8000),
    readOneBot(config, 'get_group_list', {}, 8000),
    readOneBot(config, 'get_friend_list', {}, 8000),
  ])
  if (![recent, groups, friends].every(Array.isArray)) throw new Error('QQ 会话列表格式无效')
  const rows = new Map()
  function add(kind, id, name, time = 0) {
    id = safeId(id)
    if (!id || rows.has(kind + ':' + id)) return
    rows.set(kind + ':' + id, { kind, id, name: chatName(name, id), time: Number(time) || 0 })
  }
  for (const item of recent) {
    if (item.chatType === 2) add('group', item.peerUin, item.peerName, item.msgTime)
    else if (item.chatType === 1 || item.chatType === 100 || item.lastestMsg?.message_type === 'private') {
      add('private', item.peerUin, item.remark || item.peerName || item.sendNickName, item.msgTime)
    }
  }
  for (const item of groups) add('group', item.group_id, item.group_name)
  for (const item of friends) add('private', item.user_id, item.remark || item.nickname)
  return { conversations: [...rows.values()].sort((a, b) => b.time - a.time || a.name.localeCompare(b.name, 'zh-CN')) }
}

const segmentLabels = { image: '图片', file: '文件', record: '语音', video: '视频', reply: '引用',
  at: '@', face: '表情', forward: '合并转发', json: '卡片', markdown: 'Markdown', dice: '骰子' }

async function history(config, account, { kind, id, before }) {
  const group = kind === 'group'
  const page = await readOneBot(config, group ? 'get_group_msg_history' : 'get_friend_msg_history', {
    [group ? 'group_id' : 'user_id']: id, count: before ? 31 : 30,
    ...(before ? { message_seq: before, reverse_order: true } : {}),
    disable_get_url: true, parse_mult_msg: false, quick_reply: false,
  }, 8000)
  if (!Array.isArray(page?.messages)) throw new Error('QQ 消息格式无效')
  const messages = page.messages.flatMap(message => {
    const messageId = historyId(message.message_id)
    if (!messageId || messageId === before || safeId(message.self_id) !== account
      || message.message_type !== kind || (group && safeId(message.group_id) !== id)) return []
    const sender = safeId(message.user_id)
    if (!group && sender !== id && sender !== account) return []
    const content = Array.isArray(message.message) ? message.message.map(segment => {
      if (segment.type === 'text') return String(segment.data?.text ?? '')
      const label = segmentLabels[segment.type] ?? '消息'
      const name = segment.type === 'file' ? chatName(segment.data?.name || segment.data?.file, '') : ''
      return '[' + label + (name ? ' ' + name : '') + ']'
    }).join('') : typeof message.raw_message === 'string' ? message.raw_message : ''
    return [{ id: messageId, time: Number(message.time) || 0, own: sender === account,
      sender: chatName(message.sender?.card || message.sender?.nickname, sender ?? 'QQ'), text: content.slice(0, 16000) }]
  }).sort((a, b) => a.time - b.time)
  const next = page.messages.length >= (before ? 31 : 30) ? messages[0]?.id ?? null : null
  return { messages, next: next === before ? null : next }
}

async function directGroups(config) {
  const account = await directAccount(config)
  const result = await readOneBot(config, 'get_group_list')
  if (await directAccount(config) !== account) throw new AccountChanged('QQ 账号已切换，请重新读取群列表')
  if (!Array.isArray(result)) throw new Error('NapCat 群列表格式无效')
  const groups = result.filter(group => safeId(group.group_id)).map(group => ({
    group_id: String(group.group_id), name: typeof group.group_name === 'string' ? group.group_name : String(group.group_id),
    member_count: Number.isSafeInteger(group.member_count) ? group.member_count : undefined,
  }))
  return { account, user_id: account, groups }
}

function withChannel(channels, channel, sameEndpoint, occupied) {
  const previous = channels.find(item => item.name === channel.name)
  if (previous && !sameEndpoint(previous)) throw new Error('NapCat 已存在同名连接，请在 WebUI 中确认配置')
  if (channels.some(item => item.name !== channel.name && occupied(item))) {
    throw new Error('NapCat 已存在指向该地址的连接，请在 WebUI 中确认配置')
  }
  if (!previous) return [...channels, channel]
  return channels.map(item => item === previous ? { ...item, ...channel } : item)
}

const settingUp = new Set()
async function reportsOwnMessages(settings, config) {
  const credential = await webUiCredential(settings)
  const report = config.napcatReport
  if (!credential || !report) return false
  const value = await webUiPost(settings.url, 'OB11Config/GetConfig', {}, credential).catch(() => undefined)
  return Boolean(value?.network?.httpClients?.some(channel =>
    channel.enable && channel.url === report.url && channel.token === report.token
    && channel.messagePostFormat === 'array' && channel.reportSelfMessage))
}

async function configureReadOnly(settings, config) {
  const reportUrl = localUrl(config.napcatReport?.url)
  const reportToken = config.napcatReport?.token
  const reading = readConfig(config)
  if (!reportUrl || reportUrl.protocol !== 'http:' || reportUrl.pathname !== '/onebot/event'
    || reportUrl.search || reportUrl.hash || !/^[a-f0-9]{64}$/.test(reportToken ?? '') || !reading) {
    return fail(503, '工作区未配置签名收件和本机读取地址')
  }
  const key = settings.url.origin
  if (settingUp.has(key)) return fail(409, 'NapCat 连接正在配置')
  settingUp.add(key)
  try {
    const credential = await webUiCredential(settings)
    const status = credential && await webUiStatus(settings)
    if (!status?.online || !status.user_id) return fail(409, '请先在 NapCat 登录 QQ，再启用收件',
      { login_url: await verifyWebUi(settings) ? settings.url.href : undefined })
    const original = await webUiPost(settings.url, 'OB11Config/GetConfig', {}, credential)
    const network = original?.network
    if (!Array.isArray(network?.httpClients) || !Array.isArray(network?.httpServers)) {
      return fail(502, 'NapCat 未返回有效的 OneBot 配置')
    }
    const report = { name: 'hnu-agent-report', enable: true, url: reportUrl.href,
      token: reportToken, messagePostFormat: 'array', reportSelfMessage: true, debug: false }
    const read = { name: 'hnu-agent-read', enable: true, host: '127.0.0.1', port: Number(reading.base.port),
      token: reading.token, enableCors: false, enableWebsocket: false, messagePostFormat: 'array', debug: false }
    let httpClients, httpServers
    try {
      httpClients = withChannel(network.httpClients, report, item => item.url === report.url, item => item.url === report.url)
      httpServers = withChannel(network.httpServers, read, item => item.host === read.host && item.port === read.port,
        item => item.enable && item.port === read.port)
    } catch (error) {
      return fail(409, error.message, { login_url: settings.url.href })
    }
    if ((await webUiStatus(settings))?.user_id !== status.user_id) return fail(409, 'QQ 账号已切换，请重新确认')
    await webUiPost(settings.url, 'OB11Config/SetConfig', {
      config: JSON.stringify({ ...original, network: { ...network, httpClients, httpServers } }),
    }, credential)
    let live
    for (let attempt = 0; attempt < 5 && !live; attempt += 1) {
      live = await directStatus(config).catch(() => undefined)
      if (!live) await new Promise(resolve => setTimeout(resolve, 300))
    }
    if (!live?.online || live.user_id !== status.user_id) {
      return fail(502, 'NapCat 已接受配置，但本机接口还未确认当前 QQ 在线', { login_url: settings.url.href })
    }
    const listed = await directGroups(config)
    if (listed.account !== status.user_id) return fail(409, 'QQ 账号已切换，请重新确认')
    return ok({ ...live, ...listed, report_ready: true, login_url: settings.url.href })
  } catch {
    return fail(502, 'NapCat 未能确认收件配置，请在本机 WebUI 检查连接', { login_url: settings.url.href })
  } finally {
    settingUp.delete(key)
  }
}

export async function napcatRequest(config, path, method = 'GET', query = {}) {
  if (!routes.has(path)) return fail(404, '未知的 NapCat 操作')
  if (routes.get(path) !== method) return fail(405, '此 NapCat 操作不支持该请求方法')
  if (path === 'conversations' || path === 'history') {
    const { account, kind, id, before } = query
    if (!safeId(account)) return fail(409, '请先在权限设置连接 QQ')
    if (path === 'history' && (!['group', 'private'].includes(kind) || !safeId(id) || (before && !historyId(before)))) {
      return fail(400, '会话或消息游标无效')
    }
    try {
      if (await directAccount(config) !== account) throw new AccountChanged()
      const result = path === 'conversations' ? await conversations(config) : await history(config, account, query)
      if (await directAccount(config) !== account) throw new AccountChanged()
      return ok({ account, ...result })
    } catch (error) {
      if (error instanceof AccountChanged) return fail(409, 'QQ 账号已切换，请先在权限设置确认')
      return fail(503, error.message)
    }
  }
  const settings = await webUiSettings(config)
  const hub = (route, verb) => request(config, route, verb).catch(() => undefined)
  if (path === 'setup') return configureReadOnly(settings, config)
  if (path === 'groups') {
    try {
      return ok(await directGroups(config))
    } catch (error) {
      if (error instanceof AccountChanged) return fail(409, error.message)
    }
    const first = (await hub('status'))?.value
    const account = first?.online === true ? safeId(first.user_id) : undefined
    if (!account) return fail(503, '登录 QQ 后点击启用收件，再刷新群列表')
    const result = await hub('groups')
    const last = (await hub('status'))?.value
    if (last?.online !== true || safeId(last.user_id) !== account) return fail(409, 'QQ 账号已切换，请重新读取群列表')
    return result?.value?.ok ? ok({ account, user_id: account, groups: result.value.groups })
      : fail(503, '群务台暂时无法读取群列表')
  }
  if (path === 'webui') {
    if (!await verifyWebUi(settings)) return fail(503, 'NapCat 登录窗口暂不可用')
    const url = new URL(settings.url)
    if (settings.token) url.searchParams.set('token', settings.token)
    return ok({ location: url.href })
  }
  if (path === 'qrcode' || path === 'refresh-qrcode') {
    const refresh = path === 'refresh-qrcode'
    const credential = await webUiCredential(settings)
    if (credential) {
      const status = await webUiPost(settings.url, 'QQLogin/CheckLoginStatus', {}, credential).catch(() => undefined)
      if (status?.isLogin || status?.qrLoginAccepted || status?.loginPhase === 'qrcode_scanned') {
        return fail(404, 'QQ 已登录或正在确认登录')
      }
      const file = await nativeQrFile()
      if (refresh) {
        const next = await webUiPost(settings.url, 'QQLogin/RefreshQRcode', {}, credential, 12_000).catch(() => undefined)
        const image = next?.qrcodeurl !== status?.qrcodeurl && renderQr(next?.qrcodeurl, Date.now())
        if (image) return image
        return fail(503, '暂时无法生成新二维码，请在 NapCat 登录窗口刷新。')
      }
      if (status?.loginError?.includes('无法重复登录')) return fail(404, '请先退出原来的桌面 QQ')
      const image = renderQr(status?.qrcodeurl, file?.createdAt ?? Date.now())
      if (image) return image
      return fail(404, '请点「换一个二维码」重新扫码')
    }
    if (!refresh) {
      const result = await hub('qrcode')
      if (result?.value?.ok) return result
      const file = await nativeQrFile()
      if (file && Date.now() - file.createdAt < qrLifetime) {
        const bytes = await readFile(file.path).catch(() => undefined)
        const image = bytes && qrImage(bytes)
        if (image) return image
      }
    }
    const loginUrl = await verifyWebUi(settings) ? settings.url.href : undefined
    return fail(404, '请在 NapCat 登录窗口生成二维码', { login_url: loginUrl })
  }

  const [hubStatus, native, direct] = await Promise.all([
    hub('status'), webUiStatus(settings), directStatus(config).catch(() => undefined),
  ])
  const fromHub = hubStatus?.value
  const status = native ?? direct ?? (fromHub?.stage ? publicStatus(fromHub) : undefined)
  const canOpenWebUi = Boolean(native || await verifyWebUi(settings))
  const loginUrl = canOpenWebUi ? settings.url.href : undefined
  if (path === 'switch') {
    if (process.platform === 'darwin' && status?.online) {
      execFile('/usr/bin/open', ['-a', '/Applications/QQ.app'], () => {})
      return ok({ ...status, stage: 'switch_in_qq', login_url: loginUrl,
        instruction: '在 QQ 客户端切换账号，然后回到这里点击「使用此 QQ」。' })
    }
    if (loginUrl) return ok({ ...status, stage: 'switch_in_webui', login_url: loginUrl,
      instruction: '在 NapCat 切换账号后，回到这里点击「使用此 QQ」。' })
    return fail(409, '请先启动 NapCat，再在 QQ 登录窗口切换账号',
      { stage: status?.stage, install_url: process.platform === 'darwin' ? installer : undefined })
  }
  if (status?.online && status.user_id) return ok({
    ...status, login_url: loginUrl, report_ready: direct?.online === true && direct.user_id === status.user_id
      && (!native?.online || await reportsOwnMessages(settings, config)),
  })
  if (loginUrl) {
    if (['waiting_qr', 'waiting_login', 'duplicate_login', 'offline'].includes(status?.stage)) {
      return ok({ ...status, login_url: loginUrl })
    }
    return ok({ online: false, stage: 'running_no_api', napcat_installed: true, napcat_running: true,
      login_url: loginUrl, error: 'NapCat 已运行。请打开本机登录窗口完成 QQ 登录，再刷新连接。' })
  }
  if (path === 'connect' && fromHub?.stage === 'running_no_api' && process.platform !== 'darwin') {
    const connected = await hub('connect', 'POST')
    if (connected?.value?.status) return ok(publicStatus(connected.value.status))
  }
  if (settings.installed || fromHub?.napcat_installed) {
    if (settings.installed && settings.originalEntry) {
      return ok({ online: false, stage: 'original_qq', napcat_installed: true,
        error: 'NapCat 已安装。请在安装器中将程序入口切换为 NapCat，再点击「启动 NapCat」。' })
    }
    return ok({ online: false, stage: 'stopped', napcat_installed: true,
      error: '请在 NapCat 安装器中启动 NapCat，再返回检查 QQ 登录状态' })
  }
  const detail = { online: false, stage: fromHub?.stage === 'error' ? 'error' : 'not_installed',
    install_url: process.platform === 'darwin' ? installer : undefined }
  const error = process.platform === 'darwin'
    ? '尚未检测到 NapCat。请安装并启动 NapCat，再连接 QQ。'
    : '尚未检测到 NapCat。启动 NapCat 并配置群务台后再试。'
  return path === 'status' ? ok({ ...detail, error }) : fail(409, error, detail)
}

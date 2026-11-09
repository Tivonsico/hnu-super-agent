import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'

const maxBody = 128 * 1024
export const defaultListenMinutes = 30
export const maxListenMinutes = 1440
const positiveId = /^[1-9][0-9]{0,19}$/
const messageId = /^-?[1-9][0-9]{0,19}$/
const asId = (value, format = positiveId) =>
  (typeof value === 'string' || Number.isSafeInteger(value)) && format.test(String(value)) ? String(value) : undefined
const signatureOf = (token, body) => 'sha1=' + createHmac('sha1', token).update(body).digest('hex')
const digest = body => createHash('sha256').update(body).digest('hex')

function effectiveGroup(value, now = Date.now()) {
  const ttlMinutes = value.ttlMinutes ?? defaultListenMinutes
  const expiresAt = value.expiresAt ?? (value.enabledAt ? value.enabledAt + ttlMinutes * 60_000 : null)
  return { ...value, ttlMinutes, expiresAt, enabled: Boolean(value.enabled && expiresAt > now) }
}

export function openQueue(path) {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS connection (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      enabled_since INTEGER NOT NULL, last_report INTEGER, online INTEGER
    );
    INSERT OR IGNORE INTO connection (singleton, enabled_since) VALUES (1, unixepoch());
    CREATE TABLE IF NOT EXISTS group_settings (
      id TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_groups (
      account TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(account, id)
    );
    CREATE TABLE IF NOT EXISTS conversation_activity (
      account TEXT NOT NULL, id TEXT NOT NULL, active_at INTEGER NOT NULL, PRIMARY KEY(account, id)
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, group_id TEXT NOT NULL, message_id TEXT, actor TEXT, sent_at INTEGER,
      text TEXT NOT NULL, raw BLOB NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL,
      forwarded INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)
  const addColumn = (table, name, type) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    addColumn('events', 'reply_to', 'TEXT')
    addColumn('connection', 'account', 'TEXT')
    db.exec(`INSERT OR IGNORE INTO account_groups
      SELECT connection.account, group_settings.id, group_settings.value
      FROM group_settings CROSS JOIN connection WHERE connection.account IS NOT NULL;
      DELETE FROM group_settings WHERE EXISTS (SELECT 1 FROM connection WHERE account IS NOT NULL);`)
    addColumn('events', 'name', 'TEXT')
    addColumn('events', 'role', 'TEXT')
    addColumn('events', 'attachments', "TEXT NOT NULL DEFAULT '[]'")
    addColumn('events', 'received_at', 'INTEGER')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    db.close()
    throw error
  }
  const select = db.prepare('SELECT * FROM events WHERE id = ?')
  const insert = db.prepare(`INSERT INTO events (id, group_id, message_id, actor, sent_at, text, raw, fingerprint, status, reply_to, name, role, attachments, received_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT account FROM connection) = ?
    ON CONFLICT(id) DO UPDATE SET status = 'conflict'
    WHERE events.fingerprint <> excluded.fingerprint`)
  const account = () => db.prepare('SELECT account FROM connection WHERE singleton = 1').get()?.account
  const group = db.prepare('SELECT value FROM account_groups WHERE account = ? AND id = ?')
  const loadGroup = (id, self = account(), now = Date.now()) => {
    const row = group.get(self ?? '', id)
    return row && effectiveGroup(JSON.parse(row.value), now)
  }
  const view = row => row && ({ ...row, attachments: JSON.parse(row.attachments), received_at: row.received_at ?? row.created_at * 1000 })
  return {
    close: () => db.close(),
    group: loadGroup,
    activity: () => Object.fromEntries(db.prepare('SELECT id, active_at FROM conversation_activity WHERE account = ?')
      .all(account() ?? '').map(row => [row.id, row.active_at])),
    recordActivity(self, id, at) {
      db.prepare(`INSERT INTO conversation_activity SELECT ?, ?, ? WHERE (SELECT account FROM connection) = ?
        ON CONFLICT(account, id) DO UPDATE SET active_at = max(active_at, excluded.active_at)`).run(self, id, at, self)
    },
    account,
    selectAccount(id) {
      if (asId(id) !== id) throw new Error('QQ 账号无效')
      db.prepare('UPDATE connection SET account = ?, last_report = NULL, online = NULL WHERE singleton = 1 AND account IS NOT ?')
        .run(id, id)
    },
    groups: () => db.prepare('SELECT value FROM account_groups WHERE account = ? ORDER BY rowid').all(account() ?? '')
      .map(row => effectiveGroup(JSON.parse(row.value))),
    saveGroup({ wasEnabled, ...input }) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const currentAccount = account()
        if (!currentAccount) throw Object.assign(new Error('请先登录 QQ'), { status: 409 })
        const now = Date.now()
        const previous = loadGroup(input.id, currentAccount, now)
        if ((previous?.version ?? 0) !== input.version || Boolean(previous?.enabled) !== wasEnabled) {
          throw Object.assign(new Error('群设置已更新，请刷新'), { status: 409 })
        }
        const ttlMinutes = input.ttlMinutes ?? previous?.ttlMinutes ?? defaultListenMinutes
        if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > maxListenMinutes) {
          throw Object.assign(new Error('监听时长必须为 1 至 1440 分钟'), { status: 400 })
        }
        const renewing = input.enabled && (!previous?.enabled || previous.ttlMinutes !== ttlMinutes)
        const value = {
          ...input,
          mode: input.enabled && !previous?.enabled ? 'observe' : input.mode,
          version: input.version + 1,
          enabledAt: input.enabled ? previous?.enabled ? previous.enabledAt : now : null,
          ttlMinutes,
          expiresAt: input.enabled ? renewing ? now + ttlMinutes * 60_000 : previous.expiresAt : null,
        }
        db.prepare('INSERT INTO account_groups VALUES (?, ?, ?) ON CONFLICT(account, id) DO UPDATE SET value = excluded.value')
          .run(currentAccount, input.id, JSON.stringify(value))
        db.exec('COMMIT')
        return value
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    health: () => db.prepare(`SELECT connection.*,
      (SELECT created_at FROM events WHERE id LIKE connection.account || ':%' ORDER BY rowid DESC LIMIT 1) AS last_message
      FROM connection WHERE singleton = 1`).get(),
    bindAccount(account) {
      const bound = db.prepare('UPDATE connection SET account = ? WHERE singleton = 1 AND (account IS NULL OR account = ?)').run(account, account)
      if (!bound.changes) throw new Error('Use a separate queue for each collection account')
    },
    touch: (online, self) => db.prepare('UPDATE connection SET last_report = unixepoch(), online = ? WHERE singleton = 1 AND account = ?')
      .run(online, self),
    save(event, raw, self) {
      const fingerprint = digest(JSON.stringify([event.actor, event.time, event.segments]))
      insert.run(event.id, event.group, event.message ?? null, event.actor ?? null, event.time ?? null,
        event.text, raw, fingerprint, event.status, event.replyTo ?? null, event.name, event.role,
        JSON.stringify(event.attachments), Date.now(), self)
    },
    get: id => view(select.get(id)),
    events: () => db.prepare('SELECT rowid AS cursor, id, group_id, message_id, actor, sent_at, text, status, forwarded, created_at, reply_to, name, role, attachments, received_at FROM events WHERE id LIKE ? ORDER BY rowid').all((account() ?? '') + ':%').map(view),
    page(before, groupId, limit) {
      return db.prepare(`SELECT rowid AS cursor, id, group_id, message_id, actor, sent_at, text, status, forwarded, created_at,
        reply_to, name, role, attachments, received_at FROM events
        WHERE id LIKE ? AND rowid < ? AND (? IS NULL OR group_id = ?) ORDER BY rowid DESC LIMIT ?`)
        .all((account() ?? '') + ':%', before, groupId, groupId, limit).map(view)
    },
    discussion(event, limit) {
      return db.prepare(`SELECT id, group_id, message_id, actor, sent_at, received_at, text, status, reply_to, name, role, attachments
        FROM events WHERE group_id = ? AND id LIKE ? AND rowid <= (SELECT rowid FROM events WHERE id = ?)
        ORDER BY rowid DESC LIMIT ?`).all(event.group_id, (account() ?? '') + ':%', event.id, limit).map(view).reverse()
    },
    unsent: () => db.prepare(`SELECT id, raw FROM events WHERE id LIKE ? AND forwarded = 0
      AND group_id NOT LIKE 'private:%' AND status <> 'conflict' AND message_id IS NOT NULL AND actor IS NOT NULL ORDER BY rowid LIMIT 25`)
      .all((account() ?? '') + ':%'),
    forwarded: id => db.prepare('UPDATE events SET forwarded = 1 WHERE id = ?').run(id),
  }
}

function conversationId(payload) {
  if (payload.message_type === 'group') return asId(payload.group_id)
  if (payload.message_type !== 'private') return
  const peer = asId(payload.post_type === 'message_sent' ? payload.target_id : payload.user_id)
  return peer && 'private:' + peer
}

function normalize(payload, raw, options, queue) {
  const self = asId(payload.self_id)
  const group = conversationId(payload)
  if (!self || self !== queue.account() || !group) return
  const settings = options.dynamicGroups ? queue.group(group, self) : undefined
  if (options.dynamicGroups ? !settings?.enabled : !options.groups.includes(group)) return
  const since = settings ? Math.floor(settings.enabledAt / 1000) : queue.health().enabled_since
  const actor = asId(payload.user_id)
  const sentBySelf = payload.post_type === 'message_sent'
  if (sentBySelf !== (actor === self)) return
  const time = Number.isSafeInteger(payload.time) && payload.time > 0 && payload.time <= Math.floor(Date.now() / 1000) + 120
    ? payload.time : undefined
  if (time !== undefined && time < since) return
  const message = asId(payload.message_id, messageId)
  const segments = payload.message
  const text = Array.isArray(segments) ? segments
    .filter(segment => segment?.type === 'text' && typeof segment.data?.text === 'string')
    .map(segment => segment.data.text).join('').trim() : ''
  const plain = text && Array.isArray(segments) && segments.every(segment =>
    segment?.type === 'text' && typeof segment.data?.text === 'string')
  const replyTo = Array.isArray(segments) && segments.length > 1 && segments[0]?.type === 'reply'
    && segments.slice(1).every(segment => segment?.type === 'text' && typeof segment.data?.text === 'string')
    ? asId(segments[0].data?.id, messageId) : undefined
  let status = 'needs_confirmation'
  if (actor && time && message && text) {
    if (plain) status = 'verified'
    else if (replyTo) status = 'reply'
  }
  const sender = payload.sender
  const name = [sender?.card, sender?.nickname].find(value => typeof value === 'string' && value.trim())
  const role = actor && asId(sender?.user_id) === actor && ['owner', 'admin', 'member'].includes(sender.role) ? sender.role : null
  const attachments = Array.isArray(segments) ? segments.filter(segment =>
    ['file', 'image', 'record', 'video', 'forward'].includes(segment?.type)).map(segment => ({
      type: segment.type,
      name: String(segment.data?.name ?? segment.data?.file ?? '').slice(0, 160),
    })).slice(0, 30) : []
  return {
    id: message ? `${self}:${group}:${message}` : `${self}:${group}:missing-${digest(raw)}`,
    group, message, actor, time, segments, text, status, replyTo, name: name?.slice(0, 100) ?? null, role, attachments,
  }
}

export function receiver(queue, options) {
  if (!options.token || options.account && !asId(options.account)
    || !options.dynamicGroups && !options.account
    || !options.dynamicGroups && (!options.groups?.length || options.groups.some(group => !asId(group)))) {
    throw new Error('A report token, collection QQ account and group allowlist are required')
  }
  if (options.account && !options.dynamicGroups) queue.bindAccount(options.account)
  if (options.account && options.dynamicGroups && !queue.account()) queue.bindAccount(options.account)
  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (req, res) => {
    const done = status => { res.writeHead(status); res.end() }
    if (req.method !== 'POST' || req.url !== '/onebot/event') return done(404)
    const signature = req.headers['x-signature']
    if (typeof signature !== 'string' || !/^sha1=[0-9a-f]{40}$/.test(signature)) return done(401)
    const chunks = []
    let size = 0
    try {
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length
        if (size > maxBody) {
          res.setHeader('Connection', 'close')
          done(413)
          break
        }
        chunks.push(chunk)
      }
      if (size > maxBody) return
      const raw = Buffer.concat(chunks)
      if (!timingSafeEqual(Buffer.from(signature), Buffer.from(signatureOf(options.token, raw)))) return done(401)
      let payload
      try { payload = JSON.parse(raw) } catch { return done(400) }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return done(400)
      const self = asId(payload.self_id)
      if (payload.post_type === 'meta_event' && payload.meta_event_type === 'heartbeat' && self) {
        queue.touch(payload.status?.online === false || payload.status?.good === false ? 0 : 1, self)
      }
      if (['message', 'message_sent'].includes(payload.post_type) && self && self === queue.account()) {
        const chat = conversationId(payload)
        const now = Math.floor(Date.now() / 1000)
        if (options.dynamicGroups && chat && Number.isSafeInteger(payload.time) && payload.time > 0 && payload.time <= now + 120) {
          queue.recordActivity(self, chat, payload.time)
        }
        const event = normalize(payload, raw, options, queue)
        if (event) {
          queue.save(event, raw, self)
          queue.touch(1, self)
        }
      }
      return done(204)
    } catch {
      if (!res.headersSent) return done(503)
    }
  })
}

export async function forwardPending(queue, { url, token }, signal) {
  const endpoint = new URL(url)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/onebot/event'
    || endpoint.search || endpoint.hash || endpoint.username || endpoint.password || !token) {
    throw new Error('Expected a signed loopback notice-hub receiver')
  }
  for (const row of queue.unsent()) {
    const payload = JSON.parse(Buffer.from(row.raw).toString('utf8'))
    let body = row.raw
    if (payload.post_type === 'message_sent') {
      // Notice Hub consumes group messages as inbound records. Keep the signed original in the queue.
      payload.post_type = 'message'
      delete payload.self_id
      body = Buffer.from(JSON.stringify(payload))
    }
    const response = await fetch(endpoint, {
      method: 'POST', body, redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-signature': signatureOf(token, body) },
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    })
    await response.body?.cancel()
    if (!response.ok) throw new Error(`群务台收件失败 HTTP ${response.status}`)
    queue.forwarded(row.id)
  }
}

export async function syncSubscriptions(groups, config, signal) {
  const base = new URL(config?.url)
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.pathname !== '/api/tasks'
    || base.search || base.hash || base.username || base.password || !config.token) {
    throw new Error('群务台订阅需要本机管理接口和令牌')
  }
  const response = await fetch(new URL('/api/subscriptions', base), {
    method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', 'X-Token': config.token },
    body: JSON.stringify({ groups, aliases: {} }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  })
  if (!response.ok || !(await response.json()).applied) throw new Error('群务台尚未应用监听群设置')
}

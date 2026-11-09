import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { maxListenMinutes, openQueue } from '../../qq-ingest/receiver.mjs'
import { openReviews } from '../../hnu/reviews.mjs'
import { documentWork } from '../../hnu/document-work.mjs'
import { bindExecution } from './execution.mjs'
import { bindApprovals } from './approval.mjs'
import { napcatRequest, qqImage } from './napcat.mjs'

export const inject = ['orchestrator', 'webServer', 'connection', 'sessionController', 'credentials', 'workspaceRegistry']
const sourceName = 'hnu-qq'
const qqId = z.string().regex(/^[1-9][0-9]{0,19}$/)
const conversationId = z.string().regex(/^(?:private:)?[1-9][0-9]{0,19}$/)
const groupInput = z.object({
  id: conversationId, name: z.string().trim().min(1).max(100), enabled: z.boolean(),
  mode: z.enum(['observe', 'auto']), roles: z.array(z.enum(['owner', 'admin'])).max(2),
  senders: z.array(qqId).max(100),
  ttlMinutes: z.number().int().min(1).max(maxListenMinutes).optional(),
  wasEnabled: z.boolean(),
  version: z.number().int().nonnegative(),
})
const ticketId = z.string().min(1).max(120)
const eventId = z.string().min(1).max(120)
const text = z.string().trim().min(1).max(1500)
const decision = z.object({
  ticket: ticketId, version: z.number().int().positive(), commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  action: z.enum(['approve', 'reject', 'revise']), note: z.string().trim().max(1500).optional(),
})
function configOf() {
  const path = process.env.HNU_COMPANION_CONFIG
  if (!path || (statSync(path).mode & 0o077)) throw new Error('工作区配置文件权限必须为 600')
  const config = JSON.parse(readFileSync(path, 'utf8'))
  if (!/^[a-f0-9]{64}$/.test(config.reviewerKey ?? '')) throw new Error('缺少本机启动凭据')
  return config
}

function safeEqual(value, expected) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
    && timingSafeEqual(Buffer.from(value), Buffer.from(expected))
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 8192) throw Object.assign(new Error('请求超过大小限制'), { status: 413 })
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function currentEvent(queue, id) {
  const account = queue.account()
  return Boolean(account && typeof id === 'string' && id.startsWith(account + ':'))
}

const sourceKind = queue => ({
  kind: sourceName,
  title: { zh: 'HNU Agent', en: 'HNU Agent' },
  description: { zh: '从已选 QQ 群接收只读消息', en: 'Read-only reports from subscribed QQ groups' },
  schema: z.object({ groups: z.array(z.object({ id: qqId })).optional() }).passthrough(),
  health: [sourceName],
  scope({ meta }) {
    return currentEvent(queue, meta.eventId) && (meta.panel || queue.group(meta.group)?.enabled)
      ? { listened: true, observed: true, row: meta.group }
      : { listened: false, reason: 'qq_group_not_listed' }
  },
  threadContext: {
    messageId: trigger => trigger.meta.eventId,
    async read(_commands, trigger, part) {
      const event = queue.get(trigger.meta.eventId)
      if (!currentEvent(queue, event?.id)) return { messages: [], body: { messages: [] } }
      const group = queue.group(event.group_id)
      if (!assessable(event, group)) return { messages: [], body: { messages: [] } }
      const parent = event.reply_to && queue.get(event.id.slice(0, event.id.lastIndexOf(':') + 1) + event.reply_to)
      const rows = part === 'parent' ? [parent] : part === 'root' ? [event] : [...new Map([
        ...(parent ? [parent] : []), ...queue.discussion(event, 16),
      ].map(row => [row.id, row])).values()]
      const messages = rows.filter(row => assessable(row, group)).map(row => ({ id: row.id, from: row.name || row.actor,
        at: new Date(row.sent_at * 1000).toISOString(), text: row.text.slice(0, 6000) || '消息含图片附件' }))
      return { messages, body: { messages }, status: 'chat_neighbours' }
    },
  },
})

function evidence(event) {
  if (!event) return
  const { raw, fingerprint, ...publicEvent } = event
  return publicEvent
}

function eligible(event, group) {
  return Boolean(group && event?.actor && (group.senders.includes(event.actor) || group.roles.includes(event.role)))
}

function assessable(event, group, previouslyAssessed = false) {
  if (!previouslyAssessed && (!group?.enabled || event?.received_at < group.enabledAt)) return false
  return eligible(event, group) && event.status !== 'conflict' && Boolean(event.message_id && event.sent_at
    && (event.text || event.attachments?.some(item => item.type === 'image')))
}

function makeTrigger(event, grant) {
  const ref = { source: sourceName, id: event.id }
  return {
    id: `${sourceName}:${event.id}${grant ? ':manual' : ''}`, source: sourceName, threads: [ref],
    actor: { source: sourceName, id: event.actor || 'qq-unknown' }, human: true,
    at: new Date(event.sent_at ? event.sent_at * 1000 : event.received_at).toISOString(),
    text: grant ? `本机用户确认的执行范围：${grant.scope}\n\nQQ 原文：\n${event.text}` : event.text || 'QQ 消息含图片附件',
    meta: { group: event.group_id, eventId: event.id,
      manual: Boolean(grant), ...(grant ? { scope: grant.scope } : {}), materialIds: grant?.materialIds ?? [] },
  }
}

function bindPolicy(runtime, queue, reviews, approvals) {
  const options = runtime.engine.options
  const original = options.policy
  function canAssess(trigger, previouslyAssessed = false) {
    const event = queue.get(trigger.meta.eventId)
    const settings = runtime.store.settings().eval
    return currentEvent(queue, event?.id) && settings.mode !== 'off' && Boolean(settings.model)
      && assessable(event, queue.group(event.group_id), previouslyAssessed) && !reviews.linked(event.id)
      && trigger.meta.manual === Boolean(reviews.manualRequest(event.id))
  }
  function authorized(event, trigger) {
    if (!currentEvent(queue, event?.id) || event.status === 'conflict' || runtime.store.settings().eval.mode === 'off' || !runtime.store.settings().eval.model) return false
    const ticket = runtime.store.tickets.list().find(item => item.origin.triggerId === trigger.id)
    if (!ticket || reviews.inputs(ticket.id).some(input => input.event && queue.get(input.event)?.status === 'conflict')) return false
    return !trigger.meta.manual || Boolean(reviews.manualRequest(event.id))
  }
  let ownerResume
  options.policy = function () {
    const base = original.call(this)
    return {
      ...base,
      gate(trigger, thread, tickets) {
        if (trigger.source !== sourceName) return base.gate(trigger, thread, tickets)
        const approval = approvals.get(trigger.meta.eventId)
        const approved = approval?.status === 'approve' && approval.triggerId === trigger.id
        if (trigger.meta.panel || !canAssess(trigger, approved)) return { admissible: false, reason: 'not_a_member' }
        const explicit = trigger.meta.manual || approved
        return { admissible: true, strength: explicit ? 'explicit' : 'inferred',
          basis: { source: sourceName, scope: trigger.meta, row: trigger.meta.group, via: 'followup' } }
      },
      revalidate(mandate) {
        if (mandate.basis.source !== sourceName) return base.revalidate(mandate)
        const meta = mandate.basis.scope
        if (!meta) return false
        const event = queue.get(meta.eventId)
        if (!currentEvent(queue, event?.id) || event.status === 'conflict') return false
        return !meta.manual || meta.eventId === ownerResume || Boolean(reviews.manualRequest(meta.eventId))
      },
    }
  }
  return {
    authorized, canAssess,
    asOwner(event, execute) {
      ownerResume = event
      try { return execute() } finally { ownerResume = undefined }
    },
    dispose() { options.policy = original },
  }
}

function workspace(runtime, queue, reviews, policy, source) {
  const origin = ticket => ticket && runtime.store.triggers.get(ticket.origin.triggerId)
  const owns = ticket => {
    const trigger = origin(ticket)
    return trigger?.source === sourceName && currentEvent(queue, trigger.meta.eventId)
  }
  const tickets = () => runtime.store.tickets.list().filter(owns)
  const ticketFor = event => currentEvent(queue, event) ? reviews.linked(event) || tickets().find(ticket => origin(ticket)?.meta.eventId === event)?.id : undefined
  function attach(ticket, operation, value, user) {
    const original = origin(ticket)
    if (!owns(ticket) || ticket.ended?.by === 'human') throw new Error('此工单无法续办')
    const id = `${original.id}:followup:${operation}`
    const act = () => runtime.store.atomic(() => {
      if (runtime.store.triggers.disposition(id)?.fanout.includes(ticket.id)) return
      const result = runtime.engine.receive({
        ...original, id, threads: [{ source: sourceName, id }], text: value, at: new Date().toISOString(),
        meta: { ...original.meta, panel: true },
      })
      if (result === 'filtered') throw new Error('工单关联请求被拒绝')
      runtime.engine.attach(ticket.id, id)
    })
    if (user) policy.asOwner(original.meta.eventId, act)
    else act()
    runtime.passes.request()
  }
  function receive(event, grant) {
    const trigger = makeTrigger(event, grant)
    if (!source.triggers.get(trigger.id)) return source.receive(trigger)
  }
  return { origin, owns, tickets, ticketFor, attach, receive }
}

function onlineAccount(result) {
  const value = result.value
  if (result.status === 200 && value.online === true && qqId.safeParse(value.user_id).success) return value.user_id
}

const officialProvider = 'deepseek-official'
const keyRef = 'DEEPSEEK_API_KEY'
async function modelState(ctx) {
  const catalog = await ctx.sessionController.modelCatalog()
  const models = catalog.groups.filter(group => catalog.routableProviders.includes(group.id))
    .flatMap(group => group.models.map(model => ({ provider: group.id, id: model.id, name: model.name ?? model.id })))
  const current = ctx.orchestrator.store.settings().eval.model
  const select = model => models.find(item => item.provider === model?.provider && item.id === model?.model)
  const selected = select(current) ?? models.find(item => item.id === 'v41f1017') ?? select(catalog.default) ?? models[0]
  return { configured: Boolean(selected), selected, models }
}

async function saveModel(ctx, value) {
  const input = z.object({
    apiKey: z.string().trim().min(1).max(4096).regex(/^[!-~]+$/).optional(),
    provider: z.string().min(1).optional(), model: z.string().min(1).optional(),
  }).parse(value)
  const options = await modelState(ctx)
  let requested = input.model ? options.models.find(item => item.id === input.model && item.provider === input.provider) : options.selected
  const invalid = (message, status = 400) => Object.assign(new Error(message), { status })
  const runtime = ctx.orchestrator
  const saved = []
  let previousKey, keyWritten, result
  try {
    if (input.apiKey) {
      const response = await fetch('https://api.deepseek.com/models', { redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: 'Bearer ' + input.apiKey } }).catch(() => undefined)
      if (response?.status === 401 || response?.status === 403) throw invalid('DeepSeek API Key 无法通过验证')
      const listing = response?.ok && await response.json().catch(() => undefined)
      const ids = Array.isArray(listing?.data) ? listing.data.map(model => model?.id).filter(id => typeof id === 'string') : []
      if (!ids.length) throw invalid('暂时无法读取 DeepSeek 模型，请重试', 503)
      const preferred = requested?.provider === officialProvider && ids.includes(requested.id) ? requested.id : 'deepseek-flash'
      previousKey = await ctx.credentials.resolve(keyRef)
      await ctx.credentials.set(keyRef, input.apiKey)
      keyWritten = true
      const catalog = await modelState(ctx)
      const available = catalog.models.filter(item => item.provider === officialProvider && ids.includes(item.id))
      requested = available.find(item => item.id === preferred) ?? available[0]
      if (!requested) throw invalid('DSH 尚未加载此 Key 可用的 DeepSeek 模型', 503)
    }
    if (!requested) throw invalid('请选择可用模型')
    const model = { provider: requested.provider, model: requested.id }
    const old = runtime.store.settings().eval.model
    for (const block of ['executor', 'eval']) {
      const previous = runtime.settings.block(block)
      const value = { ...previous.value, model }
      if (block === 'eval' && !previous.value.model) value.mode = 'auto'
      const change = await runtime.settings.save(block, value, previous.revision, 'panel')
      if (change.revision !== previous.revision) saved.push({ block, previous, revision: change.revision })
    }
    result = await modelState(ctx)
    if (old?.provider !== model.provider || old?.model !== model.model) {
      await ctx.sessionController.selectModel({ sessionId: runtime.masterId, ...model })
    }
  } catch (failure) {
    try {
      if (keyWritten && (await ctx.credentials.resolve(keyRef))?.value === input.apiKey) {
        if (previousKey?.source === 'file') await ctx.credentials.set(keyRef, previousKey.value)
        else await ctx.credentials.unset(keyRef)
      }
      for (const { block, previous, revision } of saved.reverse()) {
        if (runtime.settings.block(block).revision === revision) await runtime.settings.save(block, previous.value, revision, 'panel')
      }
    } catch { throw invalid('模型配置失败，部分设置需要重新确认', 500) }
    throw failure
  }
  return result
}

function registerApi(ctx, config, queue, reviews, work, source, desk, state, approvals) {
  const web = ctx.webServer
  let modelUpdate = Promise.resolve()
  const noCache = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }
  const isLoopback = host => host === `127.0.0.1:${web.port}` || host === `localhost:${web.port}`
  const launch = web.register({ kind: 'prefix', path: '/hnu/launch', handler: async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const token = url.searchParams.get('dsh')
    if (req.method !== 'GET' || url.pathname !== '/hnu/launch' || !isLoopback(req.headers.host)
      || !safeEqual(url.searchParams.get('key'), config.reviewerKey) || !/^[A-Za-z0-9_-]{20,180}$/.test(token ?? '')) {
      res.writeHead(403, noCache)
      return res.end('请使用本机启动器打开 HNU Agent')
    }
    const nonce = randomBytes(18).toString('base64')
    res.writeHead(200, { ...noCache, 'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'` })
    res.end(`<!doctype html><meta charset="utf-8"><title>HNU Agent</title><script nonce="${nonce}">
      sessionStorage.setItem('hnu.workspace.launch', '1');
      location.replace('/?token=${token}');
    </script>`)
  } })
  try {
    const api = web.register({ kind: 'prefix', path: '/hnu/api', handler: async (req, res) => {
      const respond = (code, value) => {
        res.writeHead(code, { ...noCache, 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(value))
      }
      const host = req.headers.host
      if (!isLoopback(host) || req.method !== 'GET' && req.headers.origin !== `http://${host}`) {
        return respond(403, { error: '工作区请求来源无效' })
      }
      const rejection = ctx.connection.requestRejection(req)
      if (rejection) return respond(rejection, { error: '请重新打开 DSH 工作区' })
      const url = new URL(req.url, 'http://127.0.0.1')
      const path = url.pathname.slice('/hnu/api/'.length)
      try {
        if (path === 'qq-image' && req.method === 'GET') {
          const account = queue.account()
          const kind = url.searchParams.get('kind')
          const id = url.searchParams.get('id')
          const messageId = url.searchParams.get('message')
          const index = Number(url.searchParams.get('index'))
          if (!account || !['group', 'private'].includes(kind) || !qqId.safeParse(id).success
            || !/^-?[1-9][0-9]{0,15}$/.test(messageId ?? '') || !Number.isInteger(index) || index < 0 || index > 29) {
            return respond(400, { error: '图片参数无效' })
          }
          const chat = kind === 'group' ? id : 'private:' + id
          const original = queue.get(account + ':' + chat + ':' + messageId)
          const signed = original?.raw ? JSON.parse(Buffer.from(original.raw)) : undefined
          const image = await qqImage(config, account, { kind, id, messageId, index, signed }).catch(() => undefined)
          if (account !== queue.account()) return respond(409, { error: 'QQ 账号已切换' })
          if (!image) return respond(404, { error: '原图暂不可用' })
          res.writeHead(200, { ...noCache, 'content-type': image.type })
          return res.end(image.bytes)
        }
        if (path.startsWith('napcat/')) {
          const route = path.slice(7)
          if (route === 'report' && req.method === 'GET') return respond(200, config.napcatReport)
          if (route === 'account' && req.method === 'POST') {
            const verified = await napcatRequest(config, 'status')
            const account = onlineAccount(verified)
            if (!account) return respond(409, { error: '请先在 NapCat 登录 QQ' })
            queue.selectAccount(account)
            state.groups = null
            return respond(200, { ...verified.value, boundAccount: account })
          }
          const bound = queue.account()
          const id = url.searchParams.get('id')
          if (route === 'permissions' && !conversationId.safeParse(id).success) return respond(400, { error: '会话无效' })
          const result = await napcatRequest(config, route, req.method, {
            account: bound, mode: url.searchParams.get('mode'), activity: route === 'conversations' ? queue.activity() : undefined,
            kind: url.searchParams.get('kind'), id, before: url.searchParams.get('before'),
            policy: route === 'permissions' ? queue.group(id, bound) : undefined,
          })
          if (['conversations', 'history', 'permissions'].includes(route) && result.status === 200 && bound !== queue.account()) {
            return respond(409, { error: 'QQ 账号已切换，请先确认使用当前账号' })
          }
          if (route === 'webui' && result.status === 200) {
            res.writeHead(303, { ...noCache, location: result.value.location })
            return res.end()
          }
          if (route === 'groups' && result.status === 200
            && (result.value.account !== bound || bound !== queue.account())) {
            return respond(409, { error: 'QQ 账号已切换，请先确认使用当前账号' })
          }
          const account = onlineAccount(result)
          if (account && !queue.account() && ['status', 'connect', 'setup'].includes(route)) queue.selectAccount(account)
          if (route === 'setup' && result.status === 200) state.groups = null
          return respond(result.status, { ...result.value, boundAccount: queue.account() })
        }
        if (path === 'model' && req.method === 'GET') return respond(200, await modelState(ctx))
        if (path === 'model' && req.method === 'POST') {
          const input = await readBody(req)
          const update = modelUpdate.then(() => saveModel(ctx, input))
          modelUpdate = update.catch(() => {})
          return respond(200, await update)
        }
        const publicProposal = ({ eventId, version, title, scope, reason }) => ({ eventId, version, title, scope,
          reason: typeof reason === 'string' ? reason : undefined })
        const display = event => {
          const proposal = approvals.get(event.id)
          const ticket = desk.ticketFor(event.id)
          const pending = !ticket && proposal?.status === 'pending' && event.status !== 'conflict'
          const listening = queue.group(event.group_id)
          const reason = ticket ? 'dssa' : pending ? 'pending_open' : proposal?.status === 'reject' ? 'open_rejected'
            : listening?.enabled && event.received_at >= listening.enabledAt ? state.reasons.get(event.id) ?? 'ordinary' : 'ordinary'
          return { ...event, reason, ticket,
            ...(pending ? { proposal: publicProposal(proposal) } : {}) }
        }
        if (req.method === 'GET' && path === 'messages') {
          const before = z.coerce.number().int().positive().safeParse(url.searchParams.get('before'))
          const group = url.searchParams.get('group')
          if (group && !conversationId.safeParse(group).success || !before.success) return respond(400, { error: '消息游标无效' })
          const rows = queue.page(before.data, group, 51)
          return respond(200, { events: rows.slice(0, 50).map(display), next: rows.length > 50 ? rows[49].cursor : null })
        }
        if (req.method === 'GET' && path === 'state') {
          const groups = queue.groups()
          const tickets = desk.tickets().slice(0, 100).map(ticket => ({
            id: ticket.id, title: ticket.title, evidence: evidence(queue.get(desk.origin(ticket).meta.eventId)),
            session: `worker-${ticket.id}`, ended: ticket.ended, attention: ticket.attention, assignments: ticket.assignments,
            inputs: reviews.inputs(ticket.id),
            deliveries: reviews.history(ticket.id).map(delivery => ({
              ...delivery, content: delivery.commit.length === 64 ? delivery.diff : null,
              file: delivery.commit.length === 64 ? 'outline.md' : null,
            })),
          }))
          const newest = queue.page(Number.MAX_SAFE_INTEGER, null, 51)
          const proposals = approvals.pending(queue.account()).map(proposal => ({ ...publicProposal(proposal),
            evidence: evidence(queue.get(proposal.eventId)) })).filter(proposal => proposal.evidence && proposal.evidence.status !== 'conflict')
          const events = newest.slice(0, 50).map(display)
          return respond(200, { groups, events, next: newest.length > 50 ? newest[49].cursor : null, tickets, account: queue.account(), availableGroups: state.groups?.account === queue.account() ? state.groups.list : [], connection: queue.health(),
            collection: state.collection, candidate: state.candidate, proposals, dispatch: {
              available: source.configured() && ctx.orchestrator.store.settings().eval.mode !== 'off' && Boolean(ctx.orchestrator.store.settings().eval.model),
              reason: '收件可用，DSSA 派工暂不可用',
              model: ctx.orchestrator.store.settings().eval.model?.model,
            },
            error: state.error, materials: Object.entries(config.materials ?? {}).map(([id, item]) => ({ id, name: item.name })),
          })
        }
        if (req.method === 'GET' && path === 'session') {
          const ticket = desk.tickets().find(item => item.id === url.searchParams.get('ticket'))
          if (!ticket) return respond(404, { error: '工单不存在' })
          const id = `worker-${ticket.id}`
          try {
            const data = await ctx.sessionController.inspect(id)
            const entries = (data.events ?? []).filter(item => item.type === 'assistant/message')
              .slice(-35).map(item => ({ role: 'assistant', text: (item.data?.message?.content ?? [])
                .filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 12000) })).filter(item => item.text)
            return respond(200, { id, ready: true, entries })
          } catch {
            return respond(200, { id, ready: false, entries: [] })
          }
        }
        if (req.method !== 'POST') return respond(404, { error: '未知操作' })
        const data = await readBody(req)
        if (path === 'groups') {
          if (queue.account() !== data.account) return respond(409, { error: 'QQ 账号已切换，请刷新群设置' })
          const input = groupInput.parse(data)
          return respond(200, queue.saveGroup(input))
        }
        if (path === 'approve-open') {
          const input = z.object({ eventId, version: z.string().min(1).max(120), action: z.enum(['approve', 'reject']) }).parse(data)
          if (!currentEvent(queue, input.eventId) || queue.account() !== data.account) return respond(409, { error: 'QQ 账号已切换，请刷新' })
          const result = approvals.decide(input.eventId, input.version, input.action)
          ctx.orchestrator.passes.request()
          return respond(200, { ticket: result.ticket })
        }
        if (path === 'open') {
          const input = z.object({ eventId, scope: text, materialIds: z.array(z.string().max(80)).max(10).default([]) }).parse(data)
          const existing = desk.ticketFor(input.eventId)
          if (existing) return respond(200, { ticket: existing })
          const event = queue.get(input.eventId)
          if (!currentEvent(queue, event?.id) || !assessable(event, queue.group(event.group_id))) {
            return respond(409, { error: '请确认来源消息、会话监听和发起人权限' })
          }
          if (approvals.get(event.id)) return respond(409, { error: '这条消息已有评估结果，请刷新查看' })
          if (input.materialIds.some(id => !Object.hasOwn(config.materials ?? {}, id))) return respond(400, { error: '选定资料不存在' })
          reviews.request(event.id, input.scope, input.materialIds)
          if (source.configured() && ctx.orchestrator.store.settings().eval.mode !== 'off' && Boolean(ctx.orchestrator.store.settings().eval.model)) await desk.receive(event, reviews.manualRequest(event.id))
          return respond(202, { queued: true })
        }
        const id = ticketId.parse(data.ticket)
        const ticket = desk.tickets().find(item => item.id === id)
        if (!ticket) return respond(404, { error: '工单不存在' })
        const original = queue.get(desk.origin(ticket).meta.eventId)
        if (path === 'decision') {
          const input = decision.parse(data)
          if (ticket.ended?.outcome !== 'completed') return respond(409, { error: '工单执行尚未结束' })
          if (input.action !== 'reject' && (original?.status === 'conflict'
            || reviews.qqChanges(ticket.id, input.version - 1).some(event => queue.get(event)?.status !== 'reply')
            || reviews.inputs(ticket.id).some(input => input.event && queue.get(input.event)?.status === 'conflict'))) {
            return respond(409, { error: 'QQ 来源待确认，当前只可拒绝交付' })
          }
          const current = reviews.current(id)
          if (input.action === 'approve' && current?.version === input.version && current.commit === input.commit && input.commit.length === 64) {
            try { work.verifyRecorded(ticket, input.commit) }
            catch { return respond(409, { error: '交付文件已变动，请重新生成' }) }
          }
          return respond(200, reviews.decide(input))
        }
        if (path === 'link') {
          const input = z.object({ eventId }).parse(data)
          const event = queue.get(input.eventId)
          if (!currentEvent(queue, event?.id) || !event?.text || event.status === 'conflict' || event.group_id !== original?.group_id) return respond(409, { error: '请选择同群且来源可确认的消息' })
          const existing = desk.ticketFor(event.id)
          if (existing && existing !== ticket.id || event.id === original.id) return respond(409, { error: '此消息已有工单' })
          reviews.addInput({ operation: `link-${event.id}`, ticket: id, event: event.id,
            text: `本机用户已关联 QQ 消息 ${event.message_id ?? event.id}。只在当前提纲的授权范围内采用。\n\n${event.text}` })
          return respond(202, { ticket: id })
        }
        if (path === 'supplement' || path === 'answer') {
          const input = z.object({ text, operation: z.uuid(), questionId: z.string().optional() }).parse(data)
          const earlier = reviews.input(input.operation)
          if (path === 'answer' && !earlier && (ticket.attention?.id !== input.questionId || ticket.ended)) return respond(409, { error: '澄清问题已变化' })
          reviews.addInput({ operation: input.operation, ticket: id, text: `本机用户补充：${input.text}` })
          return respond(202, { ticket: id })
        }
        return respond(404, { error: '未知操作' })
      } catch (error) {
        return respond(error.status ?? (error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500), { error: error.message })
      }
    } })
    return () => { api(); launch() }
  } catch (error) {
    launch()
    throw error
  }
}

export function apply(ctx) {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('工作区需要回环 Web 服务')
  const config = configOf()
  const runtime = ctx.orchestrator
  ctx.effect(() => {
    const queue = openQueue(config.queue)
    const controller = new AbortController()
    const state = { reasons: new Map(), collection: '等待收件', candidate: '等待 DSSA 评估', error: null }
    let reviews, policy, approvals, unbind, unregister, unregisterSource, source, desk, work
    function workspaceTitle(ticket) {
      if (!desk.owns(ticket)) return
      const group = desk.origin(ticket).meta.group
      if (!qqId.safeParse(group).success) return
      const knownGroups = state.groups?.account === queue.account() ? state.groups?.list : undefined
      return knownGroups?.find(item => item.id === group)?.name || queue.group(group)?.name
    }
    function release() {
      unregister?.()
      unbind?.()
      approvals?.dispose()
      policy?.dispose()
      unregisterSource?.()
      reviews?.close()
      queue.close()
    }
    try {
      reviews = openReviews(config.reviews)
      const kind = sourceKind(queue)
      unregisterSource = runtime.sources.register(kind)
      source = runtime.context(kind)
      approvals = bindApprovals(runtime, (trigger, previouslyAssessed) => policy.canAssess(trigger, previouslyAssessed))
      policy = bindPolicy(runtime, queue, reviews, approvals)
      desk = workspace(runtime, queue, reviews, policy, source)
      work = documentWork(config)
      unbind = bindExecution(runtime, work, reviews, queue, policy.authorized, config, workspaceTitle)
      unregister = registerApi(ctx, config, queue, reviews, work, source, desk, state, approvals)
    } catch (error) {
      release()
      throw error
    }

    async function processMessages() {
      if (controller.signal.aborted) return
      const dispatchReady = source.configured() && runtime.store.settings().eval.mode !== 'off' && Boolean(runtime.store.settings().eval.model)
      const account = queue.account()
      if (account && (!state.groups || state.groups.account !== account || Date.now() - state.groups.updated > 15_000)) {
        const cached = state.groups?.account === account ? state.groups.list : []
        const result = await napcatRequest(config, 'groups')
        const list = result.status === 200 && result.value.account === account ? result.value.groups.flatMap(group =>
          qqId.safeParse(String(group.group_id)).success && group.name ? [{ id: String(group.group_id), name: group.name }] : []) : result.status === 200 ? [] : cached
        if (account === queue.account()) state.groups = { account, updated: Date.now(), list }
      }
      const events = queue.events()
      const tickets = desk.tickets()
      const byEvent = new Map(tickets.map(ticket => [desk.origin(ticket).meta.eventId, ticket]))
      for (const event of events) {
        const group = queue.group(event.group_id)
        const grant = reviews.manualRequest(event.id)
        const trigger = makeTrigger(event, grant)
        const proposal = approvals.get(event.id)
        const decisionId = runtime.store.triggers.disposition(trigger.id)?.decisionId
        const result = decisionId && runtime.store.decisions.get(decisionId)
        let reason
        if (byEvent.has(event.id) || reviews.linked(event.id)) reason = 'dssa'
        else if (event.status === 'conflict') reason = 'needs_confirmation'
        else if (proposal?.status === 'pending') reason = 'pending_open'
        else if (proposal?.status === 'reject') reason = 'open_rejected'
        else if (!group?.enabled || event.received_at < group.enabledAt) reason = 'ordinary'
        else if (!eligible(event, group)) reason = 'sender_not_allowed'
        else if (!assessable(event, group) || result?.kind === 'unavailable') reason = 'needs_confirmation'
        else if (result?.kind === 'ignore') reason = grant ? 'needs_confirmation' : 'ordinary'
        else {
          reason = grant ? 'queued' : 'awaiting_candidate'
          if (dispatchReady) await desk.receive(event, grant)
        }
        state.reasons.set(event.id, reason)
      }
      let followupError
      for (const entry of ctx.workspaceRegistry.list()) {
        const ticket = runtime.store.tickets.get(entry.title)
        const title = workspaceTitle(ticket)
        if (title && title !== entry.title && entry.path === work.directoryFor(ticket.id)) {
          try { await entry.setTitle(title) } catch (error) { followupError ??= error.message }
        }
      }
      if (dispatchReady) {
        for (const input of reviews.pendingInputs()) {
          try {
            const ticket = runtime.store.tickets.get(input.ticket)
            if (!desk.owns(ticket)) continue
            if (input.event && queue.get(input.event)?.status === 'conflict') throw new Error('关联消息来源冲突')
            desk.attach(ticket, input.operation, input.text, true)
            reviews.deliverInput(input.operation)
          } catch (error) { followupError ??= error.message }
        }
        for (const revision of reviews.revisions()) {
          try {
            const ticket = runtime.store.tickets.get(revision.ticket)
            if (!desk.owns(ticket) || ticket.ended?.outcome !== 'completed') continue
            const events = reviews.qqChanges(ticket.id, revision.version)
            if (events.some(event => queue.get(event)?.status !== 'reply')) continue
            const user = revision.status === 'revise'
            desk.attach(ticket, `revise-${revision.version}`, `按原工单范围修订提纲。要求：${revision.note}`, user)
          } catch (error) { followupError ??= error.message }
        }
      }
      state.collection = queue.health().last_report ? '已收到群消息' : '等待收件'
      state.candidate = dispatchReady ? 'DSSA 评估可用' : 'DSSA 评估暂不可用'
      state.error = followupError ?? null
      source.report(sourceName, { state: state.error ? 'error' : 'ready', detail: state.error ?? state.collection })
    }
    const running = (async () => {
      await source.ready
      while (!controller.signal.aborted) {
        try { await processMessages() } catch (error) { state.error = error.message }
        await delay(1800, undefined, { signal: controller.signal }).catch(() => {})
      }
    })().catch(error => { if (!controller.signal.aborted) state.error = error.message })
    return async () => {
      controller.abort()
      await running
      release()
    }
  }, 'HNU workspace services')
}

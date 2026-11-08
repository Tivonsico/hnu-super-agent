window.__ModuleLoader__.load({
  id: 'hnu-companion',
  factory(require) {
    const { createElement: h, useEffect, useRef, useState } = require('react')
    const inject = ['slots', 'sessions', 'uiWorkspace', 'layout']
    const panel = 'hnu-companion'
    const brand = 'HNU Agent'
    const labels = {
      ordinary: '普通消息', observed: '观察中', waiting_candidate: '等待候选', awaiting_candidate: '等待候选',
      sender_not_allowed: '发起人未授权', needs_confirmation: '待确认', group_disabled: '监听已关闭',
      queued: '等待派工', dssa: '已送审', opened: '已建工单', continued: '已关联',
      pending: '待审核', approve: '已批准', approved: '已批准', revise: '已要求修改',
      reject: '已拒绝', superseded: '已被新版替代', 'qq-change': '需求已更新',
      completed: '已完成', failed: '执行失败', running: '执行中', ready: '已交付',
      observe: '仅观察', auto: '自动接单', off: '监听已关闭',
    }
    const roleNames = { owner: '群主', admin: '管理员', member: '成员' }
    const welcomeKey = 'hnu.workspace.welcome.v1'
    const storageKey = 'hnu.workspace.v1'
    const initial = { view: 'board', list: 'messages', group: '', filter: '', ticket: '', anchor: '' }
    function readSelection() {
      try {
        const inTab = sessionStorage.getItem(storageKey)
        return inTab ? { ...initial, ...JSON.parse(inTab) } : { ...initial, ...JSON.parse(localStorage.getItem(storageKey)), view: 'board' }
      } catch { return initial }
    }
    const styles = `
      .hnu { --line: color-mix(in srgb, currentColor 13%, transparent); --surface: color-mix(in srgb, currentColor 4%, transparent);
        --selected: color-mix(in srgb, #4878e6 15%, transparent); --muted: color-mix(in srgb, currentColor 68%, transparent);
        height:100%; min-width:0; display:flex; flex-direction:column; font-family:var(--dsh-font-family-text,inherit);
        font-size:14px; line-height:1.5; }
      .hnu *, .hnu *::before, .hnu *::after { box-sizing:border-box; }
      .hnu h1,.hnu h2,.hnu h3,.hnu p { margin:0; }
      .hnu h1 { font-size:22px; font-weight:650; letter-spacing:-.03em; }
      .hnu h2 { font-size:19px; font-weight:650; letter-spacing:-.02em; }
      .hnu h3 { font-size:15px; font-weight:620; overflow-wrap:anywhere; }
      .hnu button,.hnu input,.hnu textarea,.hnu select { font:inherit; color:inherit; }
      .hnu button,.hnu input:not([type=checkbox]),.hnu textarea,.hnu select { border:1px solid var(--line); border-radius:8px; padding:6px 10px; background:transparent; }
      .hnu textarea { width:100%; resize:vertical; min-height:65px; }
      .hnu input:not([type=checkbox]) { width:100%; }
      .hnu button { cursor:pointer; min-height:32px; }
      .hnu button:hover:not(:disabled),.hnu button[aria-pressed=true] { background:var(--surface); }
      .hnu button:disabled { cursor:default; opacity:.45; }
      .hnu button.hnu-primary { background:#3763cf; color:white; border-color:transparent; font-weight:550; }
      .hnu button.hnu-primary:hover:not(:disabled) { background:#2f57be; }
      .hnu button.hnu-quiet { border-color:transparent; }
      .hnu button.hnu-quiet[aria-pressed=true] { background:var(--selected); font-weight:620; }
      .hnu :focus-visible { outline:2px solid #658bf0; outline-offset:2px; }
      .hnu-head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; padding:18px 26px 12px; border-bottom:1px solid var(--line); }
      .hnu-brand,.hnu-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
      .hnu-nav { display:flex; flex-wrap:wrap; gap:4px; }
      .hnu-page { display:flex; flex-direction:column; gap:14px; overflow:auto; flex:1; padding:22px 26px 36px; min-height:0; }
      .hnu-stack { display:flex; flex-direction:column; gap:10px; min-width:0; }
      .hnu-between { justify-content:space-between; }
      .hnu-card { border:1px solid var(--line); border-radius:11px; padding:12px 14px; min-width:0; }
      .hnu-card[aria-current=true] { border-color:#658bf0; }
      .hnu-card details > summary { cursor:pointer; list-style-position:outside; margin:8px 0 0 12px; overflow-wrap:anywhere; }
      .hnu-card details[open] > summary { margin-bottom:10px; }
      .hnu-muted { color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
      .hnu-pill { font-size:12px; padding:2px 7px; border:1px solid var(--line); border-radius:6px; white-space:nowrap; }
      .hnu-pill[data-tone=pending] { background:color-mix(in srgb,#c78827 17%,transparent); }
      .hnu-pill[data-tone=active] { background:var(--selected); }
      .hnu-source { white-space:pre-wrap; overflow-wrap:anywhere; margin:0; padding:8px 12px; border-left:2px solid var(--line); }
      .hnu-form { display:grid; gap:9px; max-width:600px; }
      .hnu-form label { display:grid; gap:4px; }
      .hnu-form label.hnu-check { display:flex; align-items:center; gap:7px; }
      .hnu-alert { border:1px solid var(--line); border-radius:8px; padding:8px 12px; margin:10px 26px 0 !important; }
      .hnu-output { padding:12px; background:var(--surface); border-radius:8px; overflow-wrap:anywhere; max-height:360px; overflow:auto; }
      .hnu-output pre { white-space:pre-wrap; margin:0; }
      .hnu-output li + li,.hnu-output p + p { margin-top:4px; }
      .hnu-history { list-style:none; padding:0; margin:0; display:grid; gap:10px; max-height:350px; overflow:auto; }
      .hnu-history li { padding:8px 11px; background:var(--surface); border-radius:8px; min-width:0; }
      .hnu-history li p:last-child { white-space:pre-wrap; overflow-wrap:anywhere; }
      .hnu-chats { display:grid; grid-template-columns:minmax(150px,230px) minmax(0,1fr); gap:20px; min-height:0; flex:1; }
      .hnu-chat-list { overflow:auto; border-right:1px solid var(--line); padding-right:10px; }
      .hnu-chat-list button { display:block; width:100%; text-align:left; overflow-wrap:anywhere; }
      .hnu-chat-history { max-height:none; flex:1; }
      .hnu-chat-history li[data-own=true] { border-left:2px solid #658bf0; }
      .hnu-qr { display:block; width:186px; height:186px; max-width:100%; background:white; padding:6px; border-radius:6px; }
      .hnu-welcome { width:min(100%,730px); margin:24px auto; gap:13px; }
      .hnu-welcome h2 { font-size:clamp(22px,4vw,28px); }
      .hnu-welcome > p { max-width:60ch; }
      .hnu-welcome a { color:#4176e6; text-decoration:underline; }
      .hnu-welcome-steps { list-style:none; margin:5px 0; padding:0 14px; background:var(--surface); border:1px solid var(--line); border-radius:10px; }
      .hnu-welcome-steps > li + li { border-top:1px solid var(--line); }
      .hnu-welcome-steps .hnu-card { border:0; padding:14px 0; }
      @media (max-width:720px) {
        .hnu-head,.hnu-page { padding-inline:14px; }
        .hnu-alert { margin-inline:14px !important; }
        .hnu-chats { grid-template-columns:minmax(0,1fr); }
        .hnu-chat-list { max-height:175px; border-right:0; border-bottom:1px solid var(--line); }
      }
    `

    const dashboardStyles = `  .hnu-boardui {
    color-scheme: light dark;
    --background: #fff;
    --sidebar: #f5f6f7;
    --surface: #f9fafb;
    --text: #0f1115;
    --muted: #61666b;
    --border: #0000001a;
    --hover: #ebeef2;
    --accent: #4176e6;
    --selected: #e8efff;
    --selected-text: #254da2;
    --pending: #fef5e7;
    --pending-text: #855011;
  }

  @media (prefers-color-scheme: dark) {
    .hnu-boardui {
      --background: #151517;
      --sidebar: #232324;
      --surface: #232324;
      --text: #f9fafb;
      --muted: #adb2b8;
      --border: #ffffff1f;
      --hover: #353638;
      --accent: #7aaaff;
      --selected: #253450;
      --selected-text: #a8c7ff;
      --pending: #422f17;
      --pending-text: #ffca81;
    }
  }

  .hnu-boardui *, .hnu-boardui *::before, .hnu-boardui *::after { box-sizing: border-box; }
  .hnu-boardui [hidden] { display: none !important; }
  .hnu-boardui {
    margin: 0;
    background: var(--background);
    color: var(--text);
    font: 14px/1.65 var(--dsh-font-family-text, -apple-system), BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .hnu-boardui :is(h1,h2,h3,p,dl,dd,blockquote) { margin: 0; }
  .hnu-boardui button { font: inherit; }
  .hnu-boardui :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

   .hnu-boardui.shell {
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    min-height: 100%;
  }
   .hnu-boardui .sidebar{
    padding: 20px 12px;
    background: var(--sidebar);
    border-right: 1px solid var(--border);
  }
   .hnu-boardui .brand{
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 0 8px;
    font-weight: 650;
  }
   .hnu-boardui .brand svg{ flex: none; color: var(--accent); }
   .hnu-boardui .courses{ margin-top: 29px; }
   .hnu-boardui .courses h2{ padding: 0 8px 7px; color: var(--muted); font-size: 12px; font-weight: 550; }
   .hnu-boardui .course{
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    min-height: 36px;
    border: 0;
    border-radius: 7px;
    padding: 6px 9px;
    text-align: left;
    color: var(--text);
    background: transparent;
    cursor: pointer;
  }
   .hnu-boardui .course + .course{ margin-top: 3px; }
   .hnu-boardui .course:hover{ background: var(--hover); }
   .hnu-boardui .course[aria-pressed="true"]{ background: var(--selected); color: var(--selected-text); font-weight: 600; }
   .hnu-boardui .course-count{ font-size: 12px; font-variant-numeric: tabular-nums; }

  .hnu-boardui .board-main {
    width: min(100%, 1100px);
    margin-inline: auto;
    padding: clamp(22px, 4.5vw, 56px);
  }
   .hnu-boardui .page-title{ font-size: 26px; line-height: 1.2; letter-spacing: -.035em; }
   .hnu-boardui .list-heading{
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 23px 0 9px;
  }
   .hnu-boardui .list-heading h2{ font-size: 14px; font-weight: 650; }
   .hnu-boardui .list-heading span{ color: var(--muted); font-size: 12px; }

   .hnu-boardui .ticket{ border: 1px solid var(--border); border-radius: 12px; }
   .hnu-boardui .ticket-header{ padding: 18px 20px 14px; }
   .hnu-boardui .ticket-title{
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: flex-start;
    gap: 7px 12px;
  }
   .hnu-boardui .ticket-title h3{ font-size: clamp(17px, 2vw, 21px); line-height: 1.45; letter-spacing: -.02em; }
   .hnu-boardui .status{
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    background: var(--pending);
    color: var(--pending-text);
    border-radius: 5px;
    font-size: 12px;
    font-weight: 650;
    white-space: nowrap;
  }
   .hnu-boardui .status::before{ content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
   .hnu-boardui .fields{
    display: flex;
    flex-wrap: wrap;
    gap: 5px 20px;
    margin-top: 9px;
    font-size: 12px;
  }
   .hnu-boardui .fields > div{ display: flex; flex-wrap: wrap; gap: 5px; }
   .hnu-boardui .fields dt{ color: var(--muted); }
   .hnu-boardui .fields dd{ font-weight: 550; }
   .hnu-boardui .metadata{
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 0 10px;
    margin-top: 9px;
  }
   .hnu-boardui .metadata .fields{ margin-top: 0; }
   .hnu-boardui .metadata .secondary-fields{ grid-column: 1 / -1; margin-top: 7px; }
   .hnu-boardui .groups > summary, .hnu-boardui .metadata-toggle{
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 5px;
    margin: 0 -5px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    list-style: none;
    cursor: pointer;
  }
   .hnu-boardui .groups > summary:hover, .hnu-boardui .metadata-toggle:hover{ background: var(--hover); }
   .hnu-boardui .groups > summary::after, .hnu-boardui .metadata-toggle::after{
    content: "";
    width: 6px;
    height: 6px;
    flex: none;
    border: solid var(--muted);
    border-width: 0 1.5px 1.5px 0;
    transform: translateY(-1px) rotate(45deg);
  }
   .hnu-boardui .groups[open] > summary::after, .hnu-boardui .metadata-toggle[aria-expanded="true"]::after{
    transform: translateY(1px) rotate(225deg);
  }
   .hnu-boardui .metadata-toggle{ justify-content: center; width: 24px; height: 22px; margin: 0; }
   .hnu-boardui .group-extra{ margin-top: 3px; }

   .hnu-boardui .ticket > details{ border-top: 1px solid var(--border); }
   .hnu-boardui .ticket > details > summary{
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 42px;
    padding: 8px 20px;
    cursor: pointer;
    list-style: none;
    font-weight: 600;
  }
   .hnu-boardui summary::-webkit-details-marker{ display: none; }
   .hnu-boardui .ticket > details > summary::before{
    content: "";
    width: 7px;
    height: 7px;
    flex: none;
    border: solid var(--muted);
    border-width: 0 1.5px 1.5px 0;
    transform: rotate(-45deg);
    margin-right: 3px;
  }
   .hnu-boardui .ticket > details[open] > summary::before{ transform: rotate(45deg); }
   .hnu-boardui .ticket > details > summary:hover{ background: var(--surface); }
   .hnu-boardui .ticket > details > summary small{ margin-left: auto; color: var(--muted); font-size: 12px; font-weight: 400; }
   .hnu-boardui .detail-body{ padding: 4px 20px 16px 37px; }
   .hnu-boardui .source-list, .hnu-boardui .timeline{ list-style: none; padding: 0; margin: 0; }
   .hnu-boardui .source-list li + li{ margin-top: 9px; }
   .hnu-boardui .message{
    padding: 9px 12px;
    background: var(--surface);
    border-radius: 7px;
    overflow-wrap: anywhere;
  }
   .hnu-boardui .byline{ display: flex; flex-wrap: wrap; gap: 3px 10px; color: var(--muted); font-size: 12px; }
   .hnu-boardui .byline strong{ color: var(--text); font-weight: 600; }
   .hnu-boardui .message blockquote{ margin-top: 3px; }
   .hnu-boardui .approval dt{ margin-top: 6px; color: var(--muted); font-size: 12px; }
   .hnu-boardui .approval dd{ margin: 1px 0 5px; }
   .hnu-boardui .timeline li{
    position: relative;
    padding: 0 0 12px 15px;
    border-left: 1px solid var(--border);
  }
   .hnu-boardui .timeline li:last-child{ padding-bottom: 0; border-left-color: transparent; }
   .hnu-boardui .timeline li::before{
    content: "";
    position: absolute;
    top: 7px;
    left: -3px;
    width: 5px;
    height: 5px;
    background: var(--muted);
    border-radius: 50%;
  }
   .hnu-boardui .timeline li:last-child::before{ background: var(--accent); }
   .hnu-boardui .timeline p{ margin-top: 1px; }
   .hnu-boardui .empty{ padding: 21px 0; border-top: 1px solid var(--border); color: var(--muted); }

  @media (max-width: 680px) {
     .hnu-boardui.shell { grid-template-columns: minmax(0, 1fr); }
     .hnu-boardui .sidebar{ padding: 12px; border-right: 0; border-bottom: 1px solid var(--border); }
     .hnu-boardui .courses{ display: flex; flex-wrap: wrap; gap: 4px; margin-top: 10px; }
     .hnu-boardui .courses h2{ width: 100%; padding-bottom: 0; }
     .hnu-boardui .course{ width: auto; min-height: 32px; }
     .hnu-boardui .course + .course{ margin-top: 0; }
    .hnu-boardui .board-main { padding: 20px 12px; }
     .hnu-boardui .ticket-header{ padding-inline: 12px; }
     .hnu-boardui .ticket > details > summary{ padding-inline: 12px; }
     .hnu-boardui .detail-body{ padding-inline: 25px 12px; }
  }

      .hnu .hnu-boardui.shell { flex:1; }
      .hnu:has(.hnu-boardui) .hnu-page { padding:0; gap:0; }
      .hnu:has(.hnu-boardui) .hnu-head { justify-content:flex-end; }
      .hnu .hnu-boardui button.course { border:0; padding:6px 9px; text-align:left; }
      .hnu .hnu-boardui .course[aria-pressed=true] { background:var(--selected); color:var(--selected-text); }
      .hnu .hnu-boardui button.metadata-toggle { min-height:0; border:0; padding:0; }
      .hnu .hnu-boardui .ticket + .ticket,.hnu .hnu-boardui .hnu-card + .hnu-card { margin-top:10px; }
      .hnu .hnu-boardui .ticket .hnu-row { margin-top:8px; }
      .hnu .hnu-boardui .ticket .message .hnu-row { margin:0; }
      .hnu .hnu-boardui .status[data-tone=normal] { background:var(--selected); color:var(--selected-text); }
      .hnu .hnu-boardui .board-main > .hnu-row { margin-top:17px; }
`

    const button = (text, click, options = {}) => h('button', { type: 'button', onClick: click, ...options }, text)
    const pill = (text, tone) => h('span', { className: 'hnu-pill', 'data-tone': tone }, text)
    const status = code => labels[code] || code || '等待状态'
    const textOf = value => typeof value === 'string' ? value : ''
    const titleOf = event => textOf(event.text).trim().split(/\n/)[0].slice(0, 100) || '含附件的群消息'
    const attachmentName = item => typeof item === 'string' ? item : item.name || item.filename || item.type || '附件'
    const eventKey = event => event?.id || event?.eventId
    const ticketKey = value => typeof value === 'string' ? value : value?.id
    const groupName = (groups, id) => groups.find(group => String(group.id) === String(id))?.name || (id ? '群 ' + id : 'QQ 群')
    function timeOf(value) {
      if (!value) return ''
      const number = Number(value)
      const date = new Date(Number.isFinite(number) ? number < 1e12 ? number * 1000 : number : value)
      if (Number.isNaN(date.valueOf())) return ''
      return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
    }
    function ticketState(ticket) {
      const version = ticket.deliveries?.[0]
      if (version) return version.superseded ? 'superseded' : version.status
      return ticket.status || ticket.ended?.outcome || (ticket.assignments?.length ? 'running' : 'queued')
    }

    async function request(path, value, signal) {
      const response = await fetch('/hnu/api/' + path, {
        signal, credentials: 'same-origin', cache: 'no-store',
        ...(value !== undefined ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) } : {}),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || result.ok === false) {
        throw Object.assign(new Error(result.error || (response.status === 403 ? '请通过 HNU Agent 启动入口重新打开工作区。' : '请求失败（' + response.status + '）')),
          { status: response.status, data: result })
      }
      return result
    }

    function Source({ event, groups }) {
      if (!event) return null
      const name = event.name || event.sender_name || event.actor || '未知发件人'
      const timestamp = timeOf(event.sent_at || event.received_at || event.created_at)
      return h('div', { className: 'hnu-stack' },
        h('div', { className: 'hnu-row hnu-muted' },
          h('span', null, groupName(groups, event.group_id)), h('strong', null, name),
          event.role && roleNames[event.role] && h('span', null, roleNames[event.role]),
          timestamp && h('time', null, timestamp),
          event.message_id && h('span', null, '消息 ' + event.message_id)),
        h('blockquote', { className: 'hnu-source' }, event.text || '这条消息没有文本。'),
        Boolean(event.attachments?.length) && h('ul', { className: 'hnu-muted' },
          event.attachments.map((item, index) => h('li', { key: index }, attachmentName(item)))))
    }

    function MessageCard({ event, groups, tickets, materials, selection, select, act, openTicket }) {
      const [action, setAction] = useState('')
      const [scope, setScope] = useState('')
      const [target, setTarget] = useState('')
      const [materialIds, setMaterialIds] = useState([])
      const id = eventKey(event)
      const linked = ticketKey(event.ticket) || tickets.find(ticket => eventKey(ticket.evidence) === id || (ticket.evidence?.group_id === event.group_id && ticket.evidence?.message_id === event.message_id))?.id
      const reason = linked ? 'opened' : event.reason || event.status
      const group = groups.find(item => String(item.id) === String(event.group_id))
      const selectable = !linked && group?.enabled && event.status !== 'conflict' && Boolean(event.text)
      const choices = tickets.filter(ticket => String(ticket.evidence?.group_id) === String(event.group_id))
      const timestamp = timeOf(event.sent_at || event.received_at || event.created_at)
      return h('article', { id: 'hnu-event-' + id, className: 'hnu-card', 'aria-current': selection.anchor === id || undefined },
        h('div', { className: 'hnu-row hnu-between' },
          h('div', { className: 'hnu-row hnu-muted' },
            h('span', null, groupName(groups, event.group_id)), h('strong', null, event.name || event.actor || '未知发件人'),
            timestamp && h('time', null, timestamp)),
          pill(status(reason), reason === 'needs_confirmation' ? 'pending' : linked ? 'active' : undefined)),
        h('details', { open: selection.anchor === id, onToggle: e => {
          if (e.currentTarget.open && selection.anchor !== id) select({ anchor: id })
          if (!e.currentTarget.open && selection.anchor === id) select({ anchor: '' })
        } },
        h('summary', null, titleOf(event)),
        h('div', { className: 'hnu-stack' },
          h(Source, { event, groups }),
          h('div', { className: 'hnu-row' },
            linked && button('打开工单', () => openTicket(linked, id)),
            selectable && button('开单', () => setAction(action === 'open' ? '' : 'open')),
            selectable && choices.length > 0 && button('关联已有工单', () => setAction(action === 'link' ? '' : 'link'))),
          action === 'open' && selectable && h('form', { className: 'hnu-form', onSubmit: async e => {
            e.preventDefault()
            const value = await act('open', { eventId: id, scope: scope.trim(), materialIds })
            if (value) {
              setAction('')
              if (ticketKey(value.ticket) || value.ticketId) openTicket(ticketKey(value.ticket) || value.ticketId, id)
            }
          } },
          h('label', null, '允许执行的任务范围', h('textarea', { required: true, value: scope, onChange: e => setScope(e.target.value), placeholder: '例如：按原文列出一份 Markdown 征文提纲' })),
          materials?.length > 0 && h('fieldset', null, h('legend', null, '允许使用的资料'),
            ...materials.map(item => h('label', { className: 'hnu-check', key: item.id }, h('input', {
              type: 'checkbox', checked: materialIds.includes(item.id), onChange: e =>
                setMaterialIds(e.target.checked ? [...materialIds, item.id] : materialIds.filter(id => id !== item.id)),
            }), item.name))),
          h('div', null, h('button', { className: 'hnu-primary', disabled: !scope.trim() }, '确认开单'))),
          action === 'link' && selectable && h('form', { className: 'hnu-form', onSubmit: async e => {
            e.preventDefault()
            if (await act('link', { eventId: id, ticket: target })) {
              setAction('')
              openTicket(target, id)
            }
          } },
          h('label', null, '要关联的工单', h('select', { required: true, value: target, onChange: e => setTarget(e.target.value) },
            h('option', { value: '' }, '选择同群工单'), choices.map(ticket => h('option', { key: ticket.id, value: ticket.id }, ticket.title)))),
          h('div', null, h('button', { className: 'hnu-primary', disabled: !target }, '确认关联'))))))
    }

    function BoardTicket({ ticket, groups, events, openTicket }) {
      const [extra, setExtra] = useState(false)
      const original = ticket.evidence
      const group = groups.find(item => String(item.id) === String(original?.group_id))
      const stage = ticketState(ticket)
      const current = ticket.deliveries?.[0]
      const sources = [original, ...events.filter(event => ticketKey(event.ticket) === ticket.id
        && eventKey(event) !== eventKey(original))].filter(Boolean)
      const report = ticket.assignments?.at(-1)?.report
      const fields = [
        ...(group?.course ? [['课程', group.course]] : []),
        ...(original ? [['发起人', original.name || original.sender_name || original.actor]] : []),
        ...(original?.group_id ? [['群聊', 'QQ · ' + groupName(groups, original.group_id)]] : []),
      ].filter(([, value]) => value)
      return h('article', { className: 'ticket' },
        h('header', { className: 'ticket-header' },
          h('div', { className: 'ticket-title' }, h('h3', null, ticket.title),
            h('span', { className: 'status', 'data-tone': stage === 'pending' ? 'pending' : 'normal' }, status(stage))),
          original && h('div', { className: 'metadata' },
            h('dl', { className: 'fields' }, fields.map(([name, value]) =>
              h('div', { key: name }, h('dt', null, name), h('dd', null, value)))),
            button(null, () => setExtra(value => !value), { className: 'metadata-toggle', 'aria-expanded': extra, 'aria-label': '展开消息元数据' }),
            extra && h('dl', { className: 'fields secondary-fields' },
              original.actor && h('div', null, h('dt', null, '发起人 QQ'), h('dd', null, original.actor)),
              original.message_id && h('div', null, h('dt', null, '消息编号'), h('dd', null, original.message_id)),
              original.sent_at && h('div', null, h('dt', null, '发出时间'), h('dd', null, timeOf(original.sent_at)))))),
        sources.length > 0 && h('details', null,
          h('summary', null, '原始 QQ 记录', h('small', null, sources.length + ' 条')),
          h('div', { className: 'detail-body' },
            h('ol', { className: 'source-list' }, sources.map((event, index) =>
              h('li', { className: 'message', key: eventKey(event) || index },
                h('div', { className: 'byline' }, h('strong', null, event.name || event.sender_name || event.actor),
                  h('time', null, timeOf(event.sent_at || event.created_at))),
                h('blockquote', null, event.text || '这条消息没有文本。'),
                event.attachments?.length > 0 && h('p', { className: 'byline' }, '附件　' + event.attachments.map(attachmentName).join('、'))))))),
        h('details', null,
          h('summary', null, '审批详情'),
          h('div', { className: 'detail-body' }, h('dl', { className: 'approval' },
            h('dt', null, '当前状态'), h('dd', null, current ? status(current.status) : '等待交付'),
            current?.file && h('dt', null, '审核内容'), current?.file && h('dd', null, typeof current.file === 'string' ? current.file : current.file.name),
            current?.note && h('dt', null, '审核意见'), current?.note && h('dd', null, current.note)))),
        h('details', { open: true },
          h('summary', null, '工单会话'),
          h('div', { className: 'detail-body' },
            report?.summary && h('ol', { className: 'timeline' }, h('li', null,
              h('div', { className: 'byline' }, h('strong', null, 'Agent')), h('p', null, report.summary))),
            h('div', { className: 'hnu-row' }, button('查看具体会话', () => openTicket(ticket.id, eventKey(original)))))))
    }

    function Board({ state, selection, select, act, openTicket }) {
      const groups = state.groups || []
      const tickets = state.tickets || []
      const [older, setOlder] = useState([])
      const [cursor, setCursor] = useState(undefined)
      const [loading, setLoading] = useState(false)
      const [pageError, setPageError] = useState('')
      const recent = state.events || []
      const events = [...recent, ...older.filter(event => !recent.some(item => item.id === event.id))]
      const next = cursor === undefined ? state.next : cursor
      async function loadOlder() {
        if (!next || loading) return
        setLoading(true)
        setPageError('')
        try {
          const page = await request('messages?before=' + next)
          setOlder(previous => [...previous, ...page.events])
          setCursor(page.next)
        } catch (error) { setPageError(error.message) }
        finally { setLoading(false) }
      }
      const configured = new Map(groups.map(group => [String(group.id), group]))
      const onlineGroups = (state.availableGroups || []).map(group => {
        const id = String(group.id ?? group.group_id)
        return { ...group, ...configured.get(id), id }
      })
      const onlineIds = new Set(onlineGroups.map(group => group.id))
      const selectableGroups = [...onlineGroups, ...groups.filter(group => !onlineIds.has(String(group.id)) &&
        (group.enabled || String(group.id) === selection.group))]
      const selectedGroup = selectableGroups.find(group => String(group.id) === selection.group) || selectableGroups[0]
      const matchesGroup = id => Boolean(selectedGroup) && String(selectedGroup.id) === String(id)
      const showTickets = selection.list === 'tickets'
      const visibleTickets = tickets.filter(ticket => matchesGroup(ticket.evidence?.group_id) && (!selection.filter || ticketState(ticket) === selection.filter))
      const visibleMessages = events.filter(event => matchesGroup(event.group_id) && (!selection.filter ||
        (selection.filter === 'opened' ? Boolean(event.ticket) : (event.reason || event.status) === selection.filter)))
      const count = showTickets ? visibleTickets.length : visibleMessages.length
      const filters = showTickets ? ['pending', 'approve', 'revise', 'reject', 'running', 'queued'] :
        ['ordinary', 'needs_confirmation', 'sender_not_allowed', 'observed', 'opened']
      useEffect(() => {
        if (!selection.anchor || showTickets) return
        const element = document.getElementById('hnu-event-' + selection.anchor)
        if (element && (element.getBoundingClientRect().top < 0 || element.getBoundingClientRect().bottom > innerHeight)) {
          element.scrollIntoView({ block: 'nearest' })
        }
      }, [selection.anchor, count, showTickets])
      return h('div', { className: 'hnu-boardui shell' },
        h('style', null, dashboardStyles),
        h('aside', { className: 'sidebar' },
          h('div', { className: 'brand' },
            h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
              h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 4 }), h('path', { d: 'M8 8.5v7m8-7v7m-8-3.5h8' })),
            h('span', null, brand)),
          h('nav', { className: 'courses', 'aria-label': '按群筛选' },
            h('h2', null, 'QQ群'),
            selectableGroups.map(group => {
              const groupCount = (showTickets ? tickets.map(ticket => ticket.evidence) : events)
                .filter(event => String(event?.group_id) === String(group.id)).length
              return button(h('span', { className: 'hnu-row hnu-between', style: { width: '100%' } },
                h('span', null, group.course || group.name || '群 ' + group.id), h('span', { className: 'course-count' }, groupCount)),
              () => select({ group: String(group.id), anchor: '' }),
              { key: group.id, className: 'course', 'aria-pressed': selectedGroup?.id === group.id })
            }))),
        h('section', { className: 'board-main' },
          h('h2', { className: 'page-title' }, '消息大屏'),
          h('div', { className: 'hnu-row hnu-between' },
            h('div', { className: 'hnu-nav', 'aria-label': '消息视图' },
              button('新消息', () => select({ list: 'messages', filter: '' }), { className: 'hnu-quiet', 'aria-pressed': !showTickets }),
              button('工单', () => select({ list: 'tickets', filter: '' }), { className: 'hnu-quiet', 'aria-pressed': showTickets })),
            h('select', { 'aria-label': '筛选状态', value: selection.filter, onChange: e => select({ filter: e.target.value }) },
              h('option', { value: '' }, '全部状态'), ...filters.map(item => h('option', { key: item, value: item }, status(item))))),
          h('div', { className: 'list-heading' }, h('h2', null, showTickets ? '工单' : '新消息'),
            h('span', { 'aria-live': 'polite' }, count + (showTickets ? ' 张' : ' 条'))),
          !count && h('div', { className: 'empty' },
            h('p', null, !selectedGroup ? '尚未读取到 QQ 群' : !selectedGroup.enabled ? '这个群尚未开启监听'
              : showTickets ? '这个群暂无符合条件的工单' : '这个群暂无符合条件的新消息'),
            !selectedGroup?.enabled && h('div', { className: 'hnu-row' }, button('去权限设置', () => select({ view: 'settings' })))),
          showTickets ? visibleTickets.map(ticket => h(BoardTicket, { key: ticket.id, ticket, groups, events, openTicket }))
            : visibleMessages.map(event => h(MessageCard, { key: eventKey(event), event, groups, tickets, materials: state.materials, selection, select, act, openTicket })),
          !showTickets && next && selectedGroup && h('div', { className: 'hnu-row' }, button(loading ? '正在加载' : '加载更早消息', loadOlder, { disabled: loading })),
          pageError && h('p', { role: 'alert' }, pageError)))
    }

    const split = text => text.split(/[\s,，、]+/).map(part => part.trim()).filter(Boolean)
    function GroupForm({ group, save, show }) {
      const [draft, set] = useState(() => ({ ...group, roles: group.roles || ['owner', 'admin'],
        sendersText: (group.senders || []).map(sender => typeof sender === 'string' ? sender : sender.id).join('，'),
        keywordsText: (group.keywords || []).join('，') }))
      const update = (key, value) => set(old => ({ ...old, [key]: value }))
      return h('form', { className: 'hnu-card hnu-stack', onSubmit: async e => {
        e.preventDefault()
        await save('groups', { id: String(draft.id), name: draft.name, enabled: draft.enabled,
          mode: draft.mode || 'observe', roles: draft.roles, senders: split(draft.sendersText), keywords: split(draft.keywordsText), version: draft.version ?? 0 })
      } },
        h('div', { className: 'hnu-row hnu-between' },
          h('h3', null, group.name || '群 ' + group.id), pill(group.enabled ? status(group.mode) : '监听已关闭'),
          button('查看群消息', () => show(String(group.id)), { className: 'hnu-quiet' })),
        h('div', { className: 'hnu-form' },
          h('label', null, '群备注', h('input', { value: draft.name || '', onChange: e => update('name', e.target.value), maxLength: 80 })),
          h('label', { className: 'hnu-check' }, h('input', { type: 'checkbox', checked: Boolean(draft.enabled), onChange: e => update('enabled', e.target.checked) }), '监听此群'),
          h('label', null, '接单模式', h('select', { value: draft.mode === 'auto' ? 'auto' : 'observe', onChange: e => update('mode', e.target.value) },
            h('option', { value: 'observe' }, '仅观察'), h('option', { value: 'auto' }, '自动接单'))),
          h('div', { className: 'hnu-row', 'aria-label': '默认允许的角色' }, ...['owner', 'admin'].map(role =>
            h('label', { key: role, className: 'hnu-check' }, h('input', { type: 'checkbox', checked: draft.roles.includes(role), onChange: e =>
              update('roles', e.target.checked ? [...draft.roles, role] : draft.roles.filter(item => item !== role)) }), '允许' + roleNames[role] + '发起'))),
          h('label', null, '指定发起人 QQ 号', h('input', { value: draft.sendersText, onChange: e => update('sendersText', e.target.value), placeholder: '多个 QQ 号用逗号分隔' })),
          h('label', null, '触发关键词', h('input', { value: draft.keywordsText, onChange: e => update('keywordsText', e.target.value), placeholder: '可选，多个词用逗号分隔' }))),
        h('div', null, h('button', { className: 'hnu-primary' }, '保存群设置')))
    }

    function verifiedUrl(value) {
      if (typeof value !== 'string') return ''
      try {
        const url = new URL(value)
        if (url.username || url.password) return ''
        if (['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return url.href
        if (url.protocol === 'https:' && (url.hostname === 'napneko.github.io' || url.hostname === 'github.com' && url.pathname.startsWith('/NapNeko/'))) return url.href
      } catch { /* Invalid links stay hidden. */ }
      return ''
    }

    function ReportSetup() {
      const [config, setConfig] = useState(null)
      const [notice, setNotice] = useState('')
      async function reveal(event) {
        if (!event.currentTarget.open) {
          setConfig(null)
          setNotice('')
          return
        }
        try { setConfig(await request('napcat/report')) }
        catch (error) { setNotice(error.message) }
      }
      async function copy(value) {
        try {
          await navigator.clipboard.writeText(value)
          setNotice('已复制')
        } catch { setNotice('请选中字段手动复制。') }
      }
      return h('details', { onToggle: reveal },
        h('summary', null, '配置消息上报'),
        h('div', { className: 'hnu-form' },
          h('p', { className: 'hnu-muted' }, '在 NapCat 的 OneBot 网络配置中添加 HTTP 客户端。'),
          config?.url && h('div', { className: 'hnu-row' }, h('label', null, '上报地址', h('input', { value: config.url, readOnly: true })),
            button('复制地址', () => copy(config.url))),
          config?.token && h('div', { className: 'hnu-row' }, h('label', null, '上报令牌', h('input', { value: config.token, type: 'password', readOnly: true })),
            button('复制令牌', () => copy(config.token))),
          notice && h('p', { role: 'status' }, notice)))
    }

    function Settings({ state, select, act, setupOnly = false }) {
      const [connection, setConnection] = useState(null)
      const [listed, setListed] = useState([])
      const [qr, setQr] = useState('')
      const [problem, setProblem] = useState('')
      const [loginUrl, setLoginUrl] = useState('')
      const [installUrl, setInstallUrl] = useState('')
      const [connecting, setConnecting] = useState(false)
      const [connectionMessage, setConnectionMessage] = useState('')
      const connectionEpoch = useRef(0)
      const qrRefreshing = useRef(false)
      const [groupId, setGroupId] = useState('')
      const [name, setName] = useState('')
      async function loadQr(signal) {
        const epoch = connectionEpoch.current
        try {
          const image = await request('napcat/qrcode', undefined, signal)
          if (epoch === connectionEpoch.current && !signal?.aborted) presentQr(image)
        } catch (error) {
          if (error.status !== 404) throw error
          if (epoch === connectionEpoch.current && !signal?.aborted) setQr('')
        }
      }
      function presentQr(image) {
        setQr(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image.qrcode || '') ? image.qrcode : '')
      }
      async function changeQr() {
        if (qrRefreshing.current) return
        qrRefreshing.current = true
        connectionEpoch.current++
        setProblem('')
        setQr('')
        setConnecting(true)
        try {
          presentQr(await request('napcat/refresh-qrcode', {}))
        } catch (error) {
          setProblem(error.message)
        } finally {
          qrRefreshing.current = false
          setConnecting(false)
        }
        try { await refresh() }
        catch (error) { setProblem(error.message) }
      }
      function accountMismatch(result) {
        const bound = result?.boundAccount || state.account?.id || state.account
        return Boolean(result?.online && result.user_id && String(result.user_id) !== String(bound || ''))
      }
      function present(result) {
        setConnection(result)
        if (result.stage !== 'waiting_qr') setQr('')
        if (accountMismatch(result) || !result.online) setListed([])
        const management = verifiedUrl(result.login_url || result.management_url || result.managementUrl)
        const install = verifiedUrl(result.install_url || result.installUrl)
        setLoginUrl(management)
        setInstallUrl(install)
      }
      async function refresh(signal) {
        if (qrRefreshing.current) return
        const epoch = connectionEpoch.current
        const result = await request('napcat/status', undefined, signal)
        if (epoch !== connectionEpoch.current || signal?.aborted) return
        present(result)
        if (result.online && !accountMismatch(result)) {
          const { groups } = await request('napcat/groups', undefined, signal).catch(error => {
            if (error.status === 503 && !result.report_ready) return { groups: [] }
            throw error
          })
          if (epoch !== connectionEpoch.current || signal?.aborted) return
          setListed(groups || [])
          if (result.online) setQr('')
        } else if (result.stage === 'waiting_qr') await loadQr(signal)
      }
      useEffect(() => {
        const abort = new AbortController()
        let timer
        const poll = async () => {
          try { await refresh(abort.signal) }
          catch (error) { if (!abort.signal.aborted) setProblem(error.message) }
          if (!abort.signal.aborted) timer = setTimeout(poll, 4500)
        }
        poll()
        return () => { abort.abort(); clearTimeout(timer) }
      }, [])
      async function connect(path = 'connect') {
        connectionEpoch.current++
        setProblem('')
        setConnectionMessage('')
        setConnecting(true)
        try {
          const next = await request('napcat/' + path, {})
          present(next)
          if (next.instruction) setConnectionMessage(next.instruction)
          if (path === 'setup') {
            if (Array.isArray(next.groups)) setListed(next.groups)
            setConnectionMessage('群消息连接已配置。可在权限设置里选择监听群。')
          } else if (path !== 'switch') {
            if (next.online) await refresh()
            else if (next.stage === 'waiting_qr') await loadQr()
          }
        } catch (error) {
          setProblem(error.message)
          if (error.data) present(error.data)
        }
        finally { setConnecting(false) }
      }
      const groups = accountMismatch(connection) ? [] : state.groups || []
      const visible = [...groups, ...listed.filter(remote => !groups.some(group => String(group.id) === String(remote.group_id)))
        .map(remote => ({ id: String(remote.group_id), name: remote.name, enabled: false, mode: 'observe', version: 0 }))]
      const show = group => select({ group, view: 'board', list: 'messages', filter: '', anchor: '' })
      const last = timeOf(state.connection?.last_message)
      const stages = { waiting_qr: '等待扫码', waiting_login: '等待手机确认', original_qq: '已安装 · QQ 仍用原版入口',
        stopped: 'NapCat 未运行', not_installed: '等待安装 NapCat',
        running_no_api: '管理接口未连通', offline: '已离线', duplicate_login: '此 QQ 已在桌面登录' }
      const requiresLaunch = ['original_qq', 'stopped', 'not_installed'].includes(connection?.stage)
      const canRefreshQr = ['waiting_qr', 'duplicate_login'].includes(connection?.stage)
      return h('div', { className: 'hnu-stack' },
        !setupOnly && h('h2', null, '权限设置'),
        !setupOnly && h(ModelSetup),
        h('section', { className: 'hnu-card hnu-stack', 'aria-label': 'QQ 连接' },
          h('div', { className: 'hnu-row hnu-between' }, h('h3', null, 'QQ 连接'),
            pill(connection?.online ? '已登录' : (stages[connection?.stage] || '尚未确认登录'), connection?.online ? 'active' : undefined)),
          connection?.user_id && h('p', { className: 'hnu-muted' }, [connection.nickname, 'QQ ' + connection.user_id].filter(Boolean).join(' · ')),
          !setupOnly && h('div', { className: 'hnu-row' },
            pill(last ? '最近收信 ' + last : '尚无收件'),
            pill(state.candidate || '候选提取等待中'),
            pill(state.dispatch?.available ? '派工可用' : '派工暂不可用')),
          h('div', { className: 'hnu-row' },
            canRefreshQr && button('换一个二维码', changeQr, { className: 'hnu-primary', disabled: connecting }),
            !connection?.online && !requiresLaunch && !canRefreshQr && connection?.stage !== 'waiting_login'
              && button('登录 QQ', () => connect(), { className: 'hnu-primary', disabled: connecting }),
            accountMismatch(connection)
              && button('使用此 QQ', () => connect('account'), { className: 'hnu-primary', disabled: connecting }),
            connection?.online && !connection.report_ready && !accountMismatch(connection)
              && button('接入群消息', () => connect('setup'), { className: 'hnu-primary', disabled: connecting }),
            connection?.online && button('切换 QQ 账号', () => connect('switch'), { disabled: connecting }),
            button(setupOnly ? '刷新连接' : '刷新连接和群列表', () => refresh().then(() => setProblem('')).catch(error => setProblem(error.message)))),
          connection?.report_ready && h('p', { className: 'hnu-muted' }, '已接入群消息。'),
          connectionMessage && h('p', { role: 'status' }, connectionMessage),
          qr && h('img', { className: 'hnu-qr', src: qr, alt: 'QQ 登录二维码' }),
          loginUrl && h('a', { href: '/hnu/api/napcat/webui', target: '_blank', rel: 'noreferrer' }, '打开本机 QQ 登录窗口'),
          installUrl && h('a', { href: installUrl, target: '_blank', rel: 'noreferrer' }, '安装 NapCat'),
          (problem || connection?.error) && h('p', { role: 'alert' }, problem || connection.error),
          !setupOnly && h(ReportSetup)),
        !setupOnly && h('h3', null, '群监听与发起权限'),
        !setupOnly && visible.map(group => h(GroupForm, { key: group.id + ':' + group.version, group, save: act, show })),
        !setupOnly && h('details', { className: 'hnu-card' },
          h('summary', null, '按群号添加'),
          h('form', { className: 'hnu-form', onSubmit: async e => {
            e.preventDefault()
            if (await act('groups', { id: groupId.trim(), name: name.trim() || '群 ' + groupId.trim(),
              enabled: false, mode: 'observe', roles: ['owner', 'admin'], senders: [], keywords: [], version: 0 })) {
              setGroupId('')
              setName('')
            }
          } }, h('label', null, 'QQ群号', h('input', { value: groupId, required: true, inputMode: 'numeric', pattern: '[0-9]+', onChange: e => setGroupId(e.target.value) })),
          h('label', null, '群备注', h('input', { value: name, onChange: e => setName(e.target.value), maxLength: 80 })),
          h('div', null, h('button', { className: 'hnu-primary' }, '添加群')))))
    }

    function ModelSetup() {
      const [model, setModel] = useState(null)
      const [error, setError] = useState('')
      const [apiKey, setKey] = useState('')
      const [choice, setChoice] = useState('')
      const [saving, setSaving] = useState(false)
      useEffect(() => {
        const abort = new AbortController()
        request('model', undefined, abort.signal).then(value => {
          if (!abort.signal.aborted) setModel(value)
        }, failure => {
          if (!abort.signal.aborted) setError(failure.message)
        })
        return () => abort.abort()
      }, [])
      async function save(event) {
        event.preventDefault()
        setError('')
        setSaving(true)
        try {
          const selected = model.models?.find(item => item.provider + ':' + item.id === choice)
          const value = await request('model', { apiKey: apiKey.trim(), ...(selected ? { model: selected.id, provider: selected.provider } : {}) })
          setKey('')
          setModel(value.configured === undefined ? await request('model') : value)
        } catch (failure) { setError(failure.message) }
        finally { setSaving(false) }
      }
      const selection = typeof model?.selected === 'string' ? model.selected : model?.selected?.name || model?.selected?.id || model?.selected?.model
      return h('section', { className: 'hnu-card hnu-stack', 'aria-label': '模型配置' },
        h('div', { className: 'hnu-row hnu-between' }, h('h3', null, '模型配置'), model?.configured && pill('已配置', 'active')),
        error && h('p', { role: 'alert' }, error),
        !model && !error && h('p', { className: 'hnu-muted' }, '正在检查 DSH 模型'),
        model?.configured && h('p', { className: 'hnu-muted' }, selection || '使用 DSH 已配置的模型'),
        model && !model.configured && h('form', { className: 'hnu-form', onSubmit: save },
          h('label', null, 'DeepSeek API Key', h('input', { type: 'password', autoComplete: 'off', required: true, value: apiKey, onChange: event => setKey(event.target.value) })),
          h('a', { href: 'https://platform.deepseek.com/api_keys', target: '_blank', rel: 'noreferrer' }, '创建 API Key'),
          h('label', null, '选择模型', h('select', { value: choice, onChange: event => setChoice(event.target.value) },
            h('option', { value: '' }, selection || '使用默认模型'),
            model.models?.map(item => h('option', { key: item.provider + ':' + item.id, value: item.provider + ':' + item.id }, item.name || item.id)))),
          h('div', null, h('button', { className: 'hnu-primary', disabled: saving || !apiKey.trim() }, '保存模型配置'))))
    }

    function Welcome({ state, select, act, finish }) {
      return h('section', { className: 'hnu-welcome hnu-stack', 'aria-label': '快速开始' },
        h('h2', null, '欢迎使用 HNU Agent'),
        h('p', { className: 'hnu-muted' }, '连接模型与 QQ 后，在消息大屏查看群消息和交付。'),
        h('ol', { className: 'hnu-welcome-steps' },
          h('li', null, h(ModelSetup)),
          h('li', null, h(Settings, { state, select, act, setupOnly: true }))),
        h('div', { className: 'hnu-row' },
          button('进入消息大屏', finish, { className: 'hnu-primary' }),
          button('暂时跳过', finish, { className: 'hnu-quiet' })))
    }

    function Markdown({ content }) {
      const inline = value => value.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return h('strong', { key: index }, part.slice(2, -2))
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return h('code', { key: index }, part.slice(1, -1))
        return part
      })
      return h('div', { className: 'hnu-output' }, content.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) return h(heading[1].length === 1 ? 'h3' : 'h4', { key: index }, inline(heading[2]))
        return h('p', { key: index, style: { whiteSpace: 'pre-wrap' } }, inline(line.replace(/^\s*[-*]\s+/, '• ')))
      }))
    }
    function saveFile(name, content) {
      const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
      const link = document.createElement('a')
      link.download = typeof name === 'string' ? name.split(/[\\/]/).at(-1) : 'outline.md'
      link.href = url
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 500)
    }

    function transcriptRows(entries) {
      return entries.flatMap(({ event }) => {
        if (event?.type !== 'assistant/message') return []
        const message = event.data?.message
        const content = typeof message?.content === 'string' ? message.content
          : (message?.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n')
        if (!content.trim()) return []
        return [{ key: event.seq, role: 'Agent', time: event.time, text: content.slice(0, 4000) }]
      }).slice(-24)
    }

    function SessionHistory({ ctx, session, ticket }) {
      const [rows, setRows] = useState([])
      const [waiting, setWaiting] = useState(true)
      const [error, setError] = useState('')
      useEffect(() => {
        if (!session) return
        const abort = new AbortController()
        let reference
        let unsubscribe
        let retry
        const fallback = async () => {
          try {
            const value = await request('session?ticket=' + encodeURIComponent(ticket), undefined, abort.signal)
            if (abort.signal.aborted) return
            setWaiting(!value.ready)
            setRows((value.entries || []).map((entry, index) => ({ key: index, role: 'Agent', text: entry.text })))
          } catch (failure) {
            if (!abort.signal.aborted) {
              setError(failure.message)
              setWaiting(false)
            }
          }
          if (!abort.signal.aborted) retry = setTimeout(fallback, 2500)
        }
        const attach = async () => {
          try {
            await ctx.sessions.refresh()
            if (abort.signal.aborted) return
            if (!ctx.sessions.list.getSnapshot().byId[session]) {
              retry = setTimeout(attach, 1500)
              return
            }
            if (typeof ctx.sessions.retain !== 'function') return fallback()
            reference = ctx.sessions.retain(session, { source: 'hnuWorkspace', signal: abort.signal })
            const binding = await reference.ready
            if (abort.signal.aborted) return
            const source = binding.eventSource
            if (!source?.getSnapshot) return fallback()
            const update = () => setRows(transcriptRows(source.getSnapshot()?.entries || []))
            unsubscribe = source.subscribe(update)
            update()
            setWaiting(false)
          } catch {
            if (!abort.signal.aborted) fallback()
          }
        }
        attach()
        return () => { abort.abort(); clearTimeout(retry); unsubscribe?.(); reference?.release() }
      }, [ctx, session, ticket])
      return h('section', { className: 'hnu-card hnu-stack', 'aria-label': 'DSH 会话记录' },
        h('h3', null, 'DSH 会话记录'),
        (error || waiting || !rows.length) && h('p', { className: 'hnu-muted' },
          error || (waiting ? '等待会话记录' : '会话还没有消息。')),
        rows.length > 0 && h('ol', { className: 'hnu-history', 'aria-label': '工单对话' }, rows.map(row =>
          h('li', { key: row.key }, h('div', { className: 'hnu-row hnu-muted' }, h('strong', null, row.role),
            h('time', null, timeOf(row.time))), h('p', null, row.text)))))
    }

    function Detail({ ctx, ticket, groups, select, act, openNative }) {
      const [note, setNote] = useState('')
      const [reply, setReply] = useState('')
      const [pending, setPending] = useState(false)
      const operation = useRef(null)
      if (!ticket) return h('div', { className: 'hnu-card hnu-stack' }, h('p', null, '从消息看板选择一张工单。'),
        h('div', null, button('回到消息看板', () => select({ view: 'board' }))))
      const original = ticket.evidence
      const latest = ticket.deliveries?.[0]
      const report = ticket.assignments?.at(-1)?.report
      const connected = ticket.session
      async function send(path, value) {
        if (pending) return
        setPending(true)
        try { return await act(path, value) }
        finally { setPending(false) }
      }
      async function supplement() {
        const path = ticket.attention ? 'answer' : 'supplement'
        const signature = JSON.stringify([path, ticket.attention?.id, reply.trim()])
        if (operation.current?.signature !== signature) operation.current = { signature, id: crypto.randomUUID() }
        if (await send(path, { ticket: ticket.id, ...(ticket.attention ? { questionId: ticket.attention.id } : {}),
          text: reply.trim(), operation: operation.current.id })) {
          operation.current = null
          setReply('')
        }
      }
      return h('div', { className: 'hnu-stack' },
        h('div', { className: 'hnu-row' }, button('返回看板', () => select({ view: 'board' }), { className: 'hnu-quiet' })),
        h('div', { className: 'hnu-row hnu-between' },
          h('h2', null, ticket.title), pill(status(ticketState(ticket)), latest?.status === 'pending' ? 'pending' : 'active')),
        h('div', { className: 'hnu-row' },
          connected ? button('打开 DSH 会话', () => openNative(ticket), { className: 'hnu-primary' }) : h('span', { className: 'hnu-muted' }, '等待会话创建'),
          original && button('查看来源消息', () => select({ view: 'board', list: 'messages', group: String(original.group_id), filter: '', anchor: eventKey(original) || '' }))),
        original && h('section', { className: 'hnu-card hnu-stack', 'aria-label': '来源消息' }, h('h3', null, '来源消息'), h(Source, { event: original, groups })),
        report?.summary && h('section', { className: 'hnu-card hnu-stack', 'aria-label': '执行进度' }, h('h3', null, '执行进度'), h('p', null, report.summary)),
        connected && h(SessionHistory, { key: connected, ctx, session: connected, ticket: ticket.id }),
        ticket.inputs?.length > 0 && h('details', { className: 'hnu-card' }, h('summary', null, '补充与关联记录'),
          ...ticket.inputs.map(input => h('p', { key: input.operation, style: { whiteSpace: 'pre-wrap' } }, input.text))),
        ticket.deliveries?.map((delivery, index) => {
          const content = typeof delivery.content === 'string' ? delivery.content : delivery.content?.text
          return h('section', { key: delivery.version, className: 'hnu-card hnu-stack', 'aria-label': '交付 v' + delivery.version },
            h('div', { className: 'hnu-row hnu-between' },
              h('h3', null, '交付 v' + delivery.version), pill(status(delivery.superseded ? 'superseded' : delivery.status),
                delivery.status === 'pending' ? 'pending' : undefined)),
            delivery.file && h('p', { className: 'hnu-muted' }, typeof delivery.file === 'string' ? delivery.file : delivery.file.name),
            h('details', { open: index === 0 }, h('summary', null, '预览交付'),
              content ? h(Markdown, { content }) : h('div', { className: 'hnu-output' }, h('pre', null, delivery.diff || '未附预览内容'))),
            content && h('div', null, button('下载 Markdown', () => saveFile(delivery.file?.name || delivery.file, content))),
            delivery.note && h('p', { className: 'hnu-muted' }, delivery.note),
            delivery.reviewer && h('p', { className: 'hnu-muted' }, '审核者：' + delivery.reviewer + (delivery.superseded ? ' · ' + status(delivery.status) : '')),
            index === 0 && delivery.status === 'pending' && h('div', { className: 'hnu-form' },
              h('label', null, '审核意见', h('textarea', { value: note, maxLength: 1500, onChange: e => setNote(e.target.value), placeholder: '要求修改时填写意见' })),
              h('div', { className: 'hnu-row' },
                ...[['approve', '批准交付'], ['revise', '要求修改'], ['reject', '拒绝']].map(([action, name]) =>
                  button(name, async () => {
                    if (await send('decision', { ticket: ticket.id, version: delivery.version, commit: delivery.commit, action, note: note.trim() })) setNote('')
                  }, { key: action, className: action === 'approve' ? 'hnu-primary' : '', disabled: pending || (action === 'revise' && !note.trim()) })))))
        }),
        h('form', { className: 'hnu-card hnu-form', onSubmit: e => { e.preventDefault(); supplement() } },
          h('h3', null, ticket.attention ? '答复澄清问题' : '补充要求'),
          ticket.attention && h('p', null, ticket.attention.question),
          h('textarea', { 'aria-label': ticket.attention ? '答复' : '补充要求', value: reply, maxLength: 1500, onChange: e => setReply(e.target.value) }),
          h('div', null, h('button', { disabled: pending || !reply.trim() }, '发送到 DSH 会话'))))
    }

    function QQHistory({ chat }) {
      const [rows, setRows] = useState([])
      const [before, setBefore] = useState(undefined)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const controller = useRef(null)
      function merge(messages) {
        setRows(current => [...new Map([...current, ...messages].map(row => [row.id, row])).values()]
          .sort((a, b) => a.time - b.time))
      }
      async function read(cursor, signal) {
        const query = new URLSearchParams({ kind: chat.kind, id: chat.id })
        if (cursor) query.set('before', cursor)
        return request('napcat/history?' + query, undefined, signal)
      }
      useEffect(() => {
        const abort = new AbortController()
        controller.current = abort
        let timer
        async function poll() {
          try {
            const page = await read(undefined, abort.signal)
            if (abort.signal.aborted) return
            merge(page.messages)
            setBefore(cursor => cursor === undefined ? page.next : cursor)
            setError('')
          } catch (failure) {
            if (!abort.signal.aborted) {
              if (failure.status === 409) setRows([])
              setError(failure.message)
            }
          }
          if (!abort.signal.aborted) timer = setTimeout(poll, 4000)
        }
        poll()
        return () => { abort.abort(); clearTimeout(timer) }
      }, [])
      async function older() {
        const signal = controller.current?.signal
        setLoading(true)
        try {
          const page = await read(before, signal)
          if (!signal?.aborted) { merge(page.messages); setBefore(page.next) }
        } catch (failure) {
          if (!signal?.aborted) setError(failure.message)
        } finally {
          if (!signal?.aborted) setLoading(false)
        }
      }
      return h('section', { className: 'hnu-stack', 'aria-label': chat.name },
        h('h3', null, chat.name),
        error && h('p', { role: 'alert' }, error),
        before && h('div', null, button('加载更早消息', older, { disabled: loading })),
        !rows.length && !error && h('p', { className: 'hnu-muted' }, before === undefined ? '正在读取消息' : '暂无消息'),
        h('ol', { className: 'hnu-history hnu-chat-history', 'aria-label': '聊天记录' },
          rows.map(row => h('li', { key: row.id, 'data-own': row.own },
            h('p', { className: 'hnu-muted' }, row.own ? '我' : row.sender, ' ', timeOf(row.time)),
            h('p', null, row.text || '[消息]')))))
    }

    function QQConversations({ account, select }) {
      const [chats, setChats] = useState(null)
      const [filter, setFilter] = useState('')
      const [selected, setSelected] = useState('')
      const [error, setError] = useState('')
      const [refresh, setRefresh] = useState(0)
      const key = chat => chat.kind + ':' + chat.id
      useEffect(() => {
        if (!account) return
        const abort = new AbortController()
        request('napcat/conversations', undefined, abort.signal).then(result => {
          if (!abort.signal.aborted) { setChats(result.conversations); setError('') }
        }, failure => {
          if (!abort.signal.aborted) { setError(failure.message); setChats([]) }
        })
        return () => abort.abort()
      }, [account, refresh])
      if (!account) return h('section', { className: 'hnu-stack' },
        h('h2', null, 'QQ 会话'), h('p', null, '连接 QQ 后查看群聊和私聊。'),
        h('div', null, button('去权限设置', () => select({ view: 'settings' }))))
      const query = filter.trim().toLocaleLowerCase()
      const visible = (chats || []).filter(chat => !query || chat.id.includes(query) || chat.name.toLocaleLowerCase().includes(query))
      const chat = (chats || []).find(chat => key(chat) === selected)
      return h('section', { className: 'hnu-stack', style: { flex: 1 } },
        h('div', { className: 'hnu-row hnu-between' }, h('h2', null, 'QQ 会话'),
          button('刷新会话', () => setRefresh(value => value + 1))),
        error && h('p', { role: 'alert' }, error),
        h('div', { className: 'hnu-chats' },
          h('nav', { className: 'hnu-stack hnu-chat-list', 'aria-label': 'QQ 会话列表' },
            h('input', { 'aria-label': '搜索 QQ 会话', placeholder: '搜索群聊或私聊', value: filter, onChange: event => setFilter(event.target.value) }),
            !visible.length && !error && h('p', { className: 'hnu-muted' }, chats ? '没有匹配的会话' : '正在读取会话'),
            visible.map(item => button(h('span', null, item.name, h('small', { className: 'hnu-muted' }, item.kind === 'group' ? ' · 群聊' : ' · 私聊')),
              () => setSelected(key(item)), { key: key(item), className: 'hnu-quiet', 'aria-pressed': selected === key(item) }))),
          chat ? h(QQHistory, { key: key(chat), chat }) : h('p', { className: 'hnu-muted' }, '选择会话查看消息')))
    }

    function Panel({ ctx }) {
      const [selection, setSelection] = useState(readSelection)
      const [welcome, setWelcome] = useState(() => {
        try { return localStorage.getItem(welcomeKey) !== 'done' } catch { return true }
      })
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [message, setMessage] = useState('')
      const mounted = useRef(false)
      const seq = useRef(0)
      function select(change) {
        setSelection(old => {
          const next = { ...old, ...change }
          try {
            sessionStorage.setItem(storageKey, JSON.stringify(next))
            localStorage.setItem(storageKey, JSON.stringify(next))
          } catch { /* storage unavailable */ }
          return next
        })
      }
      async function refresh(signal) {
        const id = ++seq.current
        const next = await request('state', undefined, signal)
        if (mounted.current && id === seq.current) setState(next)
      }
      useEffect(() => {
        mounted.current = true
        const abort = new AbortController()
        let timer
        const update = async () => {
          try { await refresh(abort.signal) }
          catch (failure) { if (!abort.signal.aborted) setError(failure.message) }
          if (!abort.signal.aborted) timer = setTimeout(update, 1800)
        }
        update()
        return () => { mounted.current = false; abort.abort(); clearTimeout(timer) }
      }, [])
      useEffect(() => {
        if (!message) return
        const timer = setTimeout(() => setMessage(''), 3000)
        return () => clearTimeout(timer)
      }, [message])
      async function act(path, input) {
        setError('')
        setMessage('')
        try {
          const result = await request(path, { ...input, account: state?.account ?? null })
          if (mounted.current) {
            setMessage(path === 'open' ? '已提交开单' : path === 'link' ? '已关联' : '已保存')
            await refresh()
          }
          return result
        } catch (failure) {
          if (mounted.current) setError(failure.message)
        }
      }
      function openTicket(id, anchor) {
        select({ view: 'detail', ticket: id, anchor: anchor || selection.anchor })
      }
      async function openNative(ticket) {
        try {
          await ctx.sessions.refresh()
          if (!ctx.sessions.list.getSnapshot().byId[ticket.session]) throw new Error('等待会话创建，请稍后再打开。')
          select({ view: 'board' })
          ctx.uiWorkspace.openSession(ticket.session)
        } catch (failure) { setError(failure.message) }
      }
      function finishWelcome() {
        try { localStorage.setItem(welcomeKey, 'done') } catch { /* storage unavailable */ }
        setWelcome(false)
        select({ view: 'board' })
      }
      const ticket = state?.tickets?.find(ticket => ticket.id === selection.ticket)
      const nav = [['board', '消息大屏'], ['qq', 'QQ 会话'], ['settings', '权限设置'], ['detail', '具体会话']]
      return h('main', { className: 'hnu' },
        h('style', null, styles),
        h('header', { className: 'hnu-head' },
          (!state || welcome || selection.view !== 'board') && h('div', { className: 'hnu-brand' }, h('h1', null, brand)),
          !welcome && h('nav', { className: 'hnu-nav', 'aria-label': brand },
            ...nav.map(([view, label]) => button(label, () => select({ view }), { key: view, className: 'hnu-quiet', 'aria-pressed': selection.view === view })))),
        error && h('p', { className: 'hnu-alert', role: 'alert' }, error),
        message && h('p', { className: 'hnu-alert', role: 'status' }, message),
        state && h('div', { className: 'hnu-page' },
          (state.error || state.dispatch?.available === false || state.dispatch?.ready === false) &&
            h('p', { className: 'hnu-muted', role: 'status' }, state.error || state.dispatch.reason || '收件可用，派工暂不可用。'),
          welcome ? h(Welcome, { state, select, act, finish: finishWelcome })
            : selection.view === 'settings' ? h(Settings, { state, select, act })
            : selection.view === 'qq' ? h(QQConversations, { key: state.account, account: state.account, select })
            : selection.view === 'detail' ? h(Detail, { key: selection.ticket, ctx, ticket, groups: state.groups || [], select, act, openNative })
            : h(Board, { key: state.account, state, selection, select, act, openTicket })),
        !state && !error && h('p', { className: 'hnu-alert', role: 'status' }, '正在加载工作区'))
    }

    function apply(ctx) {
      ctx.slots.inject('main', () => {
        const registration = ctx.slots.register({ name: 'main', key: panel, inject: () => ({}) }, () => h(Panel, { ctx }))
        if (sessionStorage.getItem('hnu.workspace.launch') === '1') {
          let attempts = 0
          function open() {
            if (document.querySelector('.hnu')) return
            try { ctx.layout.selectPanel(panel) } catch { /* Wait for DSH layout initialization. */ }
            if (++attempts < 30) setTimeout(open, 100)
          }
          queueMicrotask(open)
        }
        return registration
      })
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: panel, order: 11, label: () => brand,
      }, ({ size }) => h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'aria-hidden': true },
        h('path', { d: 'M4 5h16v11H9l-5 4V5zm4 5h8m-8 3h5', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }))))
    }

    return { apply, inject }
  },
})

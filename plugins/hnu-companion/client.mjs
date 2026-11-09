window.__ModuleLoader__.load({
  id: 'hnu-companion',
  factory(require) {
    const { createElement: h, Fragment, useEffect, useRef, useState } = require('react')
    const { Button } = require('@deepseek-ai/dsh-client-ui-primitives')
    const inject = ['slots', 'sessions', 'uiWorkspace', 'layout']
    const panel = 'hnu-companion'
    const brand = 'HNU Agent'
    const labels = {
      ordinary: '普通消息', observed: '观察中', waiting_candidate: '等待评估', awaiting_candidate: '等待评估',
      pending_open: '待审核开单', open_rejected: '已拒绝开单',
      sender_not_allowed: '发起人未授权', needs_confirmation: '待确认', group_disabled: '监听已关闭',
      queued: '等待派工', dssa: '已送审', opened: '已建工单', continued: '已关联',
      pending: '待审核', approve: '已批准', approved: '已批准', revise: '已要求修改',
      reject: '已拒绝', superseded: '已被新版替代', 'qq-change': '需求已更新',
      completed: '已完成', failed: '执行失败', running: '执行中', ready: '已交付',
      observe: '仅观察', auto: '自动送审', off: '监听已关闭',
    }
    const roleNames = { owner: '群主', admin: '管理员', member: '成员' }
    const welcomeKey = 'hnu.workspace.welcome.v1'
    const storageKey = 'hnu.workspace.v1'
    const initial = { view: 'board', list: 'messages', group: '', filter: '', ticket: '', anchor: '', locate: '' }
    const ticketSelection = (ticket, group) => ({ view: 'board', list: 'tickets', ticket, group, locate: '' })
    function readSelection() {
      try {
        const inTab = sessionStorage.getItem(storageKey)
        const saved = JSON.parse(inTab || localStorage.getItem(storageKey))
        if (saved?.view === 'detail') return { ...initial, ...saved, view: 'board', list: 'tickets', group: '' }
        return { ...initial, ...saved, view: inTab ? saved?.view ?? 'board' : 'board' }
      } catch { return initial }
    }
    function saveSelection(selection) {
      try {
        const value = JSON.stringify(selection)
        sessionStorage.setItem(storageKey, value)
        localStorage.setItem(storageKey, value)
      } catch { /* storage unavailable */ }
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
      .hnu .hnu-delivery { padding:0; }
      .hnu .hnu-delivery > summary { display:flex; align-items:center; justify-content:space-between; min-height:40px;
        padding:6px 14px; margin:0; list-style:none; cursor:pointer; font-weight:620; }
      .hnu-delivery > summary::-webkit-details-marker { display:none; }
      .hnu-delivery > summary::after { content:""; width:7px; height:7px; margin-right:2px;
        border:solid var(--muted); border-width:0 1.5px 1.5px 0; transform:rotate(45deg); }
      .hnu-delivery[open] > summary::after { transform:rotate(225deg); }
      .hnu-delivery-body { padding:0 14px 12px; }
      .hnu .hnu-permission-row { padding:0; }
      .hnu .hnu-permission-row > summary { display:grid; grid-template-columns:minmax(0,1fr) auto auto minmax(6em,auto) 8px;
        gap:clamp(5px,1.4vw,16px); align-items:center; min-height:42px; padding:7px 12px; margin:0; list-style:none; cursor:pointer; }
      .hnu-permission-row > summary::-webkit-details-marker { display:none; }
      .hnu-permission-row > summary::after { content:""; width:7px; height:7px; border:solid var(--muted);
        border-width:0 1.5px 1.5px 0; transform:rotate(45deg); }
      .hnu-permission-row[open] > summary::after { transform:rotate(225deg); }
      .hnu-permission-name { font-weight:620; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .hnu-permission-row > summary .hnu-muted { white-space:nowrap; }
      .hnu-permission-row > form.hnu-card { border:0; border-radius:0; border-top:1px solid var(--line); }
      .hnu-permission-list { display:grid; gap:6px; }
      .hnu-permission-section > summary { cursor:pointer; padding:7px 12px; }
      .hnu-permission-section[open] > summary { margin-bottom:6px; }
      @media (max-width:560px) { .hnu-permission-roles { display:none; } }
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
      .hnu-page.hnu-conversation-page { overflow:hidden; padding:0; gap:0; }
      .hnu-conversation-page > [role=status] { padding:4px 16px; }
      .hnu-chats { display:grid; grid-template-columns:minmax(150px,230px) minmax(0,1fr); gap:0; min-height:0; flex:1; overflow:hidden; }
      .hnu-chat-list { overflow:auto; min-height:0; border-right:1px solid var(--line); padding:12px 10px; background:var(--surface); }
      .hnu-chat-list button { display:block; width:100%; text-align:left; overflow-wrap:anywhere; }
      .hnu-chat-list-header { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:8px; }
      .hnu-chat-list-header h2 { white-space:nowrap; }
      .hnu-chat-list .hnu-chat-list-header button { width:auto; text-align:center; }
      .hnu-chat-right { min-width:0; min-height:0; overflow:auto; padding:18px 22px 30px; }
      .hnu-chat-list .hnu-conversation-row { display:flex; align-items:center; justify-content:space-between; gap:7px; }
      .hnu-conversation-row span:first-child { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .hnu-chat-list h3 { font-size:12px; color:var(--muted); padding:5px 8px; }
      .hnu-chat-assistant { border-block:1px solid var(--line); }
      .hnu-chat-assistant > summary { display:flex; align-items:center; justify-content:space-between; cursor:pointer;
        min-height:36px; padding:5px 10px; list-style:none; font-weight:620; }
      .hnu-chat-assistant > summary::-webkit-details-marker { display:none; }
      .hnu-chat-assistant > summary::after { content:""; width:7px; height:7px; margin-right:2px;
        border:solid var(--muted); border-width:0 1.5px 1.5px 0; transform:rotate(45deg); }
      .hnu-chat-assistant[open] > summary::after { transform:rotate(225deg); }
      .hnu-chat-assistant > div { padding:0 0 4px 8px; }
      .hnu-chat-unread { font-size:12px; font-variant-numeric:tabular-nums; }
      .hnu-chat-unread[data-muted=true] { color:var(--muted); }
      .hnu-chat-right .hnu-card { max-width:900px; }
      .hnu-chat-right .hnu-msg-image { display:block; max-width:min(100%,360px); max-height:320px; object-fit:contain; border-radius:8px; }
      .hnu-chat-tabs { position:sticky; top:-18px; z-index:1; padding:10px 0; background:var(--background,#fff); }
      @media (prefers-color-scheme:dark) { .hnu-chat-tabs { background:var(--background,#151517); } }
      .hnu-help { position:relative; border:1px solid var(--line); border-radius:50%; width:22px; height:22px; text-align:center; }
      .hnu-help [role=tooltip] { display:none; position:absolute; z-index:5; left:0; bottom:26px; width:min(280px,70vw); padding:9px 12px; border-radius:6px; background:#252930; color:#fff; text-align:left; }
      .hnu-help:hover [role=tooltip], .hnu-help:focus [role=tooltip] { display:block; }
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
        .hnu-chats { grid-template-columns:minmax(0,1fr); grid-template-rows:auto minmax(0,1fr); }
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

   .hnu-boardui .ticket{ border: 1px solid var(--border); border-radius: 12px; scroll-margin-top: 48px; }
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
   .hnu-boardui .source-list{ list-style: none; padding: 0; margin: 0; }
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
        throw Object.assign(new Error(result.error || '请求失败（' + response.status + '）'),
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

    function MessageImage({ event, index }) {
      const [failed, setFailed] = useState(false)
      if (failed) return h('span', { className: 'hnu-muted' }, '原图暂不可用')
      const privateChat = event.group_id.startsWith('private:')
      const query = new URLSearchParams({ kind: privateChat ? 'private' : 'group',
        id: privateChat ? event.group_id.slice(8) : event.group_id, message: event.message_id, index: String(index) })
      return h('img', { className: 'hnu-msg-image', src: '/hnu/api/qq-image?' + query,
        alt: 'QQ 消息图片', loading: 'lazy', onError: () => setFailed(true) })
    }

    function OpeningReview({ proposal, groupId, act, openTicket, showSource }) {
      const [busy, setBusy] = useState(false)
      async function review(action) {
        if (busy) return
        setBusy(true)
        try {
          const result = await act('approve-open', { eventId: proposal.eventId, version: proposal.version, action })
          if (result?.ticket) openTicket(result.ticket, groupId)
        } finally { setBusy(false) }
      }
      return h('section', { className: 'hnu-card hnu-stack', 'aria-label': '待审核开单' },
        h('div', { className: 'hnu-row hnu-between' }, h('h3', null, proposal.title), pill('待审核开单', 'pending')),
        h('p', null, proposal.scope),
        proposal.reason && h('p', { className: 'hnu-muted' }, proposal.reason),
        h('div', { className: 'hnu-row' },
          button('批准开单并执行', () => review('approve'), { className: 'hnu-primary', disabled: busy }),
          button('拒绝开单', () => review('reject'), { disabled: busy }),
          showSource && button('查看来源消息', showSource, { className: 'hnu-quiet' })))
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
      const allowed = group?.enabled && event.received_at >= group.enabledAt
        && (group.roles.includes(event.role) || group.senders.includes(event.actor))
      const selectable = !event.historyOnly && !linked && !event.proposal && reason !== 'open_rejected' && allowed
        && event.status !== 'conflict' && Boolean(event.message_id && event.sent_at && (event.text || event.attachments?.some(item => item.type === 'image')))
      const choices = tickets.filter(ticket => String(ticket.evidence?.group_id) === String(event.group_id))
      const timestamp = timeOf(event.sent_at || event.received_at || event.created_at)
      const imageCount = Math.min(30, Math.max(event.images || 0, (event.attachments || []).filter(item => item.type === 'image').length))
      return h('article', { id: 'hnu-event-' + id, className: 'hnu-card', 'aria-current': selection.anchor === id || undefined },
        h('div', { className: 'hnu-row hnu-between' },
          h('div', { className: 'hnu-row hnu-muted' },
            h('span', null, groupName(groups, event.group_id)), h('strong', null, event.name || event.actor || '未知发件人'),
            timestamp && h('time', null, timestamp)),
          pill(status(reason), ['needs_confirmation', 'pending_open'].includes(reason) ? 'pending' : linked ? 'active' : undefined)),
        event.message_id && imageCount > 0 && h('div', { className: 'hnu-stack', style: { marginTop: 8 } },
          Array.from({ length: imageCount }, (_, index) => h(MessageImage, { key: index, event, index }))),
        h('details', { open: selection.anchor === id, onToggle: e => {
          if (e.currentTarget.open && selection.anchor !== id) select({ anchor: id })
          if (!e.currentTarget.open && selection.anchor === id) select({ anchor: '' })
        } },
        h('summary', null, titleOf(event)),
        h('div', { className: 'hnu-stack' },
          h(Source, { event, groups }),
          event.proposal && h(OpeningReview, { proposal: event.proposal, groupId: event.group_id, act, openTicket }),
          h('div', { className: 'hnu-row' },
            linked && button('打开工单', () => openTicket(linked, event.group_id)),
            selectable && button('开单', () => setAction(action === 'open' ? '' : 'open')),
            selectable && choices.length > 0 && button('关联已有工单', () => setAction(action === 'link' ? '' : 'link'))),
          action === 'open' && selectable && h('form', { className: 'hnu-form', onSubmit: async e => {
            e.preventDefault()
            const value = await act('open', { eventId: id, scope: scope.trim(), materialIds })
            if (value) {
              setAction('')
              if (ticketKey(value.ticket) || value.ticketId) openTicket(ticketKey(value.ticket) || value.ticketId, event.group_id)
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
              openTicket(target, event.group_id)
            }
          } },
          h('label', null, '要关联的工单', h('select', { required: true, value: target, onChange: e => setTarget(e.target.value) },
            h('option', { value: '' }, '选择同群工单'), choices.map(ticket => h('option', { key: ticket.id, value: ticket.id }, ticket.title)))),
          h('div', null, h('button', { className: 'hnu-primary', disabled: !target }, '确认关联'))))))
    }

    function BoardTicket({ ctx, ticket, groups, events, expanded, selected, select, act, openNative }) {
      const [extra, setExtra] = useState(false)
      const card = useRef(null)
      useEffect(() => {
        if (selected) card.current?.scrollIntoView({ block: 'nearest' })
      }, [selected])
      const original = ticket.evidence
      const group = groups.find(item => String(item.id) === String(original?.group_id))
      const stage = ticketState(ticket)
      const sources = [original, ...events.filter(event => ticketKey(event.ticket) === ticket.id
        && eventKey(event) !== eventKey(original))].filter(Boolean)
      const fields = [
        ...(group?.course ? [['课程', group.course]] : []),
        ...(original ? [['发起人', original.name || original.sender_name || original.actor]] : []),
        ...(original?.group_id ? [['群聊', 'QQ · ' + groupName(groups, original.group_id)]] : []),
      ].filter(([, value]) => value)
      return h('article', { className: 'ticket', ref: card },
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
        h('details', { open: expanded },
          h('summary', { onClick: event => {
            event.preventDefault()
            select({ group: original.group_id, ticket: expanded ? null : ticket.id })
          } }, '工单会话'),
          expanded && h('div', { className: 'detail-body' }, h(TicketContent, { ctx, ticket, select, act, openNative }))))
    }

    const split = text => text.split(/[\s,，、]+/).map(part => part.trim()).filter(Boolean)
    const chatKey = chat => chat.kind === 'group' ? chat.id : 'private:' + chat.id
    const inAssistant = chat => chat.kind === 'group' && chat.assistant
    const pinnedGroup = chat => chat.kind === 'group' && chat.pinned && !inAssistant(chat)
    const chatSections = chats => ({ pinned: chats.filter(pinnedGroup), assistant: chats.filter(inAssistant),
      ordinary: chats.filter(chat => !pinnedGroup(chat) && !inAssistant(chat)) })
    const groupSettings = (chat, saved) => saved.find(group => group.id === chatKey(chat)) ?? {
      id: chatKey(chat), name: chat.name, version: 0, enabled: false, roles: chat.kind === 'private' ? [] : ['owner', 'admin'],
      senders: chat.kind === 'private' ? [chat.id] : [], mode: 'observe',
    }
    function findChat(chats, key) {
      const recent = chats.filter(chat => chat.recent)
      return chats.find(chat => chatKey(chat) === key) || recent.find(pinnedGroup) || recent.find(chat => !inAssistant(chat)) || recent[0]
    }
    function readHistory(chat, before, signal) {
      const query = new URLSearchParams({ kind: chat.kind, id: chat.id })
      if (before) query.set('before', before)
      return request('napcat/history?' + query, undefined, signal)
    }
    function GroupForm({ group, save, show, compact = false }) {
      const isPrivate = group.id.startsWith('private:')
      const [draft, set] = useState(() => ({ ...group, ttlMinutes: group.ttlMinutes ?? 30, roles: group.roles || ['owner', 'admin'],
        sendersText: (group.senders || []).map(sender => typeof sender === 'string' ? sender : sender.id).join('，') }))
      const [listen, setListen] = useState(null)
      const enabled = listen?.wasEnabled === group.enabled ? listen.enabled : group.enabled
      const update = (key, value) => set(old => ({ ...old, [key]: value }))
      return h('form', { className: 'hnu-card hnu-stack', onSubmit: async e => {
        e.preventDefault()
        await save('groups', { id: String(draft.id), name: draft.name, enabled, wasEnabled: group.enabled,
          mode: draft.mode || 'observe', ttlMinutes: Number(draft.ttlMinutes), roles: draft.roles,
          senders: split(draft.sendersText), version: draft.version ?? 0 })
      } },
        !compact && h('div', { className: 'hnu-row hnu-between' },
          h('h3', null, group.name || '群 ' + group.id), pill(group.enabled ? '监听中' : '监听已关闭')),
        h('div', { className: 'hnu-form' },
          h('label', null, isPrivate ? '会话备注' : '群备注', h('input', { value: draft.name || '', onChange: e => update('name', e.target.value), maxLength: 80 })),
          h('label', { className: 'hnu-check' }, h('input', { type: 'checkbox', checked: enabled,
            onChange: e => setListen({ wasEnabled: group.enabled, enabled: e.target.checked }) }), isPrivate ? '监听此会话' : '监听此群'),
          h('label', null, '监听时长（分钟）', h('input', { type: 'number', min: 1, max: 1440, step: 1,
            required: true, value: draft.ttlMinutes, onChange: e => update('ttlMinutes', e.target.value) })),
          group.enabled && h('span', { className: 'hnu-muted' }, timeOf(group.expiresAt) + ' 自动关闭 · 开单需人工审核'),
          !isPrivate && h('div', { className: 'hnu-row', 'aria-label': '默认允许的角色' }, ...['owner', 'admin'].map(role =>
            h('label', { key: role, className: 'hnu-check' }, h('input', { type: 'checkbox', checked: draft.roles.includes(role), onChange: e =>
              update('roles', e.target.checked ? [...draft.roles, role] : draft.roles.filter(item => item !== role)) }), '允许' + roleNames[role] + '发起'))),
          h('label', null, '指定发起人 QQ 号', h('input', { value: draft.sendersText, onChange: e => update('sendersText', e.target.value), placeholder: '多个 QQ 号用逗号分隔' }))),
        h('div', { className: 'hnu-row' }, h('button', { className: 'hnu-primary' }, '保存会话设置'),
          show && button(isPrivate ? '查看私聊' : '查看群消息', () => show(String(group.id)), { className: 'hnu-quiet' })))
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

    function PermissionRow({ chat, group, refreshCount, save, show }) {
      const [visited, setVisited] = useState(false)
      const [count, setCount] = useState(null)
      const needsCount = group.enabled && Boolean(group.roles?.length || group.senders?.length)
      useEffect(() => {
        if (!needsCount) return
        const abort = new AbortController()
        setCount(null)
        request('napcat/permissions?' + new URLSearchParams({ id: group.id }), undefined, abort.signal)
          .then(value => { if (!abort.signal.aborted) setCount(value.count) }, () => {
            if (!abort.signal.aborted) setCount(undefined)
          })
        return () => abort.abort()
      }, [group.id, group.version, needsCount, refreshCount])
      const roles = (group.roles || []).map(role => roleNames[role]).filter(Boolean)
      const permission = !needsCount ? '0 人可发起' : count === null ? '统计中…' : count === undefined ? '人数暂不可用' : count + ' 人可发起'
      return h('details', { className: 'hnu-card hnu-permission-row', onToggle: event => {
        if (event.currentTarget.open) setVisited(true)
      } },
      h('summary', null,
        h('span', { className: 'hnu-permission-name', title: chat.name }, chat.name),
        pill(group.enabled ? '监听中' : '未监听', group.enabled ? 'active' : undefined),
        h('span', { className: 'hnu-muted' }, group.enabled ? '人工审核' : '—'),
        h('span', { className: 'hnu-muted' }, group.enabled && roles.length > 0 && h('span', { className: 'hnu-permission-roles' }, roles.join('、') + ' · '), permission)),
      visited && h(GroupForm, { key: group.version, group, save, show, compact: true }))
    }

    function PermissionList({ chats, groups, refreshCount, save, show }) {
      const { pinned, assistant, ordinary } = chatSections(chats.filter(chat => chat.recent))
      const render = items => h('div', { className: 'hnu-permission-list' }, items.map(chat => h(PermissionRow, {
        key: chatKey(chat), chat, group: groupSettings(chat, groups), refreshCount, save, show,
      })))
      const other = chats.filter(chat => !chat.recent)
      return h(Fragment, null,
        pinned.length > 0 && h('section', { className: 'hnu-stack', 'aria-label': '置顶群聊' }, h('h4', null, '置顶群聊'), render(pinned)),
        assistant.length > 0 && h('details', { className: 'hnu-permission-section' }, h('summary', null, '群助手'), render(assistant)),
        ordinary.length > 0 && h('section', { 'aria-label': '最近会话' }, render(ordinary)),
        other.length > 0 && h('details', { className: 'hnu-permission-section' }, h('summary', null, '其他会话'), render(other)))
    }

    function Settings({ state, select, act, chats, chatError, syncQQ, setupOnly = false }) {
      const [connection, setConnection] = useState(null)
      const [qr, setQr] = useState('')
      const [problem, setProblem] = useState('')
      const [installUrl, setInstallUrl] = useState('')
      const [connecting, setConnecting] = useState(false)
      const [refreshing, setRefreshing] = useState(false)
      const [refreshCount, setRefreshCount] = useState(0)
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
        const install = verifiedUrl(result.install_url || result.installUrl)
        setInstallUrl(install)
      }
      async function refresh(signal) {
        if (qrRefreshing.current) return
        const epoch = connectionEpoch.current
        const result = await request('napcat/status', undefined, signal)
        if (epoch !== connectionEpoch.current || signal?.aborted) return
        present(result)
        if (result.stage === 'waiting_qr') await loadQr(signal)
        return result
      }
      async function refreshConnection() {
        connectionEpoch.current++
        setProblem('')
        setConnectionMessage('')
        setRefreshing(true)
        try {
          const result = await refresh()
          if (!result) return
          if (!result.online) setConnectionMessage('已刷新连接，QQ 当前离线。')
          else if (accountMismatch(result)) setConnectionMessage('已刷新连接，请确认使用当前 QQ 账号。')
          else {
            const refreshedHistory = await syncQQ?.(result.boundAccount)
            setRefreshCount(count => count + 1)
            setConnectionMessage(refreshedHistory ? '已刷新连接、会话列表和当前消息。' : setupOnly ? '已刷新 QQ 连接。' : '已刷新连接和会话列表。')
          }
        } catch (error) { setProblem(error.message) }
        finally { setRefreshing(false) }
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
      const show = group => select({ group, view: 'board', list: 'messages', filter: '', anchor: '', ticket: '', locate: '' })
      const last = timeOf(state.connection?.last_message)
      const stages = { waiting_qr: '等待扫码', waiting_login: '等待手机确认', original_qq: '已安装 · QQ 仍用原版入口',
        stopped: 'NapCat 未运行', not_installed: '等待安装 NapCat',
        running_no_api: '管理接口未连通', offline: '已离线', duplicate_login: '此 QQ 已在桌面登录' }
      const canStart = ['stopped', 'offline'].includes(connection?.stage)
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
            pill(state.candidate || '等待 DSSA 评估'),
            pill(state.dispatch?.available ? '派工可用' : '派工暂不可用')),
          h('div', { className: 'hnu-row' },
            canRefreshQr && button('换一个二维码', changeQr, { className: 'hnu-primary', disabled: connecting }),
            canStart && button('扫码 · 只登录 Agent', () => connect('start?mode=agent'), { disabled: connecting }),
            canStart && button('扫码 · 同时登录客户端', () => connect('start?mode=desktop'), { className: 'hnu-primary', disabled: connecting }),
            accountMismatch(connection)
              && button('使用此 QQ', () => connect('account'), { className: 'hnu-primary', disabled: connecting }),
            connection?.online && !connection.report_ready && !accountMismatch(connection)
              && button('接入群消息', () => connect('setup'), { className: 'hnu-primary', disabled: connecting }),
            connection?.online && button('切换 QQ 账号', () => connect('switch'), { disabled: connecting || refreshing }),
            button(refreshing ? '正在刷新…' : '刷新连接', refreshConnection, { disabled: connecting || refreshing })),
          connection?.report_ready && h('p', { className: 'hnu-muted' }, '已接入群消息。'),
          connectionMessage && h('p', { role: 'status' }, connectionMessage),
          qr && h('img', { className: 'hnu-qr', src: qr, alt: 'QQ 登录二维码' }),
          installUrl && h('div', { className: 'hnu-row' },
            h('a', { href: installUrl, target: '_blank', rel: 'noreferrer' }, '下载 NapCat 安装器'),
            h('span', { className: 'hnu-help', tabIndex: 0, 'aria-describedby': 'hnu-napcat-help' }, '？',
              h('span', { id: 'hnu-napcat-help', role: 'tooltip' }, '解压并打开安装器。安装 NapCat 后切换程序入口，回来刷新连接。想同时使用桌面 QQ，先运行项目里的「启动桌面 QQ」。'))),
          (problem || connection?.error) && h('p', { role: 'alert' }, problem || connection.error)),
        !setupOnly && h('h3', null, '会话监听与权限管理'),
        !setupOnly && chatError && h('p', { role: 'alert' }, chatError),
        !setupOnly && !accountMismatch(connection) && h(PermissionList, {
          key: state.account, chats: chats || [], groups: state.groups, refreshCount, save: act, show,
        }),
        !setupOnly && h('details', { className: 'hnu-card' },
          h('summary', null, '按群号添加'),
          h('form', { className: 'hnu-form', onSubmit: async e => {
            e.preventDefault()
            if (await act('groups', { id: groupId.trim(), name: name.trim() || '群 ' + groupId.trim(),
              enabled: false, mode: 'observe', roles: ['owner', 'admin'], senders: [], version: 0 })) {
              setGroupId('')
              setName('')
            }
          } }, h('label', null, 'QQ群号', h('input', { value: groupId, required: true, inputMode: 'numeric', pattern: '[0-9]+', onChange: e => setGroupId(e.target.value) })),
          h('label', null, '群备注', h('input', { value: name, onChange: e => setName(e.target.value), maxLength: 80 })),
          h('div', null, h('button', { className: 'hnu-primary' }, '添加群')))))
    }

    function ModelSetup({ setupOnly = false }) {
      const [model, setModel] = useState(null)
      const [error, setError] = useState('')
      const [message, setMessage] = useState('')
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
        setMessage('')
        setSaving(true)
        try {
          const selected = model.models.find(item => item.provider + ':' + item.id === choice)
          const key = apiKey.trim()
          const value = await request('model', { ...(key ? { apiKey: key } : {}),
            ...(selected ? { model: selected.id, provider: selected.provider } : {}) })
          setKey('')
          setChoice('')
          setModel(value)
          setMessage(key ? 'API Key 已保存，模型列表已更新。' : '模型已切换。')
        } catch (failure) { setError(failure.message) }
        finally { setSaving(false) }
      }
      const selected = model?.selected
      const current = selected ? selected.provider + ':' + selected.id : ''
      function optionLabel(item) {
        const name = item.name || item.id
        const duplicate = model.models.some(other => other !== item && (other.name || other.id) === name)
        const provider = { 'deepseek-account': 'DeepSeek 账号', 'deepseek-official': 'API Key' }[item.provider] || item.provider
        return duplicate ? name + ' · ' + provider : name
      }
      return h('section', { className: 'hnu-card hnu-stack', 'aria-label': '模型配置' },
        h('div', { className: 'hnu-row hnu-between' }, h('h3', null, '模型配置'), model?.configured && pill('已配置', 'active')),
        error && h('p', { role: 'alert' }, error),
        !model && !error && h('p', { className: 'hnu-muted' }, '正在检查 DSH 模型'),
        setupOnly && selected && h('p', { className: 'hnu-muted' }, selected.name),
        model && (!setupOnly || !model.configured) && h('form', { className: 'hnu-form', onSubmit: save },
          model.models.length > 0 && h('label', null, '模型', h('select', { value: choice || current, disabled: saving, onChange: event => setChoice(event.target.value) },
            model.models.map(item => h('option', { key: item.provider + ':' + item.id, value: item.provider + ':' + item.id }, optionLabel(item))))),
          h('label', null, 'DeepSeek API Key', h('input', { type: 'password', autoComplete: 'new-password', maxLength: 4096,
            required: !model.configured, placeholder: model.configured ? '输入新 Key 以添加或更换' : undefined,
            value: apiKey, disabled: saving, onChange: event => setKey(event.target.value) })),
          h('div', { className: 'hnu-row' }, h('button', { className: 'hnu-primary',
            disabled: saving || (!apiKey.trim() && (!choice || choice === current)) }, saving ? '正在保存…' : apiKey.trim() ? '保存 API Key' : '切换模型'),
            !model.configured && h('a', { href: 'https://platform.deepseek.com/api_keys', target: '_blank', rel: 'noreferrer' }, '创建 API Key'))),
        message && h('p', { role: 'status' }, message))
    }

    function Welcome({ state, select, act, finish }) {
      return h('section', { className: 'hnu-welcome hnu-stack', 'aria-label': '快速开始' },
        h('h2', null, '欢迎使用 HNU Agent'),
        h('p', { className: 'hnu-muted' }, '连接模型与 QQ 后，在会话列表查看消息和工单。'),
        h('ol', { className: 'hnu-welcome-steps' },
          h('li', null, h(ModelSetup, { setupOnly: true })),
          h('li', null, h(Settings, { state, select, act, setupOnly: true }))),
        h('div', { className: 'hnu-row' },
          button('进入会话列表', finish, { className: 'hnu-primary' }),
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

    function SessionHistory({ ctx, session, ticket, summary }) {
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
        rows.length ? h('ol', { className: 'hnu-history', 'aria-label': '工单对话' }, rows.map(row =>
          h('li', { key: row.key }, h('div', { className: 'hnu-row hnu-muted' }, h('strong', null, row.role),
            h('time', null, timeOf(row.time))), h('p', null, row.text))))
          : h('p', { className: 'hnu-muted', style: { whiteSpace: 'pre-wrap' } },
            summary || error || (waiting ? '等待会话记录' : '会话还没有消息。')))
    }

    function TicketContent({ ctx, ticket, select, act, openNative }) {
      const [note, setNote] = useState('')
      const [reply, setReply] = useState('')
      const [pending, setPending] = useState(false)
      const operation = useRef(null)
      const original = ticket.evidence
      const summary = ticket.assignments?.at(-1)?.report?.summary
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
        h('div', { className: 'hnu-row' },
          connected && button('打开 DSH 会话', () => openNative(ticket)),
          original && button('查看来源消息', () => {
            const anchor = eventKey(original) || ''
            select({ view: 'board', list: 'messages', group: String(original.group_id), filter: '', anchor, locate: anchor })
          })),
        connected ? h(SessionHistory, { key: connected, ctx, session: connected, ticket: ticket.id, summary })
          : h('p', { className: 'hnu-muted' }, summary || '等待会话创建'),
        ticket.inputs?.length > 0 && h('details', { className: 'hnu-card' }, h('summary', null, '补充与关联记录'),
          ...ticket.inputs.map(input => h('p', { key: input.operation, style: { whiteSpace: 'pre-wrap' } }, input.text))),
        ticket.deliveries?.map((delivery, index) => {
          const content = typeof delivery.content === 'string' ? delivery.content : delivery.content?.text
          return h('details', { key: delivery.version, className: 'hnu-card hnu-delivery' },
            h('summary', null, '交付 v' + delivery.version),
            h('div', { className: 'hnu-stack hnu-delivery-body' },
              content ? h(Markdown, { content }) : h('div', { className: 'hnu-output' }, h('pre', null, delivery.diff || '未附预览内容')),
              content && h('div', null, button('下载 Markdown', () => saveFile(delivery.file?.name || delivery.file, content))),
              delivery.note && h('p', { className: 'hnu-muted' }, delivery.note),
              delivery.reviewer && h('p', { className: 'hnu-muted' }, '审核者：' + delivery.reviewer),
              index === 0 && delivery.status === 'pending' && h('div', { className: 'hnu-form' },
                h('label', null, '审核意见', h('textarea', { value: note, maxLength: 1500, onChange: e => setNote(e.target.value), placeholder: '要求修改时填写意见' })),
                h('div', { className: 'hnu-row' },
                  ...[['approve', '批准交付'], ['revise', '要求修改'], ['reject', '拒绝']].map(([action, name]) =>
                    button(name, async () => {
                      if (await send('decision', { ticket: ticket.id, version: delivery.version, commit: delivery.commit, action, note: note.trim() })) setNote('')
                    }, { key: action, className: action === 'approve' ? 'hnu-primary' : '', disabled: pending || (action === 'revise' && !note.trim()) }))))))
        }),
        h('form', { className: 'hnu-card hnu-form', onSubmit: e => { e.preventDefault(); supplement() } },
          h('h3', null, ticket.attention ? '答复澄清问题' : '补充要求'),
          ticket.attention && h('p', null, ticket.attention.question),
          h('textarea', { 'aria-label': ticket.attention ? '答复' : '补充要求', value: reply, maxLength: 1500, onChange: e => setReply(e.target.value) }),
          h('div', null, h('button', { disabled: pending || !reply.trim() }, '发送到 DSH 会话'))))
    }

    function QQHistory({ chat, state, selection, select, act, openTicket, initialPage }) {
      const [rows, setRows] = useState(() => initialPage?.messages ?? [])
      const [before, setBefore] = useState(() => initialPage?.next)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const controller = useRef(null)
      const history = useRef(null)
      const loaded = before !== undefined || Boolean(error)
      useEffect(() => {
        if (!loaded || !selection.locate) return
        const list = history.current
        const target = document.getElementById('hnu-event-' + selection.locate)
        if (!list?.contains(target)) return
        const pane = list.closest('.hnu-chat-right')
        const tabs = pane.querySelector('.hnu-chat-tabs')
        const inset = Number.parseFloat(getComputedStyle(pane).paddingBottom)
        function center() {
          const bounds = pane.getBoundingClientRect()
          const message = target.getBoundingClientRect()
          const top = Math.max(bounds.top, tabs.getBoundingClientRect().bottom)
          const delta = (message.top + message.bottom - top - bounds.bottom) / 2
          if (Math.abs(delta) <= 1) return
          const position = pane.scrollTop + delta
          if (position < 0) {
            list.style.paddingTop = Math.ceil((Number.parseFloat(list.style.paddingTop) || 0) - position) + 'px'
          } else {
            const scrollLimit = list.getBoundingClientRect().bottom + pane.scrollTop + inset - bounds.bottom
            const missing = Math.ceil(position - scrollLimit)
            if (missing > 0) list.style.paddingBottom = (Number.parseFloat(list.style.paddingBottom) || 0) + missing + 'px'
          }
          pane.scrollTop = Math.max(0, position)
        }
        center()
        center() // Recalculate after the tabs move into their sticky position.
        const observer = new ResizeObserver(center)
        observer.observe(list)
        observer.observe(target)
        const stop = () => observer.disconnect()
        const timer = setTimeout(stop, 3000)
        pane.addEventListener('wheel', stop, { passive: true })
        pane.addEventListener('touchstart', stop, { passive: true })
        return () => {
          clearTimeout(timer)
          stop()
          pane.removeEventListener('wheel', stop)
          pane.removeEventListener('touchstart', stop)
          list.style.paddingTop = ''
          list.style.paddingBottom = ''
        }
      }, [selection.locate, loaded])
      function merge(messages) {
        setRows(current => [...new Map([...current, ...messages].map(row => [row.id, row])).values()]
          .sort((a, b) => a.time - b.time))
      }
      useEffect(() => {
        const abort = new AbortController()
        controller.current = abort
        let timer
        async function poll() {
          try {
            const page = await readHistory(chat, undefined, abort.signal)
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
          const page = await readHistory(chat, before, signal)
          if (!signal?.aborted) { merge(page.messages); setBefore(page.next) }
        } catch (failure) {
          if (!signal?.aborted) setError(failure.message)
        } finally {
          if (!signal?.aborted) setLoading(false)
        }
      }
      const id = chat.kind === 'group' ? chat.id : 'private:' + chat.id
      const stored = new Map((state.events || []).filter(event => event.group_id === id).map(event => [String(event.message_id), event]))
      for (const proposal of state.proposals || []) {
        const event = proposal.evidence
        if (event.group_id === id && !stored.has(String(event.message_id))) {
          stored.set(String(event.message_id), { ...event, reason: 'pending_open', proposal })
        }
      }
      const source = selection.locate && state.tickets.find(ticket => eventKey(ticket.evidence) === selection.locate)?.evidence
      if (source?.group_id === id && !stored.has(String(source.message_id))) stored.set(String(source.message_id), source)
      const messages = rows.map(row => {
        const original = stored.get(row.id)
        stored.delete(row.id)
        return original ? { ...original, images: row.images } : {
          id: state.account + ':' + id + ':' + row.id, group_id: id, message_id: row.id,
          name: row.sender, sent_at: row.time, text: row.text, reason: 'ordinary', historyOnly: true, images: row.images,
        }
      })
      messages.push(...stored.values())
      messages.sort((a, b) => (b.sent_at || b.created_at) - (a.sent_at || a.created_at))
      return h('section', { className: 'hnu-stack', 'aria-label': '聊天记录', ref: history },
        error && h('p', { role: 'alert' }, error),
        before && h('div', null, button('加载更早消息', older, { disabled: loading })),
        !rows.length && !error && h('p', { className: 'hnu-muted' }, before === undefined ? '正在读取消息' : '暂无消息'),
        messages.map(event => h(MessageCard, { key: event.id, event,
          groups: [...state.groups, { id, name: chat.name }], tickets: state.tickets, materials: state.materials,
          selection, select, act, openTicket })))
    }

    function QQConversations({ ctx, state, selection, select, act, openTicket, openNative, chats, chatError, refreshChats, cachedHistory }) {
      const account = state.account
      const [filter, setFilter] = useState('')
      const [expanded, setExpanded] = useState(false)
      const available = chats || (state.availableGroups || []).map(group => ({ ...group, kind: 'group' }))
      const query = filter.trim().toLocaleLowerCase()
      const recent = available.filter(item => item.recent)
      const visible = query ? available.filter(item => item.id.includes(query) || item.name.toLocaleLowerCase().includes(query)) : recent
      const tab = selection.list
      const selectedTicket = tab === 'tickets' && state.tickets.find(ticket => ticket.id === selection.ticket)
      const chatId = selection.group || selectedTicket?.evidence?.group_id
      const chat = findChat(available, chatId)
      const group = chat && groupSettings(chat, state.groups)
      const tickets = chat ? state.tickets.filter(ticket => ticket.evidence?.group_id === chatKey(chat)) : []
      const proposals = chat ? (state.proposals || []).filter(item => item.evidence.group_id === chatKey(chat)) : []
      const expandedTicket = selection.ticket === null ? null : tickets.find(ticket => ticket.id === selection.ticket) ?? tickets[0]
      function choose(item) {
        select({ view: 'board', group: chatKey(item), anchor: '', ticket: '', locate: '', list: tab === 'settings' ? 'messages' : tab })
      }
      function row(item) {
        return button(h(Fragment, null, h('span', null, item.name),
          item.unread > 0 && h('span', { className: 'hnu-chat-unread', 'data-muted': item.muted }, item.unread)),
        () => choose(item), { key: chatKey(item), className: 'hnu-quiet hnu-conversation-row', title: item.name,
          'aria-pressed': chat && chatKey(chat) === chatKey(item) })
      }
      const { pinned: top, assistant: folded, ordinary } = chatSections(visible)
      const showAll = Boolean(query) || expanded
      return h('div', { className: 'hnu-chats' },
        h('nav', { className: 'hnu-stack hnu-chat-list', 'aria-label': 'QQ 会话列表' },
          h('div', { className: 'hnu-chat-list-header' }, h('h2', null, '会话列表'),
            button('↻', () => refreshChats().catch(() => {}), { className: 'hnu-quiet', 'aria-label': '刷新会话' })),
          h('input', { 'aria-label': '搜索 QQ 会话', placeholder: '搜索会话或 QQ 号', value: filter, onChange: event => setFilter(event.target.value) }),
          chatError && h('div', { className: 'hnu-stack' },
            h('p', { role: 'alert' }, chatError),
            button('打开 QQ 连接设置', () => select({ view: 'settings' }), { className: 'hnu-quiet' })),
          top.length > 0 && h('section', { 'aria-label': '置顶群聊' }, h('h3', null, '置顶群聊'), top.map(row)),
          folded.length > 0 && h('details', { className: 'hnu-chat-assistant', open: query ? true : undefined },
            h('summary', null, '群助手'), h('div', null, folded.map(row))),
          ordinary.length > 0 && h('section', { 'aria-label': '最近会话' }, ordinary.slice(0, showAll ? ordinary.length : 20).map(row),
            ordinary.length > 20 && !query && button(expanded ? '▴ 收起' : '▾ 展开其余 ' + (ordinary.length - 20) + ' 个',
              () => setExpanded(value => !value), { className: 'hnu-quiet', 'aria-expanded': expanded })),
          !visible.length && !chatError && h('p', { className: 'hnu-muted' }, !account ? '请先连接 QQ' : chats ? query ? '没有匹配的会话' : '暂无最近会话' : '正在读取会话')),
        h('section', { className: 'hnu-chat-right hnu-stack hnu-boardui', 'aria-label': chat?.name },
          h('style', null, dashboardStyles),
          chat ? h(Fragment, null,
            h('div', { className: 'hnu-nav hnu-chat-tabs', 'aria-label': '会话视图' },
              [['messages', '消息'], ['tickets', '工单'], ['settings', '会话设置']].map(([id, label]) =>
                button(label, () => select({ list: id, locate: '' }), { key: id, className: 'hnu-quiet', 'aria-pressed': tab === id }))),
            tab === 'settings' ? h(GroupForm, { key: group.id + ':' + group.version, group, save: act })
              : tab === 'tickets' ? h(Fragment, null,
                proposals.map(proposal => h(OpeningReview, { key: proposal.eventId, proposal, groupId: group.id, act, openTicket,
                  showSource: () => select({ list: 'messages', anchor: proposal.eventId, locate: proposal.eventId }) })),
                tickets.map(ticket => h(BoardTicket, { key: ticket.id, ctx, ticket, groups: [group], events: state.events, select, act, openNative,
                  expanded: ticket === expandedTicket, selected: selection.ticket === ticket.id })),
                !proposals.length && !tickets.length && h('p', { className: 'hnu-muted' }, '此会话暂无工单'))
              : h(QQHistory, { key: chatKey(chat), chat, state, selection, select, act, openTicket,
                initialPage: cachedHistory?.account === account && cachedHistory?.group === chatKey(chat) ? cachedHistory.page : undefined }))
            : h('p', { className: 'hnu-muted' }, '连接 QQ 后选择一个会话')))
    }

    function Panel({ ctx }) {
      const [selection, setSelection] = useState(readSelection)
      const [welcome, setWelcome] = useState(() => {
        try { return localStorage.getItem(welcomeKey) !== 'done' } catch { return true }
      })
      const [state, setState] = useState(null)
      const [chatSnapshot, setChatSnapshot] = useState(null)
      const [cachedHistory, setCachedHistory] = useState(null)
      const [error, setError] = useState('')
      const [message, setMessage] = useState('')
      const mounted = useRef(false)
      const seq = useRef(0)
      const chatSeq = useRef(0)
      const account = state?.account
      const chats = chatSnapshot?.account === account ? chatSnapshot?.items : undefined
      const chatError = chatSnapshot?.account === account ? chatSnapshot?.error : undefined
      function select(change) {
        setSelection(old => {
          const next = { ...old, ...change }
          saveSelection(next)
          return next
        })
      }
      async function refresh(signal) {
        const id = ++seq.current
        const next = await request('state', undefined, signal)
        if (mounted.current && id === seq.current) setState(next)
      }
      async function refreshChats(signal, expected = account) {
        const id = ++chatSeq.current
        try {
          const result = await request('napcat/conversations', undefined, signal)
          if (result.account !== expected) throw Object.assign(new Error('QQ 账号已切换，请确认后刷新'), { status: 409 })
          if (!signal?.aborted && mounted.current && id === chatSeq.current) {
            setChatSnapshot({ account: result.account, items: result.conversations })
          }
          return result.conversations
        } catch (failure) {
          if (!signal?.aborted && mounted.current && id === chatSeq.current) {
            setChatSnapshot(old => ({ account: expected, items: failure.status === 409 ? [] : old?.account === expected ? old.items : null,
              error: failure.message }))
          }
          throw failure
        }
      }
      async function syncQQ(expected) {
        const [items] = await Promise.all([refreshChats(undefined, expected), refresh()])
        const chat = findChat(items, selection.group)
        if (!chat) return false
        const page = await readHistory(chat)
        if (page.account !== expected) throw new Error('QQ 账号已切换，请确认后刷新')
        if (mounted.current) setCachedHistory({ account: expected, group: chatKey(chat), page })
        return true
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
        if (!account || welcome) return
        const abort = new AbortController()
        let timer
        const poll = async () => {
          await refreshChats(abort.signal).catch(() => {})
          if (!abort.signal.aborted) timer = setTimeout(poll, 20_000)
        }
        poll()
        return () => { abort.abort(); clearTimeout(timer) }
      }, [account, welcome])
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
      function openTicket(id, group) {
        select(ticketSelection(id, group))
      }
      async function openNative(ticket) {
        try {
          await ctx.sessions.refresh()
          if (!ctx.sessions.list.getSnapshot().byId[ticket.session]) throw new Error('等待会话创建，请稍后再打开。')
          ctx.uiWorkspace.openSession(ticket.session)
        } catch (failure) { setError(failure.message) }
      }
      function finishWelcome() {
        try { localStorage.setItem(welcomeKey, 'done') } catch { /* storage unavailable */ }
        setWelcome(false)
        select({ view: 'board' })
      }
      useEffect(() => {
        if (!welcome) return
        const abort = new AbortController()
        Promise.all([request('napcat/status', undefined, abort.signal), request('model', undefined, abort.signal)])
          .then(([connection, model]) => {
            if (!abort.signal.aborted && connection.online && connection.report_ready
              && connection.boundAccount === connection.user_id && model.configured) finishWelcome()
          }).catch(() => {})
        return () => abort.abort()
      }, [welcome])
      const nav = [['board', '会话列表'], ['settings', '权限设置']]
      const onConversations = !welcome && selection.view !== 'settings'
      return h('main', { className: 'hnu' },
        h('style', null, styles),
        h('header', { className: 'hnu-head' },
          h('div', { className: 'hnu-brand' }, h('h1', null, brand)),
          !welcome && h('nav', { className: 'hnu-nav', 'aria-label': brand },
            ...nav.map(([view, label]) => button(label, () => select({ view }), { key: view, className: 'hnu-quiet', 'aria-pressed': view === 'board' ? onConversations : selection.view === view })))),
        error && h('p', { className: 'hnu-alert', role: 'alert' }, error),
        message && h('p', { className: 'hnu-alert', role: 'status' }, message),
        state && h('div', { className: 'hnu-page' + (onConversations ? ' hnu-conversation-page' : '') },
          (state.error || state.dispatch?.available === false || state.dispatch?.ready === false) &&
            h('p', { className: 'hnu-muted', role: 'status' }, state.error || state.dispatch.reason || '收件可用，派工暂不可用。'),
          welcome ? h(Welcome, { state, select, act, finish: finishWelcome })
            : selection.view === 'settings' ? h(Settings, { state, select, act, chats, chatError, syncQQ })
            : h(QQConversations, { key: state.account, ctx, state, selection, select, act, openTicket, openNative,
              chats, chatError, refreshChats, cachedHistory })),
        !state && !error && h('p', { className: 'hnu-alert', role: 'status' }, '正在加载工作区'))
    }

    function ReturnToTicket({ sessionId, navigate }) {
      const [ticket, setTicket] = useState(null)
      useEffect(() => {
        if (!sessionId?.startsWith('worker-')) return
        const abort = new AbortController()
        request('state', undefined, abort.signal).then(state => {
          if (!abort.signal.aborted) setTicket(state.tickets.find(ticket => ticket.session === sessionId) ?? null)
        }).catch(() => {})
        return () => abort.abort()
      }, [sessionId])
      if (ticket?.session !== sessionId || !ticket?.evidence?.group_id) return null
      return h(Button, { type: 'button', variant: 'outline', size: 'sm', style: { whiteSpace: 'nowrap' },
        onClick: () => navigate(ticket.id, ticket.evidence.group_id) },
        h('span', { 'aria-hidden': true }, '←'), '返回工单')
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
      const slot = 'conversation.session.header.utilities'
      ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id: 'hnu-return-to-ticket', order: -20,
        inject: () => ({ navigate(ticket, group) {
          saveSelection({ ...readSelection(), ...ticketSelection(ticket, group), anchor: '' })
          ctx.layout.selectPanel(panel)
        } }),
      }, ReturnToTicket))
    }

    return { apply, inject }
  },
})

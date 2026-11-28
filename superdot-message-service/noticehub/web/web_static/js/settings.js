function bulkInputs(button) {
  const list = document.querySelector(button.dataset.selectList);
  return list ? Array.from(list.querySelectorAll(button.dataset.selectFilter || 'input[type="checkbox"]'))
    .filter(input => !input.disabled) : [];
}
function syncBulkButtons() {
  document.querySelectorAll('[data-select-list]').forEach(button => {
    const items = bulkInputs(button);
    const all = items.length > 0 && items.every(input => input.checked);
    const suffix = button.dataset.selectSuffix || '';
    const label = (all ? '取消全选' : '全选') + suffix;
    if (button.textContent !== label) button.textContent = label;
  });
}
let bulkSyncFrame;
function scheduleBulkSync() {
  if (!bulkSyncFrame) bulkSyncFrame = requestAnimationFrame(() => { bulkSyncFrame = 0; syncBulkButtons(); });
}
document.addEventListener('change', scheduleBulkSync);
document.addEventListener('click', event => {
  const button = event.target.closest('[data-select-list]');
  if (!button) return;
  const items = bulkInputs(button);
  const select = items.some(input => !input.checked);
  items.forEach(input => {
    if (input.checked === select) return;
    input.checked = select;
    input.dispatchEvent(new Event('input', {bubbles:true}));
    input.dispatchEvent(new Event('change', {bubbles:true}));
  });
  syncBulkButtons();
});
for (const id of ['tab-settings','onboarding','platform-setup-wizard','history-groups']) {
  const root = document.getElementById(id);
  if (root) new MutationObserver(scheduleBulkSync).observe(root, {childList:true, subtree:true});
}

/* 设置卡（服务设置页）—— 从 page.html 原样搬出，逻辑未改。
   包含：学习通 cURL/Cookie 助手、loadSettings（整页设置卡构建）。
   依赖 page.html 里的全局：api、el、token、setupToken、showFeedback、safeUrl、setupApi、
   setupGroupPull、groupCategoryName、groupPull 相关 DOM，以及 guide.js 的 groupCategoryName。 */

function formatServiceStartedAt(raw) {
  var text = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!text) return {text: '未知', title: ''};
  var match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(text);
  if (!match) return {text: text, title: text};
  return {text: match[1] + '-' + match[2] + '-' + match[3] + ' ' + match[4] + ':' + match[5], title: text};
}
function renderRuntimeDetails(data) {
  var panel = document.getElementById('rail-runtime-values');
  if (!panel) return;
  var rows = [];
  var webPort = Number(data.web_port);
  if (Number.isFinite(webPort) && webPort > 0) {
    var port = String(webPort) + (data.web_port_source === 'env' ? '（来自环境变量，已覆盖 .env）' : '');
    rows.push(['服务端口', port, 'web-port']);
  }
  if (data.started_at) {
    rows.push(['启动时间', formatServiceStartedAt(data.started_at).text]);
  }
  if (data.stats) {
    rows.push(['工单统计', '共 ' + data.stats.total + ' 件，未完成 ' + data.stats.open + ' 件']);
  }
  if (Array.isArray(data.groups) && data.groups.length) rows.push(['QQ 订阅群', data.groups.join('、')]);
  rows.push(
    ['截止提醒', data.reminders || '未开启'],
    ['推送预算', data.push_budget || '不限'],
    ['夜间静默', data.quiet_hours || '未设置']
  );
  panel.replaceChildren();
  rows.forEach(function (row) {
    var item = el('div', 'kv');
    if (row[2]) item.dataset.row = row[2];
    item.append(el('span', '', row[0]), el('span', '', row[1]));
    panel.appendChild(item);
  });
  if (data.insights && data.insights.length) {
    var tips = el('details', 'settings-extra');
    var list = el('ul', 'insight-list');
    data.insights.forEach(function (text) { list.appendChild(el('li', '', text)); });
    tips.append(el('summary', '', '纠错提示'), list);
    panel.appendChild(tips);
  }
}
function chaoxingConnectError(result) {
  const guidance = {
    unsupported_platform: '这台电脑不能自动读取浏览器登录凭证，请改用「其他接入方式」粘贴凭证。',
    browser_unavailable: '没有找到可用的浏览器登录态。请先用 Chrome 或 Edge 打开并登录学习通。',
    browser_locked: '浏览器的 Cookie 库正被占用。等几秒重试，或改用「其他接入方式」。',
    keychain_denied: '系统授权没通过。请在弹出的钥匙串窗口里输入开机密码并点「允许」，再重试。',
    no_chaoxing_cookie: '浏览器里没有学习通的登录状态。请在同一个浏览器登录学习通后重试。',
    decrypt_failed: '这份登录凭证的加密格式解不开，请改用「其他接入方式」粘贴凭证。',
  };
  return guidance[result.category] || result.error || '暂时无法连接学习通，请稍后重试。';
}
function chaoxingBrowserLabel(source) {
  return {chrome: 'Chrome', edge: 'Edge', brave: 'Brave', vivaldi: 'Vivaldi', opera: 'Opera', firefox: 'Firefox'}[source] || '';
}
function chaoxingDetectionHint(status) {
  if (status.auto_cookie_supported) {
    return status.auto_cookie_platform === 'macos'
      ? '用 Chrome 或 Edge 登录过学习通就行，不用退出浏览器；首次会弹一次系统授权。'
      : '用 Edge 或 Chrome 登录过学习通就行，不用退出浏览器。';
  }
  return '这台电脑不能自动读取浏览器登录凭证，请改用「其他接入方式」粘贴凭证。';
}
function extractCookieFromCurl(text){
  var src=String(text||'').replace(/\\\r?\n/g,' ');
  if(!/^\s*curl(?:\.exe)?[\s"']/i.test(src))return {looksLikeCurl:false,found:false,cookie:''};
  var re=/(?:^|\s)(?:-H|--header)\s*('([^']*)'|"((?:[^"\\]|\\.)*)"|([^\s]+))/g;
  var match;
  while((match=re.exec(src))){
    var header=match[2]!==undefined?match[2]:(match[3]!==undefined?match[3].replace(/\\"/g,'"'):match[4]);
    if(!/^\s*cookie\s*:/i.test(header))continue;
    return {looksLikeCurl:true,found:true,cookie:header.replace(/^\s*cookie\s*:\s*/i,'').replace(/\s+$/,'')};
  }
  return {looksLikeCurl:true,found:false,cookie:''};
}
function handleCurlPaste(event){
  var input=document.getElementById('cx-manual-cred');
  var result=document.getElementById('cx-manual-cred-result');
  if(!input||!result)return;
  var text=(event&&event.clipboardData&&event.clipboardData.getData)?event.clipboardData.getData('text'):'';
  if(!text)return;
  var parsed=extractCookieFromCurl(text);
  if(!parsed.looksLikeCurl)return;
  if(event&&event.preventDefault)event.preventDefault();
  if(!parsed.found){result.textContent='这段内容里没有登录凭证。';return;}
  var current=String(input.value||'').replace(/^\s+|\s+$/g,'');
  if(current&&current!==parsed.cookie){result.textContent='输入框里已经有登录凭证了，没有自动覆盖：要换成 cURL 里的，请先清空输入框再粘贴。';return;}
  input.value=parsed.cookie;
  result.textContent='已从 cURL 中提取出登录凭证，请确认后保存。';
}
// —— 装载列表的统一规则：响应回来时不能吞掉用户刚做的编辑 ——
// 用户在响应回来之前点了「新增」或改过某行时，把这些行先摘出来，
// 服务端结果照常渲染，摘出来的行按原样接回末尾（同 id 的服务端行让位，避免两张同名卡）。
// 抽成顶层函数是为了能在测试里用假列表跑真实逻辑（行为级断言，不测实现细节）。
function loadRulesKeepingEdits(deps){
  var list=deps.list;
  if(!list||!deps.request)return Promise.resolve(0);
  return deps.request().then(function(v){
    // 现场采集：必须在响应到达这一刻摘（请求发出时摘会漏掉等待期间新增的行）。
    var kept=[],keptIds={};
    Array.prototype.slice.call(list.children||[]).forEach(function(node,index){
      var id=deps.readId(node);
      var dirty=!!(node.dataset&&node.dataset.dirty==='1');
      // 改名后的卡：当前名字和原来的 dataset.ruleId 都要挡住，否则服务端那张旧名字的卡会再渲染一遍。
      var key=String((node.dataset&&node.dataset.ruleId)||'').trim();
      if(dirty||!id){kept.push({node:node,index:index,id:id});if(id)keptIds[id]=1;if(key)keptIds[key]=1;}
    });
    var all=deps.toCards((v&&v.rules)||[]);
    var fresh=all.filter(function(card){return !keptIds[String((card&&card.id)||'').trim()];});
    deps.render(fresh);
    // 有 id 的编辑行按原索引插回原位（改过的「规则A」刷新后仍在第一位）；
    // 新加的空行没有位置可言，接在末尾。
    kept.forEach(function(entry){
      if(!entry.id||!list.insertBefore){if(list.appendChild)list.appendChild(entry.node);return;}
      list.insertBefore(entry.node,list.children[entry.index]||null);
    });
    if(deps.refreshEmpty)deps.refreshEmpty();
    return fresh.length;
  });
}
// 群白名单重渲染前，把用户还没保存的勾选与别名收进本地集合；
// 否则点一次「拉取我的群」就会把没保存的勾选/别名冲掉。列表为空（首次/报错文案）时不动本地状态。
function harvestGroupEdits(kind, box, selected, aliases){
  var next={selected:(selected||[]).slice(),aliases:aliases||{}};
  if(!box||!box.querySelectorAll)return next;
  var boxes=box.querySelectorAll('input[type="checkbox"][value]');
  if(!boxes||!boxes.length)return next;
  var ids=[];
  var seen={};
  for(var i=0;i<boxes.length;i+=1){if(boxes[i].checked){var id=String(boxes[i].value);if(!seen[id]){seen[id]=true;ids.push(id);}}}
  next.selected=ids;
  if(kind==='wechat'){
    var aliasInputs=box.querySelectorAll('.wx-alias');
    for(var j=0;j<aliasInputs.length;j+=1){
      var gid=aliasInputs[j].getAttribute('data-group');
      if(gid)next.aliases[gid]=aliasInputs[j].value;
    }
  }
  return next;
}
// 设置页整块重建前先把用户已经输入/勾选但没保存的内容收起来：粘好 64 位密钥、填好数据目录，
// 手滑切个标签再回来不能白填。只认有 id 的控件（没 id 无处复位，宁可不猜）。
var settingsUnsaved = {};
// 清空输入框是合法状态（微信数据目录清空＝回到自动查找），可空值本身推断不出「用户改过」，
// 所以用户一碰就打个显式标记，重建设置页时 harvestSettingsInputs 靠它把空值一起保住。
function markSettingsDirty(node) {
  if (!node || !node.id || !node.dataset) return;
  node.dataset.nhDirty = '1';
}
function bindSettingsDirtyTracking(root) {
  if (!root || !root.addEventListener) return;
  if (root.dataset && root.dataset.nhDirtyBound === '1') return;
  if (root.dataset) root.dataset.nhDirtyBound = '1';
  var handler = function (event) { markSettingsDirty(event && event.target); };
  root.addEventListener('input', handler);
  root.addEventListener('change', handler);
}
function harvestSettingsInputs(root) {
  var keep = {};
  if (!root || !root.querySelectorAll) return keep;
  Array.prototype.forEach.call(root.querySelectorAll('input[id],textarea[id],select[id]'), function (node) {
    var isCheck = node.type === 'checkbox' || node.type === 'radio';
    var data = node.dataset || {};
    if (data.noDraft !== undefined) return;
    var dirty = isCheck ? node.checked !== node.defaultChecked : data.nhDirty === '1' ||
      (data.draftOnEdit === undefined && !!String(node.value || ''));
    if (!dirty) return;
    keep[node.id] = isCheck ? {checked: node.checked} : {value: node.value};
  });
  return keep;
}
function restoreSettingsInputs(keep) {
  Object.keys(keep || {}).forEach(function (id) {
    var node = document.getElementById(id);
    if (!node) return;
    var saved = keep[id];
    if (Object.prototype.hasOwnProperty.call(saved, 'checked')) { if (node.checked !== saved.checked) node.checked = saved.checked; return; }
    // 只补空框：新渲染已经放好值的地方不抢（那些是服务端真值）
    if (!String(node.value || '')) node.value = saved.value;
  });
}
var settingsRenderSeq = 0;
var dingtalkScanTimer = null;
function bindChaoxingSettings(card) {
  const find = (id) => card.querySelector('#cx-' + id);
  const state = find('state');
  const status = find('status');
  const meta = find('meta');
  const hint = find('hint');
  const auto = find('auto-cred');
  const refresh = find('load-courses');
  const manual = find('manual-option');
  const input = find('manual-cred');
  const importButton = find('manual-cred-save');
  const subscriptions = find('subscriptions');
  const enabled = find('enabled');
  const courses = find('courses');
  const search = find('course-search');
  const count = find('course-count');
  const save = find('save');
  const result = find('result');
  let selected = [];
  let connected = false;
  let busy = false;

  // 一行状态：圆点颜色 + 一句结论 + 一条来源/时间。别再用三段互相重复的说明文字。
  function setState(kind, text, metaText) {
    state.dataset.state = kind;
    status.textContent = text;
    meta.textContent = metaText || '';
  }

  function controls(hasCookie) {
    subscriptions.hidden = false;
    refresh.hidden = !hasCookie;
  }

  function coursesReady(rows, source) {
    renderCourses(rows);
    connected = true;
    controls(true);
    const label = chaoxingBrowserLabel(source);
    setState('ready', '已连接', label ? '最近使用 ' + label : '');
    hint.textContent = '';
  }

  function renderCourses(rows) {
    courses.replaceChildren();
    const available = new Set(rows.map((row) => String(row.course_id || '')).filter(Boolean));
    const saved = selected.filter(id => !available.has(id)).map(id => ({course_id:id, course_name:id + '（已订阅）'}));
    const entries = saved.concat(rows).sort((a,b) => Number(selected.includes(String(b.course_id))) - Number(selected.includes(String(a.course_id))));
    entries.forEach((row) => {
      const id = String(row.course_id || '');
      if (!id) return;
      const label = el('label', 'cx-course');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.value = id;
      check.checked = selected.includes(id);
      label.append(check, document.createTextNode(row.course_name || id));
      courses.append(label);
    });
    if (!courses.childElementCount) courses.textContent = '当前账号没有可订阅的课程。';
    search.hidden = !entries.length;
    count.textContent = '已选 ' + selected.length + ' 门';
    filterCourses();
    refresh.textContent = '刷新课程';
    save.hidden = !courses.childElementCount;

  }

  function send(path, payload, timeoutMs = 20000) {
    const options = payload === undefined ? {} : {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload),
    };
    return api(path, {...options, timeoutMs});
  }

  async function run(button, waiting, action, report = status) {
    if (busy) return;
    busy = true;
    const buttons = [auto, refresh, importButton, enabled, save, input];
    buttons.forEach((item) => { item.disabled = true; });
    courses.inert = true;
    const label = button.textContent;
    button.textContent = waiting;
    report.textContent = '';
    try {
      await action();
    } catch (error) {
      if (report === status) setState('error', '未连接', '');
      report.textContent = error.message;
    } finally {
      button.textContent = button === refresh && connected ? '刷新课程' : label;
      buttons.forEach((item) => { item.disabled = false; });
      courses.inert = false;
      busy = false;
    }
  }

  api('/api/settings').then((settings) => {
    const connection = settings.chaoxing_status || {};
    const hasCookie = !!(connection.has_cookie || settings.chaoxing_cookie?.has_cookie);
    selected = (settings.chaoxing_group_whitelist || []).map(String);
    enabled.checked = !!settings.chaoxing_enabled;
    auto.hidden = connection.auto_cookie_supported !== true;
    controls(hasCookie);
    renderCourses([]);
    if (!selected.length) courses.textContent = hasCookie ? '刷新课程后，勾选要监听的课程。' : '请先连接学习通，再刷新课程。';
    if (!hasCookie) {
      setState('idle', '未连接', '');
      hint.textContent = chaoxingDetectionHint(connection);
    } else if (connection.expired) {
      setState('warn', '登录已过期', connection.last_sync_at ? '上次同步 ' + connection.last_sync_at : '');
      hint.textContent = '浏览器里重新登录学习通后点「自动连接」。';
    } else {
      setState('ready', '已连接', connection.last_sync_at ? '最近同步 ' + connection.last_sync_at : '');
      hint.textContent = '可以刷新课程，或重新读取浏览器登录态。';
    }
  }).catch(() => setState('error', '状态读取失败', ''));

  function filterCourses() {
    const query = search.value.trim().toLowerCase();
    courses.querySelectorAll('.cx-course').forEach(row => {
      row.hidden = !row.textContent.toLowerCase().includes(query)
        && !row.querySelector('input').value.toLowerCase().includes(query);
    });
  }
  search.addEventListener('input', filterCourses);
  function showCourseSubscriptions() {
    const nav = document.querySelector('#tab-settings [data-goto="chaoxing-subscriptions"]');
    if (nav) nav.click();
  }
  input.addEventListener('paste', handleCurlPaste);
  courses.addEventListener('change', (event) => {
    const check = event.target;
    if (!check.matches('input[type=checkbox]')) return;
    selected = selected.filter((id) => id !== check.value);
    if (check.checked) selected.push(check.value);
    count.textContent = '已选 ' + selected.length + ' 门';
  });

  auto.onclick = () => run(auto, '读取中…', async () => {
    const data = await send('/api/chaoxing/auto_cookie', {}, 120000);
    if (!data.ok) throw Error(chaoxingConnectError(data));
    enabled.checked = true;
    coursesReady(data.course_items || [], data.source || '');
    manual.open = false;
    showCourseSubscriptions();
  });
  importButton.onclick = () => run(importButton, '验证中…', async () => {
    const value = input.value.trim();
    if (!value) throw Error('请先粘贴登录凭证。');
    const data = await send('/api/settings', {chaoxing_cookie: value, chaoxing_verify_cookie: true}, 120000);
    if (!data.ok) throw Error(data.error || '登录凭证未保存，请重试。');
    input.value = '';
    if (!connected) enabled.checked = true;
    coursesReady(data.course_items || [], 'manual');
    manual.open = false;
    showCourseSubscriptions();
  }, find('manual-cred-result'));
  refresh.onclick = () => run(refresh, '读取中…', async () => {
    const data = await send('/api/chaoxing/courses', undefined, 120000);
    if (!data.ok) throw Error(data.error || '暂时无法读取课程。');
    coursesReady(data.courses || [], '');
  });
  enabled.onchange = () => run(enabled, '', async () => {
    const checked = enabled.checked;
    try {
      const data = await send('/api/settings', {chaoxing_enabled: checked});
      if (!data.ok) throw Error(data.error || '设置未保存，请重试。');
      result.textContent = checked ? '已开启接收。' : '已暂停接收。';
    } catch (error) {
      enabled.checked = !checked;
      throw error;
    }
  }, result);
  save.onclick = () => run(save, '保存中…', async () => {
    const data = await send('/api/settings', {
      chaoxing_enabled: enabled.checked,
      chaoxing_group_whitelist: selected,
    });
    if (!data.ok) throw Error(data.error || '课程订阅未保存，请重试。');
    result.textContent = '课程订阅已保存。';
  }, result);
}

function loadSettings() {

  if (dingtalkScanTimer !== null) { clearInterval(dingtalkScanTimer); dingtalkScanTimer = null; }
  var root = document.querySelector('#tab-settings .settings-body') || document.getElementById('tab-settings');
  bindSettingsDirtyTracking(root);
  settingsUnsaved = harvestSettingsInputs(root);
  // 重进设置/重渲染时不能丢滚动位置：`.settings-body` 是 display:contents（page.html:761），
  // 清空它就等于删掉设置页全部面板，文档高度瞬间塌到页头，浏览器会把 scrollTop 夹成 0
  // ——用户看到的就是「正在看下面的设置，突然自己滑到最顶」。
  // 所以先用 min-height 锁住页签高度（清空期间文档高度不变、不会被夹），
  // 等面板建完（微任务，同步构建结束后、绘制前）再放开并校准一次滚动。
  var settingsTab = document.getElementById('tab-settings');
  var scrollBefore = window.scrollY;
  var tabHeightBefore = settingsTab ? settingsTab.getBoundingClientRect().height : 0;
  if (settingsTab && tabHeightBefore > 0) settingsTab.style.minHeight = Math.ceil(tabHeightBefore) + 'px';
  // 分组会把动态卡片移出挂载点；同步清理，避免本轮 getElementById 绑定到旧控件。
  settingsTab.querySelectorAll('[data-setting-anchor]:not([data-setting-static])').forEach(function (card) { card.remove(); });
  root.textContent = '';
  // 分组容器由 page.html 的脚本按 render 号回收：号一变就说明这一轮的面板全换了，
  // 组里留着的是上一轮的旧卡片，得整批扔掉重建。
  root.setAttribute('data-render', String(Date.now()) + '-' + String(++settingsRenderSeq));
  if (settingsTab && tabHeightBefore > 0) {
    Promise.resolve().then(function () {
      settingsTab.style.minHeight = '';
      if (window.scrollY !== scrollBefore) {
        window.scrollTo({ top: scrollBefore, left: 0, behavior: 'instant' });
      }
    });
  }
  var setupCard=el('section','surface hosting-settings');setupCard.id='platform-setup-settings';setupCard.dataset.settingAnchor='setup';setupCard.innerHTML='<h2 class="section-title">首次配置</h2><button id="platform-setup-rerun" class="btn" type="button">重新运行首次向导</button>';root.appendChild(setupCard);
  function renderSuggestionSource(id, source) { var box=document.getElementById(id);box.textContent='按关键词识别';box.hidden=source!=='heuristic';box.dataset.source=source||''; }
  function appendRecommendation(meta, row) { var category=document.createElement('span');category.className='category-badge';category.textContent=groupCategoryName(row.category);meta.appendChild(category);if(row.suggested){var badge=document.createElement('span');badge.className='suggest-badge';badge.textContent='建议订阅';meta.appendChild(badge);}if(row.reason){var reason=document.createElement('span');reason.className='suggest-reason';reason.textContent=row.reason;meta.appendChild(reason);} }
  var syncBox = el('section', 'surface sync-card');
  syncBox.dataset.settingAnchor = 'calendar';
  syncBox.setAttribute('aria-labelledby', 'sync-title');
  syncBox.innerHTML = `<div class="section-head">
    <h2 id="sync-title" class="section-title">用 iPhone 日历看截止时间</h2>
  </div>
  <p class="setting-note">订阅一次，日历 App 就会定期更新工单的截止时间。</p>
  <div class="sync-layout">
    <div class="sync-qr-wrap"><img id="sync-qr" class="sync-qr" alt="iPhone 日历订阅二维码" hidden>
      <p id="sync-qr-message" class="sync-status" role="status" aria-live="polite">正在生成二维码…</p>
    </div>
    <div class="sync-copy">
      <p>用 iPhone 相机扫码订阅，也可以复制链接手动订阅。</p>
      <label for="sync-url">订阅地址</label>
      <input id="sync-url" class="sync-url" type="url" autocomplete="off">
      <div class="sync-actions"><button id="sync-copy" class="btn primary" type="button">复制订阅链接</button></div>
      <p id="sync-public-note" class="setting-note" hidden></p>
      <div id="sync-public-actions" hidden><button id="sync-public-open" class="btn plain" type="button">设置外网访问</button></div>
      <p id="sync-alts" class="sync-alts" hidden></p>
      <details class="settings-extra"><summary>订阅帮助</summary>
        <p>在 iPhone 的「设置 → 日历 → 账户」中添加已订阅的日历，然后粘贴上面的链接。</p>
        <button id="sync-test" class="btn" type="button">测试订阅地址</button>
      </details>
      <p id="sync-status" class="sync-status" role="status" aria-live="polite"></p>
    </div>
  </div>`;
  root.appendChild(syncBox);
   var backupCard=el('section','surface hosting-settings');
   backupCard.id='backup-card';
   backupCard.dataset.settingAnchor='backup';
   backupCard.innerHTML='<h2 class="section-title">数据备份</h2><p class="setting-note">仅导出本机待办数据库，不包含令牌、配置文件或日志。</p><button id="backup-download" class="btn" type="button">备份数据</button><p id="backup-result" class="setting-note" role="status" aria-live="polite"></p>';
   root.appendChild(backupCard);
   document.getElementById('backup-download').onclick=function(){
     var button=this;var result=document.getElementById('backup-result');button.disabled=true;result.textContent='正在生成备份…';
     fetch('/api/backup',{headers:{'X-Token':token},cache:'no-store'}).then(function(response){
       if(!response.ok)return response.json().catch(function(){return {};}).then(function(body){throw new Error(body.error||'备份请求失败');});
       return response.blob();
     }).then(function(blob){
       var now=new Date();var date=now.getFullYear()+'-'+('0'+(now.getMonth()+1)).slice(-2)+'-'+('0'+now.getDate()).slice(-2);
       var url=URL.createObjectURL(blob);var link=document.createElement('a');link.href=url;link.download='notice-hub-backup-'+date+'.zip';document.body.appendChild(link);link.click();link.remove();window.setTimeout(function(){URL.revokeObjectURL(url);},1000);result.textContent='备份下载已开始。';
     }).catch(function(error){result.textContent='备份失败：'+error.message;}).then(function(){button.disabled=false;});
   };
  var cxBox = el('section', 'surface hosting-settings');
  cxBox.id = 'chaoxing-settings-card';
  cxBox.dataset.settingAnchor = 'chaoxing';
  cxBox.innerHTML = `<h2 class="section-title">学习通接入</h2>
    <div class="cx-connect">
      <div id="cx-state" class="cx-state" data-state="idle"><span class="cx-dot" aria-hidden="true"></span><span id="cx-status" class="cx-state-text" role="status">正在读取连接状态…</span><span id="cx-meta" class="cx-state-meta"></span></div>
      <div class="cx-actions">
        <button id="cx-auto-cred" class="btn primary cx-primary" type="button" hidden>自动连接</button>
        <a class="btn cx-link" href="https://i.chaoxing.com/" target="_blank" rel="noopener noreferrer">打开学习通 ↗</a>
        <button id="cx-load-courses" class="btn" type="button" hidden>刷新课程</button>
      </div>
      <p id="cx-hint" class="cx-hint" role="status"></p>
      <details id="cx-manual-option" class="cx-alt">
        <summary>其他接入方式</summary>
        <div class="cx-alt-body">
          <label class="field" for="cx-manual-cred"><span>粘贴登录凭证（Cookie 或 cURL）</span><textarea id="cx-manual-cred" rows="3" autocomplete="off" spellcheck="false" data-no-draft></textarea></label>
          <button id="cx-manual-cred-save" class="btn" type="button">验证并读取课程</button>
          <p id="cx-manual-cred-result" class="cx-hint" role="status"></p>
        </div>
      </details>
      <section id="cx-subscriptions" aria-label="课程订阅" hidden>
        <label class="preference"><input id="cx-enabled" type="checkbox"><span>接收已选课程的通知</span></label>
        <input id="cx-course-search" class="input" type="search" aria-label="搜索课程" placeholder="搜索课程名或课程编号" hidden>
        <p id="cx-course-count" class="setting-note" aria-live="polite"></p>
        <button type="button" class="btn" data-select-list="#cx-courses">全选</button><div id="cx-courses" class="cx-courses" aria-label="我的课程"></div>
        <div class="cx-save-row"><p id="cx-result" class="cx-hint" role="status"></p><button id="cx-save" class="btn primary" type="button" hidden>保存课程订阅</button></div>
      </section>
    </div>`;
  root.appendChild(cxBox);
    /* —— 群选择区（微信/钉钉共用） ——
       拉取成功后不能把上百个群一屏铺开：顶部先给「共 N 个群」，推荐区按类别分组可折叠，
       「全部群聊」默认收起、展开可搜——用户才看得出这是不是全部，也才找得到某个群。 */
    var GROUP_CATS=['course','activity','market','chat','other'];
    function groupBoxId(kind){return kind==='wechat'?'wx-groups':'dt-groups';}
    function groupIdOf(row){var value=row.id!==undefined&&row.id!==null?row.id:row.cid;return String(value===null||value===undefined?'':value);}
    function groupTitleOf(row){
      var raw=row.name!==undefined&&row.name!==null?row.name:row.title;
      var name=String(raw===null||raw===undefined?'':raw).trim();
      if(name)return name;
      var id=groupIdOf(row);
      // 钉钉有的会话没有标题：只显示裸群号等于没信息，给「未命名会话（616…）」仍能认出来。
      return '未命名会话（'+(id.length>6?id.slice(0,6)+'…':id)+'）';
    }
    function groupRowLabel(kind,row){
      var id=groupIdOf(row),title=groupTitleOf(row);
      var text=title===id?id:title+' ('+id+')';
      if(kind==='dingtalk')text+=' · '+String(row.members||0)+' 人';
      return text;
    }
    function groupSelectedIds(kind){return (kind==='wechat'?wxSelected:dtSelected)||[];}
    function groupPickedCount(box){
      var seen={},count=0;
      if(!box||!box.querySelectorAll)return 0;
      Array.prototype.forEach.call(box.querySelectorAll('input[type="checkbox"][value]'),function(input){
        var id=String(input.value||'');
        if(!input.checked||!id||seen[id])return;
        seen[id]=true;count+=1;
      });
      return count;
    }
    function groupSyncTwins(box,id,checked){
      Array.prototype.forEach.call(box.querySelectorAll('input[type="checkbox"][value]'),function(input){
        if(String(input.value||'')===id)input.checked=checked;
      });
    }
    function groupSyncAlias(box,id,value){
      Array.prototype.forEach.call(box.querySelectorAll('.wx-alias'),function(input){
        if(input.getAttribute('data-group')===id&&input.value!==value)input.value=value;
      });
    }
    function groupUpdateCount(box){
      var node=box?box.querySelector('[data-gsel-count]'):null;
      if(node)node.textContent='已选 '+groupPickedCount(box)+' 个';
    }
    function groupRowNode(kind,row,checked){
      var id=groupIdOf(row);
      var wrap=document.createElement('div');
      wrap.className='preference '+(kind==='wechat'?'wx-group-row':'dt-group-row');
      wrap.dataset.suggested=row.suggested?'true':'false';
      wrap.dataset.search=(groupTitleOf(row)+' '+id).toLocaleLowerCase();
      var label=document.createElement('label');
      label.className='preference';
      var input=document.createElement('input');
      input.type='checkbox';input.value=id;input.checked=!!checked;
      var meta=document.createElement('span');
      meta.className='group-meta';
      var name=document.createElement('span');
      name.className='group-name';
      name.textContent=groupRowLabel(kind,row);
      meta.appendChild(name);
      appendRecommendation(meta,row);
      label.appendChild(input);label.appendChild(meta);
      wrap.appendChild(label);
      if(kind==='wechat'){
        var alias=document.createElement('input');
        alias.type='text';alias.className='wx-alias';
        alias.placeholder='别名（可选）';
        alias.setAttribute('data-group',id);
        alias.setAttribute('aria-label','群 '+id+' 的别名');
        alias.value=Object.prototype.hasOwnProperty.call(wxAliases,id)?wxAliases[id]:String(row.alias||'');
        wrap.appendChild(alias);
      }
      return wrap;
    }
    function groupCategoryBlock(kind,label,rows,selected){
      var block=document.createElement('div');
      block.className='gsel-cat';
      var heading=document.createElement('h3');
      heading.textContent=label+'（'+rows.length+'）';
      block.appendChild(heading);
      var list=document.createElement('div');
      list.className='gsel-list';
      rows.forEach(function(row){list.appendChild(groupRowNode(kind,row,selected.indexOf(groupIdOf(row))>=0));});
      block.appendChild(list);
      return block;
    }
    function groupFoldButton(boxId,key,label,open){
      var button=document.createElement('button');
      button.type='button';
      button.className='gsel-fold';
      button.dataset.gselFold=key;
      button.setAttribute('aria-expanded',open?'true':'false');
      button.setAttribute('aria-controls',boxId+'-'+key);
      button.appendChild(document.createTextNode(label));
      var chev=document.createElement('span');
      chev.className='gsel-chev';
      chev.setAttribute('aria-hidden','true');
      button.appendChild(chev);
      return button;
    }
    function groupEmptyNode(kind,payload){
      var wrap=document.createElement('div');
      wrap.className='gsel-empty';
      // 真实原因优先：只显示 hint 的话，用户拿到的永远是「去授权」四个字，
      // 看不到「授权没走通（-60007）」这种能直接定位的原文。
      var reason=String(payload.error||'').trim();
      var hint=String(payload.error_hint||'').trim();
      if(!reason)reason=hint;
      else if(hint&&reason.indexOf(hint)<0)reason+='（'+hint+'）';
      var note=document.createElement('p');
      note.className='setting-note';
      if(kind==='wechat'){
        note.textContent=reason||'没有读到会话。请确认已登录桌面微信，再重新检测。';
        wrap.appendChild(note);
        return wrap;
      }
      note.textContent=reason?('没有解析到群：'+reason+'（确认已登录，再点「再试一次」）'):'没有解析到群。按下面三步自查，再点「再试一次」。';
      wrap.appendChild(note);
      var steps=document.createElement('ol');
      [
        '确认'+(kind==='wechat'?'微信':'钉钉')+'已在这台电脑上登录，和SuperDot用的是同一个 Windows 账号。',
        kind==='wechat'?'确认「微信数据目录」填写正确（微信 → 设置 → 文件管理 里的位置）。':'确认钉钉正常打开过一次，未停留在登录页。',
        '刚登录或刚升级时索引尚未建立完成，请等待 1 分钟后重试。'
      ].forEach(function(text){var li=document.createElement('li');li.textContent=text;steps.appendChild(li);});
      wrap.appendChild(steps);
      var retry=document.createElement('button');
      retry.type='button';retry.className='btn primary';retry.dataset.gselRetry='1';retry.textContent='再试一次';
      wrap.appendChild(retry);
      return wrap;
    }
    function groupRetry(kind){var button=document.getElementById(kind==='wechat'?'wx-load-groups':'dt-load-groups');if(button&&!button.disabled)button.click();}
    function groupFilterAll(box,query){
      var list=box.querySelector('[data-gsel-list="all"]');
      if(!list)return;
      var text=String(query||'').trim().toLocaleLowerCase();
      var shown=0;
      Array.prototype.forEach.call(list.querySelectorAll('.wx-group-row,.dt-group-row'),function(row){
        var hit=!text||String(row.dataset.search||'').indexOf(text)>=0;
        row.hidden=!hit;
        if(hit)shown+=1;
      });
      var none=box.querySelector('[data-gsel-nomatch]');
      if(none)none.hidden=shown>0;
    }
    function bindGroupPicker(kind,box){
      box.onclick=function(event){
        var target=event.target;
        if(!target||!target.closest)return;
        var fold=target.closest('[data-gsel-fold]');
        if(fold){
          var key=fold.getAttribute('data-gsel-fold');
          var body=box.querySelector('[data-gsel-body="'+key+'"]');
          var open=fold.getAttribute('aria-expanded')==='true';
          fold.setAttribute('aria-expanded',open?'false':'true');
          if(body)body.hidden=open;
          return;
        }
        if(target.closest('[data-gsel-retry]')){groupRetry(kind);return;}
      };
      box.onchange=function(event){
        var input=event.target;
        if(!input||input.type!=='checkbox')return;
        groupSyncTwins(box,String(input.value||''),input.checked);
        groupUpdateCount(box);
        patchGroupCount(kind,groupPickedCount(box));
      };
      box.oninput=function(event){
        var node=event.target;
        if(!node||!node.classList)return;
        if(node.classList.contains('wx-alias')){groupSyncAlias(box,node.getAttribute('data-group'),node.value);return;}
        if(node.classList.contains('gsel-search'))groupFilterAll(box,node.value);
      };
    }
    function renderGroupPicker(kind,payload){
      var boxId=groupBoxId(kind);
      var box=document.getElementById(boxId);
      if(!box)return;
      var rows=Array.isArray(payload.groups)?payload.groups:[];
      var harvest=harvestGroupEdits(kind,box,groupSelectedIds(kind),kind==='wechat'?wxAliases:null);
      if(kind==='wechat'){wxSelected=harvest.selected;wxAliases=harvest.aliases;}else{dtSelected=harvest.selected;}
      renderSuggestionSource(kind==='wechat'?'wx-suggest-source':'dt-suggest-source',payload.suggest_source);
      box.textContent='';
      // 占位文案的 .setting-note（灰、小字）不能遗传给整块列表，否则群名全变成小灰字。
      box.classList.remove('setting-note');
      if(!rows.length){box.appendChild(groupEmptyNode(kind,payload));syncSavedGroupRows(kind);return;}
      var selected=groupSelectedIds(kind);
      var root=document.createElement('div');
      root.className='gsel';
      var top=document.createElement('p');
      top.className='gsel-top';
      var totalSpan=document.createElement('span');
      totalSpan.textContent='共 '+rows.length+' 个群';
      var suggestedSpan=document.createElement('span');
      var suggestedCount=rows.filter(function(row){return row.suggested;}).length;
      suggestedSpan.textContent='建议订阅 '+suggestedCount+' 个';
      var pickedSpan=document.createElement('span');
      pickedSpan.setAttribute('data-gsel-count','1');
      pickedSpan.textContent='已选 0 个';
      top.appendChild(totalSpan);top.appendChild(suggestedSpan);top.appendChild(pickedSpan);
      root.appendChild(top);
      var recRows=rows.filter(function(row){return row.suggested;});
      var recSection=document.createElement('section');
      recSection.className='gsel-sec';
      var recHead=document.createElement('div');
      recHead.className='gsel-sec-head';
      recHead.appendChild(groupFoldButton(boxId,'rec','建议订阅（'+recRows.length+' 个）',true));
      var pickAll=document.createElement('button');
      pickAll.type='button';pickAll.className='btn';pickAll.dataset.gselPickAll='1';pickAll.dataset.selectList='#'+box.id;pickAll.dataset.selectFilter='[data-suggested="true"] input[type=checkbox]';pickAll.dataset.selectSuffix='建议';pickAll.textContent='全选建议';
      recHead.appendChild(pickAll);
      recSection.appendChild(recHead);
      var recBody=document.createElement('div');
      recBody.className='gsel-sec-body';
      recBody.dataset.gselBody='rec';
      recBody.id=boxId+'-rec';
      GROUP_CATS.forEach(function(category){
        var members=recRows.filter(function(row){return String(row.category||'other')===category;});
        if(!members.length)return;
        recBody.appendChild(groupCategoryBlock(kind,groupCategoryName(category),members,selected));
      });
      if(!recRows.length){
        var none=document.createElement('p');
        none.className='setting-note';
        none.textContent='这批没有可推荐的群，可在下方「全部群聊」中勾选。';
        recBody.appendChild(none);
      }
      recSection.appendChild(recBody);
      root.appendChild(recSection);
      var allSection=document.createElement('section');
      allSection.className='gsel-sec';
      var allHead=document.createElement('div');
      allHead.className='gsel-sec-head';
      allHead.appendChild(groupFoldButton(boxId,'all','全部群聊（'+rows.length+' 个）',false));
      allSection.appendChild(allHead);
      var allBody=document.createElement('div');
      allBody.className='gsel-sec-body';
      allBody.dataset.gselBody='all';
      allBody.id=boxId+'-all';
      allBody.hidden=true;
      var search=document.createElement('input');
      search.type='search';search.className='gsel-search';
      search.placeholder='搜群名或群号…';
      search.setAttribute('aria-label','按群名搜索全部群');
      allBody.appendChild(search);
      var allList=document.createElement('div');
      allList.className='gsel-list';
      allList.dataset.gselList='all';
      rows.slice().sort(function (left, right) {
        return Number(selected.includes(groupIdOf(right))) - Number(selected.includes(groupIdOf(left)));
      }).forEach(function (row) {
        allList.appendChild(groupRowNode(kind, row, selected.includes(groupIdOf(row))));
      });
      allBody.appendChild(allList);
      var nomatch=document.createElement('p');
      nomatch.className='gsel-nomatch';nomatch.dataset.gselNomatch='1';nomatch.hidden=true;
      nomatch.textContent='没有匹配的群。可以换一个关键词。';
      allBody.appendChild(nomatch);
      allSection.appendChild(allBody);
      root.appendChild(allSection);
      box.appendChild(root);
      bindGroupPicker(kind,box);
      syncSavedGroupRows(kind);
      groupUpdateCount(box);
    }
   var dtBox=el('section','surface hosting-settings dingtalk-settings');dtBox.id='dingtalk-settings-card';dtBox.dataset.settingAnchor='dingtalk';
    dtBox.innerHTML='<h2 class="section-title">钉钉接入</h2><p class="setting-note">只读本机钉钉数据库；仅处理勾选群聊。</p><label class="preference"><input id="dt-enabled" type="checkbox"><span><strong>启用钉钉</strong><small>请先登录本机钉钉。</small></span></label><p id="dt-status" class="setting-note" role="status" aria-live="polite">正在检测…</p><p class="setting-note"><button id="dt-reconnect" class="btn" type="button" hidden>重连监听</button></p><p id="dt-scan" class="setting-note" role="status" aria-live="polite"></p><button id="dt-scan-now" class="btn" type="button">立即扫描一次</button><div class="field"><span>我的群</span><button id="dt-load-groups" class="btn" type="button">拉取我的群</button><button id="dt-cancel-groups" class="btn" type="button" hidden>取消拉取</button></div><div id="dt-suggest-source" class="group-source" hidden></div><div id="dt-groups" class="setting-note">点击拉取钉钉群。</div><button id="dt-save" class="btn primary" type="button">保存钉钉设置</button><p id="dt-result" class="setting-note" role="status" aria-live="polite"></p>';
    root.appendChild(dtBox);
    var dtSelected=[];var dtLoaded=false;
    function renderDingtalkGroups(payload){dtLoaded=true;renderGroupPicker('dingtalk',payload);}
    api('/api/settings').then(function(v){document.getElementById('dt-enabled').checked=!!v.dingtalk_enabled;dtSelected=v.dingtalk_group_whitelist||[];syncSavedGroupRows('dingtalk');});
    // 扫描启动失败的真原因不能被 1.5 秒一次的轮询冲掉：拦 30 秒（同 guide.js 的 holdSetupStatus 写法）。
    function updateScanStatus(source){api('/api/'+source+'/status').then(function(v){var target=document.getElementById(source==='dingtalk'?'dt-scan':'wx-scan');if(!target)return;if(v.scan_state==='running')target.textContent='⟳ '+(v.scan_stage||'正在扫描…')+' 已用 '+Number(v.scan_elapsed_seconds||0).toFixed(1)+' 秒';else if(v.scan_state==='error'){var scanMsg=v.error_hint||v.last_error||v.scan_stage||'未知错误';if(v.detail)scanMsg+='（'+v.detail+'）';target.textContent='扫描失败：'+scanMsg;}else if(v.last_read_at)target.textContent='最近读取：'+v.last_read_at+(v.last_read_seconds?'，用时 '+Number(v.last_read_seconds).toFixed(1)+' 秒':'');else target.textContent=v.scan_state==='disabled'?'扫描未启用':'等待扫描';}).catch(function(e){var target=document.getElementById(source==='dingtalk'?'dt-scan':'wx-scan');if(target)target.textContent='状态读取失败：'+e.message;});}
 function refreshDingtalkStatus(){api('/api/dingtalk/status').then(function(v){var node=document.getElementById('dt-status');node.textContent=v.state||'状态未知';node.dataset.state=v.running?'ok':(v.enabled?'warn':'');var reconnect=document.getElementById('dt-reconnect');if(reconnect)reconnect.hidden=!(v.enabled&&!v.running&&Number(v.groups||0)>0);updateScanStatus('dingtalk');}).catch(function(e){document.getElementById('dt-status').textContent='状态读取失败：'+e.message;});}
    refreshDingtalkStatus();
    setupGroupPull({path:'/api/dingtalk/groups',boxId:'dt-groups',buttonId:'dt-load-groups',cancelButtonId:'dt-cancel-groups',idleButtonText:'拉取我的群',busyButtonText:'正在拉取…',busyCopy:'正在读取钉钉群…',longWaitCopy:function(){return '首次读取可能较久，正在扫描数据库…';},render:renderDingtalkGroups});
     document.getElementById('dt-scan-now').onclick=function(){var button=this;button.disabled=true;api('/api/dingtalk/scan',{method:'POST',body:'{}'}).then(function(v){if(v.started===false){var box=document.getElementById('dt-scan');if(v.already_running){box.textContent=v.message||'扫描正在进行中，等这一轮跑完会自动刷新。';updateScanStatus('dingtalk');}else if(v.ok){box.textContent='未开始扫描：'+(v.error||'先勾选并保存群，或先启用钉钉');}else{box.textContent='扫描启动失败：'+(v.error||'未知原因');}return;}if(!v.ok)throw new Error(v.error||'扫描失败');updateScanStatus('dingtalk');}).catch(function(e){document.getElementById('dt-scan').textContent='扫描启动失败：'+e.message;}).then(function(){button.disabled=false;});}; dingtalkScanTimer = setInterval(function(){updateScanStatus('dingtalk');},1500);
// 「重连监听」与「保存钉钉设置」走同一条链路：重新提交当前配置，后端就会重连监听。
function saveDingtalkSettings(){var button=document.getElementById('dt-save');if(button)button.disabled=true;var boxes=document.querySelectorAll('#dt-groups input[type=checkbox]');var groups=[];var seenGroups={};Array.prototype.forEach.call(boxes,function(x){if(x.checked&&!seenGroups[x.value]){seenGroups[x.value]=true;groups.push(x.value);}});api('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dingtalk_enabled:document.getElementById('dt-enabled').checked,dingtalk_group_whitelist:boxes.length?groups:dtSelected.slice()})}).then(function(v){if(!v.ok)throw new Error(v.error||'保存失败');if(boxes.length)dtSelected=groups.slice();document.getElementById('dt-result').textContent='已保存，正在重新连接监听…';refreshDingtalkStatus();}).catch(function(e){dtLoaded=false;document.getElementById('dt-result').textContent='保存失败：'+e.message;}).then(function(){if(button)button.disabled=false;});}
document.getElementById('dt-save').onclick=saveDingtalkSettings;
document.getElementById('dt-reconnect').onclick=saveDingtalkSettings;
    var wxBox=el('section','surface hosting-settings wechat-settings');wxBox.id='wechat-settings-card';wxBox.dataset.settingAnchor='wechat';
    wxBox.innerHTML='<h2 class="section-title">微信接入</h2><p id="wx-status" class="setting-note" role="status"></p><label class="preference"><input type="checkbox" id="wx-enabled"><span>自动读取已订阅会话</span></label><div class="wb-actions"><button id="wx-load-groups" class="btn" type="button">检测本机微信</button><button id="wx-cancel-groups" class="btn" type="button" hidden>取消读取</button></div><div id="wx-suggest-source" class="group-source" hidden></div><div id="wx-groups"></div><button id="wx-save" class="btn primary" type="button">保存订阅</button><p id="wx-result" class="setting-note" role="status"></p><details id="wx-connection"><summary>本机连接设置</summary><label class="field"><span>数据库解密密钥</span><input id="wx-key" type="password" autocomplete="off"></label><button id="wx-key-save" class="btn" type="button">保存密钥</button><p id="wx-key-status" class="setting-note" role="status"></p><label class="field"><span>微信数据目录（默认自动查找）</span><input id="wx-dir-input" type="text"></label><button id="wx-dir-save" class="btn" type="button">保存目录</button><p id="wx-dir-status" class="setting-note" role="status"></p></details>';
    root.appendChild(wxBox);
    var wxSelected=[];var wxAliases={};
    // C：已保存白名单里的群即使没拉到列表也要有行可操作——渲染成「id + 移除」，
    // 移除只改本地选中集合，等用户点「保存微信设置/保存钉钉设置」才生效，不偷偷自动保存。
    function groupSelectionIds(kind){return (kind==='wechat'?wxSelected:dtSelected)||[];}
    function currentGroupCount(kind){
      var box=document.getElementById(kind==='wechat'?'wx-groups':'dt-groups');
      return box?box.querySelectorAll('input[type="checkbox"]:checked').length:0;
    }
    function patchGroupCount(kind,count){
      var node=document.getElementById(kind==='wechat'?'wx-status':'dt-status');
      if(!node)return;
      node.textContent=node.textContent.replace(/已选 \d+ 个群/,'已选 '+count+' 个群');
    }
    function removeGroupSelection(kind,id,wrap,input){
      id=String(id);
      if(input)input.checked=false;
      var list=groupSelectionIds(kind),next=[];
      for(var i=0;i<list.length;i+=1)if(String(list[i])!==id)next.push(String(list[i]));
      if(kind==='wechat')wxSelected=next;else dtSelected=next;
      // 拉取来的行保留（取消勾选即可再选回）；已保存白名单那行删掉，别留个空勾选框。
      if(wrap&&wrap.getAttribute('data-saved-group'))wrap.remove();
      patchGroupCount(kind,currentGroupCount(kind));
    }
    function appendSavedGroupRow(kind, box, id){
      var wrap=document.createElement('div');
      wrap.className='preference '+(kind==='wechat'?'wx-group-row':'dt-group-row');
      wrap.setAttribute('data-saved-group','1');
      var label=document.createElement('label');
      label.className='preference';
      var input=document.createElement('input');
      input.type='checkbox';input.value=id;input.checked=true;
      input.setAttribute('aria-label','已选群 '+id);
      var meta=document.createElement('span');
      meta.className='group-meta';
      var name=document.createElement('span');
      name.className='group-name';
      name.textContent=id;   // 没拉到群名就显示 id 本身，不编「未命名」
      meta.appendChild(name);
      label.appendChild(input);
      label.appendChild(meta);
      wrap.appendChild(label);
      var remove=document.createElement('button');
      remove.type='button';
      remove.className='btn';
      remove.textContent='移除';
      remove.setAttribute('aria-label','移除已选群 '+id);
      // 取消勾选也同步到本地选中集合，别让「保存」再把它提交回去。
      input.onchange=function(){
        var list=groupSelectionIds(kind),next=[],found=false;
        for(var k=0;k<list.length;k+=1){
          if(String(list[k])===id){found=true;if(input.checked)next.push(id);}
          else next.push(String(list[k]));
        }
        if(input.checked&&!found)next.push(id);
        if(kind==='wechat')wxSelected=next;else dtSelected=next;
        patchGroupCount(kind,currentGroupCount(kind));
      };
      remove.onclick=function(){removeGroupSelection(kind,id,wrap,input);};
      wrap.appendChild(remove);
      var target=box.querySelector('[data-gsel-list="all"]')||box;
      target.appendChild(wrap);
    }
    function syncSavedGroupRows(kind){
      var boxId=kind==='wechat'?'wx-groups':'dt-groups';
      var box=document.getElementById(boxId);
      if(!box)return;
      var stale=box.querySelectorAll('[data-saved-group]');
      for(var i=0;i<stale.length;i+=1)stale[i].remove();
      var ids=groupSelectionIds(kind);
      for(var j=0;j<ids.length;j+=1){
        var id=String(ids[j]||'').trim();
        if(!id)continue;
        if(Array.from(box.querySelectorAll('input[type=checkbox]')).some(input => input.value === id))continue;   // 拉取行已覆盖，不重复
        appendSavedGroupRow(kind,box,id);
      }
    }
    function renderWechatGroups(payload){renderGroupPicker('wechat',payload);}
    function refreshWechatStatus() {
      return api('/api/wechat/status').then(function (value) {
        var status = wxBox.querySelector('#wx-status');
        status.textContent = value.supported === false
          ? '本机微信读取支持 macOS 和 Windows。'
          : (value.scan_state === 'error' ? (value.error_hint || value.state) : (value.running ? value.state : ''));
        setWechatKeyStatus(value.manual_key ? '解密密钥已配置。' : '', value.manual_key ? 'ok' : '');
        return value;
      }).catch(function (error) { wxBox.querySelector('#wx-status').textContent = error.message; });
    }
function normalizeWechatKey(raw) {
  return String(raw === null || raw === undefined ? '' : raw).replace(/\s+/g, '').toLowerCase();
}
function wechatKeyProblem(key) {
  if (!key) return '请先粘贴 64 位十六进制密钥。';
  if (!/^[0-9a-f]{64}$/.test(key)) return '密钥必须是 64 位十六进制（0-9、a-f）。当前为 ' + key.length + ' 位，请检查是否有漏粘或多粘。';
  return '';
}
function setWechatKeyStatus(text, state) {
  var node = document.getElementById('wx-key-status');
  if (!node) return;
  node.textContent = text;
  node.dataset.state = state || '';
}
function setWechatDirStatus(text, state) {
  var node = document.getElementById('wx-dir-status');
  if (!node) return;
  node.textContent = text;
  node.dataset.state = state || '';
}
function saveWechatKey() {
  var input = document.getElementById('wx-key');
  var button = document.getElementById('wx-key-save');
  if (!input) return;
  var key = normalizeWechatKey(input.value);
  var problem = wechatKeyProblem(key);
  if (problem) { setWechatKeyStatus(problem, 'error'); input.focus(); return; }
  if (button) button.disabled = true;
  setWechatKeyStatus('正在保存…', '');
  api('/api/settings', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({wechat_key: key})}).then(function (v) {
    if (!v || !v.ok) throw new Error((v && v.error) || '保存失败');
    input.value = '';
    refreshWechatStatus().then(function () {
      var subscription = document.querySelector('#tab-settings [data-goto="wechat-subscriptions"]');
      if (subscription) subscription.click();
      document.getElementById('wx-load-groups').click();
    });
  }).catch(function (error) {
    setWechatKeyStatus('保存失败：' + error.message, 'error');
  }).then(function () { if (button) button.disabled = false; });
}
    api('/api/settings').then(function(v){document.getElementById('wx-enabled').checked=!!v.wechat_enabled;wxSelected=v.wechat_group_whitelist||[];wxAliases=v.wechat_group_aliases||{};var keep=settingsUnsaved||{};var dirInput=document.getElementById('wx-dir-input');if(dirInput&&!keep['wx-dir-input'])dirInput.value=typeof v.wechat_dir==='string'?v.wechat_dir:'';syncSavedGroupRows('wechat');});
    // 微信数据目录：后端 POST /api/settings 的 wechat_dir，空=清空回到自动查找，保存后立即生效。
    function saveWechatDir(){
      var input=document.getElementById('wx-dir-input');
      var button=document.getElementById('wx-dir-save');
      if(!input)return;
      var value=String(input.value||'').trim();
      if(button)button.disabled=true;
      setWechatDirStatus('正在保存…','');
      api('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wechat_dir:value})}).then(function(v){
        if(v&&v.ok===false)throw new Error(v.error||'保存失败');
        var saved=v&&typeof v.wechat_dir==='string'?v.wechat_dir:value;
        input.value=saved;
        // 已保存成功：标记清掉，下次重建设置页按服务端真值走，不把旧值当「未保存的编辑」。
        if(input.dataset)delete input.dataset.nhDirty;
        setWechatDirStatus(saved?'已保存，立即生效。':'已保存，立即生效。现在自动查找微信数据目录。','ok');
        // 目录换了，旧的群列表就不作数了：清掉并提示重新拉，避免对着上个目录的群去保存。
        var groupsBox=document.getElementById('wx-groups');
        if(groupsBox)groupsBox.textContent='已保存目录。点「检测本机微信」刷新。';

        refreshWechatStatus();
      }).catch(function(e){
        // 后端原文直接给用户看（例如「微信数据目录不存在：…」），别吞成通用失败。
        setWechatDirStatus('保存失败：'+String((e&&e.message)||e),'error');
      }).then(function(){if(button)button.disabled=false;});
    }
    document.getElementById('wx-dir-save').onclick=saveWechatDir;
    document.getElementById('wx-dir-input').addEventListener('keydown',function(event){if(event.key==='Enter'){event.preventDefault();saveWechatDir();}});
     function saveEnabledToggle(inputId,resultId,key,after){var input=document.getElementById(inputId),result=document.getElementById(resultId);input.addEventListener('change',function(){var enabled=input.checked;input.disabled=true;var payload={};payload[key]=enabled;api('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).then(function(v){if(!v.ok)throw new Error(v.error||'保存失败');result.textContent=enabled?'已启用':'已关闭';if(after)after();}).catch(function(e){input.checked=!enabled;result.textContent='保存失败，已恢复原状态：'+e.message;}).then(function(){input.disabled=false;});});}
     saveEnabledToggle('wx-enabled','wx-result','wechat_enabled');
     // 钉钉勾选即存，和微信动作一致：以前只勾不点「保存钉钉设置」，后端仍是未启用，用户读作「未应用」。
     saveEnabledToggle('dt-enabled','dt-result','dingtalk_enabled',refreshDingtalkStatus);
    // 实验室：默认收起，勾选即存（写 .env 的 QQ_DIGEST_LAB_*，后端热生效），不用再手改 .env。
    // 1.1.0 转正式版：实验室不再有开关，自动整理规则独立成一张卡，挂进「提醒与订阅」组。
    var rulesCard=el('section','surface hosting-settings rules-settings');
    rulesCard.id='rules-settings-card';
    rulesCard.dataset.settingAnchor='rules';
    var screeningChannels = [
      ['qq', 'QQ', 'groups'], ['wechat', '微信', 'wechat-subscriptions'],
      ['dingtalk', '钉钉', 'dingtalk-subscriptions'], ['chaoxing', '学习通', 'chaoxing-subscriptions']
    ];
    var screeningWindows = [
      ['lookback_minutes', '向前每段最多回看（分钟）', 10080],
      ['lookback_count', '向前每段最多回看（条）', 200],
      ['collect_minutes', '命中后至少等待（分钟）', 1440],
      ['quiet_minutes', '静默等待（分钟）', 1440],
      ['max_minutes', '最长收集时间（分钟）', 1440]
    ];
    function windowFields(prefix) {
      return '<div class="package-rule-windows">'+screeningWindows.map(([name, label, max]) =>
        '<label>'+label+'<input type="number" name="'+prefix+name+'" min="1" max="'+max+'" required></label>'
      ).join('')+'</div>';
    }
    rulesCard.innerHTML='<h2 class="section-title">消息触发规则</h2>'
      +'<form class="package-rule" id="channel-screening"><fieldset disabled>'
      +'<h3>通用规则</h3><div data-keyword-library></div><small data-keyword-count></small>'
      +'<details class="settings-extra"><summary>回看和等待时间</summary>'+windowFields('')+'</details>'
      +'<h3>渠道规则</h3><div class="channel-switch" role="group" aria-label="选择渠道">'
      +screeningChannels.map(([key,label]) => '<button type="button" data-select-channel="'+key+'" aria-controls="rules-'+key+'">'+label+'</button>').join('')
      +'</div>'+screeningChannels.map(([key,label,anchor]) => {
        const qq = key === 'qq';
        return '<section hidden data-screening-channel="'+key+'" id="rules-'+key+'" aria-label="'+label+'规则">'
          +'<button class="btn" data-screening-goto="'+anchor+'" type="button">'+(key==='chaoxing'?'选择监听课程':'选择监听会话')+'</button>'
          +(qq?'':'<label class="preference"><input type="checkbox" name="'+key+'-enabled"> 启用组包</label>')
          +'<label class="preference"><input type="checkbox" name="'+key+'-inherit"> '+(qq?'使用通用关键词和等待时间（含已订阅私聊）':'使用通用关键词')+'</label>'
          +'<div data-custom="'+key+'"><label class="field">专属关键词<input name="'+key+'-keywords" placeholder="多个关键词用逗号分隔"></label>'
          +(qq?'<details class="settings-extra"><summary>QQ 群回看和等待时间</summary>'+windowFields('qq-')+'</details>':'')+'</div>'
          +(qq?'<fieldset><legend>触发消息的群成员 <button type="button" class="btn" data-select-list="#qq-member-roles">全选</button></legend><div id="qq-member-roles" class="package-rule-roles"><label><input type="checkbox" name="role" value="owner"> 群主</label><label><input type="checkbox" name="role" value="admin"> 管理员</label><label><input type="checkbox" name="include_self"> 我自己</label></div></fieldset>':'')
          +'<label class="field">'+(qq?'其他成员的 QQ 号':'指定发送者')+'<input name="'+key+'-senders" placeholder="'+(qq?'多个号码用逗号分隔':'姓名或 ID，留空不限')+'"></label></section>';
      }).join('')
      +'<button class="btn primary" type="submit">保存规则</button></fieldset><p role="status"></p></form>'
      +'<details class="settings-extra" id="legacy-rules" hidden><summary>旧版消息分类规则</summary>'
      +'<label class="preference rules-master"><span>启用旧版分类</span><input id="lab-rules-master" type="checkbox" disabled></label>'
      +'<div id="lab-rules-editor">'
      +'<div id="lab-rules-list" class="lab-rule-list"></div>'
      +'<div class="lab-rule-actions"><button type="button" class="btn" data-select-filter=".lab-rule-enabled" data-select-list="#lab-rules-list">全选</button><button id="lab-rules-save" class="btn" type="button">保存旧版规则</button></div>'
      +'</div>'
      +'<p id="lab-rules-status" class="setting-note" role="status" aria-live="polite"></p>'
      +'</details>';
    root.appendChild(rulesCard);
    var screeningForm = rulesCard.querySelector('#channel-screening');
    var screeningFields = screeningForm.querySelector('fieldset');
    var screeningStatus = screeningForm.querySelector('[role="status"]');
    function screeningWords(value) {
      return value.split(/[,，\n]/).map(function (word) { return word.trim(); }).filter(Boolean);
    }
    const fields = screeningForm.elements;
    let savedQQ, keywordLibrary;
    const activeWords = new Set();
    function selectChannel(key) {
      screeningForm.querySelectorAll('[data-select-channel]').forEach(button =>
        button.setAttribute('aria-pressed', String(button.dataset.selectChannel === key)));
      screeningForm.querySelectorAll('[data-screening-channel]').forEach(panel =>
        panel.hidden = panel.dataset.screeningChannel !== key);
    }
    function showInheritance(key) {
      const custom = screeningForm.querySelector('[data-custom="'+key+'"]');
      custom.hidden = fields[key+'-inherit'].checked;
      custom.querySelectorAll('input').forEach(input => input.disabled = custom.hidden);
    }
    screeningChannels.forEach(([key,label,anchor]) => {
      screeningForm.querySelector('[data-select-channel="'+key+'"]').onclick = () => selectChannel(key);
      screeningForm.querySelector('[data-screening-goto="'+anchor+'"]').onclick = () =>
        document.querySelector('#tab-settings [data-goto="'+anchor+'"]').click();
      fields[key+'-inherit'].onchange = () => showInheritance(key);
    });
    selectChannel('qq');
    screeningForm.addEventListener('invalid', event => {
      const panel = event.target.closest('[data-screening-channel]');
      if (panel) selectChannel(panel.dataset.screeningChannel);
      const details = event.target.closest('details.settings-extra');
      if (details) details.open = true;
    }, true);
    function readWindows(prefix) {
      return Object.fromEntries(screeningWindows.map(([key]) => [key, Number(fields[prefix+key].value)]));
    }
    function readQQ() {
      return {...readWindows('qq-'), roles:Array.from(screeningForm.querySelectorAll('[name="role"]:checked'), input => input.value),
        include_self:fields.include_self.checked, keywords:screeningWords(fields['qq-keywords'].value),
        sender_ids:screeningWords(fields['qq-senders'].value)};
    }
    Promise.all([api('/api/settings/screening'), api('/api/settings/package-rule')]).then(([data, qq]) => {
      if (!screeningForm.isConnected) return;
      const screening = data.screening;
      keywordLibrary = data.keyword_library;
      screening.keywords.forEach(word => activeWords.add(word));
      const library = screeningForm.querySelector('[data-keyword-library]');
      const wordButtons = new Map();
      function syncWords() {
        wordButtons.forEach((words, button) => {
          const list = words();
          button.textContent = list.length && list.every(word => activeWords.has(word)) ? '取消全选' : '全选';
        });
        library.querySelectorAll('input[type=checkbox]').forEach(input => input.checked = activeWords.has(input.value));
        screeningForm.querySelector('[data-keyword-count]').textContent = activeWords.size
          ? '已启用 '+activeWords.size+' 个关键词' : '未启用关键词，消息按其他条件筛选';
      }
      function selectWordsButton(words) {
        const button = el('button', 'btn', '全选');
        button.type = 'button';
        wordButtons.set(button, words);
        button.classList.add('bulk-link');
        button.onclick = () => {
          const list = words();
          const select = list.some(word => !activeWords.has(word));
          list.forEach(word => select ? activeWords.add(word) : activeWords.delete(word));
          syncWords();
        };
        return button;
      }
      library.append(selectWordsButton(() => Object.values(keywordLibrary).flat()));
      Object.entries(keywordLibrary).forEach(([category, words]) => {
        const group = el('details', 'settings-extra');
        const summary = el('summary');
        const choices = el('div', 'keyword-choices');
        const tools = el('div', 'scope-manual');
        const input = el('input','input');
        input.placeholder = '输入新关键词';
        input.setAttribute('aria-label', category+'新关键词');
        input.maxLength = 100;
        const add = el('button','btn','添加');
        const edit = el('button','btn','删除关键词');
        add.type = edit.type = 'button';
        let deleting = false;
        function render() {
          summary.textContent = category+'（'+words.length+'）';
          choices.replaceChildren();
          edit.textContent = deleting ? '完成删除' : '删除关键词';
          edit.setAttribute('aria-pressed', String(deleting));
          words.forEach(word => {
            const chip = el('span','keyword-chip');
            const label = el('label');
            const check = document.createElement('input');
            check.type = 'checkbox';
            check.value = word;
            check.onchange = () => {
              if (check.checked) activeWords.add(word); else activeWords.delete(word);
              syncWords();
            };
            label.append(check, document.createTextNode(word));
            chip.append(label);
            if (deleting) {
              const remove = el('button','keyword-remove','×');
              remove.type = 'button';
              remove.setAttribute('aria-label','删除'+word);
              remove.onclick = () => {
                words.splice(words.indexOf(word),1);
                if (!Object.values(keywordLibrary).some(list => list.includes(word))) activeWords.delete(word);
                render();
              };
              chip.append(remove);
            }
            choices.append(chip);
          });
          syncWords();
        }
        add.onclick = () => {
          const word = input.value.trim();
          if (!word) return input.focus();
          if (!words.includes(word)) words.push(word);
          activeWords.add(word);
          input.value = '';
          render();
          input.focus();
        };
        input.onkeydown = event => {
          if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); add.click(); }
        };
        edit.onclick = () => { deleting = !deleting; render(); };
        tools.append(selectWordsButton(() => words), input, add, edit);
        group.append(summary, tools, choices);
        library.append(group);
        render();
      });
      screeningWindows.forEach(([key]) => {
        fields[key].value = screening.windows[key];
        fields['qq-'+key].value = qq.rule[key];
      });
      screeningChannels.forEach(([key]) => {
        const rule = screening.channels[key];
        fields[key+'-inherit'].checked = rule.inherit;
        fields[key+'-keywords'].value = (key==='qq'?qq.rule.keywords:rule.keywords).join('，');
        fields[key+'-senders'].value = (key==='qq'?qq.rule.sender_ids:rule.senders).join('，');
        if (key !== 'qq') fields[key+'-enabled'].checked = rule.enabled;
        showInheritance(key);
      });
      screeningForm.querySelectorAll('[name="role"]').forEach(input => input.checked = qq.rule.roles.includes(input.value));
      fields.include_self.checked = qq.rule.include_self;
      scheduleBulkSync();
      savedQQ = JSON.stringify(readQQ());
      legacyRules.hidden = !qq.legacy_rules?.count;
      if (!legacyRules.hidden) setRulesMaster(qq.legacy_rules.enabled);
      screeningFields.disabled = false;
    }).catch(error => screeningStatus.textContent = '规则读取失败：'+error.message);
    screeningForm.onsubmit = async event => {
      event.preventDefault();
      const channels = Object.fromEntries(screeningChannels.map(([key]) => [key, {
        inherit:fields[key+'-inherit'].checked, enabled:key==='qq'||fields[key+'-enabled'].checked,
        keywords:key==='qq'?[]:screeningWords(fields[key+'-keywords'].value),
        senders:key==='qq'?[]:screeningWords(fields[key+'-senders'].value)
      }]));
      const payload = {keywords:Array.from(activeWords), keyword_library:keywordLibrary, windows:readWindows(''), channels};
      const qq = readQQ();
      if (JSON.stringify(qq) !== savedQQ) payload.qq_rule = qq;
      screeningFields.disabled = true;
      try {
        await api('/api/settings/screening', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
        savedQQ = JSON.stringify(qq);
        screeningStatus.textContent = '规则已保存';
      } catch (error) {
        screeningStatus.textContent = '保存失败：'+error.message;
      } finally {
        screeningFields.disabled = false;
      }
    };
    // 规则编辑器：一条规则一张卡片，用户看不到 JSON。规则存在 <data_dir>/rules.json，页面直接读写。
    // 数据变换（后端规则 <-> 卡片）全在 js/lab-rules.js 的 NhLabRules 里，这里只管渲染和读表单。
    var rulesEditor=document.getElementById('lab-rules-editor');
    var rulesList=document.getElementById('lab-rules-list');
    // 任何在卡片里敲过的输入都算「未保存编辑」：装载响应回来时要保留（loadRulesKeepingEdits）。
    if(rulesList){
      rulesList.addEventListener('input',function(event){var node=event.target&&event.target.closest?event.target.closest('.lab-rule-card'):null;if(node)node.dataset.dirty='1';});
      rulesList.addEventListener('change',function(event){var node=event.target&&event.target.closest?event.target.closest('.lab-rule-card'):null;if(node)node.dataset.dirty='1';});
    }
    var rulesStatus=document.getElementById('lab-rules-status');
    var legacyRules=rulesCard.querySelector('#legacy-rules');
    var CATEGORY_NAMES=window.CATEGORY_LABELS||{urgent:'紧急',action:'待办',academic:'学业',info:'通知'};
    function setRulesStatus(text,state){if(!rulesStatus)return;rulesStatus.textContent=text;rulesStatus.dataset.state=state||'';}
    // 自动整理总开关：默认开，写 .env 后热生效，不用重启。关掉不删规则。
    var rulesMaster=document.getElementById('lab-rules-master');
    function setRulesMaster(on){rulesMaster.checked=!!on;rulesMaster.disabled=false;rulesEditor.hidden=!on;}
    if(rulesMaster)rulesMaster.addEventListener('change',function(){
      var want=rulesMaster.checked;
      rulesMaster.disabled=true;
      api('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lab_rules:want})}).then(function(v){
        if(!v.ok)throw new Error(v.error||'保存失败');
        var actual=!!(v.lab&&v.lab.rules);
        setRulesMaster(actual);
        setRulesStatus('', '');
        if(actual)loadRulesIntoEditor();
      }).catch(function(e){rulesMaster.checked=!want;setRulesStatus('保存失败，已恢复原状：'+e.message,'error');}).then(function(){rulesMaster.disabled=false;});
    });
    function rulesToolkit(){return window.NhLabRules||null;}
    function categoryOptions(current){return ['urgent','action','academic','info'].map(function(key){return '<option value="'+key+'"'+(key===current?' selected':'')+'>'+(CATEGORY_NAMES[key]||key)+'</option>';}).join('');}
    function ruleField(node,selector){return node.querySelector(selector);}
    function makeRuleCard(card){
      card=card||{};
      var node=document.createElement('div');node.className='lab-rule-card';
      node.__nhRaw=card.raw||null;
      node.dataset.ruleId=card.id||'';   // 服务端原来的名字：改名后刷新时用它认出旧卡，别留一张幽灵卡
      node.innerHTML='<div class="lab-rule-head">'
        +'<label class="field lab-rule-name-field"><span>规则名称</span><input class="lab-rule-name" type="text" placeholder="例如：班委通知" autocomplete="off"></label>'
        +'<button class="btn ghost lab-rule-remove" type="button">删除</button>'
        +'</div>'
        +'<div class="lab-rule-block">'
        +'<p class="lab-rule-legend">什么时候命中</p>'
        +'<div class="lab-rule-grid">'
        +'<label class="field"><span>关键词</span><input class="lab-rule-keywords" type="text" placeholder="报名, 截止, 开会" autocomplete="off"></label>'
        +'<label class="field"><span>指定发件人</span><input class="lab-rule-senders" type="text" placeholder="QQ 号或昵称，留空不限" autocomplete="off"></label>'
        +'</div>'
        +'<label class="preference"><input class="lab-rule-atme" type="checkbox"><span><strong>只处理 @我 的消息</strong></span></label>'
        +'<label class="preference"><input class="lab-rule-useregex" type="checkbox"><span><strong>使用正则（高级）</strong><small>开启后，条件按正则表达式匹配。</small></span></label>'
        +'<label class="field lab-rule-regex" hidden><span>正则（逗号分隔多条）</span><input class="lab-rule-regextext" type="text" placeholder="如 ^【通知】" autocomplete="off"></label>'
        +'<p class="setting-note lab-rule-hint">关键词、正则、指定发件人、只处理 @我 —— 至少填一项。</p>'
        +'</div>'
        +'<div class="lab-rule-block">'
        +'<p class="lab-rule-legend">转为工单时的默认值</p>'
        +'<div class="lab-rule-grid">'
        +'<label class="field"><span>工单标题</span><input class="lab-rule-summary" type="text" placeholder="留空就用消息第一行" autocomplete="off"></label>'
        +'<label class="field"><span>分类</span><select class="lab-rule-category">'+categoryOptions(card.category)+'</select></label>'
        +'</div>'
        +'</div>'
        +'<div class="lab-rule-block">'
        +'<p class="lab-rule-legend">范围</p>'
        +'<div class="lab-rule-grid">'
        +'<label class="field"><span>适用对话</span><select class="lab-rule-scope"><option value="all">所有对话</option><option value="groups">指定对话</option></select></label>'
        +'<label class="field lab-rule-groups" hidden><span>对话 ID（逗号分隔）</span><input class="lab-rule-grouptext" type="text" placeholder="例如：123456789, private:987654321" autocomplete="off"></label>'
        +'</div>'
        +'</div>'
        +'<div class="lab-rule-foot">'
        +'<label class="preference"><input class="lab-rule-enabled" type="checkbox"><span><strong>启用这条规则</strong></span></label>'
        +'<p class="lab-rule-error" role="alert" hidden></p>'
        +'</div>';
      ruleField(node,'.lab-rule-name').value=card.id||'';
      ruleField(node,'.lab-rule-keywords').value=card.keywordText||'';
      ruleField(node,'.lab-rule-senders').value=card.senderText||'';
      ruleField(node,'.lab-rule-regextext').value=card.regexText||'';
      ruleField(node,'.lab-rule-summary').value=card.summary||'';
      ruleField(node,'.lab-rule-grouptext').value=card.scopeText||'';
      ruleField(node,'.lab-rule-atme').checked=card.atMe===true;
      ruleField(node,'.lab-rule-useregex').checked=card.useRegex===true;
      ruleField(node,'.lab-rule-enabled').checked=card.enabled!==false;
      ruleField(node,'.lab-rule-scope').value=card.scopeMode==='groups'?'groups':'all';
      ruleField(node,'.lab-rule-regex').hidden=card.useRegex!==true;
      ruleField(node,'.lab-rule-groups').hidden=card.scopeMode!=='groups';
      ruleField(node,'.lab-rule-useregex').addEventListener('change',function(event){ruleField(node,'.lab-rule-regex').hidden=!event.target.checked;});
      ruleField(node,'.lab-rule-scope').addEventListener('change',function(event){ruleField(node,'.lab-rule-groups').hidden=event.target.value!=='groups';});
      ruleField(node,'.lab-rule-remove').addEventListener('click',function(){node.remove();});
      return node;
    }
    function readRuleCard(node){
      return {
        id:ruleField(node,'.lab-rule-name').value,
        enabled:ruleField(node,'.lab-rule-enabled').checked,
        scopeMode:ruleField(node,'.lab-rule-scope').value,
        scopeText:ruleField(node,'.lab-rule-grouptext').value,
        keywordText:ruleField(node,'.lab-rule-keywords').value,
        atMe:ruleField(node,'.lab-rule-atme').checked,
        useRegex:ruleField(node,'.lab-rule-useregex').checked,
        regexText:ruleField(node,'.lab-rule-regextext').value,
        senderText:ruleField(node,'.lab-rule-senders').value,
        summary:ruleField(node,'.lab-rule-summary').value,
        category:ruleField(node,'.lab-rule-category').value,
        raw:node.__nhRaw||null
      };
    }
    function ruleNodes(){return Array.prototype.slice.call(document.querySelectorAll('#lab-rules-list .lab-rule-card'));}
    function clearRuleErrors(nodes){nodes.forEach(function(node){node.classList.remove('is-invalid');var box=ruleField(node,'.lab-rule-error');if(box){box.hidden=true;box.textContent='';}});}
    function markRuleError(message,nodes){
      var match=/第\s*(\d+)\s*条/.exec(String(message||''));
      var index=match?Number(match[1])-1:0;
      var node=nodes[index]||nodes[0];
      if(!node)return;
      node.classList.add('is-invalid');
      var box=ruleField(node,'.lab-rule-error');
      if(box){box.hidden=false;box.textContent=String(message||'');}
    }
    function renderRuleCards(cards){
      if(!rulesList)return;
      rulesList.textContent='';
      (cards||[]).forEach(function(card){rulesList.appendChild(makeRuleCard(card));});
    }
    function loadRulesIntoEditor(){
      var toolkit=rulesToolkit();
      if(!rulesList||!toolkit){setRulesStatus('规则组件没加载成功，请刷新页面重试。','error');return;}
      // 装载期间用户可能已点「新增」/改过卡片：响应回来不能把它冲掉（未保存的行原样接回末尾）。
      loadRulesKeepingEdits({
        list:rulesList,
        request:function(){return api('/api/lab/rules');},
        toCards:function(rules){return toolkit.rulesToCards(rules);},
        render:renderRuleCards,
        readId:function(node){var name=node.querySelector?node.querySelector('.lab-rule-name'):null;return name?String(name.value||'').trim():'';}
      }).then(function(count){setRulesStatus(count?('已载入 '+count+' 条规则。'):'','');})
        .catch(function(e){
          // 总开关关着时读规则会被拒：那就是「关着」，不是故障，把开关摆回关位。
          if(String(e&&e.message||e).indexOf('已关闭')>=0){setRulesMaster(false);return;}
          setRulesStatus('读取规则失败：'+e.message,'error');
        });
    }
    legacyRules.addEventListener('toggle', function () {
      if (this.open && rulesMaster.checked) loadRulesIntoEditor();
    });
    var rulesSave=document.getElementById('lab-rules-save');
    if(rulesSave)rulesSave.onclick=function(){
      var toolkit=rulesToolkit();
      var nodes=ruleNodes();
      if(!toolkit){setRulesStatus('规则组件没加载成功，请刷新页面重试。','error');return;}
      var mapped=toolkit.cardsToRules(nodes.map(readRuleCard));
      clearRuleErrors(nodes);
      if(!mapped.ok){markRuleError(mapped.error,nodes);setRulesStatus(mapped.error,'error');return;}
      rulesSave.disabled=true;
      api('/api/lab/rules',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rules:mapped.rules})}).then(function(v){
        if(!v.ok)throw new Error(v.error||'保存失败');
        nodes.forEach(function(node){node.dataset.ruleId=String(ruleField(node,'.lab-rule-name').value||'').trim();});
        setRulesStatus('已保存 '+v.count+' 条规则。','ok');
      }).catch(function(e){var message=String(e&&e.message||e);markRuleError(message,nodes);setRulesStatus('保存失败：'+message,'error');}).then(function(){rulesSave.disabled=false;});
    };
    setupGroupPull({
      path:'/api/wechat/groups?setup=1',boxId:'wx-groups',buttonId:'wx-load-groups',cancelButtonId:'wx-cancel-groups',
      idleButtonText:'检测本机微信',busyButtonText:'等待授权…',busyCopy:'正在检测：若弹出系统授权框，输密码后等它扫完，别重复点…',
      render:renderWechatGroups,after:refreshWechatStatus,
      renderError:function(result){
        var box=document.getElementById('wx-groups');
        box.replaceChildren(groupEmptyNode('wechat',result));
        syncSavedGroupRows('wechat');
      }
    });
    refreshWechatStatus();
    document.getElementById('wx-key-save').onclick=saveWechatKey;
    document.getElementById('wx-key').addEventListener('keydown',function(event){if(event.key==='Enter'){event.preventDefault();saveWechatKey();}});
document.getElementById('wx-save').onclick=function(){var boxes=document.querySelectorAll('#wx-groups input[type=checkbox]');var groups=[];var seenGroups={};Array.prototype.forEach.call(boxes,function(x){if(x.checked&&!seenGroups[x.value]){seenGroups[x.value]=true;groups.push(x.value);}});var aliases={};Object.keys(wxAliases).forEach(function(k){aliases[k]=wxAliases[k];});Array.prototype.forEach.call(document.querySelectorAll('#wx-groups .wx-alias'),function(x){var gid=x.getAttribute('data-group');var val=x.value.trim();if(val)aliases[gid]=val;else delete aliases[gid];});var body={wechat_enabled:document.getElementById('wx-enabled').checked,wechat_group_aliases:aliases};body.wechat_group_whitelist=boxes.length?groups:wxSelected.slice();api('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(v){if(!v.ok)throw new Error(v.error||'保存失败');if(boxes.length)wxSelected=groups.slice();wxAliases=aliases;document.getElementById('wx-result').textContent='订阅已保存。';refreshWechatStatus();}).catch(function(e){document.getElementById('wx-result').textContent='保存失败：'+e.message;});};
    bindChaoxingSettings(cxBox);
    function placeSubscriptionCard(anchor, title, channel, controls) {
      var card = el('section', 'surface hosting-settings ' + channel.className.split(' ').filter(function (name) {
        return name.endsWith('-settings') && name !== 'hosting-settings';
      }).join(' '));
      card.dataset.settingAnchor = anchor;
      var heading = el('h2', 'section-title', title);
      card.append(heading, ...controls);
      const rules = el('button', 'btn', '查看触发规则');
      rules.type = 'button';
      rules.onclick = () => {
        const key = anchor.split('-')[0];
        selectChannel(key);
        document.querySelector('#tab-settings [data-goto="rules"]').click();
      };
      card.append(rules);
      root.append(card);
      return card;
    }
    function manualGroup(kind) {
      const field = el('div', 'scope-manual');
      const input = el('input', 'input');
      input.placeholder = kind === 'wechat' ? '输入微信会话 ID' : '输入钉钉群 ID';
      input.setAttribute('aria-label', input.placeholder);
      const add = el('button', 'btn', '添加');
      add.type = 'button';
      add.onclick = () => {
        const id = input.value.trim();
        if (!id) return input.focus();
        const box = document.getElementById(groupBoxId(kind));
        const matches = Array.from(box.querySelectorAll('input[type=checkbox]')).filter(row => row.value === id);
        if (matches.length) matches.forEach(row => { row.checked = true; });
        else appendSavedGroupRow(kind, box, id);
        if (!groupSelectionIds(kind).includes(id)) groupSelectionIds(kind).push(id);
        input.value = '';
        document.getElementById(kind === 'wechat' ? 'wx-result' : 'dt-result').textContent = '已添加，保存后生效。';
      };
      input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); add.click(); } };
      field.append(input, add);
      return field;
    }
    function selectAllGroups(selector) {
      const button = el('button', 'btn', '全选');
      button.type = 'button';
      button.dataset.selectList = selector;
      return button;
    }
    var wxLoad = document.getElementById('wx-load-groups');
    placeSubscriptionCard('wechat-subscriptions', '微信订阅会话', wxBox, [
      document.getElementById('wx-enabled').closest('label'), manualGroup('wechat'), wxLoad.parentElement, selectAllGroups('#wx-groups'), document.getElementById('wx-suggest-source'), document.getElementById('wx-groups'),
      document.getElementById('wx-save'), document.getElementById('wx-result')
    ]);
    placeSubscriptionCard('dingtalk-subscriptions', '钉钉订阅会话', dtBox, [
      document.getElementById('dt-enabled').closest('label'), manualGroup('dingtalk'), document.getElementById('dt-load-groups').parentElement, selectAllGroups('#dt-groups'), document.getElementById('dt-suggest-source'),
      document.getElementById('dt-groups'), document.getElementById('dt-save'), document.getElementById('dt-result')
    ]);
    var refreshCourses = document.getElementById('cx-load-courses');
    placeSubscriptionCard('chaoxing-subscriptions', '学习通订阅课程', cxBox, [
      refreshCourses, document.getElementById('cx-subscriptions')
    ]);
    ['wechat', 'dingtalk', 'chaoxing'].forEach(function (channel) {
      var card = channel === 'wechat' ? wxBox : channel === 'dingtalk' ? dtBox : cxBox;
      var button = el('button', 'btn', channel === 'wechat' ? '选择微信会话' : channel === 'dingtalk' ? '选择钉钉群聊' : '选择学习通课程');
      button.type = 'button';
      button.onclick = function () {
        document.querySelector('#tab-settings [data-goto="' + channel + '-subscriptions"]').click();
      };
      card.append(button);
    });

   root.appendChild(pairCard());
  setupPairCard();
  (function setupSyncCard() {
    var input = document.getElementById('sync-url');
    var qrImage = document.getElementById('sync-qr');
    var qrMessage = document.getElementById('sync-qr-message');
    var status = document.getElementById('sync-status');
    var copyButton = document.getElementById('sync-copy');
    var testButton = document.getElementById('sync-test');
    function setStatus(message, state) { status.textContent = message; status.dataset.state = state || ''; }
    function setQrMessage(message) { qrMessage.textContent = message; }
    function webcalAddress(raw) {
      var value = String(raw || '').trim();
      var parsed = new URL(value);
      if (!parsed.hostname || parsed.username || parsed.password || !['http:', 'https:', 'webcal:'].includes(parsed.protocol)) throw new Error('请输入包含主机名的 HTTP、HTTPS 或 webcal 订阅地址。');
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') input.dataset.testScheme = parsed.protocol;
      else if (!input.dataset.testScheme) input.dataset.testScheme = 'http:';
      return value.replace(/^https?:/i, 'webcal:');
    }
    function renderSyncQr() {
      try {
        var address = webcalAddress(input.value);
        if (input.value !== address) input.value = address;
        qrMessage.textContent = '';
        qrImage.hidden = false;
        qrImage.onload = function () { setQrMessage(''); };
        qrImage.onerror = function () { qrImage.hidden = true; setQrMessage('二维码生成失败；请检查地址长度后重试。'); };
        qrImage.src = '/api/sync/qr.png?text=' + encodeURIComponent(address) + '&token=' + encodeURIComponent(setupToken) + '&t=' + Date.now();
      } catch (error) {
        qrImage.hidden = true;
        qrImage.removeAttribute('src');
        setQrMessage(error.message || '订阅地址无效。');
      }
    }
    var altList = document.getElementById('sync-alts');
    // B3：备选地址收进默认折叠的 details，每条写清是哪一类、哪个主机，别让用户在一排按钮里猜。
    function addressChoiceLabel(item) {
      var host = '';
      try { host = new URL(item.url).hostname; } catch (error) {}
      var kind = {lan: '局域网', public: '公网', tailscale: 'Tailscale', cellular: '手机热点', virtual: '虚拟网卡'}[item.kind] || '';
      var text = [kind, host].filter(function (part) { return !!part; }).join(' · ');
      return text || item.name || '备用地址';
    }
    function renderAddressChoices(calendars, current) {
      var others = (calendars || []).filter(function (item) { return item && item.url && item.url !== current; });
      altList.textContent = '';
      if (!others.length) { altList.hidden = true; return; }
      altList.hidden = false;
      var details = document.createElement('details');
      details.className = 'sync-alt-details';
      var summary = document.createElement('summary');
      summary.textContent = '换一个地址（' + others.length + ' 个）';
      details.appendChild(summary);
      var list = document.createElement('div');
      list.className = 'sync-alt-list';
      others.forEach(function (item) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn ghost sync-alt';
        button.textContent = addressChoiceLabel(item);
        button.title = (item.hint ? item.hint + '；' : '') + item.url;
        button.onclick = function () {
          input.value = item.url;
          delete input.dataset.edited;
          try { input.dataset.testScheme = new URL(item.url).protocol; } catch (error) { input.dataset.testScheme = ''; }
          // 输入框、二维码、公网/局域网提示都取同一条地址，别再各说各的。
          renderPublicNote(item);
          renderSyncQr();
          renderAddressChoices(calendars, item.url);
          setStatus('已切换为' + addressChoiceLabel(item) + '，二维码和提示语一起换新。', '');
        };
        list.appendChild(button);
      });
      details.appendChild(list);
      altList.appendChild(details);
    }
    function manualCopy() {
      input.focus();
      input.select();
      try {
        if (document.execCommand('copy')) { setStatus('订阅链接已复制。', 'success'); return; }
      } catch (error) {}
      setStatus('浏览器不允许复制；地址已选中，请手动复制。', 'error');
    }
    copyButton.onclick = function () {
      try { input.value = webcalAddress(input.value); } catch (error) { setStatus(error.message, 'error'); return; }
      renderSyncQr();
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') { manualCopy(); return; }
      try { navigator.clipboard.writeText(input.value).then(function () { setStatus('订阅链接已复制。', 'success'); }, manualCopy); } catch (error) { manualCopy(); }
    };
    testButton.onclick = function () {
      var requestUrl;
      try {
        input.value = webcalAddress(input.value);
        requestUrl = input.value.replace(/^webcal:/i, input.dataset.testScheme || 'http:');
      } catch (error) { setStatus(error.message, 'error'); return; }
      testButton.disabled = true;
      setStatus('正在让本机服务读取这个地址…', '');
      setupApi('/api/sync/test?url=' + encodeURIComponent(requestUrl)).then(function (data) {
        setStatus('本机服务能读取这个地址，包含 ' + data.events + ' 条事项。手机能不能订阅，请用手机打开同一地址确认。', 'success');
      }).catch(function (error) {
        var raw = String((error && error.message) || error || '').replace(/[。.\s]+$/, '');
        setStatus('本机服务读不到这个地址：' + raw + '。点上方其他地址可以换一个，或直接用手机打开这个地址确认。', 'error');
      }).then(function () { testButton.disabled = false; });
    };
    input.addEventListener('input', function () { input.dataset.testScheme = ''; input.dataset.edited = '1'; renderSyncQr(); });
    // 公网地址排第一是后端给的顺序，但页面别依赖它：手机用流量只能走公网那条。
    // B3：后端会标 primary（公网第一、其次唯一推荐的一条）；没有 primary 再退回公网/第一条。
    function primaryAddress(calendars) {
      var list = (calendars || []).filter(function (item) { return item && item.url; });
      var primary = list.filter(function (item) { return item.primary === true; })[0];
      if (primary) return primary;
      var publicItem = list.filter(function (item) { return item.kind === 'public'; })[0];
      return publicItem || list[0] || null;
    }
    function renderPublicNote(item) {
      var note = document.getElementById('sync-public-note');
      var actions = document.getElementById('sync-public-actions');
      if (!note || !actions) return;
      note.hidden = false;
      if (item && item.kind === 'public') {
        note.textContent = '可通过移动网络更新日历。';
        note.dataset.state = 'ok';
        actions.hidden = true;
        return;
      }
      note.textContent = '当前订阅地址仅在同一网络内可用。';
      note.dataset.state = 'warn';
      actions.hidden = false;
    }
    function scrollToPublicBlock() {
      var options = document.getElementById('sync-public-block');
      if (options) {
        options.open = true;
        scrollTargetIntoView(options, 'smooth');
      }
    }
    function refreshSyncInfo() {
      fetch('/api/sync/info', {headers: {'X-Token': token}, cache: 'no-store'}).then(function (response) {
        return response.json().then(function (data) { if (!response.ok || !data.ok) throw new Error(data.error || ('HTTP ' + response.status)); return data; });
      }).then(function (data) {
        var calendar = primaryAddress(data.calendars);
        if (!calendar || !calendar.url) throw new Error('没有可用的订阅地址');
        renderPublicNote(calendar);
        // 用户手改过地址（比如粘一条公网地址来测）就别被静默刷新冲掉：
        // 想换回自动识别的地址，点「换一个地址」里的那条即可（会自动清掉 edited）。
        if (input.dataset.edited !== '1') {
          input.value = calendar.url;
          try { input.dataset.testScheme = new URL(calendar.url).protocol; } catch (error) { input.dataset.testScheme = ''; }
        }
        renderSyncQr();
        renderAddressChoices(data.calendars, calendar.url);
        if (status.dataset.state === 'error') setStatus('', '');
      }).catch(function (error) {
        renderPublicNote(null);
        setStatus('无法确定局域网订阅地址：' + (error.message || '请粘贴公网地址重试'), 'error');
        renderSyncQr();
      });
    }
    var publicButton = document.getElementById('sync-public-open');
    if (publicButton) publicButton.onclick = scrollToPublicBlock;
    refreshSyncInfo();
  })();
  var themeBox = document.createElement('section'); themeBox.className='surface hosting-settings'; themeBox.dataset.settingAnchor='appearance';
  themeBox.innerHTML='<h2 class="section-title">主题与动效</h2><img class="whale-preview" src="/whale/done.png" width="76" height="76" alt="">'
    +'<fieldset id="pref-font-scale" class="theme-choice-list"><legend>字号</legend>'
    +'<label class="theme-option"><input name="pref-font-scale" type="radio" value="default"><span class="theme-option-body"><strong>默认</strong></span></label>'
    +'<label class="theme-option"><input name="pref-font-scale" type="radio" value="large"><span class="theme-option-body"><strong>偏大</strong></span></label>'
    +'<label class="theme-option"><input name="pref-font-scale" type="radio" value="xlarge"><span class="theme-option-body"><strong>很大</strong></span></label>'
    +'<p id="pref-font-scale-note" class="setting-note">只影响这一台设备的浏览器</p></fieldset>'
    +'<fieldset id="pref-theme" class="theme-choice-list"><legend>主题</legend>'
    +'<label class="theme-option"><input name="pref-theme" type="radio" value="auto"><span class="theme-option-body"><strong>跟随系统</strong></span></label>'
    +'<label class="theme-option"><input name="pref-theme" type="radio" value="light"><span class="theme-option-body"><strong>浅色</strong></span></label>'
    +'<label class="theme-option"><input name="pref-theme" type="radio" value="dark"><span class="theme-option-body"><strong>深色</strong></span></label>'
    +'<p id="pref-theme-note" class="setting-note">仅保存在此浏览器</p></fieldset>'
    +'<fieldset class="preference-list local-preferences"><legend>界面动效</legend><label class="preference"><input id="pref-motion-enabled" type="checkbox"><span><strong>轻微动效</strong><small id="pref-motion-note"></small></span></label></fieldset>'
    +'<fieldset id="pref-accent" class="theme-choice-list"><legend>强调色</legend>'
    +'<div class="accent-swatches" role="radiogroup" aria-label="强调色">'
    +'<button type="button" class="accent-swatch" role="radio" aria-checked="true" data-accent="#2459D3" data-accent-soft="#EAF0FF" aria-label="蓝色" title="蓝色" style="background:#2459D3"></button>'
    +'<button type="button" class="accent-swatch" role="radio" aria-checked="false" data-accent="#8B5E74" data-accent-soft="#EFE1E7" aria-label="梅紫" title="梅紫" style="background:#8B5E74"></button>'
    +'<button type="button" class="accent-swatch" role="radio" aria-checked="false" data-accent="#B0713F" data-accent-soft="#F3E4D6" aria-label="赭橙" title="赭橙" style="background:#B0713F"></button>'
    +'<button type="button" class="accent-swatch" role="radio" aria-checked="false" data-accent="#5E7B8B" data-accent-soft="#DFE7EB" aria-label="黛蓝" title="黛蓝" style="background:#5E7B8B"></button>'
    +'<button type="button" class="accent-swatch" role="radio" aria-checked="false" data-accent="#6E6A5E" data-accent-soft="#E6E4DD" aria-label="石墨" title="石墨" style="background:#6E6A5E"></button>'
    +'</div><p class="setting-note">用在主按钮、选中态与焦点环。</p></fieldset>'
    +'<fieldset id="pref-notice-tint" class="theme-choice-list"><legend>通知颜色</legend>'
    +'<div class="accent-swatches" role="radiogroup" aria-label="通知颜色">'
    +'<button type="button" class="accent-swatch" role="radio" aria-checked="true" data-tint="" aria-label="跟随纸面" title="跟随纸面" style="background:var(--paper-raise)"></button>'
    +'<button type="button" class="accent-swatch" role="radio" aria-checked="false" data-tint="#5C6B44" aria-label="鼠尾草" title="鼠尾草" style="background:color-mix(in srgb,#5C6B44 30%,var(--paper-raise))"></button>'
    +'<button type="button" class="accent-swatch" role="radio" aria-checked="false" data-tint="#8B5E74" aria-label="梅紫" title="梅紫" style="background:color-mix(in srgb,#8B5E74 30%,var(--paper-raise))"></button>'
    +'<button type="button" class="accent-swatch" role="radio" aria-checked="false" data-tint="#B0713F" aria-label="赭橙" title="赭橙" style="background:color-mix(in srgb,#B0713F 30%,var(--paper-raise))"></button>'
    +'<button type="button" class="accent-swatch" role="radio" aria-checked="false" data-tint="#5E7B8B" aria-label="黛蓝" title="黛蓝" style="background:color-mix(in srgb,#5E7B8B 30%,var(--paper-raise))"></button>'
    +'<button type="button" class="accent-swatch" role="radio" aria-checked="false" data-tint="#6E6A5E" aria-label="石墨" title="石墨" style="background:color-mix(in srgb,#6E6A5E 30%,var(--paper-raise))"></button>'
    +'</div><p class="setting-note">右上角悬浮通知那层磨砂玻璃的底色，与强调色同一套色；颜色会和纸面调和，玻璃质感不变。只保存在此浏览器。</p></fieldset>';
  function petSwitches(pairs, attribute) {
    return pairs.map(function (pair) {
      return '<label class="preference"><input type="checkbox" '+attribute+'="'+pair[0]+'"> '+pair[1]+'</label>';
    }).join('');
  }
  function petGroup(title, controls) {
    return '<details class="pet-options"><summary>'+title+'</summary><div>'+controls+'</div></details>';
  }
  themeBox.insertAdjacentHTML('beforeend',
    '<fieldset id="desktop-pet-settings" class="preference-list local-preferences" disabled><legend>大肥鱼桌宠</legend>'
    +'<p id="pref-desktop-pet-status" role="status">正在读取桌宠状态…</p>'
    +'<div class="hosting-actions">'
    +'<button type="button" class="btn primary" data-pet-action="launch" hidden>启动桌宠</button>'
    +'<button type="button" class="btn" id="pet-visibility" hidden>显示桌宠</button>'
    +'<button type="button" class="btn" data-pet-action="open-settings" hidden>高级桌宠设置</button>'
    +'<button type="button" class="btn" data-pet-action="quit" hidden>退出桌宠</button></div>'
    +'<div id="pet-native-options" hidden>'
    +petGroup('外观与交互',
      '<label class="field"><span>桌宠大小（像素）</span><input type="number" min="1" step="1" data-pet-native="size"></label>'
      +petSwitches([['fixedEnabled','固定位置'],['confineToScreen','限制在屏幕内'],['trayEnabled','显示托盘图标'],
        ['clickSoundEnabled','点击音效'],['balanceEnabled','定时显示余额'],['whisperEnabled','自动碎碎念'],
        ['workStatusEnabled','显示工作状态'],['whisperImageEnabled','碎碎念配图'],['chatImageEnabled','对话配图'],
        ['chatAnimationEnabled','对话动画']], 'data-pet-native'))
    +petGroup('原生通知与语音', petSwitches([['notificationsEnabled','桌宠通知'],['notifyWhenFocused','窗口聚焦时仍提醒'],
        ['voiceEnabled','启用语音'],['voiceWhisperEnabled','朗读自动碎碎念'],['voiceTodoEnabled','朗读待办提醒'],
        ['voiceNotifyEnabled','朗读通知']], 'data-pet-native')
      +'<label class="field"><span>语音音量 <output id="pet-volume"></output></span>'
      +'<input type="range" min="0" max="100" step="1" data-pet-native="voiceVolume"></label>')+'</div>'
    +'<label class="preference"><input id="pref-desktop-pet" type="checkbox"> 桌宠播报工单</label>'
    +petGroup('工单播报选项','<div id="desktop-pet-reminder-options">'
      +petSwitches([['created','已转为工单'],['action','需要我处理'],['result','成果可查看'],['problem','执行中断'],['speech','出声提醒']], 'data-pet-reminder')
      +'</div><div class="hosting-actions"><button type="button" class="btn" data-pet-action="preview">试播一条</button></div>')
    +'<div class="hosting-actions"><button type="button" class="btn" id="pet-pending">查看待处理</button></div></fieldset>');
  var petPanel = themeBox.querySelector('#desktop-pet-settings');
  var desktopPetToggle = petPanel.querySelector('#pref-desktop-pet');
  var desktopPetStatus = petPanel.querySelector('#pref-desktop-pet-status');
  var petChoices = Array.from(petPanel.querySelectorAll('[data-pet-reminder]'));
  var nativeControls = Array.from(petPanel.querySelectorAll('[data-pet-native]'));
  var visibilityButton = petPanel.querySelector('#pet-visibility');
  var volumeLabel = petPanel.querySelector('#pet-volume');
  var petStatus = null;
  var petSaveInProgress = false;
  var localPet = ['127.0.0.1','localhost','[::1]'].includes(location.hostname);
  function showDesktopPet(data) {
    petStatus = data;
    desktopPetToggle.checked = data.enabled;
    petChoices.forEach(function (choice) {
      choice.checked = Boolean((data.preferences || {})[choice.dataset.petReminder]);
      choice.disabled = !data.enabled;
    });
    petPanel.disabled = false;
    petPanel.querySelector('[data-pet-action="preview"]').disabled = !localPet || !data.connected || data.visible === false || !data.enhanced;
    var native = data.native || {};
    petPanel.querySelector('[data-pet-action="launch"]').hidden = !localPet || data.connected;
    ['quit', 'open-settings'].forEach(function (action) {
      petPanel.querySelector('[data-pet-action="'+action+'"]').hidden = !localPet || !data.connected || (action === 'quit' && data.system_managed);
    });
    visibilityButton.hidden = !localPet || !data.connected || typeof native.visible !== 'boolean';
    visibilityButton.textContent = native.visible ? '隐藏桌宠' : '显示桌宠';
    visibilityButton.classList.toggle('primary', native.visible === false);
    petPanel.querySelector('#pet-native-options').hidden = !localPet || !data.connected || !Object.keys(native).length;
    nativeControls.forEach(function (input) {
      var key = input.dataset.petNative;
      input.disabled = native[key] == null;
      if (input.type === 'checkbox') input.checked = native[key] === true;
      else if (key === 'voiceVolume') {
        input.value = Math.round(native[key] * 100);
        volumeLabel.value = native[key] == null ? '' : input.value + '%';
      } else if (input !== document.activeElement) input.value = native[key] == null ? '' : native[key];
    });
    desktopPetStatus.textContent = data.message || (!data.connected ? '桌宠未启动' :
      data.visible === false ? '桌宠已隐藏' : '桌宠已连接');
  }
  function loadDesktopPet() {
    if (petSaveInProgress || !petPanel.isConnected || document.hidden) return;
    api('/api/settings/desktop-pet').then(function (data) {
      if (!petSaveInProgress) showDesktopPet(data);
    }).catch(function (error) {
      desktopPetStatus.textContent = '读取桌宠设置失败。' + error.message;
    });
  }
  function submitDesktopPet(payload) {
    if (petSaveInProgress) return;
    petSaveInProgress = true;
    petPanel.disabled = true;
    api('/api/settings/desktop-pet', {method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload)}).then(function (data) {
      showDesktopPet(data);
      if (payload.action === 'preview') desktopPetStatus.textContent = '试播已发给桌宠';
    }).catch(function (error) {
      if (payload.key === 'size') petPanel.querySelector('[data-pet-native="size"]').value = petStatus.native.size;
      if (petStatus) showDesktopPet(petStatus);
      desktopPetStatus.textContent = error.message;
    }).finally(function () { petSaveInProgress = false; petPanel.disabled = !petStatus; });
  }
  visibilityButton.onclick = function () {
    submitDesktopPet({action:'native', key:'visible', value:!petStatus.native.visible});
  };
  petPanel.querySelector('[data-pet-native="voiceVolume"]').oninput = function () {
    volumeLabel.value = this.value + '%';
  };
  petPanel.onchange = function (event) {
    var input = event.target;
    if (input.dataset.petNative) {
      if (!input.checkValidity() || input.value === '') {
        input.reportValidity();
        input.value = petStatus.native[input.dataset.petNative];
        return;
      }
      var value = input.type === 'checkbox' ? input.checked : Number(input.value);
      if (input.dataset.petNative === 'voiceVolume') value /= 100;
      submitDesktopPet({action:'native', key:input.dataset.petNative, value:value});
      return;
    }
    var preferences = {};
    petChoices.forEach(function (choice) { preferences[choice.dataset.petReminder] = choice.checked; });
    submitDesktopPet({enabled:desktopPetToggle.checked, preferences:preferences});
  };
  petPanel.querySelectorAll('[data-pet-action]').forEach(function (button) {
    button.onclick = function () { submitDesktopPet({action:button.dataset.petAction}); };
  });
  petPanel.querySelector('#pet-pending').onclick = function () { location.hash = '#tasks?pending=1'; };
  window.addEventListener('superdot-desktop-pet', function (event) {
    if (petPanel.isConnected && !petSaveInProgress && petStatus !== event.detail &&
        (petStatus === null || JSON.stringify(petStatus) !== JSON.stringify(event.detail))) showDesktopPet(event.detail);
  });
  root.appendChild(themeBox); initFontScalePreference(); initThemePreference(); initAccentPreference(); initNoticeTintPreference();
  loadDesktopPet();
  var hostingBox = document.createElement('div'); hostingBox.className='hosting-settings hosting-panel'; hostingBox.dataset.settingAnchor='hosting';
  hostingBox.innerHTML = `<h2 class="section-title">运行设置</h2>
    <div class="hosting-legacy">
      <div id="hosting-status" role="status" aria-live="polite"></div>
      <div class="hosting-actions hosting-actions-main">
        <button id="hosting-start" class="btn primary" type="button">开始托管</button>
        <button id="hosting-stop" class="btn" type="button">结束托管</button>
      </div>
      <label class="field"><span>开始托管前退出桌面 QQ</span><input id="pref-quit_qq" type="checkbox"></label>
      <label class="field"><span>结束托管后打开桌面 QQ</span><input id="pref-restore_qq" type="checkbox"></label>
      <label class="field"><span>退出 SuperDot 时打开桌面 QQ</span><input id="pref-quit_restore_qq" type="checkbox"></label>
      <label class="field"><span>启动时自动开始托管</span><input id="pref-auto_on_start" type="checkbox"></label>
    </div>
    <div class="settings-rows">
      <label class="field"><span>开机启动 SuperDot</span><input id="pref-autostart" type="checkbox"></label>
      <label class="field"><span>显示桌面浮球</span><input id="pref-floatball-enabled" type="checkbox"></label>
    </div>
    <p id="hosting-result" class="sync-status" role="status" aria-live="polite"></p>
    <div class="settings-subsection">
      <h3 class="settings-group-title">补收 QQ 群消息</h3>
      <label class="field"><span>启动时补收已订阅群的消息</span><input id="pref-catchup-enabled" type="checkbox" disabled></label>
      <label class="field"><span>向前补收的天数</span><input id="pref-catchup-days" type="number" disabled min="1" max="365" step="1" value="1"></label>
      <div class="settings-row-actions">
        <button id="pref-catchup-save" class="btn" type="button" disabled>保存补收设置</button>
        <p id="pref-catchup-result" role="status" aria-live="polite"></p>
      </div>
    </div>`;

  var pushPanel = document.createElement('section');
  pushPanel.className = 'surface hosting-settings';
  pushPanel.dataset.settingAnchor = 'push';
  pushPanel.innerHTML = `<h2 class="section-title">手机接收工单提醒</h2>
    <div id="push-settings" class="push-settings">
      <p>选择你平时用的通知渠道，例如微信或工作群。保存后可以发一条测试消息。</p>
      <details class="push-channel" data-channel="wxpusher"><summary>WxPusher 微信推送 <small class="setting-note">发给指定微信用户</small></summary>
        <p>在官网创建标准推送应用，填写应用密钥。接收人关注应用后，在「用户管理」中获取接收人 UID。</p>
        <a class="push-help" data-help="wxpusher" target="_blank" rel="noreferrer">打开 WxPusher</a>
        <label class="field"><span>应用密钥</span><input id="push-wxpusher_key" type="password" autocomplete="off" spellcheck="false"></label>
        <label class="field"><span>接收人 UID</span><input id="push-wxpusher_uids" type="text" autocomplete="off" aria-label="WxPusher UID" placeholder="多个 UID 用逗号分隔"></label>
        <details class="settings-extra"><summary>群发设置</summary>
          <p>填写话题 ID，把同一条提醒发给订阅该话题的人。</p>
          <label class="field"><span>话题 ID</span><input id="push-wxpusher_topic_ids" type="text" autocomplete="off"></label>
        </details>
      </details>
      <details class="push-channel" data-channel="serverchan"><summary>Server 酱 <small class="setting-note">用已有的 Server 酱收提醒</small></summary>
        <p>登录官网，在发送密钥页面获取密钥。</p>
        <a class="push-help" data-help="serverchan" target="_blank" rel="noreferrer">打开 Server 酱</a>
        <label class="field"><span>发送密钥</span><input id="push-serverchan_keys" type="password" autocomplete="off" spellcheck="false"></label>
      </details>
      <details class="push-channel" data-channel="pushplus"><summary>PushPlus <small class="setting-note">收一对一通知</small></summary>
        <p>登录官网，在「一对一消息」中获取用户密钥。</p>
        <a class="push-help" data-help="pushplus" target="_blank" rel="noreferrer">打开 PushPlus</a>
        <label class="field"><span>用户密钥</span><input id="push-pushplus_key" type="password" autocomplete="off" spellcheck="false"></label>
      </details>
      <details class="push-channel" data-channel="custom"><summary>群机器人 <small class="setting-note">发到工作群</small></summary>
        <p>在企业微信、钉钉或飞书的群里添加机器人，再把地址填到这里。钉钉机器人启用加签时，按「地址|签名密钥」填写。</p>
        <label class="field"><span>机器人地址</span><input id="push-robot-urls" type="password" autocomplete="off" spellcheck="false"></label>
      </details>
      <div class="settings-row-actions">
        <button id="push-save" class="btn primary" type="button">保存推送设置</button>
        <button id="push-test" class="btn" type="button" hidden>发送测试消息</button>
      </div>
      <p id="push-result" role="status" aria-live="polite"></p>
      <details id="push-manage" class="settings-extra" hidden><summary>管理已保存的推送设置</summary>
        <button id="push-clear" class="btn destructive" type="button">清除推送配置</button>
      </details>
    </div>`;
  root.appendChild(pushPanel);
  root.appendChild(hostingBox);
  var aiBox = el('section', 'surface hosting-settings');
  aiBox.dataset.settingAnchor = 'llm';
  aiBox.innerHTML = `<h2 class="section-title sr-only" id="llm-settings">AI API Key 配置</h2>
    <form id="llm-form" class="llm-form" aria-labelledby="llm-settings" novalidate>
      <label class="llm-field" for="llm-provider">服务商
        <select id="llm-provider" data-draft-on-edit disabled></select>
      </label>
      <label class="llm-field" id="llm-model-row" for="llm-model">模型
        <select id="llm-model" data-draft-on-edit disabled></select>
      </label>
      <label class="llm-field llm-wide" id="llm-custom-model-row" for="llm-custom-model" hidden>模型 ID
        <input id="llm-custom-model" type="text" data-draft-on-edit autocomplete="off" spellcheck="false" disabled>
      </label>
      <label class="llm-field llm-wide" id="llm-endpoint-row" for="llm-endpoint" hidden>接口地址
        <input id="llm-endpoint" type="url" data-draft-on-edit autocomplete="off" spellcheck="false" disabled>
      </label>
      <div class="llm-key-pair llm-wide" id="llm-key-row">
        <div class="llm-field">
          <div class="llm-label"><label for="llm-key">API Key</label>
            <a id="llm-help-link" target="_blank" rel="noreferrer" hidden>获取 API Key</a>
          </div>
          <input id="llm-key" type="password" data-draft-on-edit autocomplete="off" spellcheck="false" disabled>
        </div>
        <img class="llm-key-art" src="/whale/key-token.png" width="148" height="148" alt="" decoding="async">
      </div>
      <details id="llm-help" class="llm-help llm-wide" hidden>
        <summary>接入说明</summary>
        <p id="llm-help-note"><a id="llm-api-site" target="_blank" rel="noreferrer" hidden></a></p>
      </details>
      <div class="llm-actions llm-wide">
        <button id="llm-save" class="btn primary" type="submit" disabled>保存配置</button>
        <button id="llm-off" class="btn" type="button" disabled>停用配置</button>
        <p id="llm-result" role="status" aria-live="polite"></p>
      </div>
    </form>`;
  root.appendChild(aiBox);
   var motionToggle = document.getElementById('pref-motion-enabled');
  motionToggle.checked = !motionPreferencePaused;
  motionToggle.addEventListener('change', function () { setMotionPreference(motionToggle.checked); });
  updateMotionNote();
  // 桌面浮球开关：勾选即存（POST /api/settings {floatball_enabled}），存进本机 .env 并热生效。
  // 契约归后端（webapp.py 的 settings 路由），这里只按字段名读写；不进 preferenceNames 批处理
  // （那套带「保存设置」按钮语义，和勾选即存冲突）。失败走 showFeedback，不再占独立一行。
  var floatballToggle = document.getElementById('pref-floatball-enabled');
  var floatballSaved = false;
  if (floatballToggle) {
    api('/api/settings').then(function (values) {
      floatballSaved = !!(values && values.floatball_enabled);
      floatballToggle.checked = floatballSaved;
    }).catch(function () {});
    floatballToggle.addEventListener('change', function () {
      var enabled = floatballToggle.checked;
      floatballToggle.disabled = true;
      api('/api/settings', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({floatball_enabled: enabled})}).then(function (result) {
        if (!result || !result.ok) throw new Error((result && result.error) || '保存失败');
        floatballSaved = result.floatball_enabled !== undefined ? !!result.floatball_enabled : enabled;
        showFeedback('桌面浮球已' + (floatballSaved ? '打开' : '关闭'), 'success');
      }).catch(function (error) {
        floatballToggle.checked = floatballSaved;
        showFeedback('桌面浮球设置未保存：' + String((error && error.message) || error), 'error', function () {
          floatballToggle.checked = enabled;
          floatballToggle.dispatchEvent(new Event('change'));
        });
      }).then(function () { floatballToggle.disabled = false; });
    });
  }
  // 公网访问：双通道。默认 Cloudflare 快速通道（不用注册、不用域名），Tailscale 作为
  // 「要固定地址」的备选。状态读 /api/tunnel/status：providers.<通道> 是各通道自己的快照，
  // 顶层 state/message/url 表示当前通道（老后端没有 providers 时退回读顶层）。
  // 开通/重试走 /api/tunnel/start（写操作要 confirm:true，带 provider）；关闭走 /api/tunnel/stop。
  // 轮询只在「开通中」跑，切走设置页即停。
  var tunnelTimer = null;
  var tunnelState = {};
  var tunnelProvider = 'cloudflare';
  var tunnelSwitchConfirmTo = null;
  var tunnelSwitchConfirmTimer = null;
  function stopTunnelPolling() { if (tunnelTimer !== null) { window.clearInterval(tunnelTimer); tunnelTimer = null; } }
  function tunnelProviderName(provider) { return provider === 'tailscale' ? 'Tailscale' : 'Cloudflare'; }
  function isTunnelProvider(provider) { return provider === 'cloudflare' || provider === 'tailscale'; }
  // 各通道自己的「开通中」状态名：Cloudflare 是 downloading/starting，Tailscale 沿用它原来那三个。
  function isTunnelBusy(provider, state) {
    var name = String(state || 'idle');
    if (provider === 'tailscale') return name === 'installing' || name === 'waiting_login' || name === 'enabling';
    return name === 'downloading' || name === 'starting';
  }
  function tunnelSnapshot(payload, provider) {
    var providers = payload && payload.providers;
    if (providers && providers[provider]) return providers[provider] || {};
    // 老后端（没有 providers）：顶层字段只代表它自己的通道，别把它当成另一条通道的状态。
    if (!payload || (payload.provider && payload.provider !== provider)) return {};
    return { installed: payload.installed, state: payload.state, message: payload.message, url: payload.url };
  }
  function clearTunnelSwitchConfirm() {
    if (tunnelSwitchConfirmTimer !== null) { window.clearTimeout(tunnelSwitchConfirmTimer); tunnelSwitchConfirmTimer = null; }
    tunnelSwitchConfirmTo = null;
  }
  function tunnelProvidersRow() {
    var row = '<div class="tunnel-providers" role="group" aria-label="公网通道">';
    [['cloudflare', 'Cloudflare（不用注册）'], ['tailscale', 'Tailscale（固定地址）']].forEach(function (item) {
      var active = item[0] === tunnelProvider;
      row += '<button type="button" class="tunnel-provider" id="tunnel-provider-' + item[0] + '" data-provider="' + item[0] + '"'
        + ' aria-pressed="' + (active ? 'true' : 'false') + '">' + item[1] + '</button>';
    });
    return row + '</div><p id="tunnel-switch-note" class="setting-note" role="status" aria-live="polite"></p>';
  }
  function switchTunnelProvider(next) {
    stopTunnelPolling();
    var note = document.getElementById('tunnel-switch-note');
    if (note) note.textContent = '正在切换到 ' + tunnelProviderName(next) + '…';
    api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tunnel_provider: next }) }).then(function (result) {
      if (!result || !result.ok) throw new Error((result && result.error) || '保存失败');
      tunnelProvider = isTunnelProvider(result.tunnel_provider) ? result.tunnel_provider : next;
      return refreshTunnelStatus();
    }).catch(function (error) {
      // 高亮不跳：没切成功就还按原通道重画，别让人以为已经换了。
      renderTunnelCard();
      showFeedback('通道切换没有成功：' + String((error && error.message) || error), 'error');
    });
  }
  function requestTunnelProviderChange(next) {
    if (!isTunnelProvider(next) || next === tunnelProvider) return;
    var snap = tunnelSnapshot(tunnelState, tunnelProvider);
    var readyNow = String(snap.state || 'idle') === 'ready' && !!snap.url;
    if (readyNow && tunnelSwitchConfirmTo !== next) {
      // 已开通时切换会切断手机上正在用的地址，先讲清后果，再点一次才动手。
      var note = document.getElementById('tunnel-switch-note');
      if (note) note.textContent = '切换后当前公网地址会失效，需要重新开通。再点一次「' + tunnelProviderName(next) + '」确认切换。';
      tunnelSwitchConfirmTo = next;
      if (tunnelSwitchConfirmTimer !== null) window.clearTimeout(tunnelSwitchConfirmTimer);
      tunnelSwitchConfirmTimer = window.setTimeout(function () {
        tunnelSwitchConfirmTimer = null;
        tunnelSwitchConfirmTo = null;
        var reset = document.getElementById('tunnel-switch-note');
        if (reset) reset.textContent = '';
      }, 4000);
      return;
    }
    clearTunnelSwitchConfirm();
    switchTunnelProvider(next);
  }
  function refreshTunnelStatus() {
    return api('/api/tunnel/status').then(function (payload) {
      if (!payload || payload.ok === false) throw new Error((payload && payload.error) || '状态读取失败');
      tunnelState = payload;
      if (isTunnelProvider(payload.provider)) tunnelProvider = payload.provider;
      renderTunnelCard();
      if (isTunnelBusy(tunnelProvider, payload.state)) pollTunnel(false);
      return payload;
    });
  }
  function tunnelCopy(text, noteNode) {
    function done(ok) { if (noteNode) noteNode.textContent = ok ? '已复制。' : ''; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      // clipboard API 不可用（http 环境等）：退到老办法选中文本让用户 Ctrl+C。
      var input = document.getElementById('tunnel-url');
      if (input && typeof input.select === 'function') { input.select(); try { document.execCommand('copy'); done(true); } catch (e) { done(false); } }
      else done(false);
    }
  }
  function renderTunnelCard() {
    var card = document.getElementById('tunnel-card');
    if (!card) { stopTunnelPolling(); return; }
    var provider = isTunnelProvider(tunnelProvider) ? tunnelProvider : 'cloudflare';
    var snap = tunnelSnapshot(tunnelState, provider);
    var state = String(snap.state || 'idle');
    var busy = isTunnelBusy(provider, state);
    if (!busy && tunnelTimer !== null) { stopTunnelPolling(); }
    var readyUrl = state === 'ready' ? String(snap.url || '') : '';
    var body;
    if (readyUrl) {
      // 地址 + 复制 + 两段式关闭 + 二维码。Cloudflare 的地址每次重启都变，单独用琥珀小字讲清楚。
      body = '<p class="setting-note">手机可通过此地址从外网访问 SuperDot。</p>'
        + '<input id="tunnel-url" class="sync-url tunnel-url" type="url" readonly value="' + readyUrl.replace(/"/g, '&quot;') + '" aria-label="公网地址">'
        + '<div class="tunnel-actions"><button id="tunnel-copy" class="btn" type="button">复制链接</button><button id="tunnel-close" class="btn" type="button">关闭公网</button><span id="tunnel-copy-note" class="setting-note"></span></div>'
        + '<div class="tunnel-qr-row"><img id="tunnel-qr" class="sync-qr" alt="公网地址二维码" hidden><p id="tunnel-qr-message" class="sync-status"></p></div>'
        + (provider === 'cloudflare' ? '<p class="tunnel-warn">Cloudflare 地址在 SuperDot 重启后会更换。</p>' : '');
    } else if (state === 'error') {
      body = '<p class="setting-note tunnel-error">' + String(snap.message || '开通没有成功。').replace(/</g, '&lt;') + '</p>'
        + '<button id="tunnel-retry" class="btn" type="button">重试</button>';
    } else if (state === 'waiting_login') {
      body = '<p class="setting-note">' + String(snap.message || '请在打开的浏览器里登录 Tailscale，登录完会自动继续。') + '</p>';
      var authUrl = safeUrl(snap.auth_url || '');
      if (authUrl) {
        body += '<p><a href="' + authUrl.replace(/"/g, '&quot;') + '" target="_blank" rel="noreferrer">打开 Tailscale 登录页</a></p>';
      }
      body += '<p class="setting-note">登录完成后这里会自动变成公网地址，不用刷新页面。</p>';
    } else if (busy) {
      body = '<p class="setting-note">' + String(snap.message || '正在开通公网入口…') + '</p>'
        + '<button id="tunnel-start" class="btn primary" type="button" disabled>正在开通…</button>';
    } else if (provider === 'cloudflare') {
      body = '<p class="setting-note">Cloudflare 无需注册，首次开通时会下载连接组件。</p>'
        + '<button id="tunnel-start" class="btn primary" type="button">开通公网</button>';
    } else {
      body = '<p class="setting-note">电脑需安装并登录 Tailscale。</p>'
        + '<button id="tunnel-start" class="btn primary" type="button">用 Tailscale 开通</button>';
    }
    card.innerHTML = tunnelProvidersRow() + '<div id="tunnel-body">' + body + '</div>';
    Array.prototype.forEach.call(card.querySelectorAll('.tunnel-provider'), function (button) {
      button.onclick = function () { requestTunnelProviderChange(button.getAttribute('data-provider')); };
    });
    var startButton = document.getElementById('tunnel-start');
    if (startButton) startButton.onclick = function () { startTunnel(); };
    var retryButton = document.getElementById('tunnel-retry');
    if (retryButton) retryButton.onclick = function () { startTunnel(); };
    if (readyUrl) bindTunnelReadyActions(readyUrl);
  }
  function bindTunnelReadyActions(url) {
    var copyNote = document.getElementById('tunnel-copy-note');
    var copyButton = document.getElementById('tunnel-copy');
    if (copyButton) copyButton.onclick = function () { tunnelCopy(url, copyNote); };
    // 关闭公网：两段式确认（跟通知删除同一套，4 秒不点第二下自动复原）——
    // 这是把手机上的入口切断，误点会让用户以为服务坏了。
    var closeBtn = document.getElementById('tunnel-close');
    var closeConfirmTimer = null;
    if (closeBtn) {
      closeBtn.onclick = function () {
        if (closeConfirmTimer === null) {
          closeBtn.textContent = '确认关闭？（4 秒内再点一次）';
          closeConfirmTimer = window.setTimeout(function () {
            closeConfirmTimer = null;
            closeBtn.textContent = '关闭公网';
          }, 4000);
          return;
        }
        window.clearTimeout(closeConfirmTimer);
        closeConfirmTimer = null;
        stopTunnelPolling();
        closeBtn.disabled = true;
        closeBtn.textContent = '正在关闭…';
        api('/api/tunnel/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(function (result) {
          if (!result || !result.ok) throw new Error((result && result.error) || '服务端没有确认关闭');
          // 写动作之后缓存必须失效：立刻按未开通重画，页面别再挂着旧公网地址。
          var snapshot = tunnelSnapshot(tunnelState, tunnelProvider) || {};
          var providers = tunnelState.providers || {};
          providers[tunnelProvider] = { installed: !!snapshot.installed, state: 'idle', message: '', url: '' };
          tunnelState = { ok: true, provider: tunnelProvider, state: 'idle', message: '', url: '', auth_url: '', retryable: true, installed: !!snapshot.installed, providers: providers };
          renderTunnelCard();
          refreshTunnelStatus().catch(function () {});
          showFeedback('公网入口已关闭。手机用移动网络打不开了，同一 Wi-Fi 下还能用。', 'success');
        }).catch(function (error) {
          closeBtn.disabled = false;
          closeBtn.textContent = '关闭公网';
          if (copyNote) copyNote.textContent = '关闭没有成功：' + String((error && error.message) || error);
        });
      };
    }
    var qrImage = document.getElementById('tunnel-qr');
    var qrMessage = document.getElementById('tunnel-qr-message');
    if (!qrImage) return;
    qrImage.onload = function () { qrMessage.textContent = ''; };
    qrImage.onerror = function () { qrImage.hidden = true; qrMessage.textContent = '二维码生成失败，可复制链接在手机浏览器打开。'; };
    qrImage.src = '/api/sync/qr.png?text=' + encodeURIComponent(url) + '&token=' + encodeURIComponent(setupToken) + '&t=' + Date.now();
    qrImage.hidden = false;
    qrMessage.textContent = '手机扫码直接打开。';
  }
  function startTunnel() {
    var provider = isTunnelProvider(tunnelProvider) ? tunnelProvider : 'cloudflare';
    var body = document.getElementById('tunnel-body');
    if (body) body.innerHTML = '<p class="setting-note">正在开通公网入口，请稍候…</p>';
    api('/api/tunnel/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true, provider: provider }) }).then(function (result) {
      if (!result || !result.ok) throw new Error((result && result.error) || '服务端没有接受开通请求');
      pollTunnel(true);
    }).catch(function (error) {
      // 只换卡片正文，顶上那排通道胶囊留着，换个通道还能再试。
      var target = document.getElementById('tunnel-body') || document.getElementById('tunnel-card');
      if (target) target.innerHTML = '<p class="setting-note tunnel-error">开通没有开始：' + String((error && error.message) || error).replace(/</g, '&lt;') + '</p><button id="tunnel-retry" class="btn" type="button">重试</button>';
      var retry = document.getElementById('tunnel-retry');
      if (retry) retry.onclick = function () { startTunnel(); };
    });
  }
  function pollTunnel(immediate) {
    stopTunnelPolling();
    var tick = function () {
      // 切走设置页就停（页面只有设置页有这张卡）。
      if (document.body.dataset.tab !== 'settings') { stopTunnelPolling(); return; }
      api('/api/tunnel/status').then(function (payload) {
        if (!payload || payload.ok === false) throw new Error(payload.error || '状态读取失败');
        tunnelState = payload;
        if (isTunnelProvider(payload.provider)) tunnelProvider = payload.provider;
        renderTunnelCard();
        // 开通中 2 秒后再查（renderTunnelCard 在终态时已经把定时器清掉了）。
        if (isTunnelBusy(tunnelProvider, payload.state)) {
          if (tunnelTimer === null) tunnelTimer = window.setInterval(tick, 2000);
        } else {
          stopTunnelPolling();
        }
      }).catch(function (error) {
        var card = document.getElementById('tunnel-card');
        if (card) card.textContent = '公网状态读取失败：' + String((error && error.message) || error);
        stopTunnelPolling();
      });
    };
    if (immediate) tick(); else tunnelTimer = window.setInterval(tick, 2000);
  }
  api('/api/tunnel/status').then(function (payload) {
    tunnelState = payload || {};
    if (isTunnelProvider(tunnelState.provider)) tunnelProvider = tunnelState.provider;
    renderTunnelCard();
    if (isTunnelBusy(tunnelProvider, tunnelState.state)) pollTunnel(false);
  }).catch(function (error) {
    var card = document.getElementById('tunnel-card');
    if (card) card.textContent = '公网状态读取失败：' + String((error && error.message) || error);
  });
  function setHostingResult(text){document.getElementById('hosting-result').textContent=text;}
  var preferenceNames=['quit_qq','restore_qq','quit_restore_qq','auto_on_start','autostart'];
  var savedPreferences=null;
   var savedCatchup=null;
  function readPreferences(){var values={};preferenceNames.forEach(function(name){values[name]=document.getElementById('pref-'+name).checked;});return values;}
  function setPreferences(values){preferenceNames.forEach(function(name){document.getElementById('pref-'+name).checked=!!values[name];});}
  function setPreferencesBusy(busy){preferenceNames.forEach(function(name){document.getElementById('pref-'+name).disabled=busy;});}
   function setCatchup(values){document.getElementById('pref-catchup-enabled').checked=!!values.catchup_enabled;document.getElementById('pref-catchup-days').value=String(values.catchup_days);}
   function setCatchupBusy(busy){document.getElementById('pref-catchup-enabled').disabled=busy;document.getElementById('pref-catchup-days').disabled=busy;document.getElementById('pref-catchup-save').disabled=busy;}
   function saveCatchup(){var days=Number(document.getElementById('pref-catchup-days').value);if(!Number.isInteger(days)||days<1||days>365){document.getElementById('pref-catchup-result').textContent='补收天数必须在 1 到 365 之间。';return;}var values={catchup_enabled:document.getElementById('pref-catchup-enabled').checked,catchup_hours:days*24};setCatchupBusy(true);document.getElementById('pref-catchup-result').textContent='正在保存…';api('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)}).then(function(result){if(!result.ok)throw new Error(result.error||'服务端未保存设置');savedCatchup={catchup_enabled:values.catchup_enabled,catchup_days:days};document.getElementById('pref-catchup-result').textContent='已保存。仅在下次启动时应用。';showFeedback('历史消息设置已保存','success');}).catch(function(error){if(savedCatchup)setCatchup(savedCatchup);document.getElementById('pref-catchup-result').textContent='保存失败：'+error.message;showFeedback('历史消息设置未保存：'+error.message,'error',saveCatchup);}).then(function(){setCatchupBusy(false);});}
   document.getElementById('pref-catchup-save').onclick=saveCatchup;
  function savePreferences(values){setPreferencesBusy(true);showFeedback('正在保存设置…','loading');return api('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)}).then(function(result){if(!result.ok)throw new Error(result.error||'服务端未保存设置');savedPreferences=values;setHostingResult('设置已保存');showFeedback('设置已保存','success');}).catch(function(error){if(savedPreferences)setPreferences(savedPreferences);setHostingResult('保存失败：'+error.message);showFeedback('设置未保存：'+error.message,'error',function(){savePreferences(values);});}).then(function(){setPreferencesBusy(false);});}
  setPreferencesBusy(true);
  api('/api/settings').then(function(values){savedPreferences={};preferenceNames.forEach(function(name){savedPreferences[name]=!!values[name];});setPreferences(savedPreferences);var days=Math.min(365,Math.max(1,Math.ceil(Number(values.catchup_hours||24)/24)));savedCatchup={catchup_enabled:!!values.catchup_enabled,catchup_days:days};setCatchup(savedCatchup);setPreferencesBusy(false);setCatchupBusy(false);}).catch(function(error){setHostingResult('设置读取失败：'+error.message);showFeedback('设置读取失败：'+error.message,'error',loadSettings);});
  preferenceNames.forEach(function(name){document.getElementById('pref-'+name).onchange=function(){if(savedPreferences)savePreferences(readPreferences());};});
  function refreshHosting(){return api('/api/hosting/status').then(function(status){if (status.mode === 'framework') { document.getElementById('hosting-status').textContent = status.napcat_online ? '桌面 QQ 已连接' : '桌面 QQ 未连接'; return status; } document.getElementById('hosting-status').textContent='托管：'+(status.hosting_active?'进行中':'未开始')+'；NapCat：'+(status.napcat_running?'运行中':'未运行')+'；登录：'+(status.napcat_online?'在线':'未登录')+'；电脑版 QQ：'+(status.user_qq_running?'运行中':'未运行');
    // start/stop 是同一个动作的两个方向：按状态只留一个，别让当前不该做的事也当主按钮摆着。
    var startBtn=document.getElementById('hosting-start'),stopBtn=document.getElementById('hosting-stop');
    if(startBtn)startBtn.hidden=!!status.hosting_active;
    if(stopBtn)stopBtn.hidden=!status.hosting_active;
    return status;}).catch(function(error){setHostingResult('状态读取失败：'+error.message);throw error;});}
  function changeHosting(button,path,desired,pending,success){button.disabled=true;setHostingResult(pending);showFeedback(pending,'loading');function retryStatus(){refreshHosting().then(function(status){if(!!status.hosting_active===desired){setHostingResult(success);showFeedback(success,'success');if(desired&&!status.napcat_online)showQrAfterAction();}else{showFeedback('托管状态尚未确认','error',retryStatus);}},function(error){showFeedback('状态刷新失败：'+error.message,'error',retryStatus);});}api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(function(result){if(!result.ok)throw new Error(result.error||'服务端未确认操作');return refreshHosting().then(function(status){if(!!status.hosting_active!==desired){setHostingResult('服务端回应了，但托管没到预期状态');showFeedback('服务端回应了，但托管没到预期状态','error',retryStatus);return;}setHostingResult(success);showFeedback(success,'success');if(desired&&!status.napcat_online)showQrAfterAction();},function(error){showFeedback('服务端已响应，但状态读取失败：'+error.message,'error',retryStatus);});}).catch(function(error){setHostingResult('托管操作未确认：'+error.message);showFeedback('托管操作未确认：'+error.message,'error',function(){changeHosting(button,path,desired,pending,success);});}).then(function(){button.disabled=false;});}
  document.getElementById('hosting-start').onclick=function(){changeHosting(this,'/api/hosting/start',true,'正在开始托管，请稍候…','托管已开始并确认');};
  document.getElementById('hosting-stop').onclick=function(){changeHosting(this,'/api/hosting/stop',false,'正在结束托管，请稍候…','托管已结束并确认');}; if(document.body.dataset.qqMode!=='framework')refreshHosting().catch(function(){});
  // 每项是 [发给后端的键名, 输入框元素 id]。两边必须写成一张显式对照表：
  // 早先写成 'push-'+name 拼 id，改元素 id 时静默取不到元素、输入值根本发不出去。
  var pushFields=[['wxpusher_app_token','push-wxpusher_key'],['wxpusher_uids','push-wxpusher_uids'],['wxpusher_topic_ids','push-wxpusher_topic_ids'],['serverchan_keys','push-serverchan_keys'],['pushplus_tokens','push-pushplus_key'],['webhook_urls','push-robot-urls']];
  function pushInput(pair){return document.getElementById(pair[1]);}
  // 通道 id 是内部标识符，给用户看的必须是服务名。
  var PUSH_CHANNEL_NAMES={wxpusher:'WxPusher',serverchan:'Server酱',pushplus:'PushPlus',webhook:'Webhook','qq-bot':'QQ 机器人'};
  function pushChannelName(id){return PUSH_CHANNEL_NAMES[id]||String(id||'未知通道');}
  function applyPushState(state,channels){if(!state)return;pushFields.forEach(function(pair){var input=pushInput(pair);var item=state[pair[0]];if(!input)return;input.placeholder=(item&&item.set)?('已配置：'+item.masked.join('、')+'（留空保留）'):'';});var list=(channels||[]).map(pushChannelName);document.getElementById('push-result').textContent='当前渠道：'+(list.join('、')||'未配置');document.getElementById('push-test').hidden=!list.length;document.getElementById('push-manage').hidden=!pushFields.some(function(pair){return state[pair[0]]&&state[pair[0]].set;});}
  function savePushSettings(all){var values={};pushFields.forEach(function(pair){var input=pushInput(pair);if(!input)return;var text=input.value.trim();if(text||all)values[pair[0]]=text;});var resultBox=document.getElementById('push-result');if(!Object.keys(values).length){resultBox.textContent='请先填写要保存的渠道信息。';return;}resultBox.textContent='正在保存…';api('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)}).then(function(result){if(!result.ok)throw new Error(result.error||'服务端未保存设置');pushFields.forEach(function(pair){var input=pushInput(pair);if(input)input.value='';});applyPushState(result.push, result.channels);resultBox.textContent='已保存。当前渠道：'+(((result.channels||[]).map(pushChannelName)).join('、')||'未配置')+'。';showFeedback('推送设置已保存','success');}).catch(function(error){resultBox.textContent='保存失败：'+error.message;showFeedback('推送设置未保存：'+error.message,'error',function(){savePushSettings(all);});});}
  document.getElementById('push-save').onclick=function(){savePushSettings(false);};
  document.getElementById('push-clear').onclick=function(){if(!window.confirm('确定清空全部推送通道配置吗？清空后「截止提醒」将发不出去。'))return;savePushSettings(true);};
  function applyPushHelp(map){if(!map)return;var links=document.querySelectorAll('a.push-help[data-help]');for(var i=0;i<links.length;i++){var url=safeUrl(map[links[i].getAttribute('data-help')]);if(url){links[i].href=url;links[i].rel='noreferrer';}}}
  function testPush(){var box=document.getElementById('push-result');box.textContent='正在发送测试消息…';return api('/api/settings/test-push',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(function(result){var list=result.results||[];if(!list.length){box.textContent=result.error||'还没有配置任何推送通道：先在上面填好并保存。';return;}var text=list.map(function(item){return (item.ok?'收到：':'失败：')+item.channel+(item.ok?'':(' · '+(item.error||'原因不明')));}).join('；');box.textContent=result.ok?('测试消息已发送：'+text):('部分渠道发送失败：'+text);if(result.ok)showFeedback('测试消息已发出','success');}).catch(function(error){box.textContent='测试失败：'+error.message;});}
  document.getElementById('push-test').onclick=function(){testPush();};
  var llmProviders = [], llmState = null;
  var llmForm = aiBox.querySelector('#llm-form');
  var llmProviderSelect = llmForm.querySelector('#llm-provider');
  var llmModelSelect = llmForm.querySelector('#llm-model');
  var llmModelInput = llmForm.querySelector('#llm-custom-model');
  var llmKey = llmForm.querySelector('#llm-key');
  var llmEndpoint = llmForm.querySelector('#llm-endpoint');
  var llmHelp = llmForm.querySelector('#llm-help');
  var llmResult = llmForm.querySelector('#llm-result');
  var llmOff = llmForm.querySelector('#llm-off');

  function llmProvider() {
    return llmProviders.find(function (item) { return item.id === llmProviderSelect.value; });
  }
  function setLlmBusy(busy) {
    Array.from(llmForm.elements).forEach(function (field) { field.disabled = busy; });
    llmOff.disabled = busy || !(llmState && llmState.enabled);
  }
  function setLlmLink(id, url) {
    var link = llmForm.querySelector('#' + id);
    var href = safeUrl(url);
    link.hidden = !href;
    if (href) link.href = href;
    else link.removeAttribute('href');
  }
  function syncCustomLlmModel() {
    var custom = !llmModelSelect.value;
    llmForm.querySelector('#llm-custom-model-row').hidden = !custom;
    llmModelInput.required = custom;
  }
  function renderLlmProvider(model, endpoint) {
    var item = llmProvider();
    var models = (item.models || []).slice(0, 10);
    llmModelSelect.replaceChildren();
    models.forEach(function (id, index) {
      llmModelSelect.add(new Option(id + (index === 0 ? '（推荐）' : ''), id));
    });
    llmModelSelect.add(new Option('手动填写模型 ID', ''));
    llmForm.querySelector('#llm-model-row').hidden = !models.length;
    llmModelSelect.value = model === undefined ? (models[0] || '') : (models.includes(model) ? model : '');
    llmModelInput.value = llmModelSelect.value ? '' : (model || '');
    syncCustomLlmModel();
    llmEndpoint.value = endpoint || item.endpoint || '';
    llmEndpoint.required = item.id === 'custom';
    llmForm.querySelector('#llm-endpoint-row').hidden = !llmEndpoint.required;
    var savedKey = llmState && llmState.key_set && llmState.provider === item.id;
    llmForm.querySelector('#llm-key-row').hidden = !item.needs_key;
    llmKey.required = item.needs_key && !savedKey;
    llmKey.placeholder = savedKey ? '已保存 ' + llmState.key_masked : '';
    llmKey.value = '';
    setLlmLink('llm-help-link', item.key_url);
    var siteUrl = safeUrl(item.api_site_url) || safeUrl(item.key_url);
    setLlmLink('llm-api-site', siteUrl);
    llmHelp.hidden = !(siteUrl || item.setup_note);
    llmHelp.open = false;
    var note = llmForm.querySelector('#llm-help-note');
    var siteLink = note.querySelector('#llm-api-site');
    if (siteUrl && item.needs_key) {
      siteLink.textContent = 'API 控制台';
      note.replaceChildren('在服务商的 ', siteLink, '注册或登录，创建 API Key 后填入上方。');
    } else {
      siteLink.textContent = '查看官方文档';
      note.replaceChildren(item.setup_note || '', ' ', siteLink);
    }
  }
  function applyLlmState(state) {
    llmState = state;
    llmProviderSelect.value = state.provider;
    if (!llmProviderSelect.value) llmProviderSelect.value = 'custom';
    renderLlmProvider(state.model || undefined, state.endpoint);
    llmResult.textContent = state.enabled ? '' : '配置已停用。';
  }
  function saveLlm(payload, message) {
    llmResult.textContent = '正在保存…';
    setLlmBusy(true);
    return api('/api/settings', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)})
      .then(function (result) {
        if (!result.ok) throw new Error(result.error || '无法保存配置');
        applyLlmState(result.llm);
        Array.from(llmForm.elements).forEach(function (field) { delete field.dataset.nhDirty; });
        llmResult.textContent = message;
      }).catch(function (error) {
        llmResult.textContent = '保存失败。' + error.message;
      }).finally(function () { setLlmBusy(false); });
  }
  llmProviderSelect.onchange = function () {
    [llmModelSelect, llmModelInput, llmEndpoint, llmKey].forEach(function (field) { delete field.dataset.nhDirty; });
    renderLlmProvider();
    llmResult.textContent = '';
  };
  llmModelSelect.onchange = function () {
    syncCustomLlmModel();
    if (!llmModelSelect.value) llmModelInput.focus();
  };
  llmForm.onsubmit = function (event) {
    event.preventDefault();
    var item = llmProvider();
    var model = llmModelSelect.value || llmModelInput.value.trim();
    var key = llmKey.value.trim();
    var endpoint = llmEndpoint.value.trim();
    var field, message;
    if (!model) {
      field = llmModelInput;
      message = '请填写模型 ID。';
    } else if (llmEndpoint.required && (!/^https?:\/\//i.test(endpoint) || !llmEndpoint.validity.valid)) {
      field = llmEndpoint;
      message = '请输入有效的 HTTP 或 HTTPS 接口地址。';
    } else if (llmKey.required && !key) {
      field = llmKey;
      message = '请填写所选服务商的 API Key。';
    }
    if (field) {
      llmResult.textContent = message;
      field.focus();
      return;
    }
    var payload = {llm_provider: item.id, llm_model: model};
    if (item.needs_key && key) payload.llm_api_key = key;
    if (item.id === 'custom') payload.llm_endpoint = endpoint;
    saveLlm(payload, '配置已保存。');
  };
  llmOff.onclick = function () { saveLlm({llm_provider:'off'}, '配置已停用。'); };
  // 先恢复其它设置的输入。AI 配置的选项要等服务商清单返回后再恢复。
  restoreSettingsInputs(settingsUnsaved);
  var llmDraft = settingsUnsaved;
  var metaRequest = api('/api/meta');
  renderRailHealth(metaRequest);
  metaRequest.then(function (data) {
    if (!aiBox.isConnected) return;
    llmProviders = (data.providers || []).filter(function (item) { return item.id !== 'off'; });
    llmProviders.forEach(function (item) { llmProviderSelect.add(new Option(item.name, item.id)); });
    applyLlmState(data.llm);
    if (llmDraft['llm-provider'] && llmProviders.some(function (item) {
      return item.id === llmDraft['llm-provider'].value;
    })) {
      llmProviderSelect.value = llmDraft['llm-provider'].value;
      renderLlmProvider();
    }
    ['llm-model', 'llm-custom-model', 'llm-endpoint', 'llm-key'].forEach(function (id) {
      if (llmDraft[id]) llmForm.querySelector('#' + id).value = llmDraft[id].value;
    });
    Array.from(llmForm.querySelectorAll('[data-draft-on-edit]')).forEach(function (field) {
      if (llmDraft[field.id]) markSettingsDirty(field);
    });
    syncCustomLlmModel();
    setLlmBusy(false);
    applyPushHelp(data.push_help);
    applyPushState(data.push, data.channels);
  }).catch(function (error) {
    if (llmProviderSelect.disabled) llmResult.textContent = '无法读取配置。' + error.message;
  });
}

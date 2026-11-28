// 手机 App 配对 / 防火墙一键放行。公网入口全站只有一套，家安在本卡内，
// 由 settings.js 的双通道实现（#tunnel-card）驱动；本文件不再有独立的公网状态机或轮询。
// 依赖页面全局 api()、token 与页面 DOM（#pair-*）。
// 这里只声明变量和函数，加载时不执行任何代码。
var pairTimer = null;
// 防火墙面板：allowed=true 才收起；checked=false 只是「非提权读不到规则清单」，不是「没放行」，
// 这时也必须露出「一键放行」入口（点它会在一次管理员授权里顺便查出结果）。
function renderFirewallPanel(firewall) {
  firewall = firewall || {};
  var box = document.getElementById('pair-firewall');
  var text = document.getElementById('pair-firewall-text');
  var allow = document.getElementById('pair-firewall-allow');
  if (!box || !text) return;
  box.hidden = firewall.supported === false || !!firewall.allowed;
  if (box.hidden) return;
  if (allow) allow.disabled = false;
  text.textContent = firewall.checked
    ? 'Windows 防火墙尚未允许此端口的局域网连接。'
    : '如果手机无法访问此地址，可检查 Windows 防火墙设置。';
}
function pairRow(item) {
  var row = el('div', 'preference');
  var text = el('span', '');
  text.appendChild(el('strong', '', item.device || '未知设备'));
  text.appendChild(el('small', '', '配对码 ' + item.code + ' · 已等待 ' + item.waiting_seconds + ' 秒'));
  row.appendChild(text);
  var allow = el('button', 'btn', '允许');
  allow.type = 'button';
  allow.addEventListener('click', function () { decidePair(item.code, true, allow); });
  var deny = el('button', 'btn', '拒绝');
  deny.type = 'button';
  deny.addEventListener('click', function () { decidePair(item.code, false, deny); });
  row.appendChild(allow);
  row.appendChild(deny);
  return row;
}
function setPairState(text, state) {
  var pill = document.getElementById('pair-state');
  if (!pill) return;
  pill.textContent = text;
  pill.hidden = state === 'ok';
  pill.dataset.state = state || '';
}
function setPairStatus(text, state) {
  var node = document.getElementById('pair-result');
  if (!node) return;
  node.textContent = text || '';
  node.dataset.state = state || '';
}
function decidePair(code, approved, button) {
  button.disabled = true;
  api('/api/pair/' + (approved ? 'approve' : 'deny'), {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({code: code})}).then(function () {
    setPairStatus(approved ? '已允许手机配对。' : '已拒绝此配对请求。', approved ? 'ok' : '');
    refreshPair();
  }).catch(function (error) {
    setPairStatus((error && error.message) || '操作失败，请重试。', 'error');
    button.disabled = false;
  });
}
function refreshPair() {
  if (!document.getElementById('pair-pending')) return;
  api('/api/pair/pending', {cache: 'no-store'}).then(function (data) {
    var list = document.getElementById('pair-pending');
    if (!list) return;
    list.textContent = '';
    var items = (data && data.pending) || [];
    // 有挂起请求才露出「清空待配对」：平时不占地方，被陌生人塞满时一眼能找到。
    var clear = document.getElementById('pair-pending-clear');
    if (clear) clear.hidden = !items.length;
    document.getElementById('pair-requests').hidden = !items.length;
    items.forEach(function (item) { list.appendChild(pairRow(item)); });
    setPairState(items.length ? items.length + ' 台手机等待确认' : '暂无待确认请求', items.length ? 'warn' : 'ok');
  }).catch(function () {
    setPairState('读取失败', 'error');
  });
}
// 红队 S6：挂起的配对请求会把槽位占满，机主要能一键清掉（旁边没有手机时也能脱身）。
function clearPendingPairs(button) {
  if (!button) return;
  button.disabled = true;
  return api('/api/pair/pending/clear', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'}).then(function (data) {
    var cleared = data && typeof data.cleared === 'number' ? data.cleared : 0;
    setPairStatus(cleared ? '已清空 ' + cleared + ' 条待配对请求' : '没有可清空的待配对请求', 'ok');
    refreshPair();
  }).catch(function (error) {
    var message = String((error && error.message) || '');
    // 后端没有这个路由就是版本问题：说清楚，别让人反复点。
    setPairStatus(/404|405|不支持/.test(message) ? '当前版本不支持，请升级' : ('清空失败：' + (message || '请重试')), 'error');
  }).then(function () { button.disabled = false; });
}
function pairCard() {
  var card = el('section', 'surface hosting-settings');
  card.dataset.settingAnchor = 'mobile';
  card.setAttribute('aria-labelledby', 'pair-title');
  card.innerHTML = `<div class="section-head"><h2 id="pair-title" class="section-title">用手机 App 看工单</h2><span id="pair-state" class="count-pill" hidden></span></div>
    <p class="setting-note">先在手机上安装 SuperDot App，并让电脑上的 SuperDot 保持运行。下面按手机当前用的网络选一种连接方式。</p>
    <details class="settings-extra"><summary>同一 Wi-Fi（局域网）</summary>
      <p>手机和电脑连着同一个 Wi-Fi 时，用局域网地址直接连电脑。需要手动连接时，把下面的地址复制到 App。</p>
      <label for="pair-candidate">选择网络地址</label>
      <select id="pair-candidate" class="sync-url"></select>
      <input id="pair-url" class="sync-url" type="text" readonly aria-label="当前配对地址">
      <div class="hosting-actions"><button id="pair-copy" class="btn" type="button">复制地址</button></div>
      <div id="pair-firewall" hidden>
        <span id="pair-firewall-text"></span>
        <div class="firewall-actions"><button id="pair-firewall-allow" class="btn" type="button">允许局域网连接</button></div>
        <p id="pair-firewall-result" class="sync-status" role="status" aria-live="polite"></p>
      </div>
    </details>
    <details class="settings-extra" id="sync-public-block"><summary>移动流量或不同 Wi-Fi（外网）</summary>
      <p>手机在外面时，需要先给电脑上的 SuperDot 开通一个外网地址。连接后，手机可以用移动流量或其他 Wi-Fi 查看工单。</p>
      <div class="settings-rows" id="tunnel-card" role="status" aria-live="polite">正在读取外网访问状态…</div>
    </details>
    <div class="settings-subsection">
      <h3 class="settings-group-title">扫码或手动配对</h3>
      <p>连通后，用 SuperDot App 扫下面的二维码。也可以在 App 输入电脑地址，发起配对后在这台电脑确认 6 位数字。</p>
      <img id="pair-qr" class="sync-qr" alt="手机配对二维码" hidden>
      <p id="pair-qr-msg" class="sync-status" role="status" aria-live="polite"></p>
    </div>
    <div id="pair-requests" class="settings-subsection" hidden>
      <h3 class="settings-group-title">确认手机配对</h3>
      <p>下面的 6 位数字和手机上显示的一致时，点「允许」。</p>
      <div id="pair-pending" class="preference-list"></div>
      <button id="pair-pending-clear" class="btn plain" type="button" hidden>清除待确认请求</button>
    </div>
    <p id="pair-result" class="sync-status" role="status" aria-live="polite"></p>`;
  var clearPending = card.querySelector('#pair-pending-clear');
  if (clearPending) clearPending.onclick = function () { clearPendingPairs(clearPending); };
  var qr = card.querySelector('#pair-qr');
  var qrMessage = card.querySelector('#pair-qr-msg');
  qr.onerror = function () {
    qr.hidden = true;
    qrMessage.dataset.state = 'error';
    qrMessage.textContent = '二维码加载失败，请检查访问令牌和手机可访问地址后刷新。';
  };
  return card;
}
function pollPairInfo() {
  var input = document.getElementById('pair-url');
  if (!input) return;
  api('/api/pair/info', {cache: 'no-store'}).then(function (data) {
    data = data || {};
    var candidates = (Array.isArray(data.candidates) ? data.candidates : []).filter(function (item) {
      return item && item.url;
    });
    var recommended = candidates.find(function (item) { return item.recommended; });
    var pairUrl = (recommended && recommended.url) || data.base || '';
    var candidateSelect = document.getElementById('pair-candidate');
    candidateSelect.textContent = '';
    candidates.forEach(function (item) {
      var option = document.createElement('option');
      option.value = item.url;
      var label = item.kind === 'lan' ? '局域网（同一 Wi-Fi）' :
        (item.url.indexOf('https://') === 0 ? '公网地址' :
          (item.kind === 'tailscale' ? 'Tailscale VPN' :
            (item.kind === 'cellular' ? '热点网卡' :
              (item.kind === 'virtual' ? '虚拟网卡' : '其他地址'))));
      option.textContent = label + ' · ' + item.url;
      candidateSelect.appendChild(option);
    });
    candidateSelect.hidden = !candidates.length;
    if (candidates.some(function (item) { return item.url === pairUrl; })) candidateSelect.value = pairUrl;
    input.value = pairUrl;
    var qr = document.getElementById('pair-qr');
    var qrMessage = document.getElementById('pair-qr-msg');
    if (data.qr_error) {
      qr.removeAttribute('src');
      qr.hidden = true;
      qrMessage.dataset.state = 'error';
      qrMessage.textContent = data.qr_error;
    } else if (pairUrl) {
      qrMessage.dataset.state = '';
      qr.src = '/api/app/qr.png?base=' + encodeURIComponent(pairUrl) + '&token=' + encodeURIComponent(token);
      qr.hidden = false;
      qrMessage.textContent = '';
    } else {
      qr.removeAttribute('src');
      qr.hidden = true;
      qrMessage.dataset.state = 'error';
      qrMessage.textContent = '没有检测到可供手机访问的地址。';
    }
    candidateSelect.onchange = function () {
      input.value = candidateSelect.value;
      if (data.qr_error || !candidateSelect.value) return;
      qr.src = '/api/app/qr.png?base=' + encodeURIComponent(candidateSelect.value) + '&token=' + encodeURIComponent(token);
      qr.hidden = false;
      qrMessage.dataset.state = '';
      qrMessage.textContent = '';
    };
    renderFirewallPanel(data.firewall);
  }).catch(function (error) {
    var qr = document.getElementById('pair-qr');
    var qrMessage = document.getElementById('pair-qr-msg');
    if (qr) qr.hidden = true;
    if (qrMessage) {
      qrMessage.dataset.state = 'error';
      qrMessage.textContent = (error && error.message) || '无法读取二维码配对信息，请刷新页面后重试。';
    }
    setPairStatus((error && error.message) || '读取失败', 'error');
  });
}
function setupPairCard() {
  if (!document.getElementById('pair-url')) return;
  document.getElementById('pair-copy').addEventListener('click', function () {
    var input = document.getElementById('pair-url');
    var text = input.value || '';
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { setPairStatus('地址已复制。', 'ok'); }, function () { input.select(); });
    } else {
      input.select();
    }
  });
  var firewallAllow = document.getElementById('pair-firewall-allow');
  if (firewallAllow) firewallAllow.addEventListener('click', function () {
    var result = document.getElementById('pair-firewall-result');
    firewallAllow.disabled = true;
    if (result) { result.dataset.state = ''; result.textContent = '正在请求管理员授权…'; }
    api('/api/firewall/allow', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({confirm: true})}).then(function () {
      // 服务不再自己弹 UAC：请求写到 data/firewall.request，由托盘执行；结果靠轮询 status。
      var waited = 0;
      var tick = function () {
        waited += 2000;
        api('/api/firewall/status').then(function (s) {
          var state = (s && s.state) || 'unknown';
          if (state === 'granted') {
            if (result) { result.dataset.state = 'ok'; result.textContent = (s && s.message) || '已放行'; }
            firewallAllow.disabled = false;
            pollPairInfo();
            return;
          }
          if (state === 'failed' || state === 'unavailable') {
            if (result) {
              result.dataset.state = 'error';
              result.textContent = state === 'failed'
                ? ('失败：' + ((s && s.message) || '未知原因'))
                : ((s && s.message) || '请先启动托盘程序');
            }
            firewallAllow.disabled = false;
            pollPairInfo();
            return;
          }
          if (result) { result.dataset.state = ''; result.textContent = (s && s.message) || '请在电脑上完成管理员授权。'; }
          if (waited >= 60000) {
            if (result) { result.dataset.state = 'error'; result.textContent = '暂未收到授权结果。请确认 SuperDot 桌面程序正在运行。'; }
            firewallAllow.disabled = false;
            return;
          }
          window.setTimeout(tick, 2000);
        }).catch(function () {
          if (waited >= 60000) { firewallAllow.disabled = false; return; }
          window.setTimeout(tick, 2000);
        });
      };
      window.setTimeout(tick, 2000);
    }).catch(function (error) {
      if (result) { result.dataset.state = 'error'; result.textContent = (error && error.message) || '无法提交防火墙设置请求。'; }
      firewallAllow.disabled = false;
    });
  });
  pollPairInfo();
  refreshPair();
  if (pairTimer) window.clearInterval(pairTimer);
  pairTimer = window.setInterval(refreshPair, 4000);
}

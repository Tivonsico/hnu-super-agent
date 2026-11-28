// 顶栏系统通知面板，承载接入体检等本机通知。
function repositionOpenAnnouncePanel() {
  var panel = document.getElementById('announce-panel');
  var bell = document.getElementById('announce-bell');
  if (!panel || panel.hidden || !panel.classList.contains('is-open') || !bell) return;
  positionAnnouncePanel(panel, bell.getBoundingClientRect(), {
    viewportWidth: document.documentElement.clientWidth, viewportHeight: window.innerHeight
  });
}
function noticeStackCount() {
  var stack = document.getElementById('notice-stack');
  return stack ? stack.children.length : 0;
}
// 通知是瞬时卡片：有卡就显示卡，没卡给一句空状态，别让用户对着空白以为没加载出来。
function syncNoticePane() {
  var empty = document.getElementById('announce-pane-notice-empty');
  if (empty) empty.hidden = noticeStackCount() > 0;
}
function announcePanelFocusable(panel) {
  if (!panel || !panel.querySelectorAll) return [];
  return Array.prototype.slice.call(panel.querySelectorAll('button, a[href], summary, [tabindex="0"]')).filter(function (node) {
    if (!node || node.disabled || node.hidden) return false;
    for (var parent = node; parent; parent = parent.parentElement) { if (parent.hidden) return false; }
    return true;
  });
}
var announcePanelReturnFocus = null;
// B5：焦点在面板外面时，绑在 panel 上的 keydown 收不到 Esc。面板打开期间把监听挂到 document
// 捕获阶段，关闭就解绑，别让页面别处的 Esc 也被我们吞掉。
function setAnnounceKeydown(on) {
  if (!document.addEventListener) return;
  if (on) document.addEventListener('keydown', announcePanelKeydown, true);
  else document.removeEventListener('keydown', announcePanelKeydown, true);
}
function openAnnouncePanel() {
  var panel = document.getElementById('announce-panel');
  var bell = document.getElementById('announce-bell');
  if (!panel) return;
  announcePanelReturnFocus = document.activeElement || bell;
  syncNoticePane();
  // 先让面板参与布局（此时 opacity 仍是 0，用户看不到），量到真实尺寸再定位，
  // 最后才加 is-open 播入场动画——顺序反了 offsetHeight 是 0，clamp 会用错的身高。
  panel.hidden = false;
  positionAnnouncePanel(panel, bell.getBoundingClientRect(), {
    viewportWidth: document.documentElement.clientWidth, viewportHeight: window.innerHeight
  });
  panel.classList.remove('is-closing');
  panel.classList.add('is-open');
  setAnnounceKeydown(true);
  if (bell) bell.setAttribute('aria-expanded', 'true');
  var close = document.getElementById('announce-panel-close');
  if (close && close.focus) close.focus();
}
// 面板定位纯函数：top = 铃铛底 + 8，right = 视口右 - 铃铛右，再 clamp 进视口。
// 单独抽出来是为了可单测（不碰真 DOM）。
function positionAnnouncePanel(panel, bellRect, env) {
  if (!panel || !bellRect) return;
  var viewportWidth = (env && env.viewportWidth) || document.documentElement.clientWidth;
  var viewportHeight = (env && env.viewportHeight) || window.innerHeight;
  var width = panel.offsetWidth || Math.min(420, viewportWidth - 32);
  var height = panel.offsetHeight || 320;
  var top = bellRect.bottom + 8;
  var right = viewportWidth - bellRect.right;
  // clamp 时先「越高越好」：铃铛贴底时面板翻上来盖住铃铛，也别压出视口底。
  var maxTop = Math.max(8, viewportHeight - height - 8);
  top = Math.min(top, maxTop);
  if (bellRect.bottom + 8 + height > viewportHeight - 8 && bellRect.top - height - 8 >= 8) {
    top = Math.max(8, bellRect.top - height - 8);  // 下方放不下、上方放得下：翻到铃铛上面
  }
  top = Math.max(8, top);
  right = Math.max(8, Math.min(right, viewportWidth - width - 8));
  panel.style.top = top + 'px';
  panel.style.right = right + 'px';
}
function closeAnnouncePanel(restoreFocus) {
  var panel = document.getElementById('announce-panel');
  var bell = document.getElementById('announce-bell');
  if (!panel || panel.hidden) return;
  // 退场 140ms：先播动画，transitionend（或兜底 180ms）后再 hidden，别用二值切换闪掉。
  var finish = function () {
    if (panel.classList.contains('is-open')) return;  // 退场中途又被打开：放弃隐藏
    panel.hidden = true;
    panel.classList.remove('is-closing');
  };
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    || document.documentElement.dataset.motion === 'paused';
  if (reduced) {
    panel.hidden = true;
  } else {
    panel.classList.remove('is-open');
    panel.classList.add('is-closing');
    panel.addEventListener('transitionend', finish, {once: true});
    window.setTimeout(finish, 180);  // 兜底：transitionend 没触发（元素已 display:none 等）
  }
  setAnnounceKeydown(false);
  if (bell) bell.setAttribute('aria-expanded', 'false');
  if (restoreFocus === false) return;
  var target = announcePanelReturnFocus || bell;
  if (target && target.focus) target.focus();
}
function announcePanelKeydown(event) {
  if (event && event.key === 'Escape') { event.preventDefault(); closeAnnouncePanel(true); return; }
  if (!event || event.key !== 'Tab') return;
  var nodes = announcePanelFocusable(document.getElementById('announce-panel'));
  if (!nodes.length) return;
  var first = nodes[0], last = nodes[nodes.length - 1], active = document.activeElement;
  if (event.shiftKey) { if (active === first || nodes.indexOf(active) < 0) { event.preventDefault(); last.focus(); } }
  else if (active === last || nodes.indexOf(active) < 0) { event.preventDefault(); first.focus(); }
}
function setupAnnounceBell() {
  var bell = document.getElementById('announce-bell');
  var panel = document.getElementById('announce-panel');
  if (!bell || !panel) return;
  // 字形、滚动条或非重画内容也会改变高度：始终按实际尺寸贴住铃铛。
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(repositionOpenAnnouncePanel).observe(panel);
  }
  panel.addEventListener('transitionend', repositionOpenAnnouncePanel);
  bell.addEventListener('click', function () { if (panel.hidden) openAnnouncePanel(); else closeAnnouncePanel(true); });
  // 面板开着时来了新通知：卡片由 NHNotify 自己塞进 #notice-stack，这里只跟着收起空状态。
  var stack = document.getElementById('notice-stack');
  if (stack && window.MutationObserver) {
    new MutationObserver(function () { syncNoticePane(); }).observe(stack, { childList: true });
  }
  var close = document.getElementById('announce-panel-close');
  if (close) close.addEventListener('click', function () { closeAnnouncePanel(true); });
  // 键盘监听由 openAnnouncePanel / closeAnnouncePanel 统一挂到 document 上，这里不再绑 panel。
  // 点面板外面关掉；点铃铛本身交给上面的 click 切换，这里跳过，免得关掉又立刻打开。
  document.addEventListener('mousedown', function (event) {
    if (panel.hidden) return;
    var target = event && event.target;
    if (panel.contains && panel.contains(target)) return;
    if (bell.contains && bell.contains(target)) return;
    closeAnnouncePanel(false);
  });
}

/* The inbox and the workbench share the same persisted work order IDs. */
window.superdotWorkbench = (function () {
  'use strict';
  var root = document.getElementById('workbench');
  var nav = root.querySelector('.wb-filters');
  var list = root.querySelector('.wb-list');
  var detail = root.querySelector('.wb-detail');
  detail.tabIndex = 0;
  var heading = root.querySelector('.wb-heading-label') || root.querySelector('h1');
  var archiveButton = root.querySelector('#wb-archive');
  var addMessageButton = root.querySelector('#wb-new');
  var dialog = root.querySelector('dialog');
  var form = dialog.querySelector('form');
  var status = root.querySelector('.wb-status');
  var board = null;
  var execution = false;
  var artifactsAvailable = false;
  var noticePanel = root.querySelector('.wb-notices');
  var noticeButton = root.querySelector('#wb-notifications');
  var notices = [];
  var noticeError = '';
  var noticeState = 'pending';
  var pendingNoticeCount = 0;
  var pendingNotices = [];
  var pendingRequest = null;
  var noticeWrites = 0;
  var pendingOperations = new Map();
  var uploadLimitMiB = 10;
  var attachmentLabel = '附件（单个不超过 ' + uploadLimitMiB + ' MiB）';
  var selection = null;
  var filter = 'all';
  var archive = false;
  var busy = false;
  var loadVersion = 0;
  var latestError = null;
  var stateNames = {
    queued: '等待 Worker 接单', running: '执行中', blocked: '等待你的指示',
    completed: '已完成', terminated: '已终止', ignored: '已忽略',
    visible: '可见', hidden: '已隐藏', merged: '已并出', interrupted: '待接续',
    review: '待确认', skipped: '已跳过', confirmed: '已确认', cleared: '已解除', waiting: '等待补充'
  };
  var eventNames = {
    work_order_assign_ai: '已分配给 Worker', work_order_router_append: 'Router 已追加消息',
    work_order_claim: 'Worker 已接单', work_order_request_approval: '等待你的指示',
    work_order_approve: '已提交提示词', work_order_complete: '已完成',
    work_order_terminate: '已终止执行', work_order_ignore: '已忽略',
    work_order_restore: '已恢复，等待 Worker 接单', work_order_set_deadline: '已调整截止时间',
    work_order_supplement: '补充内容', work_order_confirm_result: '确认本阶段',
    work_order_merge: '合并出单', work_order_merge_in: '合并入单'
  };
  var sources = {frontend: '手动提交', onebot: 'QQ', qq: 'QQ', wechat: '微信', chaoxing: '学习通', dingtalk: '钉钉', manual: '手动添加'};

  function node(tag, className, value) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (value) element.textContent = value;
    return element;
  }

  function button(label, className, action) {
    var element = node('button', className, label);
    element.type = 'button';
    element.addEventListener('click', action);
    return element;
  }

  function closed(order) {
    return ['ignored', 'terminated', 'hidden', 'merged'].includes(order.state);
  }

  var hiddenKey = 'superdot:workbench:hidden';
  var hiddenOrders = new Set();
  try {
    var storedHidden = JSON.parse(localStorage.getItem(hiddenKey) || '[]');
    if (Array.isArray(storedHidden)) hiddenOrders = new Set(storedHidden);
  } catch (error) {}

  function hiddenId(order) { return (order.ticket ? 'ticket:' : 'local:') + order.id; }
  function isHidden(order) { return hiddenOrders.has(hiddenId(order)); }

  function changeVisibility(order) {
    var wasHidden = isHidden(order);
    if (wasHidden) hiddenOrders.delete(hiddenId(order));
    else hiddenOrders.add(hiddenId(order));
    try { localStorage.setItem(hiddenKey, JSON.stringify(Array.from(hiddenOrders))); } catch (error) {}
    status.textContent = wasHidden ? '工单已恢复显示。' : '工单已隐藏，可在归档工单恢复显示。';
    if (wasHidden && !closed(order)) {
      archive = false;
      filter = 'all';
    }
    render();
  }

  function workerSession(order) {
    if (!order.ticket) return null;
    var sessions = order.ticket.nodes.slice().reverse();
    for (var entry of sessions) {
      if (entry.kind !== 'session' || !Array.isArray(entry.refs)) continue;
      var ref = entry.refs.find(function (item) {
        return item.kind === 'session' && item.role === 'worker' && typeof item.id === 'string' && item.id.trim();
      });
      if (ref) return ref;
    }
    return null;
  }

  function appendWorkerSession(actions, order) {
    var session = workerSession(order);
    if (!session) return;
    actions.append(button('打开 DSH 会话', 'btn', function () {
      post('/api/dsh/session', {ticket_id: order.id}).then(function (data) {
        if (!data.url) throw new Error('会话地址不可用');
        window.location.assign(data.url);
      }).catch(showExecutionError);
    }));
  }

  function commonActions(actions, order) {
    if (isHidden(order)) {
      actions.append(button('恢复显示', 'btn', function () { changeVisibility(order); }));
      return [];
    }
    if (closed(order)) return [];
    var targets = board.orders.filter(function (row) {
      return row.id !== order.id && !closed(row) && row.state !== 'completed';
    });
    var mergeButton = button('合并工单至', 'btn', function () {
      showDialog('合并工单至', '确认合并', [
        {key: 'target', label: '目标工单', type: 'select', required: true, options: targets.map(function (target) {
          return {value: target.id, label: target.summary + ' · ' + target.id};
        })}
      ], function (values) {
        if (order.ticket) return performExecution(order, 'merge', {target_ticket_id: values.target});
        return perform(order, 'merge', '工单已合并。', {target_id: Number(values.target)});
      });
    });
    mergeButton.disabled = !targets.length;
    var controls = [mergeButton];
    if (order.ticket || order.state !== 'completed') {
      controls.push(button('停止工单', 'btn wb-stop', function () {
        if (order.ticket) simpleAction(order, 'stop', '停止工单');
        else confirmClose(order, 'terminate', '停止工单');
      }));
    }
    controls.push(button('隐藏工单', 'btn', function () { changeVisibility(order); }));
    return controls;
  }

  function moreActions(controls) {
    var group = node('div', 'wb-more');
    var menu = node('div', 'wb-menu');
    menu.hidden = true;
    var trigger = button('更多操作', 'btn', function () {
      menu.hidden = !menu.hidden;
      trigger.setAttribute('aria-expanded', String(!menu.hidden));
    });
    trigger.setAttribute('aria-expanded', 'false');
    menu.append.apply(menu, controls);
    group.append(trigger, menu);
    return group;
  }

  function inboxLink(packageId, messageId) {
    var id = packageId || messageId;
    if (!id) return null;
    var link = node('a', 'wb-source-link', '在收件箱查看原消息包');
    link.href = '#inbox?' + new URLSearchParams([[packageId ? 'package_id' : 'msg_id', id]]);
    link.addEventListener('click', function (event) {
      if (location.hash === link.hash && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }
    });
    return link;
  }

  function timelineNode(label, stamp, body, number) {
    var item = node('li', 'wb-node');
    var byline = node('div', 'wb-node-heading');
    if (number) byline.append(node('span', 'wb-meta wb-node-number', number));
    byline.append(node('strong', '', label));
    var date = node('time', 'wb-meta wb-node-time', dateLabel(stamp));
    if (stamp) date.dateTime = stamp;
    byline.append(date);
    item.append(byline);
    if (body) {
      var preview = node('p', 'wb-node-copy', body);
      
      item.append(preview);
    }
    return item;
  }

  function creationNode(order) {
    return timelineNode('工单创建', order.created_at, '');
  }

  var titleSegmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('zh', {granularity: 'grapheme'}) : null;

  function conversationName(value, id) {
    var label = String(value || '').trim();
    if (!label || label === id || /^(?:(?:private|group|channel)[:：]\s*)?\d+$/i.test(label)) return '';
    return label;
  }

  function conversationLabel(name, id) {
    var label = conversationName(name, id);
    var number = String(id || '').trim().replace(/^(?:private|group|channel)[:：]\s*/i, '');
    return label || number || '未知';
  }

  function isDemo(order) {
    return !order.ticket && (order.source_event === 'PREVIEW_DEMO' || order.summary.startsWith('（演示数据）'));
  }

  function source(order) {
    var conversation = order.source_conversation || {};
    var key = conversation.source || order.source || '';
    var id = conversation.id || order.source_conversation_id || '';
    var label = conversationName(conversation.name || order.source_conversation_name, id);
    if (!label && !order.ticket) {
      label = (order.groups || []).map(function (group) {
        return conversationName(group, id);
      }).filter(Boolean).join('、');
    }
    var platform = sources[key] || (key.startsWith('onebot') || key === 'qqbot' || key === 'qq_message' ? 'QQ' : '');
    var fallbackId = id || (order.groups || []).find(function (group) {
      return /^(?:(?:private|group|channel)[:：]\s*)?\d+$/i.test(String(group || '').trim());
    });
    var origin = [platform, label || fallbackId ? conversationLabel(label, fallbackId) : ''].filter(Boolean).join('·');
    return isDemo(order) ? '演示来源 · ' + origin : origin;
  }

  function title(order) {
    var text = order.summary || '未命名工单';
    return isDemo(order) && !text.startsWith('（演示数据）') ? '（演示数据）' + text : text;
  }

  function shortTitle(text) {
    var letters = titleSegmenter
      ? Array.from(titleSegmenter.segment(text), function (part) { return part.segment; })
      : Array.from(text);
    return letters.length > 20 ? letters.slice(0, 20).join('') + '…' : text;
  }

  function name(order) {
    if (order.state === 'running') return 'Worker 执行中';
    if (order.ticket && order.state === 'blocked') return '执行受阻';
    return stateNames[order.state];
  }

  function badge(order) {
    var element = node('span', 'wb-badge', name(order));
    element.dataset.state = order.state;
    return element;
  }

  function dateLabel(value, short) {
    var raw = String(value || '');
    if (!raw) return '';
    var day = raw.slice(0, 10);
    var time = raw.slice(11, 16);
    if (day === (board ? board.today : todayLabel())) return short ? time || '今天' : '今天 ' + time;
    return short ? day.slice(5) : [day, time].filter(Boolean).join(' ');
  }

  function lanes() {
    var rows = board.orders.filter(function (order) { return !isHidden(order); });
    var active = rows.filter(function (order) { return !closed(order) && order.state !== 'completed'; });
    var archived = board.orders.filter(function (order) { return closed(order) || isHidden(order); }).sort(function (left, right) { return Date.parse(right.updated_at) - Date.parse(left.updated_at); });
    if (execution) return archive ? {
      archive: ['全部', archived],
      hidden: ['已隐藏', archived.filter(isHidden)],
      terminated: ['已终止', archived.filter(function (order) { return order.state === 'terminated'; })],
      merged: ['已并出', archived.filter(function (order) { return order.state === 'merged'; })]
    } : {
      all: ['全部', rows.filter(function (order) { return !closed(order); })],
      new: ['今日新增', active.filter(function (order) { return order.created_at.slice(0, 10) === board.today; })],
      blocked: ['待处理', active.filter(function (order) { return ['blocked', 'interrupted', 'review'].includes(order.state); })]
    };
    return archive ? {
      archive: ['全部', archived],
      hidden: ['已隐藏', archived.filter(isHidden)],
      terminated: ['已终止', archived.filter(function (order) { return order.state === 'terminated'; })],
      merged: ['已并出', archived.filter(function (order) { return order.state === 'merged'; })],
      ignored: ['已忽略', archived.filter(function (order) { return order.state === 'ignored'; })]
    } : {
      new: ['今日新获取', rows.filter(function (order) { return !closed(order) && order.created_at.slice(0, 10) === board.today; })
        .sort(function (left, right) { return right.id - left.id; })],
      running: ['正在进行', active.filter(function (order) { return ['queued', 'running', 'blocked'].includes(order.state); })],
      blocked: ['待处理', active.filter(function (order) { return ['blocked', 'interrupted', 'review'].includes(order.state); })],
      all: ['全部', rows.filter(function (order) { return !closed(order); })]
    };
  }

  function render() {
    var groups = lanes();
    if (!groups[filter]) filter = Object.keys(groups)[0];
    var rows = groups[filter][1];
    var selected = rows.find(function (order) { return order.id === selection; }) || rows[0];
    selection = selected ? selected.id : null;
    root.dataset.archive = String(archive);
    root.dataset.execution = String(execution);
    if (!execution) {
      noticePanel.hidden = true;
      noticeButton.setAttribute('aria-expanded', 'false');
    }
    var archiveLabel = '归档工单';
    heading.textContent = archive ? archiveLabel : '工单工作台';
    archiveButton.textContent = archive ? '返回工单工作台' : archiveLabel;
    addMessageButton.textContent = execution ? '＋ 新任务' : '＋ 添加消息';
    noticeButton.hidden = !execution;
    addMessageButton.hidden = archive;
    nav.replaceChildren();
    Object.keys(groups).forEach(function (key) {
      var lane = groups[key];
      var tab = button(lane[0], 'wb-filter', function () {
        if (filter === key) return;
        filter = key;
        selection = null;
        render();
        nav.querySelector('[aria-pressed="true"]').focus();
      });
      tab.setAttribute('aria-pressed', key === filter ? 'true' : 'false');
      tab.append(node('span', 'wb-count', String(lane[1].length)));
      nav.append(tab);
    });
    var listScroll = list.dataset.filter === filter ? list.scrollTop : 0;
    list.dataset.filter = filter;
    list.replaceChildren();
    if (!rows.length) list.append(node('p', 'wb-empty', '暂无' + (filter === 'all' || filter === 'archive' ? '' : groups[filter][0] + '的') + '工单'));
    rows.forEach(function (order) {
      var row = button('', 'wb-row', function () {
        selection = order.id;
        render();
        if (window.matchMedia('(max-width: 800px)').matches) {
          detail.tabIndex = -1;
          detail.focus({preventScroll: true});
          detail.scrollIntoView({block: 'start'});
        } else list.querySelector('[aria-current="true"]').focus({preventScroll: true});
        if (execution) refreshTicket(order.id).catch(showExecutionError);
      });
      if (order.id === selection) row.setAttribute('aria-current', 'true');
      var fullTitle = title(order);
      var headline = node('strong', '', shortTitle(fullTitle));
      if (headline.textContent !== fullTitle) headline.title = fullTitle;
      row.append(headline, node('time', '', dateLabel(execution || archive ? order.updated_at : order.deadline, true)));
      if (source(order)) row.append(node('span', 'wb-meta wb-row-summary', source(order)));
      if (order.state !== 'visible') row.append(badge(order));
      list.append(row);
    });
    list.scrollTop = listScroll;
    if (execution) renderExecutionDetail(selected);
    else renderDetail(selected);
  }

  function post(path, payload) {
    return api(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
  }

  function perform(order, action, label, extra) {
    if (busy) return Promise.reject(new Error('正在保存，请稍候'));
    busy = true;
    status.textContent = '';
    detail.setAttribute('aria-busy', 'true');
    detail.querySelectorAll('button').forEach(function (control) { control.disabled = true; });
    return post('/api/work-orders/action', Object.assign({id: order.id, revision: order.revision, action: action}, extra))
      .then(function (result) {
        if (action === 'restore') {
          archive = false;
          filter = 'all';
          selection = order.id;
        }
        board.orders = board.orders.map(function (row) { return row.id === order.id ? result.order : row; });
        status.textContent = label;
        render();
        return refresh().catch(function () {});
      }).catch(function (error) {
        status.textContent = error.message;
        return refresh().catch(function () {}).then(function () { throw error; });
      }).finally(function () {
        busy = false;
        detail.removeAttribute('aria-busy');
        detail.querySelectorAll('button').forEach(function (control) { control.disabled = false; });
      });
  }

  function block(titleText, body) {
    var area = node('section', 'wb-box');
    area.append(node('h3', '', titleText), node('p', 'wb-copy', body));
    return area;
  }

  function disclosure(label, content) {
    var panel = node('details', 'wb-section');
    panel.append(node('summary', '', label), content);
    return panel;
  }

  function anchorAction(label, target, primary) {
    return button(label, primary ? 'btn primary' : 'btn', function () {
      if (target.tagName === 'DETAILS') target.open = true;
      var focus = target.querySelector('summary, select, textarea, button');
      if (focus) focus.focus();
      target.scrollIntoView({block: 'nearest'});
    });
  }

  function inlineReply(actions, target, label, field, submitLabel, withFiles, submit) {
    var reply = node('form', 'wb-approval wb-reply');
    reply.hidden = true;
    var toggle = button(label, 'btn', function () {
      reply.hidden = !reply.hidden;
      toggle.setAttribute('aria-expanded', String(!reply.hidden));
      if (!reply.hidden) input.focus();
    });
    toggle.setAttribute('aria-expanded', 'false');
    actions.append(toggle);
    var fieldLabel = node('label', '', field);
    var input = node('textarea', '');
    input.rows = 3;
    input.maxLength = 8000;
    input.required = !withFiles;
    fieldLabel.append(input);
    reply.append(fieldLabel);
    var files;
    if (withFiles) {
      var attachment = node('label', '', attachmentLabel);
      files = node('input', '');
      files.type = 'file';
      files.multiple = true;
      attachment.append(files);
      reply.append(attachment);
    }
    var save = node('button', 'btn primary', submitLabel);
    save.type = 'submit';
    var error = node('p', 'wb-reply-error');
    error.setAttribute('role', 'alert');
    reply.append(save, error);
    reply.addEventListener('submit', function (event) {
      event.preventDefault();
      if (save.disabled) return;
      var value = input.value.trim();
      var selectedFiles = files ? Array.from(files.files) : [];
      if (!value && !selectedFiles.length) {
        error.textContent = withFiles ? '请填写内容或添加附件。' : '请填写内容。';
        return;
      }
      save.disabled = true;
      error.textContent = '';
      Promise.resolve().then(function () {
        return submit(value, selectedFiles);
      }).then(function () {
        reply.reset();
        reply.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        if (toggle.isConnected) toggle.focus();
      }).catch(function (failure) {
        error.textContent = failure.message;
      }).finally(function () { save.disabled = false; });
    });
    target.append(reply);
  }

  function approvalForm(order, draft) {
    var area = node('section', 'wb-box wb-blocker');
    area.append(node('p', 'wb-copy', order.checkpoint));
    var form = node('form', 'wb-approval');
    form.dataset.key = order.id + ':' + order.revision;
    var input = node('textarea', '');
    input.setAttribute('aria-label', '给助手的提示词');
    input.required = true;
    input.rows = 3;
    input.maxLength = 8000;
    if (draft) input.value = draft;
    var submit = node('button', 'btn primary', '提交提示词');
    submit.type = 'submit';
    form.append(input, submit);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var response = input.value;
      if (!response.trim()) {
        input.setCustomValidity('请输入提示词');
        input.reportValidity();
        return;
      }
      perform(order, 'approve', '提示词已提交，等待助手继续。', {note: response}).catch(function () {});
    });
    input.addEventListener('input', function () { input.setCustomValidity(''); });
    area.append(form);
    return area;
  }

  function detailSticker() {
    var image = node('img', 'wb-detail-sticker');
    image.src = '/whale/inbox-checklist.png?v=480';
    image.alt = '';
    image.width = 480;
    image.height = 480;
    return image;
  }

  function renderDetail(order) {
    var orderId = order ? String(order.id) : '';
    var detailScroll = detail.dataset.orderId === orderId ? detail.scrollTop : 0;
    detail.dataset.orderId = orderId;
    var previous = detail.querySelector('.wb-approval');
    var draft = previous && order && previous.dataset.key === order.id + ':' + order.revision
      ? previous.querySelector('select, textarea').value : '';
    detail.replaceChildren();
    if (!order) {
      detail.append(node('p', 'wb-empty', '在左侧选择工单查看详情。'));
      return;
    }
    var head = node('header', 'wb-detail-head');
    var titleRow = node('div', 'wb-title-row');
    var heading = node('h2', '', title(order));
    heading.title = heading.textContent;
    titleRow.append(heading, badge(order));
    head.append(titleRow, node('p', 'wb-meta', [order.deadline ? dateLabel(order.deadline) + ' 截止' : '未设截止时间', source(order)].join(' · ')));
    var actions = node('div', 'wb-actions wb-toolbar');
    appendWorkerSession(actions, order);
    function add(label, action, primary) {
      actions.append(button(label, 'btn' + (primary ? ' primary' : ''), function () {
        perform(order, action, eventNames['work_order_' + action]).catch(function () {});
      }));
    }
    var approval = order.state === 'blocked' ? approvalForm(order, draft) : null;
    if (approval && !isHidden(order)) actions.append(anchorAction('补充工单', approval));
    if (['queued', 'running', 'completed'].includes(order.state) && !isHidden(order)) {
      inlineReply(actions, head, '补充工单', '补充说明', '保存补充', false, function (value) {
        return perform(order, 'supplement', '补充已保存。', {note: value});
      });
    }
    var originalBody = node('div', '');
    originalBody.append(node('p', 'wb-copy', order.source_text || order.evidence || '暂无可读原文。'));
    var sourceLink = inboxLink(order.source_package_id, order.source_message_id);
    if (sourceLink) originalBody.append(sourceLink);
    var originals = disclosure('原始消息', originalBody);
    var extraActions = commonActions(actions, order);
    if (['terminated', 'ignored'].includes(order.state)) {
      add(order.state === 'terminated' ? '恢复执行' : '撤销忽略', 'restore', true);
    }
    if (!closed(order) && order.state !== 'completed' && !isHidden(order)) {
      extraActions.push(button('修改截止时间', 'btn', function () { editDeadline(order); }),
        button('忽略工单', 'btn', function () { confirmClose(order, 'ignore', '忽略工单'); }));
    }
    extraActions.push(anchorAction('查看原始消息', originals));
    actions.append(moreActions(extraActions));
    head.insertBefore(actions, head.querySelector('.wb-reply'));
    detail.append(head);
    var body = node('div', 'wb-detail-body');
    if (approval) body.append(approval);
    if (order.result) {
      var result = block('交付成果', order.result);
      result.classList.add('wb-stage-result');
      result.firstElementChild.append(badge({state: order.result_confirmed ? 'confirmed' : 'review'}));
      if (order.state === 'completed') {
        var review = node('div', 'wb-actions');
        if (!order.result_confirmed) review.append(button('确认完成', 'btn primary', function () {
          perform(order, 'confirm_result', '成果已确认。').catch(function () {});
        }));
        result.append(review);
        inlineReply(review, result, '还有问题', '追加提示词', '发送反馈', false, function (value) {
          return perform(order, 'supplement', '反馈已保存，等待 Worker 接单。', {note: value});
        });
      }
      body.append(result);
    }
    var executionRequirement = block('执行要求', [order.action || order.summary].concat(order.details || []).filter(Boolean).join('\n'));
    executionRequirement.classList.add('wb-requirement');
    body.append(executionRequirement, originals);
    var activity = node('section', 'wb-activity');
    activity.append(node('h3', '', '节点记录'));
    var timeline = node('ol', 'wb-timeline');
    timeline.setAttribute('role', 'list');
    timeline.append(creationNode(order));
    activity.append(timeline);
    body.append(activity);
    detail.append(body, detailSticker());
    detail.scrollTop = detailScroll;
    api('/api/work-orders/events?id=' + encodeURIComponent(order.id)).then(function (data) {
      if (!activity.isConnected) return;
      data.events.slice().reverse().forEach(function (event) {
        var label = eventNames[event.event];
        var showDetail = ['work_order_request_approval', 'work_order_approve', 'work_order_terminate', 'work_order_ignore', 'work_order_router_append'];
        if (!label) return;
        var showBody = showDetail.includes(event.event) || event.event === 'work_order_supplement' ||
          (event.event === 'work_order_complete' && event.detail !== order.result);
        var item = timelineNode(label, event.created_at, showBody ? event.detail : '');
        if (event.detail && ['work_order_merge', 'work_order_merge_in'].includes(event.event)) {
          var refs = node('ul', 'wb-node-refs');
          var ref = node('li', '');
          ref.append(button('查看关联工单 ' + event.detail, 'btn', function () { open(event.detail).catch(showExecutionError); }));
          refs.append(ref);
          item.append(refs);
        }
        timeline.append(item);
      });
    }).catch(function (error) {
      if (activity.isConnected) activity.append(node('p', '', error.message));
    });
  }

  function requireCode(data, codes) {
    if (!data || !codes.includes(data.code)) throw new Error('服务未返回预期回执，请重试。');
    return data;
  }

  function todayLabel() {
    var today = new Date();
    return [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0')].join('-');
  }

  function executionOrder(ticket, conversation, availablePackages) {
    var updated = ticket.nodes.reduce(function (stamp, entry) {
      return Date.parse(entry.created_at) > Date.parse(stamp) ? entry.created_at : stamp;
    }, ticket.created_at);
    var unresolved = new Set();
    var visibility = 'hidden';
    var interrupted = false;
    ticket.nodes.forEach(function (entry) {
      if (entry.kind === 'blocked') unresolved.add(entry.node_id);
      if (entry.kind === 'unblocked') entry.refs.forEach(function (ref) {
        if (ref.kind === 'node') unresolved.delete(ref.id);
      });
      if (entry.kind === 'interrupted') interrupted = true;
      if (entry.kind === 'recover' || entry.kind === 'resume') interrupted = false;
      if (entry.kind === 'stop') visibility = 'terminated';
      if (entry.kind === 'merge_out') visibility = 'merged';
    });
    var review = ticket.review;
    var lastDecision = ticket.nodes.filter(function (entry) {
      return ['confirm', 'result', 'input', 'feedback', 'blocked', 'merge_in', 'recover', 'resume'].includes(entry.kind);
    }).pop();
    var state = ticket.description.visible === 0 ? visibility
      : interrupted ? 'interrupted' : (review ? review.blocked_node_ids.length : unresolved.size) ? 'blocked'
      : review && review.result_node_id ? 'review' : lastDecision && lastDecision.kind === 'confirm' ? 'completed' : 'visible';
    return {id: ticket.ticket_id, summary: ticket.title, created_at: ticket.created_at,
      updated_at: updated, revision: JSON.stringify([ticket, conversation, availablePackages]), deadline: '',
      ticket: ticket, state: state, availablePackages: availablePackages || [], source_conversation: conversation};
  }

  function showExecutionError(error) {
    latestError = error;
    status.textContent = error.message;
  }

  function refreshTicket(id) {
    return api('/api/tickets/' + encodeURIComponent(id)).then(function (data) {
      requireCode(data, ['OK']);
      if (data.ticket.ticket_id !== id) throw new Error('工单回执的编号不一致，请重新打开。');
      var order = executionOrder(data.ticket, data.source_conversation, data.available_package_ids);
      if (!execution || !board) return order;
      var previous = board.orders.find(function (row) { return row.id === id; });
      if (!previous) board.orders.push(order);
      else board.orders = board.orders.map(function (row) { return row.id === id ? order : row; });
      if (selection === id && (!previous || previous.revision !== order.revision)) render();
      return order;
    });
  }

  function operationId() {
    var bytes = crypto.getRandomValues(new Uint8Array(16));
    return 'op-' + Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
  }

  function operationKey(path, payload) {
    var key = path + '\n' + JSON.stringify(payload);
    if (!crypto.subtle) return Promise.resolve({memory: key});
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)).then(function (bytes) {
      return {saved: 'superdot:pending:' + Array.from(new Uint8Array(bytes), function (byte) {
        return byte.toString(16).padStart(2, '0');
      }).join('')};
    });
  }

  function rememberedOperation(key) {
    if (key.saved) {
      try { return sessionStorage.getItem(key.saved) || pendingOperations.get(key.saved); } catch (error) {}
    }
    return pendingOperations.get(key.memory || key.saved);
  }

  function rememberOperation(key, id) {
    var lookup = key.memory || key.saved;
    if (id) pendingOperations.set(lookup, id);
    else pendingOperations.delete(lookup);
    if (!key.saved) return;
    try {
      if (id) sessionStorage.setItem(key.saved, id);
      else sessionStorage.removeItem(key.saved);
    } catch (error) {}
  }

  function submitOperation(path, args, validate, retainKey) {
    return operationKey(path, args).then(function (key) {
      var id = rememberedOperation(key) || operationId();
      rememberOperation(key, id);
      return post(path, Object.assign({operation_id: id}, args)).then(function (receipt) {
        if (!receipt || !validate(receipt, id)) throw new Error('提交回执无法核对，请用原内容重试。');
        if (retainKey) retainKey(key);
        else rememberOperation(key, null);
        return receipt;
      });
    });
  }

  function registerAttachments(files) {
    if (files.some(function (file) { return !file.size || file.size > uploadLimitMiB * 1024 * 1024; })) {
      return Promise.reject(new Error('单个附件需大于 0 字节且不超过 ' + uploadLimitMiB + ' MiB。'));
    }
    var keys = [];
    return files.reduce(function (registered, file) {
      return registered.then(function (refs) {
        return file.arrayBuffer().then(function (buffer) {
          var bytes = new Uint8Array(buffer);
          var binary = '';
          for (var start = 0; start < bytes.length; start += 8192) {
            binary += String.fromCharCode.apply(null, bytes.subarray(start, start + 8192));
          }
          return submitOperation('/api/raw/attachments', {filename: file.name, content_base64: btoa(binary)},
            function (result) { return ['OK', 'REPLAYED'].includes(result.code) && result.ref && result.ref.id; },
            function (key) { keys.push(key); });
        }).then(function (result) {
          if (refs.some(function (ref) { return ref.id === result.ref.id; })) return refs;
          return refs.concat(result.ref);
        });
      });
    }, Promise.resolve([])).then(function (refs) {
      return {refs: refs, complete: function () { keys.forEach(function (key) { rememberOperation(key, null); }); }};
    });
  }

  function submitNewTask(text, files) {
    var args = {kind: 'new_task'};
    if (!text.trim() && !(files && files.length)) return Promise.reject(new Error('请填写任务内容或添加附件。'));
    if (text.trim()) args.text = text;
    return registerAttachments(files || []).then(function (uploads) {
      if (uploads.refs.length) args.attachment_refs = uploads.refs;
      return submitOperation('/api/packages', args, function (result) {
        return ['QUEUED', 'OK', 'REPLAYED'].includes(result.code) && result.package_ref && result.package_ref.id;
      }).then(function (result) {
        uploads.complete();
        return result;
      });
    }).then(function (result) {
      status.textContent = '任务已收录，等待执行端接管。';
      if (typeof loadInbox === 'function' && !document.getElementById('tab-inbox').hidden) loadInbox();
      return result;
    });
  }

  function performExecution(order, operation, fields) {
    var args = Object.assign({operation: operation, ticket_id: order.id}, fields);
    if (operation === 'merge') {
      delete args.ticket_id;
      args.source_ticket_id = order.id;
    }
    var expected = args.target_ticket_id || order.id;
    var codes = operation === 'confirm' ? ['OK', 'REPLAYED'] : ['ACCEPTED', 'REPLAYED'];
    return submitOperation('/api/tickets/actions', args, function (result, id) {
      return codes.includes(result.code) && result.operation_id === id && result.ticket_id === expected &&
        (operation !== 'confirm' || Boolean(result.node_id));
    }).then(function () {
      status.textContent = operation === 'confirm' ? '成果已确认。' : '操作已提交。';
      return refresh().catch(showExecutionError);
    });
  }

  function packageEvidence(id) {
    var disclosure = node('details', 'wb-evidence');
    var output = node('div', 'wb-evidence-body');
    disclosure.append(node('summary', '', '查看原始消息'), output);
    var requested = false;
    disclosure.addEventListener('toggle', function () {
      if (!disclosure.open || requested) return;
      requested = true;
      output.textContent = '正在读取原文…';
      api('/api/packages/' + encodeURIComponent(id)).then(function (data) {
        requireCode(data, ['OK']);
        output.replaceChildren();
        var records = node('ul', 'wb-records');
        data.records.forEach(function (record) {
          var item = node('li', '');
          var fileState = {NOT_DOWNLOADED: '未下载', DOWNLOADED: '已下载', UNAVAILABLE: '文件不可用'};
          item.append(node('span', 'wb-meta', [sources[record.source] || record.source, record.sender_id,
            dateLabel(record.sent_at), fileState[record.download_state]].filter(Boolean).join(' · ')),
            node('p', '', record.content));
          records.append(item);
        });
        if (records.childElementCount) output.append(records);
        else output.append(node('p', '', '此消息包暂无可读原文。'));
        if (data.missing_refs.length) output.append(node('p', 'wb-meta',
          '缺失的原始记录 ' + data.missing_refs.map(function (ref) { return ref.id; }).join('、')));
      }).catch(function (error) {
        requested = false;
        output.textContent = error.message + ' 关闭后重新展开可重试。';
      });
    });
    return disclosure;
  }

  function ticketIdsForPackage(id) {
    if (!execution || !board) return [];
    return board.orders.filter(function (order) {
      return order.ticket.package_refs.some(function (ref) { return ref.id === id; });
    }).map(function (order) { return {id: order.id, title: order.summary}; });
  }

  function sendTicketMessage(order, operation, content, files, entry) {
    var extra = {};
    if (content) extra.text = content;
    if (entry) extra.node_id = entry.node_id;
    return registerAttachments(files).then(function (uploads) {
      if (uploads.refs.length) extra.attachment_refs = uploads.refs;
      return performExecution(order, operation, extra).then(uploads.complete);
    });
  }

  function simpleAction(order, operation, label, entry) {
    showDialog(label, label, [], function () {
      return performExecution(order, operation, entry ? {node_id: entry.node_id} : undefined);
    });
  }

  function resultArtifact(id) {
    var parts = id.split('/');
    var filename = parts[1];
    if (!artifactsAvailable || parts.length !== 2 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(parts[0]) ||
        !filename || filename === '.' || filename === '..' || filename.includes('\\')) {
      return node('span', '', '成果 ' + (filename || id));
    }
    var url = '/api/artifacts/' + parts.map(encodeURIComponent).join('/');
    var link = node('a', 'btn wb-file-button', '下载 ' + filename);
    link.href = url;
    link.download = filename;
    link.addEventListener('click', function (event) {
      if (typeof token !== 'string' || !token) return;
      event.preventDefault();
      fetch(url, {headers: {'X-Token': token}}).then(function (response) {
        if (!response.ok) throw new Error('成果文件下载失败，请刷新工单后重试。');
        return response.blob();
      }).then(function (blob) {
        var download = node('a', '');
        download.href = URL.createObjectURL(blob);
        download.download = filename;
        download.click();
        window.setTimeout(function () { URL.revokeObjectURL(download.href); }, 30000);
      }).catch(showExecutionError);
    });
    return link;
  }

  function renderExecutionDetail(order) {
    var id = order ? order.id : '';
    var sameTicket = detail.dataset.orderId === id;
    var revision = order && order.revision;
    if (order && sameTicket && detail.dataset.revision === revision && detail.dataset.hiddenOrder === String(isHidden(order)) &&
        detail.dataset.artifacts === String(artifactsAvailable)) {
      renderTicketNotices();
      return;
    }
    var scroll = sameTicket ? detail.scrollTop : 0;
    detail.dataset.revision = revision || '';
    detail.dataset.artifacts = String(artifactsAvailable);
    detail.dataset.orderId = id;
    detail.dataset.hiddenOrder = String(order && isHidden(order));
    detail.replaceChildren();
    if (!order) {
      detail.append(node('p', 'wb-empty', '在左侧选择工单查看详情。'));
      return;
    }
    var ticket = order.ticket;
    var head = node('header', 'wb-detail-head');
    var titleRow = node('div', 'wb-title-row');
    var heading = node('h2', '', ticket.title || '未命名工单');
    heading.title = heading.textContent;
    titleRow.append(heading);
    if (order.state !== 'visible') titleRow.append(badge(order));
    head.append(titleRow);
    if (source(order)) head.append(node('p', 'wb-meta', source(order)));
    if (ticket.description.text) head.append(node('p', 'wb-description', ticket.description.text));
    var actions = node('div', 'wb-actions wb-toolbar');
    appendWorkerSession(actions, order);
    if (order.state === 'terminated') actions.append(button('恢复执行', 'btn primary', function () {
      simpleAction(order, 'resume', '恢复执行');
    }));
    if (!closed(order) && !isHidden(order)) {
      inlineReply(actions, head, '补充工单', '补充说明', '发送补充', true, function (content, files) {
        return sendTicketMessage(order, 'supplement', content, files);
      });
    }
    var extraActions = commonActions(actions, order);
    if (extraActions.length) actions.append(moreActions(extraActions));
    var body = node('div', 'wb-detail-body');
    var requirement = ticket.nodes.find(function (entry) { return entry.kind === 'requirement'; });
    var sourceRef = requirement && requirement.refs.find(function (ref) { return ref.kind === 'package'; });
    var primaryPackage = (sourceRef || ticket.package_refs[0] || {}).id;
    var nextTasks = node('section', 'wb-ticket-tasks');
    nextTasks.dataset.ticketNotices = order.id;
    var delivery;
    var latestResult;
    var awaitingReview;
    var currentFiles = new Map();
    var activity = node('section', 'wb-activity');
    activity.append(node('h3', '', '节点记录'));
    var timeline = node('ol', 'wb-timeline');
    timeline.setAttribute('role', 'list');
    timeline.append(creationNode(order));
    var names = {requirement: '原始要求', session: 'Worker 会话', input: '补充内容', feedback: '成果反馈',
      result: '阶段成果', blocked: '执行卡点', unblocked: '卡点解除', stop: '终止执行', resume: '恢复执行',
      recover: '接续执行', merge_in: '并入工单', merge_out: '并出工单', confirm: '确认成果',
      note: '执行笔记', interrupted: '执行中断'};
    var confirmed = new Set();
    var resolved = new Set();
    var latestInterrupted = null;
    ticket.nodes.forEach(function (entry) {
      if (entry.kind === 'result') {
        latestResult = awaitingReview = entry;
        entry.refs.filter(function (ref) { return ref.kind === 'artifact'; }).forEach(function (ref) {
          var key = ref.id.replace(/-v[0-9]+(?:-[^/.]+)?(?=\.[^/.]+$)/i, '');
          currentFiles.set(key, ref.id);
        });
      } else if (['input', 'feedback', 'resume', 'recover', 'merge_in', 'unblocked'].includes(entry.kind)) {
        awaitingReview = null;
      }
      if (entry.kind === 'interrupted') latestInterrupted = entry.node_id;
      if (entry.kind === 'recover') latestInterrupted = null;
      entry.refs.forEach(function (ref) {
        if (ref.kind !== 'node') return;
        if (entry.kind === 'confirm') confirmed.add(ref.id);
        if (entry.kind === 'unblocked') resolved.add(ref.id);
      });
    });
    ticket.nodes.forEach(function (entry, index) {
      var number = String(index + 1).padStart(3, '0');
      var summary = entry.text;
      if (entry.kind === 'result' || entry.kind === 'note') {
        summary = entry.summary || entry.text.split(/[。；\n（]/, 1)[0].replace(/^本轮(?:小结|收尾)[：:]/, '').trim();
        if (summary.length > 60) summary = summary.slice(0, 59) + '…';
      }
      var item = timelineNode(names[entry.kind] || '执行记录', entry.created_at, summary, number);
      if (entry.kind === 'unblocked' && entry.refs.some(function (ref) { return ref.kind === 'package' || ref.kind === 'ticket'; })) {
        item.querySelector('strong').textContent = '卡点已自动解除';
      }
      item.tabIndex = -1;
      var line = item.firstElementChild;
      if (entry === requirement && order.availablePackages.includes(primaryPackage)) {
        var originalLink = inboxLink(primaryPackage);
        originalLink.className = 'wb-original-button';
        originalLink.textContent = '查看原始消息';
        line.querySelector('strong').after(originalLink);
      }
      var pendingReview = ticket.review ? ticket.review.result_node_id === entry.node_id : entry === awaitingReview;
      var reviewState = confirmed.has(entry.node_id) ? 'confirmed' : pendingReview ? 'review' : 'skipped';
      if (entry.kind === 'result') line.append(badge({state: reviewState}));
      if (entry.kind === 'blocked' && (resolved.has(entry.node_id) || (ticket.review && !ticket.review.blocked_node_ids.includes(entry.node_id)))) line.append(badge({state: 'cleared'}));
      else if (entry.kind === 'blocked' && order.state === 'blocked') {
        line.append(badge({state: 'waiting'}));
      }
      var references = node('ul', 'wb-node-refs');
      entry.refs.forEach(function (ref) {
        if (ref.kind === 'ticket') {
          var related = node('li', '');
          related.append(button(entry.kind === 'merge_out' ? '打开合并后的工单' : '查看并入的工单', 'btn', function () { open(ref.id).catch(showExecutionError); }));
          references.append(related);
        } else if (ref.kind === 'artifact') {
          var result = node('li', '');
          result.append(resultArtifact(ref.id));
          references.append(result);
        } else if (ref.kind === 'attachment') {
          references.append(node('li', '', '附件 ' + ref.id));
        }
      });
      if (references.childElementCount) item.append(references);
      if (entry === latestResult) {
        var revisionNote = /\n+([（(]相比\s*\/\d+\s*的变化[：:][\s\S]*[）)])\s*$/.exec(entry.text);
        delivery = block('交付成果', revisionNote ? entry.text.slice(0, revisionNote.index) : entry.text);
        if (revisionNote) delivery.append(disclosure('修订说明', node('p', 'wb-copy', revisionNote[1].slice(1, -1))));
        delivery.dataset.resultNode = entry.node_id;
        delivery.classList.add('wb-stage-result');
        delivery.firstElementChild.append(badge({state: reviewState}));
        var reviewActions = node('div', 'wb-actions');
        currentFiles.forEach(function (id) { reviewActions.append(resultArtifact(id)); });
        delivery.append(reviewActions);
        if (reviewState === 'review' && !closed(order) && !isHidden(order)) {
          reviewActions.append(button('确认完成', 'btn primary', function () {
            simpleAction(order, 'confirm', '确认完成', entry);
          }));
          inlineReply(reviewActions, delivery, '还有问题', '追加提示词', '发送反馈', true, function (content, files) {
            return sendTicketMessage(order, 'feedback', content, files, entry);
          });
        }
        if (!reviewActions.childElementCount) reviewActions.remove();
      }
      timeline.append(item);
    });
    if (order.state === 'interrupted' && latestInterrupted) {
      var recovery = block('待接续执行', '');
      recovery.append(button('接续执行', 'btn primary', function () {
        simpleAction(order, 'recover', '接续执行', {node_id: latestInterrupted});
      }));
      body.append(recovery);
    }
    activity.append(timeline);
    if (delivery) body.prepend(delivery);
    body.append(nextTasks);
    body.append(activity);
    if (actions.childElementCount) head.insertBefore(actions, head.querySelector('.wb-reply'));
    detail.append(head, body, detailSticker());
    renderTicketNotices();
    detail.scrollTop = scroll;
  }

  function renderNotices() {
    noticeButton.textContent = pendingNoticeCount ? '通知（' + pendingNoticeCount + '）' : '通知';
    var drafts = new Map();
    noticePanel.querySelectorAll('form[data-notice-id]').forEach(function (form) {
      var input = form.querySelector('select, textarea');
      if (input) drafts.set(form.dataset.noticeId, input.value);
    });
    noticePanel.replaceChildren();
    var tabs = node('div', 'wb-actions');
    [['pending', '待处理'], ['handled', '已处理']].forEach(function (entry) {
      var control = button(entry[1], 'btn', function () {
        if (noticeState === entry[0]) return;
        noticeState = entry[0];
        notices = [];
        noticeError = '';
        renderNotices();
        noticePanel.querySelector('[aria-pressed=true]').focus();
        refreshNotices();
      });
      control.setAttribute('aria-pressed', String(noticeState === entry[0]));
      tabs.append(control);
    });
    noticePanel.append(tabs);
    if (noticeError) noticePanel.append(node('p', 'wb-status', noticeError));
    else if (!notices.length) noticePanel.append(node('p', 'wb-meta',
      noticeState === 'pending' ? '暂无待处理通知。' : '暂无已处理通知。'));
    notices.forEach(function (notice) { noticePanel.append(notificationCard(notice, false, drafts.get(notice.id))); });
  }

  function notificationText(content) {
    // 兼容旧通知里写在同一段的编号清单，保留原文和已有换行。
    return String(content || '').replace(/([：:；;。])[^\S\n]*(?=\d{1,2}[)）])/g, '$1\n')
      .replace(/([^\s])[^\S\n]*(?=[①②③④⑤⑥⑦⑧⑨⑩])/g, '$1\n');
  }

  function notificationCard(notice, inTicket, draft) {
    var view = node('section', 'wb-box');
    view.dataset.noticeId = notice.id;
    view.tabIndex = -1;
    var order = board && board.orders.find(function (row) { return row.id === notice.ticket_id; });
    var outcome = {confirm: '已确认', feedback: '已反馈', input: '已补充', result: '已有新版', unblocked: '已解除',
      merge_in: '已并入新内容', merge_out: '已并出', stop: '已终止'};
    var linkedResult = notice.code === 'RESULT_READY' && order && order.ticket;
    if (order && !inTicket) view.append(node('h3', '', order.summary));
    var message = notice.content;
    if (linkedResult) {
      var result = order.ticket.nodes.find(function (entry) { return entry.node_id === notice.node_id; });
      message = result && result.summary || '阶段成果已提交';
    }
    view.append(node('p', 'wb-copy', notificationText(message)), node('p', 'wb-meta',
      [outcome[notice.resolution], dateLabel(notice.occurred_at)].filter(Boolean).join(' · ')));
    if (!inTicket && notice.ticket_id) view.append(button(linkedResult && notice.state === 'pending' ? '审阅成果' : '查看工单', 'btn', function () {
      open(notice.ticket_id).then(function () {
        noticePanel.hidden = true;
        noticeButton.setAttribute('aria-expanded', 'false');
        var target = linkedResult && detail.querySelector('[data-result-node]') || detail;
        target.tabIndex = -1;
        target.focus();
        if (linkedResult && !notice.read && notice.state === 'pending') {
          return post('/api/notifications/' + encodeURIComponent(notice.id) + '/handle', {}).then(function (receipt) {
            requireCode(receipt, ['OK', 'REPLAYED']);
            return refreshNotices();
          });
        }
      }).catch(showExecutionError);
    }));
    if (notice.package_ref && (!order || !order.ticket || order.availablePackages.includes(notice.package_ref.id))) {
      view.append(packageEvidence(notice.package_ref.id));
    }
    if (notice.state === 'handled') {
      if (notice.answer) {
        var answerLabel = (notice.options || []).find(function (option) { return option.value === notice.answer; });
        view.append(node('p', 'wb-meta', '已答复 ' + (answerLabel ? answerLabel.label : notice.answer)));
      }
      return view;
    }
    if (linkedResult) return view;
    var reply = node('form', 'wb-approval');
    reply.dataset.noticeId = notice.id;
    var input = null;
    var options = notice.options || [];
    if (options.length || ['APPROVAL_REQUIRED', 'APPROVAL_NEEDED', 'INPUT_NEEDED', 'ROUTE_REVIEW'].includes(notice.code)) {
      if (options.length) {
        input = node('select', '');
        var prompt = node('option', '', '请选择答复');
        prompt.value = '';
        input.append(prompt);
        options.forEach(function (choice) {
          var option = node('option', '', choice.label || choice.value);
          option.value = choice.value;
          input.append(option);
        });
      } else {
        input = node('textarea', '');
        input.rows = 3;
      }
      input.setAttribute('aria-label', '答复');
      input.required = true;
      if (draft !== undefined) input.value = draft;
      reply.append(input);
    }
    var submit = node('button', 'btn primary', input ? '提交答复' : '标为已读');
    submit.type = 'submit';
    var errorLine = node('p', 'wb-status', '');
    errorLine.setAttribute('role', 'alert');
    reply.append(submit, errorLine);
    reply.addEventListener('submit', function (event) {
      event.preventDefault();
      if (input && !input.value.trim()) {
        errorLine.textContent = '请填写答复。';
        return;
      }
      var answer = input ? input.value : '';
      submit.disabled = true;
      var args = input ? {answer: answer} : {};
      post('/api/notifications/' + encodeURIComponent(notice.id) + '/handle', args).then(function (data) {
        requireCode(data, ['OK', 'REPLAYED']);
        if (data.id !== notice.id || data.state !== 'handled') throw new Error('通知回执无法核对，请重试。');
        noticeWrites++;
        notices = notices.filter(function (item) { return item.id !== notice.id; });
        pendingNotices = pendingNotices.filter(function (item) { return item.id !== notice.id; });
        pendingNoticeCount = pendingNotices.length;
        renderNotices();
        renderTicketNotices();
        refreshNotices();
        if (input) status.textContent = '答复已提交，等待助手继续。';
        if (notice.ticket_id) refreshTicket(notice.ticket_id).catch(showExecutionError);
      }).catch(function (error) { errorLine.textContent = error.message; }).finally(function () { submit.disabled = false; });
    });
    view.append(reply);
    return view;
  }

  function renderTicketNotices() {
    var host = detail.querySelector('[data-ticket-notices]');
    if (!host) return;
    var items = pendingNotices.filter(function (notice) {
      return notice.ticket_id === host.dataset.ticketNotices && notice.code !== 'RESULT_READY';
    });
    var snapshot = JSON.stringify(items);
    if (host.dataset.snapshot === snapshot) return;
    host.dataset.snapshot = snapshot;
    var drafts = new Map();
    host.querySelectorAll('[data-notice-id]').forEach(function (card) {
      var input = card.querySelector('select, textarea');
      if (input) drafts.set(card.dataset.noticeId, input.value);
    });
    host.replaceChildren();
    if (items.length) host.append(node('h3', '', '待处理事项'));
    items.forEach(function (notice) { host.append(notificationCard(notice, true, drafts.get(notice.id))); });
  }

  function openNotice(id) {
    document.getElementById('tab-tasks-button').click();
    var notice = pendingNotices.find(function (item) { return item.id === id; });
    if (notice && notice.ticket_id) {
      open(notice.ticket_id).then(function () {
        var target = Array.from(detail.querySelectorAll('[data-notice-id]')).find(function (card) {
          return card.dataset.noticeId === id;
        });
        if (!target && notice.code === 'RESULT_READY') target = detail.querySelector('[data-result-node]');
        if (target) { target.tabIndex = -1; target.focus(); }
        else showNoticePanel(id);
      }).catch(function () { showNoticePanel(id); });
      return;
    }
    showNoticePanel(id);
  }

  function showNoticePanel(id) {
    noticeState = 'pending';
    notices = pendingNotices;
    noticePanel.hidden = false;
    noticeButton.setAttribute('aria-expanded', 'true');
    renderNotices();
    var target = Array.from(noticePanel.querySelectorAll('section[data-notice-id]')).find(function (card) {
      return card.dataset.noticeId === id;
    });
    if (target) {
      target.scrollIntoView({block: 'nearest'});
      target.focus({preventScroll: true});
    }
    refreshNotices();
  }

  function fetchPendingNotices() {
    if (pendingRequest) return pendingRequest;
    var writes = noticeWrites;
    pendingRequest = api('/api/notifications?state=pending').then(function (data) {
      requireCode(data, ['OK']);
      if (writes !== noticeWrites) return pendingNotices;
      pendingNotices = data.items;
      pendingNoticeCount = pendingNotices.length;
      noticeButton.textContent = pendingNoticeCount ? '通知（' + pendingNoticeCount + '）' : '通知';
      renderTicketNotices();
      return pendingNotices;
    }).finally(function () { pendingRequest = null; });
    return pendingRequest;
  }

  var noticesVersion = 0;
  function refreshNotices() {
    var version = ++noticesVersion;
    var state = noticeState;
    var request = state === 'pending' ? fetchPendingNotices() :
      api('/api/notifications?state=handled').then(function (data) {
        requireCode(data, ['OK']);
        return data.items;
      });
    return request.then(function (items) {
      if (version !== noticesVersion || state !== noticeState) return;
      if (!noticeError && JSON.stringify(notices) === JSON.stringify(items) && noticePanel.childElementCount) return;
      notices = items;
      noticeError = '';
      renderNotices();
    }).catch(function (error) {
      if (version !== noticesVersion) return;
      noticeError = error.message;
      renderNotices();
    });
  }

  function showDialog(titleText, label, fields, submit) {
    dialog.querySelector('h2').textContent = titleText;
    var fieldset = form.querySelector('.wb-fields');
    fieldset.replaceChildren();
    var values = {};
    fields.forEach(function (field) {
      var fieldLabel = node('label', '', field.label);
      var tag = ['textarea', 'select'].includes(field.type) ? field.type : 'input';
      var input = node(tag, '');
      if (tag === 'textarea') input.rows = 4;
      if (tag === 'select') {
        input.add(new Option('请选择', ''));
        field.options.forEach(function (option) { input.add(new Option(option.label, option.value)); });
      }
      if (tag === 'input') input.type = field.type;
      if (field.type === 'file') input.multiple = true;
      input.value = field.value || '';
      input.required = !!field.required;
      if (field.type === 'text') input.maxLength = 200;
      fieldLabel.append(input);
      fieldset.append(fieldLabel);
      values[field.key] = input;
    });
    var submitButton = form.querySelector('[type="submit"]');
    var cancelButton = form.querySelector('[data-close]');
    var errorLine = form.querySelector('[role="alert"]');
    errorLine.textContent = '';
    submitButton.textContent = label;
    form.onsubmit = function (event) {
      event.preventDefault();
      submitButton.disabled = true;
      cancelButton.disabled = true;
      var payload = {};
      Object.keys(values).forEach(function (key) {
        var input = values[key];
        payload[key] = input.type === 'file' ? Array.from(input.files) : input.value;
      });
      Promise.resolve().then(function () { return submit(payload); }).then(function () {
        dialog.close();
      }).catch(function (error) {
        errorLine.textContent = error.message;
      }).finally(function () { submitButton.disabled = false; cancelButton.disabled = false; });
    };
    dialog.showModal();
    (fieldset.querySelector('input, textarea, select') || submitButton).focus();
  }

  function confirmClose(order, action, label) {
    showDialog(label, label, [{key: 'note', label: '原因（选填）', type: 'text'}], function (values) {
      return perform(order, action, eventNames['work_order_' + action], values);
    });
  }

  function editDeadline(order) {
    showDialog('修改截止时间', '保存', [
      {key: 'deadline', label: '截止时间（留空清除）', type: 'datetime-local', value: order.deadline.slice(0, 16)}
    ], function (values) { return perform(order, 'set_deadline', '截止时间已保存', values); });
  }

  function open(id) {
    return refresh(false).then(function () {
      return execution ? refreshTicket(String(id)) : board.orders.find(function (item) { return item.id === Number(id); });
    }).then(function (order) {
      if (!order) throw new Error('没有找到工单');
      archive = closed(order) || isHidden(order);
      filter = archive ? 'archive' : 'all';
      selection = order.id;
      render();
      if (window.matchMedia('(max-width: 800px)').matches) detail.scrollIntoView({block: 'start'});
    });
  }

  function refresh(paint) {
    var version = ++loadVersion;
    return api('/api/execution/status').then(function (configuration) {
      if (!configuration.configured) return api('/api/work-orders').then(function (data) {
        return {execution: false, data: data};
      });
      if (version === loadVersion && !execution) {
        execution = true;
        artifactsAvailable = configuration.artifacts_available === true;
        board = {today: todayLabel(), orders: []};
        archive = false;
        filter = 'all';
        selection = null;
        render();
        window.dispatchEvent(new Event('superdot-ticket-index'));
      }
      if (noticeState === 'handled') fetchPendingNotices().catch(function () {});
      refreshNotices();
      return api('/api/tickets').then(function (data) {
        requireCode(data, ['OK']);
        return {execution: true, artifactsAvailable: configuration.artifacts_available === true, data: {
          today: todayLabel(),
          orders: data.items.map(function (entry) { return executionOrder(entry.ticket, entry.source_conversation, entry.available_package_ids); }).sort(function (left, right) {
            return Date.parse(right.updated_at) - Date.parse(left.updated_at);
          })
        }};
      });
    }).then(function (response) {
      var data = response.data;
      if (version !== loadVersion && board) return board;
      var downloadChanged = artifactsAvailable !== Boolean(response.artifactsAvailable);
      var changed = execution !== response.execution || downloadChanged || !board || board.today !== data.today || board.orders.length !== data.orders.length ||
        data.orders.some(function (order, index) {
          var old = board.orders[index];
          return old.id !== order.id || old.revision !== order.revision || old.updated_at !== order.updated_at || source(old) !== source(order);
        });
      execution = response.execution;
      artifactsAvailable = Boolean(response.artifactsAvailable);
      board = data;
      if (changed && paint !== false) render();
      if (changed && execution) renderNotices();
      if (changed) window.dispatchEvent(new Event('superdot-ticket-index'));
      if (latestError && status.textContent === latestError.message) status.textContent = '';
      latestError = null;
      return data;
    }).catch(function (error) {
      if (version === loadVersion) showExecutionError(error);
      throw error;
    });
  }

  archiveButton.onclick = function () {
    if (!board) return;
    archive = !archive;
    filter = archive ? 'archive' : 'all';
    selection = null;
    render();
  };
  addMessageButton.onclick = function () {
    if (execution) {
      showDialog('新任务', '提交任务', [{key: 'text', label: '任务内容', type: 'textarea'},
        {key: 'files', label: attachmentLabel, type: 'file'}], function (values) {
        return submitNewTask(values.text, values.files);
      });
      return;
    }
    document.getElementById('tab-inbox-button').click();
    if (document.getElementById('inbox-add-form').hidden) document.getElementById('inbox-add').click();
  };
  dialog.addEventListener('cancel', function (event) {
    if (form.querySelector('[type="submit"]').disabled) event.preventDefault();
  });
  form.querySelector('[data-close]').onclick = function () { dialog.close(); };
  noticeButton.onclick = function () {
    noticePanel.hidden = !noticePanel.hidden;
    noticeButton.setAttribute('aria-expanded', String(!noticePanel.hidden));
    if (!noticePanel.hidden) refreshNotices();
  };
  function openDesktopNotice(id) {
    return fetchPendingNotices().then(function (items) {
      if (!items.some(function (notice) { return notice.id === id; })) return false;
      openNotice(id);
      return true;
    });
  }
  function showPending() {
    return refresh(false).then(function () {
      if (execution) showNoticePanel();
      else {
        archive = false;
        filter = 'blocked';
        selection = null;
        render();
      }
    });
  }
  function pollNotifications() { if (!document.hidden) refresh().catch(function () {}); }
  window.setInterval(pollNotifications, 10000);
  document.addEventListener("visibilitychange", pollNotifications);
  return {refresh: refresh, open: open, openDesktopNotice: openDesktopNotice, showPending: showPending, ticketIdsForPackage: ticketIdsForPackage,
    conversationLabel: conversationLabel, isExecutionConfigured: function () { return execution; }};
})();

function initOnboarding() {
  const modal = document.getElementById('onboarding');
  const node = (id) => document.getElementById(id);
  const accept = node('onboarding-accept');
  const close = node('onboarding-close');
  const framework = document.body.dataset.qqMode === 'framework';
  const guideKey = 'superdot:start-guide-dismissed';
  const channels = ['wechat', 'dingtalk', 'chaoxing'];
  const changes = Object.fromEntries(channels.map((key) => [key, {}]));
  const settingsFields = [...modal.querySelectorAll('[data-guide-setting]')];
  const toggles = [...modal.querySelectorAll('[data-guide-panel]')];
  const ruleFields = node('guide-rule-fields');
  const ruleNumbers = [...ruleFields.querySelectorAll('input[type=number]')];
  const qqGroups = node('guide-qq-list');
  let settings;
  let qqDraft;
  let ruleDraft;
  let qqDirty = false;
  let ruleDirty = false;
  let saved = false;
  let dismissed = false;
  let saving = false;
  let running = 0;
  let panelGeneration = 0;
  try { dismissed = sessionStorage.getItem(guideKey) === '1'; } catch (error) {}

  async function request(path, body, timeoutMs) {
    const options = body === undefined ? {cache: 'no-store'} : {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    };
    const result = await setupApi(path, {...options, timeoutMs});
    if (result.ok === false) {
      const error = Error(result.error || result.next_step || '请求未完成，请重试。');
      error.category = result.category;
      throw error;
    }
    return result;
  }

  function note(id, message) {
    const element = node(id);
    element.textContent = message;
    element.hidden = !message;
  }

  function updateActions() {
    accept.disabled = saving || running > 0;
    close.disabled = saving || running > 0;
    accept.firstElementChild.textContent = saving ? '正在保存…' : '保存并继续';
  }

  async function runAction(button, noteId, busyText, action) {
    if (saving || button.disabled) return;
    button.disabled = true;
    running++;
    updateActions();
    note(noteId, busyText);
    try {
      await action();
    } catch (error) {
      note(noteId, error.message);
    } finally {
      button.disabled = false;
      running--;
      updateActions();
    }
  }

  function currentValue(input) {
    return input.type === 'checkbox' ? input.checked : input.value.trim();
  }

  function settingsKey(input) {
    return input.dataset.guideSetting;
  }

  function loadSettings() {
    if (!settings) settings = request('/api/settings').then((data) => {
      settingsFields.forEach((input) => {
        const key = settingsKey(input);
        if (input.type === 'checkbox') input.checked = !!data[key];
        if (key === 'wechat_dir') input.value = data[key] || '';
        input.disabled = false;
      });
      return data;
    }).catch((error) => {
      settings = null;
      throw error;
    });
    return settings;
  }

  settingsFields.forEach((input) => input.addEventListener('input', () => {
    const key = settingsKey(input);
    const draft = changes[key.split('_')[0]];
    const value = currentValue(input);
    if (typeof value === 'string' && !value && key !== 'wechat_dir') delete draft[key];
    else draft[key] = value;
  }));

  function selected(list) {
    return [...list.querySelectorAll('input:checked')].map((input) => input.value);
  }

  function choices(list, rows, ids, emptyText) {
    list.replaceChildren();
    if (!rows.length) {
      const message = document.createElement('p');
      message.textContent = emptyText;
      list.append(message);
      return;
    }
    const checked = new Set(ids);
    rows.forEach(({id, name, private: direct}) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = id;
      input.dataset.direct = String(!!direct);
      input.checked = checked.has(id);
      label.append(input, document.createTextNode(name));
      list.append(label);
    });
  }

  function withSavedChoices(rows, ids) {
    const byId = new Map(rows.map((row) => [row.id, row]));
    ids.forEach((id) => {
      if (!byId.has(id)) byId.set(id, {id, name: id});
    });
    return [...byId.values()];
  }

  async function saveChannel(channel, keys) {
    const draft = changes[channel];
    const payload = Object.fromEntries(Object.entries(draft).filter(([key]) => !keys || keys.includes(key)));
    if (!Object.keys(payload).length) return;
    const verifyChaoxing = 'chaoxing_cookie' in payload;
    const data = await request('/api/settings', verifyChaoxing
      ? {...payload, chaoxing_verify_cookie: true} : payload, verifyChaoxing ? 120000 : undefined);
    Object.keys(payload).forEach((key) => {
      if (draft[key] !== payload[key]) return;
      delete draft[key];
      if (key.endsWith('_key') || key.endsWith('_cookie')) {
        modal.querySelector('[data-guide-setting="' + key + '"]').value = '';
      }
    });
    Object.assign(await loadSettings(), data);
    return data;
  }

  const pickers = {
    wechat: {path: '/api/wechat/groups?setup=1', items: 'groups', prepare: ['wechat_dir', 'wechat_key'], empty: '未读取到会话。'},
    dingtalk: {path: '/api/dingtalk/groups', items: 'groups', empty: '未读取到群聊。'},
    chaoxing: {path: '/api/chaoxing/courses', items: 'courses', empty: '当前账号没有可订阅的课程。'},
  };

  async function loadPicker(channel, supplied) {
    const picker = pickers[channel];
    const data = await loadSettings();
    if (picker.prepare) await saveChannel(channel, picker.prepare);
    const result = supplied || await request(picker.path, undefined, channel === 'wechat' ? 600000 : 120000);
    const isWechat = channel === 'wechat';
    if (isWechat && !result.groups.length && result.error) {
      const error = Error(result.error);
      error.category = result.error_category;
      throw error;
    }
    const whitelist = channel + '_group_whitelist';
    const ids = (changes[channel][whitelist] || data[whitelist] || []).map(String);
    const rows = (result[picker.items] || []).map((row) => {
      const id = String(row.id ?? row.group_id ?? row.course_id ?? '');
      return {id, name: row.alias || row.name || row.group_name || row.course_name || id};
    }).filter((row) => row.id);
    choices(node('guide-' + channel + '-list'), withSavedChoices(rows, ids), ids, picker.empty);
    if (isWechat) {
      node('guide-wechat-switch').hidden = !rows.length;
      note('guide-wechat-status', rows.length ? '已检测' : '暂无会话');
      note('guide-wechat-note', rows.length ? '勾选要接入的会话。' : picker.empty);
    } else if (channel === 'chaoxing') {
      node('guide-chaoxing-switch').hidden = !rows.length && !data.chaoxing_enabled;
      node('guide-chaoxing-load').textContent = '刷新课程';
      node('guide-chaoxing-load').hidden = false;
      note('guide-chaoxing-status', '已连接');
      note('guide-chaoxing-note', rows.length ? '勾选要接收通知的课程。' : '');
    } else {
      note('guide-' + channel + '-status', rows.length ? '勾选要接入的项目' : (result.error || picker.empty));
    }
  }

  channels.forEach((channel) => {
    const list = node('guide-' + channel + '-list');
    const button = node('guide-' + channel + '-load');
    const noteId = 'guide-' + channel + '-status';
    if (channel === 'dingtalk') button.onclick = () => runAction(button, noteId, '正在读取…', () => loadPicker(channel));
    list.addEventListener('change', () => {
      const ids = selected(list);
      const draft = changes[channel];
      draft[channel + '_group_whitelist'] = ids;
      if (channel === 'wechat' && !wechatEnableEdited && ids.length) {
        node('guide-wechat-enabled').checked = true;
        draft.wechat_enabled = true;
      }
    });
  });

  let wechatEnableEdited = false;
  let wechatChecked = false;
  const wechatButton = node('guide-wechat-load');
  const wechatConnection = node('guide-wechat-connection');
  node('guide-wechat-enabled').addEventListener('change', () => { wechatEnableEdited = true; });
  wechatButton.onclick = () => runAction(wechatButton, 'guide-wechat-note', '正在检测：弹授权框就输密码，等它扫完…', async () => {
    wechatChecked = true;
    try {
      await loadPicker('wechat');
      wechatButton.textContent = '重新检测';
    } catch (error) {
      const unsupported = error.category === 'unsupported_platform';
      const needsAdmin = error.category === 'needs_admin';
      const needsKey = ['missing_key', 'bad_manual_key'].includes(error.category);
      note('guide-wechat-status', unsupported ? '暂不支持' : (needsAdmin ? '待授权' : (needsKey ? '待填密钥' : '待接入')));
      wechatConnection.hidden = unsupported;
      if (needsKey || needsAdmin) {
        wechatConnection.open = true;
        requestAnimationFrame(() => {
          if (node('guide-wechat-panel').hidden) return;
          const scroller = modal.querySelector('.start-guide-scroll');
          const input = wechatConnection.querySelector('[data-guide-setting="wechat_key"]');
          const overflow = input.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom;
          if (overflow > 0) scroller.scrollTop += Math.ceil(overflow) + 8;
        });
      }
      wechatButton.hidden = unsupported;
      wechatButton.textContent = '重新检测';
      throw error;
    }
  });

  const cookieButton = node('guide-chaoxing-auto');
  const chaoxingLoad = node('guide-chaoxing-load');
  const chaoxingImport = node('guide-chaoxing-import');
  const chaoxingApply = node('guide-chaoxing-import-apply');

  function showChaoxingConnection(data) {
    const status = data.chaoxing_status || {};
    const hasCookie = !!(status.has_cookie || data.chaoxing_cookie?.has_cookie);
    cookieButton.hidden = status.auto_cookie_supported !== true;
    chaoxingLoad.hidden = !hasCookie;
    if (node('guide-chaoxing-status').textContent === '已连接') return;
    note('guide-chaoxing-note', status.expired ? '登录已过期：在浏览器重新登录学习通后点「自动连接」。'
      : hasCookie ? '' : chaoxingDetectionHint(status));
  }

  cookieButton.onclick = () => runAction(cookieButton, 'guide-chaoxing-note', '正在读取浏览器登录态…', async () => {
    const settingsData = await loadSettings();
    let result;
    try {
      result = await request('/api/chaoxing/auto_cookie', {}, 120000);
    } catch (error) {
      throw Error(chaoxingConnectError({category: error.category, error: error.message}));
    }
    settingsData.chaoxing_cookie = {has_cookie: true};
    settingsData.chaoxing_enabled = true;
    if (!Object.hasOwn(changes.chaoxing, 'chaoxing_enabled')) node('guide-chaoxing-enabled').checked = true;
    await loadPicker('chaoxing', {courses: result.course_items || []});
    const from = chaoxingBrowserLabel(result.source);
    if (from) {
      const hasRows = (result.course_items || []).length > 0;
      note('guide-chaoxing-note', '已从本机 ' + from + ' 读取登录状态。' + (hasRows ? '勾选课程后保存。' : ''));
    }
    chaoxingImport.open = false;
  });
  chaoxingLoad.onclick = () => runAction(chaoxingLoad, 'guide-chaoxing-note', '正在读取课程…', () => loadPicker('chaoxing'));
  chaoxingApply.onclick = () => runAction(chaoxingApply, 'guide-chaoxing-note', '正在验证…', async () => {
    if (!changes.chaoxing.chaoxing_cookie) throw Error('请填入已有的学习通登录凭证。');
    const existing = await loadSettings();
    const hadCookie = !!existing.chaoxing_cookie?.has_cookie;
    const input = chaoxingImport.querySelector('textarea');
    input.disabled = true;
    const result = await saveChannel('chaoxing', ['chaoxing_cookie']).finally(() => { input.disabled = false; });
    if (!hadCookie && result.course_items?.length && !Object.hasOwn(changes.chaoxing, 'chaoxing_enabled')) {
      node('guide-chaoxing-enabled').checked = true;
      changes.chaoxing.chaoxing_enabled = true;
    }
    await loadPicker('chaoxing', {courses: result.course_items || []});
    chaoxingImport.open = false;
  });

  async function readRule() {
    const data = await request('/api/settings/package-rule');
    ruleDraft = data;
    const rule = data.rule;
    ruleFields.querySelectorAll('[name=roles]').forEach((input) => {
      input.checked = rule.roles.includes(input.value);
    });
    ruleFields.querySelector('[name=include_self]').checked = rule.include_self;
    ['keywords', 'sender_ids'].forEach((key) => {
      ruleFields.querySelector('[name="' + key + '"]').value = rule[key].join('，');
    });
    ruleNumbers.forEach((input) => { input.value = rule[input.name]; });
    ruleFields.disabled = false;
  }

  ruleFields.addEventListener('input', () => { ruleDirty = true; });
  qqGroups.addEventListener('change', () => {
    qqDirty = true;
  });

  async function readQQ() {
    const [persisted, subscription, data] = await Promise.all([
      request('/api/napcat/groups'),
      request('/api/settings/package-rule'),
      framework ? request('/api/qq/conversations') : {},
    ]);
    const groups = persisted.groups.map((row) => ({
      id: String(row.group_id), name: row.name || row.group_name || String(row.group_id),
      selected: !!row.selected,
    }));
    const byId = new Map((data.conversations || []).map((row) => [String(row.id), row]));
    groups.forEach((row) => byId.set(row.id, {...byId.get(row.id), ...row}));
    subscription.groups.forEach((row) => {
      if (!byId.has(row.id)) byId.set(row.id, {...row, selected: true});
    });
    const retained = qqDirty ? new Map([...qqGroups.querySelectorAll('input')].map((input) => [input.value, input.checked])) : new Map();
    qqDraft = [...byId.values()];
    const ids = qqDraft.filter((row) => retained.has(row.id) ? retained.get(row.id) : row.selected).map((row) => row.id);
    choices(qqGroups, qqDraft, ids, '未读取到 QQ 会话。');
  }

  const qq = node('guide-qq');
  const qqConnect = node('guide-qq-connect');
  const qqLaunch = node('guide-qq-launch');
  const qrImage = node('guide-qq-qr');
  const accounts = node('guide-qq-accounts');
  node('guide-qq-manual').hidden = !framework;
  node('guide-qq-shell').hidden = framework;

  function showQQCode(status) {
    qrImage.hidden = !status.qr_stamp;
    if (status.qr_stamp) {
      const query = new URLSearchParams({token: setupToken, t: status.qr_stamp});
      qrImage.src = '/api/napcat/qrcode?' + query;
    }
  }

  function detectQQ(selection, button = qq) {
    return runAction(button, 'guide-qq-note', '正在检测本机 QQ…', async () => {
      try {
        const result = framework
          ? await request('/api/napcat/connect', selection || {}, 60000)
          : await request('/api/napcat/status');
        accounts.replaceChildren();
        if (result.accounts?.length) {
          note('guide-qq-note', '选择要连接的 QQ 账号。');
          result.accounts.forEach((account) => {
            const choice = document.createElement('button');
            choice.type = 'button';
            choice.className = 'btn';
            choice.textContent = account.nickname || account.user_id;
            choice.onclick = () => detectQQ({user_id: account.user_id}, choice);
            accounts.append(choice);
          });
          return;
        }
        if (!framework && !result.online) {
          showQQCode(result);
          throw Error('请登录桌面 QQ，或扫描二维码后重新检测。');
        }
        qrImage.hidden = true;
      } catch (error) {
        note('guide-qq-status', '尚未连接');
        throw error;
      }
      node('guide-qq-token').value = '';
      note('guide-qq-status', 'QQ 已连接');
      note('guide-qq-note', '正在读取 QQ 会话…');
      await readQQ();
      note('guide-qq-note', '勾选要接入的群聊或私聊。');
    });
  }

  qq.onclick = () => detectQQ();
  qqConnect.onclick = () => {
    const input = node('guide-qq-port');
    if (!input.value || !input.reportValidity()) {
      note('guide-qq-note', '请输入 1 到 65535 之间的本机端口。');
      return;
    }
    detectQQ({port: Number(input.value), token: node('guide-qq-token').value}, qqConnect);
  };
  qqLaunch.onclick = () => runAction(qqLaunch, 'guide-qq-note', '正在启动 QQ 接入…', async () => {
    await request('/api/napcat/launch', {}, 120000);
    const status = await request('/api/napcat/status');
    showQQCode(status);
    note('guide-qq-note', '请在桌面 QQ 登录或扫码，然后重新检测。');
  });

  modal.addEventListener('click', (event) => {
    const button = event.target.closest('[data-guide-panel]');
    if (!button || saving) return;
    const section = button.dataset.guidePanel;
    const expands = button.getAttribute('aria-expanded') === 'false';
    const generation = ++panelGeneration;
    toggles.forEach((toggle) => {
      const open = toggle === button ? expands : section === 'rule' || toggle.dataset.guidePanel === 'rule'
        ? toggle.getAttribute('aria-expanded') === 'true' : false;
      toggle.setAttribute('aria-expanded', String(open));
      node(toggle.getAttribute('aria-controls')).hidden = !open;
    });
    if (!expands) return;
    if (section === 'qq' && !qqDraft && !qq.disabled) detectQQ();
    if (section === 'wechat' && !wechatChecked) wechatButton.click();
    if (section !== 'wechat' && channels.includes(section)) {
      loadSettings().then((data) => {
        if (section === 'chaoxing') showChaoxingConnection(data);
      }).catch((error) => note('guide-' + section + '-status', error.message));
    }
    if (section === 'rule' && !ruleDraft) {
      runAction(button, 'guide-rule-status', '正在读取规则…', async () => {
        await readRule();
        note('guide-rule-status', '');
      });
    }
    requestAnimationFrame(() => {
      if (generation === panelGeneration) node(button.getAttribute('aria-controls')).scrollIntoView({block: 'nearest'});
    });
  });

  async function persistDismissal() {
    if (saved) return;
    await request('/api/onboarding/accept', {});
    saved = true;
  }

  function closeGuide() {
    dismissed = true;
    try { sessionStorage.setItem(guideKey, '1'); } catch (error) {}
    modal.close();
  }

  function dismissGuide() {
    if (saving || running) return;
    [node('guide-api-key'), node('guide-qq-token'), ...settingsFields].forEach((input) => {
      if (input.type !== 'password' && input.tagName !== 'TEXTAREA') return;
      input.value = '';
      if (input.dataset.guideSetting) delete changes[input.dataset.guideSetting.split('_')[0]][input.dataset.guideSetting];
    });
    closeGuide();
    persistDismissal().catch(() => {
      if (typeof showFeedback === 'function') showFeedback('新手指南已收起，关闭状态暂未同步。', 'error');
    });
  }

  async function saveQQ() {
    const ids = selected(qqGroups);
    const groups = qqDraft.filter((row) => !row.private && ids.includes(row.id));
    const payload = {groups: groups.map((row) => row.id)};
    if (framework) payload.private_ids = ids.filter((id) => id.startsWith('private:')).map((id) => id.slice(8));
    await request('/api/subscriptions', payload);
    qqDirty = false;
  }

  async function saveRule() {
    const split = (value) => value.split(/[,，\n]+/).map((item) => item.trim()).filter(Boolean);
    const rule = {
      roles: [...ruleFields.querySelectorAll('[name=roles]:checked')].map((input) => input.value),
      include_self: ruleFields.querySelector('[name=include_self]').checked,
    };
    ['keywords', 'sender_ids'].forEach((key) => {
      rule[key] = split(ruleFields.querySelector('[name="' + key + '"]').value);
    });
    ruleNumbers.forEach((input) => { rule[input.name] = Number(input.value); });
    const result = await request('/api/settings/package-rule', rule);
    ruleDraft.rule = result.rule;
    ruleDirty = false;
  }

  accept.onclick = async () => {
    if (saving || running) return;
    const keyInput = node('guide-api-key');
    saving = true;
    updateActions();
    note('guide-save-status', '');
    const content = modal.querySelector('.start-guide-scroll');
    content.inert = true;
    let step = 'API Key';
    try {
      if (keyInput.value.trim()) {
        await request('/api/settings', {llm_provider: 'deepseek', llm_api_key: keyInput.value.trim(), llm_model: 'deepseek-flash'});
        keyInput.value = '';
        node('guide-model-status').hidden = false;
      }
      step = 'QQ 订阅';
      if (qqDirty) await saveQQ();
      for (const [channel, name] of [['wechat', '微信'], ['dingtalk', '钉钉'], ['chaoxing', '学习通']]) {
        step = name;
        await saveChannel(channel);
      }
      step = '粗筛规则';
      if (ruleDirty) {
        const invalid = ruleNumbers.find((input) => !input.validity.valid);
        if (invalid) throw Error(invalid.parentElement.textContent.trim() + '需要填写 ' + invalid.min + '–' + invalid.max + ' 之间的整数。');
        await saveRule();
      }
      step = '指南完成状态';
      await persistDismissal();
      closeGuide();
      if (typeof checkSetup === 'function') checkSetup();
    } catch (error) {
      note('guide-save-status', step + '保存失败。' + error.message);
    } finally {
      content.inert = false;
      saving = false;
      updateActions();
    }
  };

  function openGuide() {
    if (modal.open) return;
    modal.showModal();
    request('/api/setup/status').then(({platforms = {}}) => {
      node('guide-model-status').hidden = !platforms.llm?.configured;
      channels.forEach((channel) => {
        const status = node('guide-' + channel + '-status');
        if (status.textContent === '待配置' && platforms[channel]?.configured) status.textContent = '已配置';
      });
      const status = node('guide-qq-status');
      if (status.textContent === '待检测' && platforms.qq?.configured) status.textContent = 'QQ 已连接';
    }).catch(() => {});
  }

  node('onboarding-open').onclick = openGuide;
  window.openSuperDotStartGuide = openGuide;
  close.onclick = dismissGuide;
  modal.addEventListener('cancel', (event) => {
    event.preventDefault();
    dismissGuide();
  });
  const query = new URLSearchParams(location.search);
  if (query.get('guide') === '1') openGuide();
  if (query.get('nowiz') !== '1') {
    request('/api/onboarding').then((state) => {
      saved ||= !state.required;
      if (state.required && !dismissed) openGuide();
      if (state.required && dismissed) return persistDismissal();
    }).catch(() => {});
  }
}

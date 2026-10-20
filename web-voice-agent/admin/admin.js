(function () {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const text = (selector, value) => { $(selector).textContent = value ?? '—'; };
  let snapshot = null;
  let selected = 'overview';
  let selectionRevision = 0;

  async function request(route, options = {}) {
    const reply = await fetch(route, { ...options, credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
    if (!reply.ok) throw new Error(reply.status === 401 ? '管理访问已过期，请刷新页面。' : '读取管理信息失败，请检查管理服务窗口。');
    return reply.json();
  }
  function error(message) {
    text('#errorBanner', message);
    $('#errorBanner').hidden = !message;
  }
  function badge(selector, value, state) {
    text(selector, value);
    $(selector).className = 'badge' + (state ? ' ' + state : '');
  }
  function safeLink(value) {
    try { const url = new URL(value); return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? url.href : null; }
    catch { return null; }
  }
  function renderOverview(data) {
    snapshot = data;
    const runtime = data.runtime;
    const readable = runtime.reachable && runtime.authorized;
    text('#runtimeLabel', readable ? 'Agent服务可达' : runtime.reachable ? 'Agent服务待授权' : 'Agent服务未连接');
    $('#runtimeDot').className = 'status-dot ' + (readable ? '' : 'offline');
    text('#runtimeVersion', runtime.version ? '运行版本 ' + runtime.version : '请先启动语音服务');
    text('#checkedAt', '检查于 ' + new Date(data.inspected_at).toLocaleTimeString('zh-CN', { hour12: false }));
    text('#questionCount', data.knowledge.available ? data.knowledge.question_count : '不可用');
    text('#sourceCount', data.knowledge.available ? data.knowledge.public_source_count : '—');
    text('#experimentCount', data.experiments.count);
    text('#procedureCount', data.experiments.demo_count + ' 套项目演示流程');
    text('#moduleCount', data.modules.length);
    text('#dialogueMode', readable ? '知识检索与流程规则' : '本机已登记检索与规则');
    text('#modelStatus', readable ? runtime.general_llm_connected ? '已接入' : '未接入' : '运行状态未读取');
    badge('#modelBadge', readable ? '状态已读取' : '待检查', readable ? 'subtle' : 'waiting');
    text('#storageStatus', runtime.storage === 'SQLITE' ? '本机 SQLite' : runtime.storage === 'BOUNDED_PROCESS_MEMORY' ? '临时内存' : '运行状态未读取');
    text('#approvedStatus', data.experiments.demo_count + ' 套演示 · ' + data.experiments.approved_count + ' 套已审核');
    text('#asrProvider', runtime.asr?.provider || '未读取');
    text('#ttsProvider', runtime.tts?.provider || '未读取');
    text('#asrState', readable ? runtime.asr?.configured ? '已配置 · 待录音验证' : '尚未配置' : '服务未读取');
    text('#ttsState', readable ? runtime.tts?.configured ? '已配置 · 待播报验证' : '尚未配置' : '服务未读取');
    const voiceReady = readable && runtime.asr?.configured && runtime.tts?.configured;
    badge('#speechBadge', voiceReady ? '配置齐全' : readable ? '配置待补齐' : '待检查', voiceReady ? '' : 'waiting');
    text('#voiceName', runtime.tts?.voice_name || '运行配置未读取');
    text('#agentName', data.persona.name);
    text('#agentRole', data.persona.role);
    $('#toneTags').replaceChildren(...data.persona.tones.map(tone => {
      const span = document.createElement('span'); span.textContent = tone; return span;
    }));
    text('#promptRevision', data.policy.prompt_revision);
    text('#workspaceVersion', '本机工作目录 ' + data.workspace_version);
    text('#demoAddress', data.demo_url);
    text('#backendAddress', data.backend_url);
    text('#adminAddress', location.origin + '/');
    const demoHref = safeLink(data.demo_url);
    $('#openDemo').hidden = !demoHref;
    if (demoHref) $('#openDemo').href = demoHref;
    $('#moduleCards').replaceChildren(...data.modules.map(module => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'module-card';
      const title = document.createElement('strong'); title.textContent = module.name;
      const caption = document.createElement('small'); caption.textContent = module.subtitle;
      const link = document.createElement('span'); link.textContent = '查看 ' + module.files.length + ' 个文件 →';
      button.append(title, caption, link); button.addEventListener('click', () => selectModule(module.id));
      return button;
    }));
  }

  function renderDetail(data) {
    text('#moduleDescription', data.description);
    $('#fileRows').replaceChildren(...data.files.map(file => {
      const row = document.createElement('tr');
      for (const value of [file.path, file.available ? '已找到' : '缺失', file.available ? (file.bytes / 1024).toFixed(1) + ' KB' : '—']) {
        const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
      }
      return row;
    }));
    $('#moduleDocuments').replaceChildren(...data.documents.map(doc => {
      const panel = document.createElement('section'); panel.className = 'panel document-panel';
      const title = document.createElement('h2'); title.textContent = doc.path;
      const pre = document.createElement('pre'); pre.textContent = doc.content;
      panel.append(title, pre); return panel;
    }));
  }

  async function selectModule(id) {
    if (!snapshot || (id !== 'overview' && !snapshot.modules.some(module => module.id === id))) return;
    selected = id;
    const revision = ++selectionRevision;
    document.querySelectorAll('[data-module]').forEach(button => {
      const current = button.dataset.module === id;
      button.classList.toggle('selected', current);
      if (current) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    const module = snapshot.modules.find(item => item.id === id);
    text('#breadcrumb', module?.name || '运行总览');
    text('#pageTitle', module?.name || 'Agent 管理控制台');
    text('#pageDescription', module?.subtitle || '查看演示服务与五个模块的当前状态。');
    $('#overview').hidden = id !== 'overview';
    $('#moduleDetail').hidden = id === 'overview';
    error('');
    if (id === 'overview') return;
    text('#moduleDescription', '正在读取模块文件…');
    $('#fileRows').replaceChildren(); $('#moduleDocuments').replaceChildren();
    try {
      const detail = await request('/api/admin/modules/' + id);
      if (revision === selectionRevision) renderDetail(detail);
    } catch (cause) { if (revision === selectionRevision) error(cause.message); }
  }

  async function refresh() {
    const button = $('#refresh'); button.disabled = true;
    try {
      error('');
      const data = await request('/api/admin/overview');
      renderOverview(data);
      if (selected !== 'overview') await selectModule(selected);
    } catch (cause) { error(cause.message); }
    finally { button.disabled = false; }
  }
  document.querySelectorAll('[data-module]').forEach(button => button.addEventListener('click', () => selectModule(button.dataset.module)));
  document.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => selectModule(button.dataset.open)));
  $('.brand').addEventListener('click', event => { event.preventDefault(); selectModule('overview'); });
  $('#refresh').addEventListener('click', refresh);
  request('/api/admin/access', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Voice-Agent-Request': '1' }, body: '{}' })
    .then(refresh).catch(cause => error(cause.message));
})();

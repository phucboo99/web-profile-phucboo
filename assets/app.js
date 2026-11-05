(() => {
  'use strict';

  /* ================= Cấu hình ================= */
  const API_URL = 'https://api.anthropic.com/v1/messages';
  const MODEL_IDS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'];
  const DEFAULT_SETTINGS = { apiKey: '', model: MODEL_IDS[0], maxTokens: 4096, lang: '', dlApi: '' };
  const MAX_IMG_BYTES = 5 * 1024 * 1024;
  const APP_CONFIG = window.APP_CONFIG || {};

  /* ================= Lưu trữ ================= */
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { console.warn(e); return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* bỏ qua */ } }
  };
  const K = { settings: 'pb.settings', store: 'pb.agents', last: 'pb.last', chat: id => 'pb.chat.' + id };

  let settings = { ...DEFAULT_SETTINGS, ...LS.get(K.settings, {}) };
  if (!settings.lang) settings.lang = /^vi\b/i.test(navigator.language || 'vi') ? 'vi' : 'en';

  let store = { overrides: {}, custom: [], removed: [], pinned: null, ...LS.get(K.store, {}) };
  if (!Array.isArray(store.pinned)) store.pinned = [...(window.DEFAULT_PINNED || [])];
  const saveStore = () => LS.set(K.store, store);

  const DEFAULTS = window.DEFAULT_AGENTS || [];
  const defaultIds = new Set(DEFAULTS.map(a => a.id));

  /* ================= Ngôn ngữ ================= */
  const I18N = window.I18N || { vi: {}, en: {} };
  function t(key, vars) {
    const dict = I18N[settings.lang] || I18N.vi;
    let s = dict[key] != null ? dict[key] : (I18N.vi[key] != null ? I18N.vi[key] : key);
    if (vars && typeof s === 'string') s = s.replace(/\{(\w+)\}/g, (_, k) => vars[k] != null ? vars[k] : '');
    return s;
  }
  // Lấy trường theo ngôn ngữ: name_en khi đang ở EN, thiếu thì dùng bản gốc
  function loc(a, field) {
    if (settings.lang === 'en' && a[field + '_en'] != null && a[field + '_en'] !== '') return a[field + '_en'];
    return a[field];
  }
  function applyStaticText() {
    document.documentElement.lang = settings.lang;
    document.querySelectorAll('[data-i18n]').forEach(n => { n.textContent = t(n.dataset.i18n); });
    document.querySelectorAll('[data-i18n-html]').forEach(n => { n.innerHTML = t(n.dataset.i18nHtml); });
    document.querySelectorAll('[data-i18n-ph]').forEach(n => { n.placeholder = t(n.dataset.i18nPh); });
    document.querySelectorAll('[data-i18n-title]').forEach(n => { n.title = t(n.dataset.i18nTitle); });
    document.querySelectorAll('[data-i18n-aria]').forEach(n => { n.setAttribute('aria-label', t(n.dataset.i18nAria)); });
    document.querySelectorAll('[data-lang]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === settings.lang)));
    const models = t('models');
    document.getElementById('modelList').innerHTML = MODEL_IDS.map(id => `<option value="${id}">${esc(models[id] || id)}</option>`).join('');
  }
  function setLang(lang) {
    if (lang === settings.lang) return;
    settings.lang = lang;
    LS.set(K.settings, settings);
    applyStaticText();
    if (current) selectAgent(current.id, true);
  }

  function allAgents() {
    const base = DEFAULTS
      .filter(a => !store.removed.includes(a.id))
      .map(a => {
        const ov = store.overrides[a.id];
        // Khi đã sửa agent mặc định, bản sửa thay cho cả hai ngôn ngữ
        const merged = ov ? { ...a, ...ov, name_en: '', description_en: '', group_en: '', starters_en: null } : { ...a };
        return { ...merged, builtIn: true, edited: !!ov };
      });
    return base.concat(store.custom.map(a => ({ ...a, builtIn: false })));
  }
  const findAgent = id => allAgents().find(a => a.id === id);
  const isTool = a => a && a.type === 'tool';

  /* ================= Trạng thái ================= */
  const chats = {};
  const running = {};
  let current = null;
  let attachments = [];
  let liveEl = null, liveMsg = null, rafPending = false;

  function getChat(id) {
    if (!chats[id]) chats[id] = LS.get(K.chat(id), []);
    return chats[id];
  }
  function saveChat(id) {
    const slim = getChat(id).map(m => ({ role: m.role, text: m.text, error: m.error || undefined, imgCount: (m.images ? m.images.length : m.imgCount) || undefined }));
    if (!LS.set(K.chat(id), slim)) toast(t('storageFull'));
  }

  /* ================= DOM ================= */
  const $ = s => document.querySelector(s);
  const el = {
    rail: $('#rail'), scrim: $('#scrim'), list: $('#agentList'), search: $('#search'),
    desk: $('#desk'), icon: $('#agentIcon'), name: $('#agentName'), desc: $('#agentDesc'), modelChip: $('#modelChip'),
    thread: $('#thread'), form: $('#composer'), input: $('#input'), send: $('#sendBtn'),
    file: $('#fileInput'), attachRow: $('#attachRow'), toast: $('#toast'),
    sDlg: $('#settingsDlg'), aDlg: $('#agentDlg'), editBtn: $('#editAgent'), clearBtn: $('#clearChat')
  };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2800);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    toast(t('copied'));
  }

  /* ================= Markdown tối giản (an toàn: escape trước) ================= */
  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = esc(s)
      .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/&lt;br\s*\/?&gt;/gi, '<br>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + esc(codes[+i]) + '</code>');
  }
  function splitRow(line) {
    let l = line.trim();
    if (l.startsWith('|')) l = l.slice(1);
    if (l.endsWith('|')) l = l.slice(0, -1);
    return l.split('|').map(c => c.trim());
  }
  function mdBlocks(text) {
    const lines = text.split('\n');
    let out = '', i = 0;
    const isTableSep = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m;
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { const lv = m[1].length; out += `<h${lv}>${inline(m[2])}</h${lv}>`; i++; continue; }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out += '<hr>'; i++; continue; }
      if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = splitRow(line); i += 2;
        let rows = '';
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows += '<tr>' + splitRow(lines[i]).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>'; i++;
        }
        out += `<div class="table-wrap"><table><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
        continue;
      }
      if (/^\s*>/.test(line)) {
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out += `<blockquote>${mdBlocks(q.join('\n'))}</blockquote>`; continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const re = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
        const items = [];
        while (i < lines.length && lines[i].trim()) {
          if (re.test(lines[i])) items.push(lines[i].replace(re, ''));
          else if (/^\s{2,}\S/.test(lines[i]) && items.length) items[items.length - 1] += '\n' + lines[i].trim();
          else break;
          i++;
        }
        const tag = ordered ? 'ol' : 'ul';
        out += `<${tag}>${items.map(it => `<li>${inline(it).replace(/\n/g, '<br>')}</li>`).join('')}</${tag}>`; continue;
      }
      const p = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]) &&
        !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) { p.push(lines[i]); i++; }
      if (!p.length) { p.push(lines[i]); i++; }
      out += `<p>${p.map(inline).join('<br>')}</p>`;
    }
    return out;
  }
  function md(src) {
    const parts = String(src || '').replace(/\r/g, '').split(/^```/m);
    let html = '';
    parts.forEach((part, idx) => {
      if (idx % 2 === 0) { html += mdBlocks(part); return; }
      const nl = part.indexOf('\n');
      const lang = (nl === -1 ? part : part.slice(0, nl)).trim();
      const code = nl === -1 ? '' : part.slice(nl + 1).replace(/\n$/, '');
      html += `<div class="code"><div class="code-bar"><span>${esc(lang || 'text')}</span><button type="button" data-copy-code>${esc(t('copy'))}</button></div><pre><code>${esc(code)}</code></pre></div>`;
    });
    return html;
  }

  /* ================= Danh sách agent ================= */
  function renderList() {
    const q = el.search.value.trim().toLowerCase();
    const agents = allAgents().filter(a => !q ||
      [a.name, a.name_en, a.description, a.description_en, a.group, a.group_en].filter(Boolean).join(' ').toLowerCase().includes(q));
    const groups = new Map();
    const pinned = agents.filter(a => store.pinned.includes(a.id))
      .sort((a, b) => store.pinned.indexOf(a.id) - store.pinned.indexOf(b.id));
    if (pinned.length && !q) groups.set(t('pinned'), pinned);
    for (const a of agents) {
      if (!q && store.pinned.includes(a.id)) continue;
      const g = loc(a, 'group') || (a.builtIn ? t('other') : t('myAgents'));
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(a);
    }
    if (!agents.length) {
      el.list.innerHTML = `<p class="empty-list">${esc(t('noMatch', { q }))}</p>`;
      return;
    }
    let html = '';
    for (const [g, items] of groups) {
      html += `<div class="group-title">${esc(g)}</div>`;
      for (const a of items) {
        const isPinned = store.pinned.includes(a.id);
        html += `<div class="agent-item" role="button" tabindex="0" data-id="${esc(a.id)}" style="--c:${esc(a.color || '#3550E8')}" aria-current="${!!(current && current.id === a.id)}">
          <span class="tile" aria-hidden="true">${esc(a.icon || '🤖')}</span>
          <span class="label">${esc(loc(a, 'name'))}</span>
          ${running[a.id] ? `<span class="busy-dot" title="${esc(t('busy'))}"></span>` : ''}
          <button class="pin" type="button" data-pin="${esc(a.id)}" aria-pressed="${isPinned}" title="${esc(isPinned ? t('unpin') : t('pin'))}">${isPinned ? '★' : '☆'}</button>
        </div>`;
      }
    }
    el.list.innerHTML = html;
  }

  el.list.addEventListener('click', e => {
    const pin = e.target.closest('[data-pin]');
    if (pin) {
      e.stopPropagation();
      const id = pin.dataset.pin;
      store.pinned = store.pinned.includes(id) ? store.pinned.filter(x => x !== id) : [...store.pinned, id];
      saveStore(); renderList(); return;
    }
    const item = e.target.closest('.agent-item');
    if (item) { selectAgent(item.dataset.id); closeRail(); }
  });
  el.list.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('agent-item')) {
      e.preventDefault(); selectAgent(e.target.dataset.id); closeRail();
    }
  });
  el.search.addEventListener('input', renderList);
  document.querySelectorAll('[data-lang]').forEach(b => b.addEventListener('click', () => setLang(b.dataset.lang)));

  /* ================= Chọn agent ================= */
  const modelFor = a => (a && a.model && a.model.trim()) || settings.model || DEFAULT_SETTINGS.model;

  function selectAgent(id, keepFocus) {
    const a = findAgent(id) || allAgents()[0];
    if (!a) return;
    current = a;
    LS.set(K.last, a.id);
    document.documentElement.style.setProperty('--agent', a.color || '#3550E8');
    el.icon.textContent = a.icon || '🤖';
    el.name.textContent = loc(a, 'name');
    el.desc.textContent = loc(a, 'description') || '';
    el.desc.title = loc(a, 'description') || '';
    const tool = isTool(a);
    el.modelChip.hidden = tool;
    el.editBtn.hidden = tool;
    el.clearBtn.hidden = tool;
    el.form.hidden = tool;
    el.modelChip.textContent = modelFor(a);
    document.title = loc(a, 'name') + ' · Phucboo Agents';
    renderList();
    if (tool) renderTool(); else { renderThread(); updateSendBtn(); }
    if (!keepFocus && !tool && matchMedia('(min-width: 861px)').matches) el.input.focus();
  }

  /* ================= Khung chat ================= */
  function renderThread() {
    liveEl = null;
    const msgs = getChat(current.id);
    if (!msgs.length) {
      const starters = (loc(current, 'starters') || []).filter(Boolean);
      el.thread.innerHTML = `<div class="welcome">
        <div class="big" aria-hidden="true">${esc(current.icon || '🤖')}</div>
        <h2>${esc(loc(current, 'name'))}</h2>
        <p>${esc(loc(current, 'description') || t('startHint'))}</p>
        ${starters.length ? `<div class="starters">${starters.map((s, i) => `<button type="button" class="starter" data-starter="${i}">${esc(s.trim())}</button>`).join('')}</div>` : ''}
        ${settings.apiKey ? '' : `<div class="key-warning"><strong>${esc(t('noKeyTitle'))}</strong> ${esc(t('noKeyBody'))}<br><button type="button" class="btn btn-sm" data-open-settings>${esc(t('enterKey'))}</button></div>`}
      </div>`;
      return;
    }
    el.thread.innerHTML = msgs.map((m, i) => msgHtml(m, i, msgs)).join('');
    if (running[current.id]) {
      liveMsg = msgs[msgs.length - 1];
      liveEl = el.thread.querySelector('.msg:last-child .body');
    }
    el.thread.scrollTop = el.thread.scrollHeight;
  }

  function msgHtml(m, i, msgs) {
    if (m.role === 'user') {
      const imgs = m.images && m.images.length
        ? `<div class="thumbs">${m.images.map(im => `<img src="${im.url || `data:${im.media_type};base64,${im.data}`}" alt="${esc(t('imgAttached'))}">`).join('')}</div>`
        : (m.imgCount ? `<div class="img-note">${esc(t('imgNote', { n: m.imgCount }))}</div>` : '');
      return `<div class="msg user">${imgs}${m.text ? `<div class="bubble">${esc(m.text)}</div>` : ''}</div>`;
    }
    const isLast = i === msgs.length - 1;
    const streaming = isLast && running[current.id];
    const body = m.error ? `<p>${esc(m.text)}</p>` : (m.text ? md(m.text) : `<p class="thinking">${esc(t('thinking'))}</p>`);
    const actions = streaming ? '' : `<div class="msg-actions">
        ${m.error ? '' : `<button type="button" data-copy-msg="${i}">${esc(t('copy'))}</button>`}
        ${isLast ? `<button type="button" data-retry>${esc(t('retry'))}</button>` : ''}
      </div>`;
    return `<div class="msg assistant${m.error ? ' error' : ''}${streaming ? ' streaming' : ''}"><div class="body">${body}</div>${actions}</div>`;
  }

  el.thread.addEventListener('click', e => {
    const tg = e.target;
    if (tg.matches('[data-copy-code]')) { copyText(tg.closest('.code').querySelector('pre').textContent); return; }
    if (tg.matches('[data-copy-msg]')) { copyText(getChat(current.id)[+tg.dataset.copyMsg].text); return; }
    if (tg.matches('[data-retry]')) { retry(); return; }
    if (tg.matches('[data-open-settings]')) { openSettings(); return; }
    const st = tg.closest('[data-starter]');
    if (st) {
      el.input.value = loc(current, 'starters')[+st.dataset.starter];
      autoGrow(); el.input.focus();
      el.input.setSelectionRange(el.input.value.length, el.input.value.length);
    }
  });

  function nearBottom() { return el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight < 140; }
  function scheduleLive() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!liveEl || !liveMsg || !current) return;
      const stick = nearBottom();
      liveEl.innerHTML = liveMsg.text ? md(liveMsg.text) : `<p class="thinking">${esc(t('thinking'))}</p>`;
      if (stick) el.thread.scrollTop = el.thread.scrollHeight;
    });
  }

  /* ================= Gọi Claude ================= */
  function toApiMessages(msgs) {
    const out = [];
    for (const m of msgs) {
      if (m.error || (m.role === 'assistant' && !m.text.trim())) continue;
      let content;
      if (m.role === 'user' && m.images && m.images.length) {
        content = m.images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } }));
        content.push({ type: 'text', text: m.text || t('seeImg') });
      } else {
        let txt = m.text || '';
        if (m.role === 'user' && m.imgCount && !(m.images && m.images.length)) txt = t('imgGone', { n: m.imgCount }) + '\n' + txt;
        content = txt;
      }
      const prev = out[out.length - 1];
      if (prev && prev.role === m.role) {
        const toBlocks = c => typeof c === 'string' ? [{ type: 'text', text: c }] : c;
        prev.content = toBlocks(prev.content).concat(toBlocks(content));
      } else out.push({ role: m.role, content });
    }
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
  }

  function friendlyError(status, message) {
    const m = message ? ` (${message})` : '';
    switch (status) {
      case 401: return t('e401');
      case 403: return t('e403') + m;
      case 404: return t('e404') + m;
      case 413: return t('e413');
      case 429: return t('e429') + m;
      case 500: case 502: case 503: return t('e5xx');
      case 529: return t('e529');
      case 400: return t('e400') + m;
      default: return (message || t('eOther')) + (status ? ` [${status}]` : '');
    }
  }

  async function runAssistant(agent) {
    const id = agent.id;
    const msgs = getChat(id);
    const apiMessages = toApiMessages(msgs);
    const reply = { role: 'assistant', text: '' };
    msgs.push(reply);
    const ctrl = new AbortController();
    running[id] = ctrl;
    if (current.id === id) renderThread();
    renderList(); updateSendBtn();

    const system = ((agent.system || '') + t('langSuffix')).trim();
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': settings.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: modelFor(agent),
          max_tokens: Number(settings.maxTokens) || DEFAULT_SETTINGS.maxTokens,
          system: system || undefined,
          messages: apiMessages,
          stream: true
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw Object.assign(new Error(friendlyError(res.status, err && err.error && err.error.message)), { friendly: true });
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', stop = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true }).replace(/\r/g, '');
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
          if (!data) continue;
          let ev; try { ev = JSON.parse(data); } catch { continue; }
          if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
            reply.text += ev.delta.text;
            if (current.id === id) scheduleLive();
          } else if (ev.type === 'message_delta' && ev.delta) {
            stop = ev.delta.stop_reason || stop;
          } else if (ev.type === 'error') {
            const et = ev.error && ev.error.type;
            throw Object.assign(new Error(friendlyError(et === 'overloaded_error' ? 529 : 0, ev.error && ev.error.message)), { friendly: true });
          }
        }
      }
      if (stop === 'max_tokens') reply.text += '\n\n' + t('truncated');
      if (stop === 'refusal' && !reply.text.trim()) reply.text = t('refused');
    } catch (e) {
      if (e.name === 'AbortError') {
        reply.text += (reply.text ? '\n\n' : '') + t('stopped');
      } else {
        const partial = reply.text;
        reply.error = true;
        reply.text = e.friendly ? e.message : t('netError');
        if (partial) msgs.splice(msgs.length - 1, 0, { role: 'assistant', text: partial });
      }
    } finally {
      delete running[id];
      saveChat(id);
      if (current.id === id && !isTool(current)) renderThread();
      renderList(); updateSendBtn();
    }
  }

  function send() {
    if (running[current.id]) { running[current.id].abort(); return; }
    const text = el.input.value.trim();
    if (!text && !attachments.length) return;
    if (!settings.apiKey) { openSettings(t('needKey')); return; }
    const msgs = getChat(current.id);
    while (msgs.length && msgs[msgs.length - 1].error) msgs.pop();
    msgs.push({ role: 'user', text, images: attachments });
    attachments = [];
    renderAttachments();
    el.input.value = ''; autoGrow();
    runAssistant(current);
  }

  function retry() {
    if (running[current.id]) return;
    if (!settings.apiKey) { openSettings(t('needKey')); return; }
    const msgs = getChat(current.id);
    while (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs.pop();
    if (!msgs.length) return;
    runAssistant(current);
  }

  function updateSendBtn() {
    const busy = current && running[current.id];
    el.send.textContent = busy ? t('stop') : t('send');
    el.send.classList.toggle('stop', !!busy);
  }

  el.form.addEventListener('submit', e => { e.preventDefault(); send(); });
  el.input.addEventListener('keydown', e => {
    // isComposing: tránh gửi nhầm khi đang gõ tiếng Việt bằng bộ gõ
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      if (matchMedia('(pointer: coarse)').matches) return;
      e.preventDefault(); send();
    }
  });
  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 260) + 'px';
  }
  el.input.addEventListener('input', autoGrow);

  el.clearBtn.addEventListener('click', () => {
    if (running[current.id]) running[current.id].abort();
    chats[current.id] = [];
    LS.del(K.chat(current.id));
    renderThread();
    el.input.focus();
  });

  /* ================= Ảnh đính kèm ================= */
  function addFiles(files) {
    for (const f of files) {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) { toast(t('onlyImages')); continue; }
      if (f.size > MAX_IMG_BYTES) { toast(t('imgTooBig', { name: f.name })); continue; }
      const r = new FileReader();
      r.onload = () => {
        const url = r.result;
        attachments.push({ media_type: f.type, data: url.split(',')[1], url });
        renderAttachments();
      };
      r.readAsDataURL(f);
    }
  }
  function renderAttachments() {
    el.attachRow.hidden = !attachments.length;
    el.attachRow.innerHTML = attachments.map((a, i) =>
      `<div class="chip"><img src="${a.url}" alt="${esc(t('imgAttached'))} ${i + 1}"><button type="button" data-rm="${i}" aria-label="${esc(t('removeImg'))}">✕</button></div>`).join('');
  }
  el.attachRow.addEventListener('click', e => {
    const b = e.target.closest('[data-rm]');
    if (b) { attachments.splice(+b.dataset.rm, 1); renderAttachments(); }
  });
  el.file.addEventListener('change', () => { addFiles(el.file.files); el.file.value = ''; });
  el.input.addEventListener('paste', e => {
    const files = [...(e.clipboardData ? e.clipboardData.files : [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  el.desk.addEventListener('dragover', e => e.preventDefault());
  el.desk.addEventListener('drop', e => {
    e.preventDefault();
    if (isTool(current)) return;
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  /* ================= Agent công cụ: tải video ================= */
  const dl = { input: '', results: [], busy: false };
  const dlApi = () => (settings.dlApi || APP_CONFIG.downloaderApi || '').trim().replace(/\/+$/, '');

  function detectPlatform(u) {
    let h;
    try { h = new URL(u).hostname.toLowerCase(); } catch { return null; }
    if (/(^|\.)(tiktok\.com|douyin\.com)$/.test(h)) return 'tiktok';
    if (/(^|\.)(facebook\.com|fb\.watch|fb\.com)$/.test(h)) return 'facebook';
    return null;
  }
  const extractLinks = text => [...new Set((text.match(/https?:\/\/[^\s"'<>]+/g) || []).map(u => u.replace(/[),.;!?]+$/, '')))];

  function renderTool() {
    if (current.tool !== 'video-downloader') { el.thread.innerHTML = ''; return; }
    const api = dlApi();
    el.thread.innerHTML = `<div class="dl">
      <form class="dl-form" id="dlForm">
        <textarea id="dlInput" rows="3" placeholder="${esc(t('dlPh'))}">${esc(dl.input)}</textarea>
        <div class="dl-buttons">
          <button type="button" class="btn" id="dlPaste">${esc(t('dlPaste'))}</button>
          <button type="submit" class="send-btn" id="dlGo" ${dl.busy ? 'disabled' : ''}>${esc(dl.busy ? t('dlWorking') : t('dlGet'))}</button>
        </div>
      </form>
      ${api ? '' : `<div class="key-warning"><strong>${esc(t('dlNoApiTitle'))}</strong> ${esc(t('dlNoApiBody'))}<br><button type="button" class="btn btn-sm" data-open-settings>${esc(t('settings'))}</button></div>`}
      <p class="dl-note">${esc(t('dlNote'))}</p>
      <div class="dl-results" id="dlResults">${dl.results.length ? dl.results.map(resultHtml).join('') : ''}</div>
      ${dl.results.length ? `<button type="button" class="btn btn-ghost btn-sm dl-clear" id="dlClear">${esc(t('dlClear'))}</button>` : ''}
    </div>`;
    const inp = $('#dlInput');
    inp.addEventListener('input', () => { dl.input = inp.value; });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runDownload(); }
    });
    $('#dlForm').addEventListener('submit', e => { e.preventDefault(); runDownload(); });
    $('#dlPaste').addEventListener('click', async () => {
      try {
        const txt = await navigator.clipboard.readText();
        inp.value = (inp.value.trim() ? inp.value.trim() + '\n' : '') + txt.trim();
        dl.input = inp.value;
        runDownload();
      } catch { toast(t('dlClipDenied')); inp.focus(); }
    });
    const clr = $('#dlClear');
    if (clr) clr.addEventListener('click', () => { dl.results = []; renderTool(); });
    if (matchMedia('(min-width: 861px)').matches && !dl.busy) inp.focus();
  }

  function fmtSize(b) {
    if (!b) return '';
    return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';
  }
  function fileName(r, item) {
    const base = [r.platform, (r.author || '').replace(/\s+/g, '_'), r.id || Date.now()].filter(Boolean).join('_');
    const suffix = item.kind === 'video_wm' ? '_logo' : item.kind === 'image' ? '_' + item.index : item.kind === 'audio' ? '_audio' : '';
    return (base + suffix).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100) + '.' + (item.ext || 'mp4');
  }
  function itemHref(r, item) {
    const api = dlApi();
    if (!api) return item.url;
    return `${api}/download?src=${encodeURIComponent(item.url)}&name=${encodeURIComponent(fileName(r, item))}`;
  }

  function resultHtml(r) {
    if (r.loading) {
      return `<article class="dl-card loading"><div class="dl-body"><p class="dl-link">${esc(r.link)}</p><p class="thinking">${esc(t('dlWorking'))}</p></div></article>`;
    }
    if (r.error) {
      return `<article class="dl-card error"><div class="dl-body"><p class="dl-link">${esc(r.link)}</p><p>${esc(t('dlErr_' + r.error))}</p></div></article>`;
    }
    const api = dlApi();
    const primary = ['video_hd', 'video'];
    const items = r.items || [];
    const firstPrimary = items.findIndex(it => primary.includes(it.kind));
    const buttons = items.map((it, i) => {
      const label = it.kind === 'image' ? t('k_image', { n: it.index }) : t('k_' + it.kind);
      const size = fmtSize(it.size);
      const cls = i === firstPrimary ? 'dl-btn primary' : 'dl-btn';
      const attrs = api ? '' : 'target="_blank" rel="noopener noreferrer"';
      return `<a class="${cls}" href="${esc(itemHref(r, it))}" ${attrs}>⬇ ${esc(label)}${size ? ` <small>${esc(size)}</small>` : ''}</a>`;
    }).join('');
    const meta = [r.platform === 'tiktok' ? 'TikTok' : 'Facebook', r.author ? t('by', { a: r.author }) : '', r.duration ? r.duration + 's' : ''].filter(Boolean).join(' · ');
    return `<article class="dl-card">
      ${r.cover ? `<img class="dl-cover" src="${esc(r.cover)}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()">` : ''}
      <div class="dl-body">
        <p class="dl-meta">${esc(meta)}</p>
        <h3 class="dl-title">${esc(r.title || r.link)}</h3>
        <div class="dl-actions">${buttons}</div>
        ${r.platform === 'facebook' ? `<p class="dl-sub">${esc(t('fbNoLogo'))}</p>` : ''}
        ${api ? '' : `<p class="dl-sub">${esc(t('dlOpenHint'))}</p>`}
      </div>
    </article>`;
  }

  async function resolveViaApi(link) {
    let res;
    try { res = await fetch(`${dlApi()}/resolve?url=${encodeURIComponent(link)}`); }
    catch { throw Object.assign(new Error(), { code: 'NET' }); }
    const j = await res.json().catch(() => null);
    if (!j) throw Object.assign(new Error(), { code: 'NET' });
    if (!j.ok) throw Object.assign(new Error(), { code: j.code || 'FAILED' });
    return j;
  }

  // Không có máy chủ: thử gọi TikWM trực tiếp từ trình duyệt (chỉ TikTok)
  async function resolveTikTokDirect(link) {
    let j;
    try {
      const res = await fetch('https://www.tikwm.com/api/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({ url: link, hd: '1' })
      });
      j = await res.json();
    } catch { throw Object.assign(new Error(), { code: 'DIRECT' }); }
    if (!j || j.code !== 0 || !j.data) throw Object.assign(new Error(), { code: /limit/i.test((j && j.msg) || '') ? 'RATE_LIMIT' : 'TIKTOK_FAIL' });
    const d = j.data;
    const abs = p => !p ? null : (/^https?:/.test(p) ? p : 'https://www.tikwm.com' + p);
    const items = [];
    if (Array.isArray(d.images) && d.images.length) d.images.forEach((im, i) => items.push({ kind: 'image', index: i + 1, url: abs(im), ext: 'jpg' }));
    else {
      if (d.hdplay) items.push({ kind: 'video_hd', url: abs(d.hdplay), size: d.hd_size, ext: 'mp4' });
      if (d.play && d.play !== d.hdplay) items.push({ kind: 'video', url: abs(d.play), size: d.size, ext: 'mp4' });
      if (d.wmplay) items.push({ kind: 'video_wm', url: abs(d.wmplay), size: d.wm_size, ext: 'mp4' });
    }
    if (d.music) items.push({ kind: 'audio', url: abs(d.music), ext: 'mp3' });
    return {
      platform: 'tiktok', id: String(d.id || ''), title: d.title || '',
      author: (d.author && (d.author.nickname || d.author.unique_id)) || '',
      cover: abs(d.origin_cover || d.cover), duration: d.duration || null, items
    };
  }

  async function runDownload() {
    if (dl.busy) return;
    const links = extractLinks(dl.input);
    if (!links.length) { toast(t('dlNoLink')); return; }
    dl.busy = true;
    const batch = links.map(link => ({ link, loading: true }));
    dl.results = batch.concat(dl.results).slice(0, 30);
    dl.input = '';
    if (isTool(current)) renderTool();
    for (const r of batch) {
      const platform = detectPlatform(r.link);
      try {
        if (!platform) throw Object.assign(new Error(), { code: 'UNSUPPORTED' });
        let data;
        if (dlApi()) data = await resolveViaApi(r.link);
        else if (platform === 'tiktok') data = await resolveTikTokDirect(r.link);
        else throw Object.assign(new Error(), { code: 'NEED_API' });
        Object.assign(r, data, { loading: false });
      } catch (e) {
        Object.assign(r, { loading: false, error: e.code || 'FAILED' });
      }
      if (isTool(current)) renderTool();
      if (batch.length > 1) await new Promise(res => setTimeout(res, 1100)); // tránh bị giới hạn tốc độ
    }
    dl.busy = false;
    if (isTool(current)) renderTool();
  }

  /* ================= Cài đặt ================= */
  function openSettings(note) {
    $('#settingsNote').hidden = !note;
    $('#settingsNote').textContent = note || '';
    $('#apiKey').value = settings.apiKey;
    $('#apiKey').type = 'password'; $('#toggleKey').textContent = t('show');
    $('#model').value = settings.model;
    $('#maxTokens').value = settings.maxTokens;
    $('#dlApi').value = settings.dlApi || '';
    $('#dlApi').placeholder = APP_CONFIG.downloaderApi || 'https://….workers.dev';
    el.sDlg.showModal();
    if (!settings.apiKey && !isTool(current)) $('#apiKey').focus();
  }
  $('#openSettings').addEventListener('click', () => { closeRail(); openSettings(); });
  $('#cancelSettings').addEventListener('click', () => el.sDlg.close());
  $('#toggleKey').addEventListener('click', () => {
    const k = $('#apiKey'); const show = k.type === 'password';
    k.type = show ? 'text' : 'password'; $('#toggleKey').textContent = show ? t('hide') : t('show');
  });
  $('#settingsForm').addEventListener('submit', () => {
    settings.apiKey = $('#apiKey').value.trim();
    settings.model = $('#model').value.trim() || DEFAULT_SETTINGS.model;
    settings.maxTokens = Math.max(256, Math.min(64000, parseInt($('#maxTokens').value, 10) || DEFAULT_SETTINGS.maxTokens));
    settings.dlApi = $('#dlApi').value.trim();
    LS.set(K.settings, settings);
    toast(t('saved'));
    selectAgent(current.id);
  });

  $('#exportAgents').addEventListener('click', () => {
    const data = { version: 1, exportedAt: new Date().toISOString(), custom: store.custom, overrides: store.overrides, pinned: store.pinned, removed: store.removed };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'phucboo-agents.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#importAgents').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!Array.isArray(data.custom)) throw new Error();
      data.custom.forEach(a => {
        if (a && a.id && a.name) { store.custom = store.custom.filter(x => x.id !== a.id); store.custom.push(a); }
      });
      if (data.overrides && typeof data.overrides === 'object') Object.assign(store.overrides, data.overrides);
      if (Array.isArray(data.pinned)) store.pinned = [...new Set(store.pinned.concat(data.pinned))];
      saveStore(); renderList();
      toast(t('imported', { n: data.custom.length }));
    } catch { toast(t('badJson')); }
  });
  $('#wipeAll').addEventListener('click', () => {
    if (!confirm(t('wipeConfirm'))) return;
    Object.keys(localStorage).filter(k => k.startsWith('pb.')).forEach(k => localStorage.removeItem(k));
    location.reload();
  });

  /* ================= Tạo / sửa agent ================= */
  let editingId = null;
  function openAgentEditor(agent) {
    editingId = agent ? agent.id : null;
    $('#agentDlgTitle').textContent = agent ? t('aEdit') : t('aCreate');
    $('#fName').value = agent ? loc(agent, 'name') : '';
    $('#fGroup').value = agent ? (loc(agent, 'group') || '') : t('myAgents');
    $('#fIcon').value = agent ? (agent.icon || '') : '🤖';
    $('#fColor').value = agent && /^#[0-9a-f]{6}$/i.test(agent.color || '') ? agent.color : '#3550E8';
    $('#fDesc').value = agent ? (loc(agent, 'description') || '') : '';
    $('#fModel').value = agent ? (agent.model || '') : '';
    $('#fSystem').value = agent ? (agent.system || '') : '';
    $('#fStarters').value = agent ? (loc(agent, 'starters') || []).map(s => s.replace(/\n/g, ' ').trim()).join('\n') : '';
    const groups = [...new Set(allAgents().map(a => loc(a, 'group')).filter(Boolean))];
    $('#groupList').innerHTML = groups.map(g => `<option value="${esc(g)}">`).join('');
    $('#deleteAgent').hidden = !agent;
    $('#deleteAgent').textContent = agent && agent.builtIn ? t('aHide') : t('aDelete');
    $('#resetAgent').hidden = !(agent && agent.builtIn && agent.edited);
    el.aDlg.showModal();
    $('#fName').focus();
  }
  $('#newAgent').addEventListener('click', () => { closeRail(); openAgentEditor(null); });
  el.editBtn.addEventListener('click', () => openAgentEditor(current));
  $('#cancelAgent').addEventListener('click', () => el.aDlg.close());

  $('#agentForm').addEventListener('submit', () => {
    const data = {
      name: $('#fName').value.trim() || t('aNewName'),
      group: $('#fGroup').value.trim(),
      icon: $('#fIcon').value.trim() || '🤖',
      color: $('#fColor').value,
      description: $('#fDesc').value.trim(),
      model: $('#fModel').value.trim(),
      system: $('#fSystem').value,
      starters: $('#fStarters').value.split('\n').map(s => s.trim()).filter(Boolean)
    };
    let id = editingId;
    if (!id) {
      id = 'c-' + Date.now().toString(36);
      store.custom.push({ id, ...data });
    } else if (defaultIds.has(id)) {
      store.overrides[id] = data;
    } else {
      store.custom = store.custom.map(a => a.id === id ? { id, ...data } : a);
    }
    saveStore();
    toast(editingId ? t('aSaved') : t('aCreated'));
    selectAgent(id);
  });

  $('#deleteAgent').addEventListener('click', () => {
    const a = findAgent(editingId); if (!a) return;
    const name = loc(a, 'name');
    if (!confirm(a.builtIn ? t('aHideConfirm', { name }) : t('aDeleteConfirm', { name }))) return;
    if (a.builtIn) store.removed.push(a.id);
    else store.custom = store.custom.filter(x => x.id !== a.id);
    store.pinned = store.pinned.filter(x => x !== a.id);
    LS.del(K.chat(a.id)); delete chats[a.id];
    saveStore();
    el.aDlg.close();
    selectAgent((allAgents()[0] || {}).id);
  });
  $('#resetAgent').addEventListener('click', () => {
    delete store.overrides[editingId];
    saveStore(); el.aDlg.close();
    toast(t('aResetDone'));
    selectAgent(editingId);
  });

  /* ================= Thanh bên trên điện thoại ================= */
  function openRail() { el.rail.classList.add('open'); el.scrim.hidden = false; }
  function closeRail() { el.rail.classList.remove('open'); el.scrim.hidden = true; }
  $('#openRail').addEventListener('click', openRail);
  $('#closeRail').addEventListener('click', closeRail);
  el.scrim.addEventListener('click', closeRail);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeRail(); });

  /* ================= Khởi động ================= */
  applyStaticText();
  const params = new URLSearchParams(location.search);
  if (params.get('lang') === 'en' || params.get('lang') === 'vi') { settings.lang = params.get('lang'); applyStaticText(); }
  const first = params.get('agent') || LS.get(K.last, null);
  if (!allAgents().length) {
    el.thread.innerHTML = `<div class="welcome"><h2>${esc(t('noAgents'))}</h2><p>${esc(t('noAgentsHint'))}</p></div>`;
  } else {
    selectAgent(first);
    if (!settings.apiKey && !isTool(current)) setTimeout(() => openSettings(t('welcomeKey')), 300);
  }
})();

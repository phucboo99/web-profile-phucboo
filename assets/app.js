(() => {
  'use strict';

  /* ================= Cấu hình ================= */
  const API_URL = 'https://api.anthropic.com/v1/messages';
  const MODELS = [
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 (cân bằng, khuyên dùng)' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5 (mạnh nhất, chậm hơn)' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5 (nhanh, rẻ)' }
  ];
  const DEFAULT_SETTINGS = { apiKey: '', model: MODELS[0].id, maxTokens: 4096 };
  const MAX_IMG_BYTES = 5 * 1024 * 1024;

  /* ================= Lưu trữ trong trình duyệt ================= */
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { console.warn(e); return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* bỏ qua */ } }
  };
  const K = { settings: 'pb.settings', store: 'pb.agents', last: 'pb.last', chat: id => 'pb.chat.' + id };

  let settings = { ...DEFAULT_SETTINGS, ...LS.get(K.settings, {}) };
  // store: overrides = sửa agent mặc định, custom = agent tự tạo, removed = agent mặc định đã ẩn
  let store = { overrides: {}, custom: [], removed: [], pinned: null, ...LS.get(K.store, {}) };
  if (!Array.isArray(store.pinned)) store.pinned = [...(window.DEFAULT_PINNED || [])];
  const saveStore = () => LS.set(K.store, store);

  const DEFAULTS = (window.DEFAULT_AGENTS || []);
  const defaultIds = new Set(DEFAULTS.map(a => a.id));

  function allAgents() {
    const base = DEFAULTS
      .filter(a => !store.removed.includes(a.id))
      .map(a => ({ ...a, ...(store.overrides[a.id] || {}), builtIn: true, edited: !!store.overrides[a.id] }));
    return base.concat(store.custom.map(a => ({ ...a, builtIn: false })));
  }
  const findAgent = id => allAgents().find(a => a.id === id);

  /* ================= Trạng thái ================= */
  const chats = {};           // agentId -> mảng tin nhắn
  const running = {};         // agentId -> AbortController
  let current = null;
  let attachments = [];       // ảnh chờ gửi: {media_type, data, url}
  let liveEl = null, liveMsg = null, rafPending = false;

  function getChat(id) {
    if (!chats[id]) chats[id] = LS.get(K.chat(id), []);
    return chats[id];
  }
  function saveChat(id) {
    const slim = getChat(id).map(m => ({ role: m.role, text: m.text, error: m.error || undefined, imgCount: (m.images ? m.images.length : m.imgCount) || undefined }));
    if (!LS.set(K.chat(id), slim)) toast('Bộ nhớ trình duyệt đầy, lịch sử chat không được lưu.');
  }

  /* ================= DOM ================= */
  const $ = s => document.querySelector(s);
  const el = {
    rail: $('#rail'), scrim: $('#scrim'), list: $('#agentList'), search: $('#search'),
    desk: $('#desk'), icon: $('#agentIcon'), name: $('#agentName'), desc: $('#agentDesc'), modelChip: $('#modelChip'),
    thread: $('#thread'), form: $('#composer'), input: $('#input'), send: $('#sendBtn'),
    file: $('#fileInput'), attachRow: $('#attachRow'), toast: $('#toast'),
    sDlg: $('#settingsDlg'), aDlg: $('#agentDlg')
  };

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const t = document.createElement('textarea');
      t.value = text; document.body.appendChild(t); t.select();
      document.execCommand('copy'); t.remove();
    }
    toast('Đã sao chép');
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
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
        const lv = m[1].length; out += `<h${lv}>${inline(m[2])}</h${lv}>`; i++; continue;
      }
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
        let q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out += `<blockquote>${mdBlocks(q.join('\n'))}</blockquote>`; continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const re = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
        let items = [];
        while (i < lines.length && lines[i].trim()) {
          if (re.test(lines[i])) items.push(lines[i].replace(re, ''));
          else if (/^\s{2,}\S/.test(lines[i]) && items.length) items[items.length - 1] += '\n' + lines[i].trim();
          else break;
          i++;
        }
        const tag = ordered ? 'ol' : 'ul';
        out += `<${tag}>${items.map(it => `<li>${inline(it).replace(/\n/g, '<br>')}</li>`).join('')}</${tag}>`; continue;
      }
      let p = [];
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
      html += `<div class="code"><div class="code-bar"><span>${esc(lang || 'text')}</span><button type="button" data-copy-code>Sao chép</button></div><pre><code>${esc(code)}</code></pre></div>`;
    });
    return html;
  }

  /* ================= Danh sách agent ================= */
  function renderList() {
    const q = el.search.value.trim().toLowerCase();
    const agents = allAgents().filter(a => !q || (a.name + ' ' + (a.description || '') + ' ' + (a.group || '')).toLowerCase().includes(q));
    const groups = new Map();
    const pinned = agents.filter(a => store.pinned.includes(a.id))
      .sort((a, b) => store.pinned.indexOf(a.id) - store.pinned.indexOf(b.id));
    if (pinned.length && !q) groups.set('Đã ghim', pinned);
    for (const a of agents) {
      if (!q && store.pinned.includes(a.id)) continue;
      const g = a.group || (a.builtIn ? 'Khác' : 'Agent của tôi');
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(a);
    }
    if (!agents.length) {
      el.list.innerHTML = `<p class="empty-list">Không có agent nào khớp “${esc(q)}”.</p>`;
      return;
    }
    let html = '';
    for (const [g, items] of groups) {
      html += `<div class="group-title">${esc(g)}</div>`;
      for (const a of items) {
        const isPinned = store.pinned.includes(a.id);
        html += `<div class="agent-item" role="button" tabindex="0" data-id="${esc(a.id)}" style="--c:${esc(a.color || '#3550E8')}" aria-current="${current && current.id === a.id}">
          <span class="tile" aria-hidden="true">${esc(a.icon || '🤖')}</span>
          <span class="label">${esc(a.name)}</span>
          ${running[a.id] ? '<span class="busy-dot" title="Đang trả lời"></span>' : ''}
          <button class="pin" type="button" data-pin="${esc(a.id)}" aria-pressed="${isPinned}" title="${isPinned ? 'Bỏ ghim' : 'Ghim lên đầu'}">${isPinned ? '★' : '☆'}</button>
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

  /* ================= Chọn agent ================= */
  function selectAgent(id) {
    const a = findAgent(id) || allAgents()[0];
    if (!a) return;
    current = a;
    LS.set(K.last, a.id);
    document.documentElement.style.setProperty('--agent', a.color || '#3550E8');
    el.icon.textContent = a.icon || '🤖';
    el.name.textContent = a.name;
    el.desc.textContent = a.description || '';
    el.desc.title = a.description || '';
    el.modelChip.textContent = modelFor(a);
    document.title = a.name + ' · Phucboo Agents';
    renderList();
    renderThread();
    updateSendBtn();
    if (matchMedia('(min-width: 861px)').matches) el.input.focus();
  }
  const modelFor = a => (a && a.model && a.model.trim()) || settings.model || DEFAULT_SETTINGS.model;

  /* ================= Khung chat ================= */
  function renderThread() {
    liveEl = null;
    const msgs = getChat(current.id);
    if (!msgs.length) {
      const starters = (current.starters || []).filter(Boolean);
      el.thread.innerHTML = `<div class="welcome">
        <div class="big" aria-hidden="true">${esc(current.icon || '🤖')}</div>
        <h2>${esc(current.name)}</h2>
        <p>${esc(current.description || 'Nhập yêu cầu để bắt đầu.')}</p>
        ${starters.length ? `<div class="starters">${starters.map((s, i) => `<button type="button" class="starter" data-starter="${i}">${esc(s.trim())}</button>`).join('')}</div>` : ''}
        ${settings.apiKey ? '' : `<div class="key-warning"><strong>Chưa có API key.</strong> Website gọi Claude bằng API key của bạn, key chỉ lưu trong trình duyệt này.<br><button type="button" class="btn btn-sm" data-open-settings>Nhập API key</button></div>`}
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
        ? `<div class="thumbs">${m.images.map(im => `<img src="${im.url || `data:${im.media_type};base64,${im.data}`}" alt="Ảnh đính kèm">`).join('')}</div>`
        : (m.imgCount ? `<div class="img-note">📎 ${m.imgCount} ảnh (không lưu lại sau khi tải lại trang)</div>` : '');
      return `<div class="msg user">${imgs}${m.text ? `<div class="bubble">${esc(m.text)}</div>` : ''}</div>`;
    }
    const isLast = i === msgs.length - 1;
    const streaming = isLast && running[current.id];
    const body = m.error ? `<p>${esc(m.text)}</p>` : (m.text ? md(m.text) : '<p class="thinking">Đang suy nghĩ…</p>');
    const actions = streaming ? '' : `<div class="msg-actions">
        ${m.error ? '' : `<button type="button" data-copy-msg="${i}">Sao chép</button>`}
        ${isLast ? `<button type="button" data-retry>Tạo lại</button>` : ''}
      </div>`;
    return `<div class="msg assistant${m.error ? ' error' : ''}${streaming ? ' streaming' : ''}"><div class="body">${body}</div>${actions}</div>`;
  }

  el.thread.addEventListener('click', e => {
    const t = e.target;
    if (t.matches('[data-copy-code]')) { copyText(t.closest('.code').querySelector('pre').textContent); return; }
    if (t.matches('[data-copy-msg]')) { copyText(getChat(current.id)[+t.dataset.copyMsg].text); return; }
    if (t.matches('[data-retry]')) { retry(); return; }
    if (t.matches('[data-open-settings]')) { openSettings(); return; }
    const st = t.closest('[data-starter]');
    if (st) {
      el.input.value = current.starters[+st.dataset.starter];
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
      liveEl.innerHTML = liveMsg.text ? md(liveMsg.text) : '<p class="thinking">Đang suy nghĩ…</p>';
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
        content.push({ type: 'text', text: m.text || 'Xem ảnh đính kèm.' });
      } else {
        let t = m.text || '';
        if (m.role === 'user' && m.imgCount && !(m.images && m.images.length)) t = `[Tin nhắn này từng có ${m.imgCount} ảnh, nay không còn]\n` + t;
        content = t;
      }
      const prev = out[out.length - 1];
      if (prev && prev.role === m.role) {   // gộp tin nhắn liên tiếp cùng vai
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
      case 401: return 'API key không hợp lệ. Mở Cài đặt và kiểm tra lại key.';
      case 403: return 'API key không có quyền dùng model này' + m;
      case 404: return 'Không tìm thấy model. Mở Cài đặt và chọn model khác' + m;
      case 413: return 'Yêu cầu quá lớn, thử gửi ít ảnh hơn hoặc bắt đầu cuộc trò chuyện mới.';
      case 429: return 'Đã chạm giới hạn tốc độ hoặc hết hạn mức. Đợi một lát rồi bấm Tạo lại' + m;
      case 500: case 502: case 503: return 'Máy chủ Claude đang lỗi. Bấm Tạo lại sau ít phút.';
      case 529: return 'Claude đang quá tải. Bấm Tạo lại sau ít phút.';
      case 400: return 'Yêu cầu không hợp lệ' + m;
      default: return (message || 'Có lỗi xảy ra') + (status ? ` [${status}]` : '');
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
    if (current.id === id) { renderThread(); }
    renderList(); updateSendBtn();

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
          system: agent.system || undefined,
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
            const t = ev.error && ev.error.type;
            throw Object.assign(new Error(friendlyError(t === 'overloaded_error' ? 529 : 0, ev.error && ev.error.message)), { friendly: true });
          }
        }
      }
      if (stop === 'max_tokens') reply.text += '\n\n> Câu trả lời bị cắt vì chạm giới hạn độ dài. Tăng “max tokens” trong Cài đặt hoặc nhắn “viết tiếp”.';
      if (stop === 'refusal' && !reply.text.trim()) reply.text = 'Claude đã từ chối yêu cầu này.';
    } catch (e) {
      if (e.name === 'AbortError') {
        reply.text += (reply.text ? '\n\n' : '') + '_(Đã dừng)_';
      } else {
        const partial = reply.text;
        reply.error = true;
        reply.text = e.friendly ? e.message
          : 'Không kết nối được tới Claude API. Kiểm tra mạng rồi bấm Tạo lại.';
        if (partial) { msgs.splice(msgs.length - 1, 0, { role: 'assistant', text: partial }); }
      }
    } finally {
      delete running[id];
      saveChat(id);
      if (current.id === id) renderThread();
      renderList(); updateSendBtn();
    }
  }

  function send() {
    if (running[current.id]) { running[current.id].abort(); return; }
    const text = el.input.value.trim();
    if (!text && !attachments.length) return;
    if (!settings.apiKey) { openSettings('Nhập Anthropic API key để agent bắt đầu làm việc.'); return; }
    const msgs = getChat(current.id);
    // bỏ lỗi cuối nếu có, để lịch sử sạch
    while (msgs.length && msgs[msgs.length - 1].error) msgs.pop();
    msgs.push({ role: 'user', text, images: attachments });
    attachments = [];
    renderAttachments();
    el.input.value = ''; autoGrow();
    runAssistant(current);
  }

  function retry() {
    if (running[current.id]) return;
    if (!settings.apiKey) { openSettings('Nhập Anthropic API key để agent bắt đầu làm việc.'); return; }
    const msgs = getChat(current.id);
    while (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs.pop();
    if (!msgs.length) return;
    runAssistant(current);
  }

  function updateSendBtn() {
    const busy = current && running[current.id];
    el.send.textContent = busy ? 'Dừng' : 'Gửi';
    el.send.classList.toggle('stop', !!busy);
  }

  el.form.addEventListener('submit', e => { e.preventDefault(); send(); });
  el.input.addEventListener('keydown', e => {
    // isComposing: tránh gửi nhầm khi đang gõ tiếng Việt bằng bộ gõ
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      if (matchMedia('(pointer: coarse)').matches) return; // điện thoại: Enter = xuống dòng
      e.preventDefault(); send();
    }
  });
  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 260) + 'px';
  }
  el.input.addEventListener('input', autoGrow);

  $('#clearChat').addEventListener('click', () => {
    if (running[current.id]) running[current.id].abort();
    chats[current.id] = [];
    LS.del(K.chat(current.id));
    renderThread();
    el.input.focus();
  });

  /* ================= Ảnh đính kèm ================= */
  function addFiles(files) {
    for (const f of files) {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) { toast('Chỉ hỗ trợ ảnh PNG, JPG, WEBP, GIF'); continue; }
      if (f.size > MAX_IMG_BYTES) { toast(`Ảnh “${f.name}” lớn hơn 5 MB`); continue; }
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
      `<div class="chip"><img src="${a.url}" alt="Ảnh đính kèm ${i + 1}"><button type="button" data-rm="${i}" aria-label="Bỏ ảnh">✕</button></div>`).join('');
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
  el.desk.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });

  /* ================= Cài đặt ================= */
  const modelList = $('#modelList');
  modelList.innerHTML = MODELS.map(m => `<option value="${m.id}">${esc(m.label)}</option>`).join('');

  function openSettings(note) {
    $('#settingsNote').hidden = !note;
    $('#settingsNote').textContent = note || '';
    $('#apiKey').value = settings.apiKey;
    $('#apiKey').type = 'password'; $('#toggleKey').textContent = 'Hiện';
    $('#model').value = settings.model;
    $('#maxTokens').value = settings.maxTokens;
    el.sDlg.showModal();
    if (!settings.apiKey) $('#apiKey').focus();
  }
  $('#openSettings').addEventListener('click', () => { closeRail(); openSettings(); });
  $('#cancelSettings').addEventListener('click', () => el.sDlg.close());
  $('#toggleKey').addEventListener('click', () => {
    const k = $('#apiKey'); const show = k.type === 'password';
    k.type = show ? 'text' : 'password'; $('#toggleKey').textContent = show ? 'Ẩn' : 'Hiện';
  });
  $('#settingsForm').addEventListener('submit', () => {
    settings.apiKey = $('#apiKey').value.trim();
    settings.model = $('#model').value.trim() || DEFAULT_SETTINGS.model;
    settings.maxTokens = Math.max(256, Math.min(64000, parseInt($('#maxTokens').value, 10) || DEFAULT_SETTINGS.maxTokens));
    LS.set(K.settings, settings);
    toast('Đã lưu cài đặt');
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
      const ids = new Set(store.custom.map(a => a.id));
      data.custom.forEach(a => { if (a && a.id && a.name) { if (ids.has(a.id)) store.custom = store.custom.filter(x => x.id !== a.id); store.custom.push(a); } });
      if (data.overrides && typeof data.overrides === 'object') Object.assign(store.overrides, data.overrides);
      if (Array.isArray(data.pinned)) store.pinned = [...new Set(store.pinned.concat(data.pinned))];
      saveStore(); renderList();
      toast(`Đã nhập ${data.custom.length} agent`);
    } catch { toast('File JSON không đúng định dạng'); }
  });
  $('#wipeAll').addEventListener('click', () => {
    if (!confirm('Xoá API key, mọi lịch sử chat và agent tự tạo trên trình duyệt này?')) return;
    Object.keys(localStorage).filter(k => k.startsWith('pb.')).forEach(k => localStorage.removeItem(k));
    location.reload();
  });

  /* ================= Tạo / sửa agent ================= */
  let editingId = null;
  function openAgentEditor(agent) {
    editingId = agent ? agent.id : null;
    $('#agentDlgTitle').textContent = agent ? 'Sửa agent' : 'Tạo agent';
    $('#fName').value = agent ? agent.name : '';
    $('#fGroup').value = agent ? (agent.group || '') : 'Agent của tôi';
    $('#fIcon').value = agent ? (agent.icon || '') : '🤖';
    $('#fColor').value = agent && /^#[0-9a-f]{6}$/i.test(agent.color || '') ? agent.color : '#3550E8';
    $('#fDesc').value = agent ? (agent.description || '') : '';
    $('#fModel').value = agent ? (agent.model || '') : '';
    $('#fSystem').value = agent ? (agent.system || '') : '';
    $('#fStarters').value = agent ? (agent.starters || []).map(s => s.replace(/\n/g, ' ').trim()).join('\n') : '';
    const groups = [...new Set(allAgents().map(a => a.group).filter(Boolean))];
    $('#groupList').innerHTML = groups.map(g => `<option value="${esc(g)}">`).join('');
    $('#deleteAgent').hidden = !agent;
    $('#deleteAgent').textContent = agent && agent.builtIn ? 'Ẩn agent' : 'Xoá agent';
    $('#resetAgent').hidden = !(agent && agent.builtIn && agent.edited);
    el.aDlg.showModal();
    $('#fName').focus();
  }
  $('#newAgent').addEventListener('click', () => { closeRail(); openAgentEditor(null); });
  $('#editAgent').addEventListener('click', () => openAgentEditor(current));
  $('#cancelAgent').addEventListener('click', () => el.aDlg.close());

  $('#agentForm').addEventListener('submit', () => {
    const data = {
      name: $('#fName').value.trim() || 'Agent mới',
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
    toast(editingId ? 'Đã lưu agent' : 'Đã tạo agent');
    selectAgent(id);
  });

  $('#deleteAgent').addEventListener('click', () => {
    const a = findAgent(editingId); if (!a) return;
    if (!confirm(a.builtIn ? `Ẩn “${a.name}”? Có thể hiện lại bằng cách Xoá toàn bộ dữ liệu hoặc sửa file agents.js.` : `Xoá “${a.name}” và lịch sử chat của nó?`)) return;
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
    toast('Đã khôi phục agent mặc định');
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
  const first = new URLSearchParams(location.search).get('agent') || LS.get(K.last, null);
  if (!allAgents().length) {
    el.thread.innerHTML = '<div class="welcome"><h2>Chưa có agent nào</h2><p>Bấm “Tạo agent” để bắt đầu.</p></div>';
  } else {
    selectAgent(first);
    if (!settings.apiKey) setTimeout(() => openSettings('Chào bạn! Nhập Anthropic API key một lần, các agent sẽ dùng chung key này.'), 300);
  }
})();

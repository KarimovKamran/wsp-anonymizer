'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k);
    return e;
  };

  let me = null;
  let TYPES = {};
  let pollTimer = null;

  async function api(url, opts = {}) {
    const headers = { 'X-Requested-With': 'anonymizer', ...(opts.headers || {}) };
    if (opts.json) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
    const res = await fetch(url, { credentials: 'same-origin', ...opts, headers });
    if (res.status === 401 && url !== '/api/login') { showLogin(); throw new Error('Требуется вход'); }
    if (opts.raw) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
    return data;
  }

  // ---------- Вход ----------
  function showLogin() {
    me = null;
    clearInterval(pollTimer);
    $('#appView').classList.add('hidden');
    $('#who').classList.add('hidden');
    $('#loginView').classList.remove('hidden');
  }

  async function showApp() {
    $('#loginView').classList.add('hidden');
    $('#appView').classList.remove('hidden');
    $('#who').classList.remove('hidden');
    $('#whoName').textContent = me.displayName || me.username;
    $('#auditTabBtn').classList.toggle('hidden', !me.isAdmin);
    $('#dictTabBtn').classList.toggle('hidden', !me.isAdmin);
    $('#allLabel').classList.toggle('hidden', !me.isAdmin);
    refreshHealth();
    refreshJobs();
    clearInterval(pollTimer);
    pollTimer = setInterval(refreshJobs, 3000);
  }

  $('#loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('#loginError').textContent = '';
    const f = new FormData(ev.target);
    try {
      await api('/api/login', { method: 'POST', json: { username: f.get('username'), password: f.get('password') } });
      ev.target.reset();
      await init();
    } catch (e) { $('#loginError').textContent = e.message; }
  });

  $('#logoutBtn').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); showLogin(); });

  // ---------- Вкладки ----------
  $$('.tabs button[data-tab]').forEach((b) => b.addEventListener('click', () => {
    $$('.tabs button[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
    $$('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== `tab-${b.dataset.tab}`));
    if (b.dataset.tab === 'history') refreshJobs();
    if (b.dataset.tab === 'audit') loadAudit();
    if (b.dataset.tab === 'dict') loadDict();
  }));

  async function refreshHealth() {
    try {
      const h = await api('/api/health');
      const ok = h.llm.ok && h.tools.pdftotext && h.tools.tesseract;
      const q = h.queue.queued + h.queue.running;
      $('#health').replaceChildren(
        el('span', { class: `dot ${ok ? 'ok' : 'bad'}` }),
        `Модель: ${h.llm.model || '—'}${h.llm.ok ? '' : ' (недоступна)'} · в очереди: ${q}`,
      );
      $('#health').title = [h.llm.error, !h.tools.tesseract && 'tesseract/языки OCR не найдены'].filter(Boolean).join('\n');
    } catch { /* noop */ }
  }

  // ---------- Загрузка ----------
  function setupDrop(zone, input, onFile) {
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault(); zone.classList.remove('over');
      if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
    });
    input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); input.value = ''; });
  }

  async function uploadFile(file) {
    $('#uploadError').textContent = '';
    const fd = new FormData();
    fd.append('file', file, file.name);
    try {
      await api('/api/jobs', { method: 'POST', body: fd });
      refreshJobs();
    } catch (e) { $('#uploadError').textContent = e.message; }
  }
  setupDrop($('#drop'), $('#fileInput'), uploadFile);

  $('#pasteBtn').addEventListener('click', () => {
    const t = $('#pasteText').value.trim();
    if (!t) return;
    const name = `текст_${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.txt`;
    uploadFile(new File([t], name, { type: 'text/plain' }));
    $('#pasteText').value = '';
  });

  // ---------- Задания ----------
  const STATUS = { queued: 'в очереди', processing: 'обработка', done: 'готово', error: 'ошибка' };
  const fmtDate = (s) => (s ? new Date(`${s.replace(' ', 'T')}Z`).toLocaleString('ru-RU') : '');

  function jobCard(j) {
    const chips = j.stats && j.stats.byType
      ? el('div', { class: 'chips' }, Object.entries(j.stats.byType).map(([t, n]) => el('span', { class: 'chip', title: TYPES[t] || t }, `${TYPES[t] || t}: ${n}`)))
      : null;
    let info = '';
    if (j.status === 'queued') info = `позиция в очереди: ${j.queuePosition}`;
    else if (j.status === 'processing') info = j.progress || '';
    else if (j.status === 'error') info = j.error;
    else if (j.stats) {
      const src = j.stats.bySource || {};
      const parts = [`замен: ${j.stats.total}`, `сущностей: ${j.stats.uniqueEntities}`];
      if (src.dict) parts.push(`из словаря: ${src.dict}`);
      if (src.llm) parts.push(`новых от модели: ${src.llm}`);
      if (j.stats.ocr) parts.push('OCR');
      if (!j.stats.llm) parts.push('без LLM');
      info = parts.join(', ');
    }

    const actions = el('div', { class: 'actions' });
    if (j.status === 'done' && j.hasResult) actions.append(el('button', { class: 'primary', onclick: () => download(j) }, 'Скачать'));
    if (j.status === 'done' && !j.hasResult) actions.append(el('span', { class: 'muted' }, 'файл удалён по сроку'));
    if (j.status === 'done') actions.append(el('button', { onclick: () => showEntities(j) }, 'Таблица замен'));
    if (j.status !== 'processing') actions.append(el('button', { class: 'danger', onclick: () => delJob(j) }, 'Удалить'));

    return el('div', { class: 'job' },
      el('div', { class: 'name' }, j.name, el('span', { class: `badge ${j.status}` }, STATUS[j.status] || j.status)),
      actions,
      el('div', { class: 'meta' }, `${fmtDate(j.createdAt)}${me.isAdmin && j.user ? ` · ${j.user}` : ''}${info ? ` · ${info}` : ''}`, chips));
  }

  async function refreshJobs() {
    if (!me) return;
    try {
      const all = $('#showAll').checked ? '?all=1' : '';
      const { jobs } = await api(`/api/jobs${all}`);
      const recent = jobs.filter((j) => j.status === 'queued' || j.status === 'processing'
        || (Date.now() - new Date(`${j.createdAt.replace(' ', 'T')}Z`).getTime() < 3600e3));
      $('#activeJobs').replaceChildren(...(recent.length ? recent.map(jobCard) : [el('div', { class: 'empty' }, 'Нет заданий за последний час')]));
      $('#historyJobs').replaceChildren(...(jobs.length ? jobs.map(jobCard) : [el('div', { class: 'empty' }, 'Пусто')]));
    } catch { /* noop */ }
  }
  $('#showAll').addEventListener('change', refreshJobs);
  setInterval(refreshHealth, 30000);

  async function saveResponse(res, fallbackName) {
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i);
    const name = m ? decodeURIComponent(m[1]) : fallbackName;
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async function download(j) {
    const res = await api(`/api/jobs/${j.id}/download`, { raw: true });
    if (!res.ok) { alertMsg((await res.json().catch(() => ({}))).error || 'Ошибка'); return; }
    saveResponse(res, j.resultName);
  }

  async function delJob(j) {
    if (!confirm(`Удалить «${j.name}»?\nТаблица замен будет удалена — деанонимизировать этот документ станет невозможно.`)) return;
    try { await api(`/api/jobs/${j.id}`, { method: 'DELETE' }); refreshJobs(); } catch (e) { alertMsg(e.message); }
  }

  const alertMsg = (m) => window.alert(m);

  const SOURCES = { llm: 'модель', regex: 'шаблон', dict: 'словарь' };

  // ---------- Таблица замен ----------
  let entRows = [];
  async function showEntities(j) {
    try {
      const { entities } = await api(`/api/jobs/${j.id}/entities`);
      entRows = entities;
      $('#entFilter').value = '';
      renderEntities();
      $('#entitiesDlg').showModal();
    } catch (e) { alertMsg(e.message); }
  }
  function renderEntities() {
    const f = $('#entFilter').value.toLowerCase();
    const rows = entRows.filter((r) => !f || `${r.token} ${r.typeName} ${r.value}`.toLowerCase().includes(f));
    $('#entTable tbody').replaceChildren(...rows.map((r) => el('tr', {},
      el('td', { class: 'mono' }, r.token), el('td', {}, r.typeName), el('td', {}, r.value), el('td', { class: 'muted' }, SOURCES[r.source] || r.source))));
  }
  $('#entFilter').addEventListener('input', renderEntities);
  $('#closeDlg').addEventListener('click', () => $('#entitiesDlg').close());

  // ---------- Деанонимизация ----------
  function reportView(r) {
    return el('div', { class: 'report' },
      `Восстановлено значений: ${r.replaced}.`,
      r.unknown.length ? el('div', { class: 'warn' }, `Неизвестные токены (${r.unknown.length}): ${r.unknown.slice(0, 20).join(', ')}${r.unknown.length > 20 ? '…' : ''}`) : null,
      r.forbidden ? el('div', { class: 'warn' }, `Токенов из чужих заданий (не восстановлены): ${r.forbidden}`) : null);
  }

  setupDrop($('#deanonDrop'), $('#deanonFile'), async (file) => {
    $('#deanonFileReport').replaceChildren(el('div', { class: 'muted' }, 'Обработка…'));
    const fd = new FormData();
    fd.append('file', file, file.name);
    try {
      const res = await api('/api/deanonymize', { method: 'POST', body: fd, raw: true });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Ошибка');
      const rep = JSON.parse(decodeURIComponent(res.headers.get('X-Deanon-Report') || '%7B%7D'));
      $('#deanonFileReport').replaceChildren(reportView(rep));
      await saveResponse(res, `restored_${file.name}`);
    } catch (e) { $('#deanonFileReport').replaceChildren(el('div', { class: 'error' }, e.message)); }
  });

  $('#deanonTextBtn').addEventListener('click', async () => {
    const text = $('#deanonText').value;
    if (!text.trim()) return;
    try {
      const r = await api('/api/deanonymize/text', { method: 'POST', json: { text } });
      $('#deanonTextReport').replaceChildren(reportView(r.report));
      $('#deanonTextOut').value = r.text;
      $('#deanonTextOut').classList.remove('hidden');
      $('#copyOut').classList.remove('hidden');
    } catch (e) { $('#deanonTextReport').replaceChildren(el('div', { class: 'error' }, e.message)); }
  });
  $('#copyOut').addEventListener('click', () => navigator.clipboard.writeText($('#deanonTextOut').value));

  // ---------- Словарь ----------
  let dictRows = [];
  async function loadDict() {
    try {
      const d = await api('/api/admin/dictionary');
      dictRows = d.items;
      renderDict();
    } catch (e) { alertMsg(e.message); }
  }
  function renderDict() {
    const f = $('#dictFilter').value.toLowerCase();
    const onlyOff = $('#dictOnlyOff').checked;
    const rows = dictRows.filter((r) => (!onlyOff || !r.enabled)
      && (!f || `${r.value} ${r.canonical} ${TYPES[r.type] || r.type}`.toLowerCase().includes(f)));
    $('#dictCount').textContent = `${dictRows.length} записей, отключено ${dictRows.filter((r) => !r.enabled).length}`;
    $('#dictTable tbody').replaceChildren(...rows.slice(0, 1000).map((r) => el('tr', { class: r.enabled ? '' : 'off' },
      el('td', {}, TYPES[r.type] || r.type), el('td', {}, r.value), el('td', { class: 'muted' }, r.canonical),
      el('td', {}, String(r.hits)), el('td', { class: 'muted' }, fmtDate(r.lastSeen)),
      el('td', {},
        el('button', { onclick: () => toggleDict(r) }, r.enabled ? 'Отключить' : 'Включить'), ' ',
        el('button', { class: 'danger', onclick: () => delDict(r) }, 'Удалить')))));
  }
  async function toggleDict(r) {
    try { await api(`/api/admin/dictionary/${r.id}`, { method: 'PATCH', json: { enabled: !r.enabled } }); r.enabled = !r.enabled; renderDict(); } catch (e) { alertMsg(e.message); }
  }
  async function delDict(r) {
    if (!confirm(`Удалить «${r.value}» из словаря?\nЕсли модель найдёт его снова, он вернётся. Чтобы запретить замену — используйте «Отключить».`)) return;
    try { await api(`/api/admin/dictionary/${r.id}`, { method: 'DELETE' }); dictRows = dictRows.filter((x) => x !== r); renderDict(); } catch (e) { alertMsg(e.message); }
  }
  $('#dictFilter').addEventListener('input', renderDict);
  $('#dictOnlyOff').addEventListener('change', renderDict);

  // ---------- Журнал ----------
  const ACTIONS = { login: 'вход', login_fail: 'неудачный вход', logout: 'выход', upload: 'загрузка', download: 'скачивание', view_entities: 'просмотр таблицы замен', deanonymize: 'деанонимизация файла', deanonymize_text: 'деанонимизация текста', delete: 'удаление', view_dictionary: 'просмотр словаря', dictionary_enable: 'словарь: включено', dictionary_disable: 'словарь: отключено', dictionary_delete: 'словарь: удалено' };
  async function loadAudit() {
    const { audit } = await api('/api/admin/audit');
    $('#auditTable tbody').replaceChildren(...audit.map((a) => el('tr', {},
      el('td', {}, a.ts), el('td', {}, a.username || ''), el('td', {}, ACTIONS[a.action] || a.action),
      el('td', { class: 'mono' }, a.job_id ? a.job_id.slice(0, 8) : ''), el('td', {}, a.ip || ''), el('td', { class: 'muted' }, a.details || ''))));
  }

  async function init() {
    try {
      const r = await fetch('/api/me', { credentials: 'same-origin' });
      if (!r.ok) {
        if (r.status === 403) { document.body.replaceChildren(el('main', { class: 'center' }, el('div', { class: 'card' }, el('h1', {}, 'Доступ запрещён'), el('p', {}, 'Нужен действительный клиентский сертификат WSP.')))); return; }
        showLogin(); return;
      }
      const d = await r.json();
      me = d.user; TYPES = d.types; $('#maxMb').textContent = d.maxUploadMb;
      showApp();
    } catch { showLogin(); }
  }
  init();
})();

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const multer = require('multer');

const { config, validate } = require('./config');

const errors = validate();
if (errors.length) {
  console.error('Ошибки конфигурации:\n - ' + errors.join('\n - '));
  process.exit(1);
}

const { db, audit } = require('./db');
const { decrypt } = require('./crypto');
const { SqliteStore } = require('./sessionStore');
const { authenticate } = require('./auth/ldap');
const mw = require('./auth/middleware');
const queue = require('./queue');
const llm = require('./engine/llm');
const { detectType, toolsHealth } = require('./engine/extract');
const { deanonymizeFile, deanonymizeText } = require('./engine/deanonymize');
const dictionary = require('./engine/dictionary');
const { TYPES } = require('./engine/types');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

app.use(helmet({
  contentSecurityPolicy: { directives: { 'default-src': ["'self'"], 'img-src': ["'self'", 'data:'], 'style-src': ["'self'"] } },
  hsts: false, // HSTS выставляет nginx
}));

// Всё приложение — только для клиентов с валидным сертификатом
app.use(mw.requireClientCert);

app.use(session({
  name: 'anon.sid',
  secret: config.sessionSecret,
  store: new SqliteStore(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.env === 'production',
    maxAge: config.sessionHours * 3600 * 1000,
  },
}));

app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));
app.use('/api', express.json({ limit: '5mb' }), mw.csrfHeader);

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- Аутентификация ----------
const upsertUser = db.prepare(`INSERT INTO users (username, display_name, email, is_admin, last_login)
  VALUES (@username, @displayName, @email, @isAdmin, datetime('now'))
  ON CONFLICT(username) DO UPDATE SET display_name = excluded.display_name, email = excluded.email,
    is_admin = excluded.is_admin, last_login = excluded.last_login`);
const getUser = db.prepare('SELECT id, username, display_name, email, is_admin FROM users WHERE username = ?');

app.post('/api/login', ah(async (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const lim = mw.loginLimiter(`${req.ip}|${String(username).toLowerCase()}`);
  if (lim.blocked()) return res.status(429).json({ error: 'Слишком много попыток. Повторите через 15 минут.' });
  let info;
  try {
    info = await authenticate(username, password);
  } catch (e) {
    if (e.code !== 'LDAP') lim.fail();
    audit(req, 'login_fail', null, { username: String(username).slice(0, 64), reason: e.code });
    const status = e.code === 'FORBIDDEN' ? 403 : e.code === 'LDAP' ? 502 : 401;
    return res.status(status).json({ error: e.code === 'LDAP' ? 'Сервер каталога недоступен' : e.message });
  }
  if (!mw.certMatchesUser(req.clientCert, info)) {
    audit(req, 'login_fail', null, { username: info.username, reason: 'CERT_MISMATCH', cert: req.clientCert && req.clientCert.dn });
    return res.status(403).json({ error: 'Сертификат выдан другому пользователю' });
  }
  lim.reset();
  upsertUser.run({ ...info, isAdmin: info.isAdmin ? 1 : 0 });
  const user = getUser.get(info.username);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Ошибка сессии' });
    req.session.user = user;
    req.session.certSerial = req.clientCert ? req.clientCert.serial : null;
    audit(req, 'login', null, { cert: req.clientCert && req.clientCert.dn });
    return res.json({ user: publicUser(user) });
  });
}));

app.post('/api/logout', (req, res) => {
  audit(req, 'logout');
  req.session.destroy(() => res.json({ ok: true }));
});

const publicUser = (u) => ({ username: u.username, displayName: u.display_name, isAdmin: !!u.is_admin });

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Требуется вход' });
  return res.json({ user: publicUser(req.session.user), types: TYPES, maxUploadMb: config.maxUploadMb });
});

app.get('/api/health', ah(async (req, res) => {
  const [l, tools] = await Promise.all([config.llm.enabled ? llm.health() : { ok: true, model: 'отключена' }, toolsHealth()]);
  const queued = db.prepare("SELECT COUNT(*) n FROM jobs WHERE status = 'queued'").get().n;
  res.json({ llm: l, tools, queue: { queued, running: queue.stats().running } });
}));

// ---------- Задания ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (req, file, cb) => { req.jobId = crypto.randomUUID(); cb(null, req.jobId); },
  }),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  defParamCharset: 'utf8',
  fileFilter: (req, file, cb) => cb(null, !!detectType(file.originalname, file.mimetype)),
});

const jobCols = 'j.id, j.original_name, j.input_type, j.status, j.progress, j.error, j.stats, j.model, j.result_name, j.result_path IS NOT NULL AS has_result, j.created_at, j.started_at, j.finished_at, u.username';
const getJob = db.prepare(`SELECT ${jobCols}, j.user_id, j.result_path FROM jobs j JOIN users u ON u.id = j.user_id WHERE j.id = ?`);

function jobView(j) {
  return {
    id: j.id,
    name: j.original_name,
    type: j.input_type,
    status: j.status,
    progress: j.progress,
    error: j.error,
    stats: j.stats ? JSON.parse(j.stats) : null,
    model: j.model,
    resultName: j.result_name,
    hasResult: !!j.has_result,
    createdAt: j.created_at,
    finishedAt: j.finished_at,
    user: j.username,
    queuePosition: j.status === 'queued' ? queue.queuePosition(j.id) : null,
  };
}

function loadOwnJob(req, res) {
  const j = getJob.get(req.params.id);
  if (!j || (j.user_id !== req.session.user.id && !req.session.user.is_admin)) {
    res.status(404).json({ error: 'Задание не найдено' });
    return null;
  }
  return j;
}

app.post('/api/jobs', mw.requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Поддерживаются DOCX, PDF, TXT, PNG/JPG/TIFF' });
  const type = detectType(req.file.originalname, req.file.mimetype);
  const name = path.basename(req.file.originalname).slice(0, 200);
  db.prepare("INSERT INTO jobs (id, user_id, original_name, input_type, status) VALUES (?, ?, ?, ?, 'queued')")
    .run(req.jobId, req.session.user.id, name, type);
  audit(req, 'upload', req.jobId, { name, size: req.file.size, type });
  queue.pump();
  res.status(201).json({ job: jobView(getJob.get(req.jobId)) });
});

app.get('/api/jobs', mw.requireAuth, (req, res) => {
  const all = req.query.all === '1' && req.session.user.is_admin;
  const rows = db.prepare(`SELECT ${jobCols} FROM jobs j JOIN users u ON u.id = j.user_id
    ${all ? '' : 'WHERE j.user_id = ?'} ORDER BY j.created_at DESC, j.rowid DESC LIMIT 200`)
    .all(...(all ? [] : [req.session.user.id]));
  res.json({ jobs: rows.map(jobView) });
});

app.get('/api/jobs/:id', mw.requireAuth, (req, res) => {
  const j = loadOwnJob(req, res);
  if (j) res.json({ job: jobView(j) });
});

app.get('/api/jobs/:id/download', mw.requireAuth, (req, res) => {
  const j = loadOwnJob(req, res);
  if (!j) return;
  if (j.status !== 'done' || !j.result_path || !fs.existsSync(j.result_path)) return res.status(410).json({ error: 'Файл результата недоступен' });
  audit(req, 'download', j.id);
  res.download(j.result_path, j.result_name);
});

app.get('/api/jobs/:id/entities', mw.requireAuth, (req, res) => {
  const j = loadOwnJob(req, res);
  if (!j) return;
  const rows = db.prepare('SELECT token, group_id, type, value_enc, source FROM entities WHERE job_id = ? ORDER BY type, group_id, id').all(j.id);
  audit(req, 'view_entities', j.id, { count: rows.length });
  res.json({
    entities: rows.map((r) => ({ token: r.token, group: r.group_id, type: r.type, typeName: TYPES[r.type] || r.type, value: decrypt(r.value_enc), source: r.source })),
  });
});

app.delete('/api/jobs/:id', mw.requireAuth, (req, res) => {
  const j = loadOwnJob(req, res);
  if (!j) return;
  if (j.status === 'processing') return res.status(409).json({ error: 'Задание обрабатывается' });
  if (j.result_path) fs.rmSync(j.result_path, { force: true });
  fs.rmSync(queue.uploadPath(j), { force: true });
  db.prepare('DELETE FROM jobs WHERE id = ?').run(j.id); // entities удалятся каскадом
  audit(req, 'delete', j.id, { name: j.original_name });
  res.json({ ok: true });
});

// ---------- Деанонимизация ----------
const deanonUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 }, defParamCharset: 'utf8' });

app.post('/api/deanonymize', mw.requireAuth, deanonUpload.single('file'), ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не передан' });
  const type = detectType(req.file.originalname, req.file.mimetype);
  if (!['docx', 'pdf', 'txt'].includes(type)) return res.status(400).json({ error: 'Поддерживаются DOCX, PDF, TXT' });
  // PDF/TXT читаются утилитами с диска — кладём во временный файл
  const tmp = path.join(config.uploadDir, `deanon-${crypto.randomUUID()}`);
  fs.writeFileSync(tmp, req.file.buffer, { mode: 0o600 });
  try {
    const r = await deanonymizeFile(type, req.file.buffer, tmp, req.session.user);
    audit(req, 'deanonymize', null, { name: req.file.originalname, ...r.report, unknown: r.report.unknown.length });
    const base = path.basename(req.file.originalname, path.extname(req.file.originalname)).replace(/_anon$/, '');
    res.setHeader('X-Deanon-Report', encodeURIComponent(JSON.stringify(r.report)));
    res.attachment(`${base}_restored${r.ext}`);
    res.send(r.buffer);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}));

app.post('/api/deanonymize/text', mw.requireAuth, (req, res) => {
  const text = (req.body && req.body.text) || '';
  if (!text) return res.status(400).json({ error: 'Пустой текст' });
  const r = deanonymizeText(text, req.session.user);
  audit(req, 'deanonymize_text', null, { ...r.report, unknown: r.report.unknown.length, chars: text.length });
  res.json(r);
});

// ---------- Админ ----------
app.get('/api/admin/audit', mw.requireAuth, mw.requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 300, 2000);
  res.json({ audit: db.prepare('SELECT ts, username, action, job_id, ip, details FROM audit ORDER BY id DESC LIMIT ?').all(limit) });
});

app.get('/api/admin/dictionary', mw.requireAuth, mw.requireAdmin, (req, res) => {
  const items = dictionary.list();
  audit(req, 'view_dictionary', null, { count: items.length });
  res.json({ items, types: TYPES });
});

app.patch('/api/admin/dictionary/:id', mw.requireAuth, mw.requireAdmin, (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  if (!dictionary.setEnabled(Number(req.params.id), enabled)) return res.status(404).json({ error: 'Не найдено' });
  audit(req, enabled ? 'dictionary_enable' : 'dictionary_disable', null, { id: Number(req.params.id) });
  res.json({ ok: true });
});

app.delete('/api/admin/dictionary/:id', mw.requireAuth, mw.requireAdmin, (req, res) => {
  if (!dictionary.remove(Number(req.params.id))) return res.status(404).json({ error: 'Не найдено' });
  audit(req, 'dictionary_delete', null, { id: Number(req.params.id) });
  res.json({ ok: true });
});

// ---------- Ошибки ----------
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Файл больше ${config.maxUploadMb} МБ` : err.message });
  }
  console.error(err);
  return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// ---------- Очистка по срокам хранения ----------
function cleanup() {
  const old = db.prepare(`SELECT id, result_path FROM jobs WHERE result_path IS NOT NULL
    AND finished_at < datetime('now', ?)`).all(`-${config.resultTtlHours} hours`);
  for (const j of old) {
    fs.rmSync(j.result_path, { force: true });
    db.prepare('UPDATE jobs SET result_path = NULL WHERE id = ?').run(j.id);
  }
  if (config.mappingTtlDays > 0) {
    const r = db.prepare(`DELETE FROM entities WHERE job_id IN (SELECT id FROM jobs WHERE created_at < datetime('now', ?))`)
      .run(`-${config.mappingTtlDays} days`);
    if (r.changes) console.log(`cleanup: удалено ${r.changes} записей соответствий`);
    const d = dictionary.purge(config.mappingTtlDays);
    if (d) console.log(`cleanup: удалено ${d} записей словаря`);
  }
  db.prepare("DELETE FROM audit WHERE ts < datetime('now', '-3 years')").run();
}

if (require.main === module) {
  queue.init();
  cleanup();
  setInterval(cleanup, 3600 * 1000).unref();
  app.listen(config.port, config.host, () => {
    console.log(`WSP Anonymizer: http://${config.host}:${config.port} (auth=${config.authMode}, llm=${config.llm.enabled ? config.llm.model : 'off'})`);
  });
}

module.exports = { app };

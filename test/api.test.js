'use strict';
// Интеграционный тест API: dev-аутентификация, mock-Ollama, полный цикл анонимизация -> деанонимизация.
const os = require('os');
const fs = require('fs');
const path = require('path');

Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'anon-api-')),
  MASTER_KEY: Buffer.alloc(32, 9).toString('base64'),
  SESSION_SECRET: 'x'.repeat(40),
  AUTH_MODE: 'dev',
  DEV_USERS: 'alice:pw,bob:pw,boss:pw:admin',
  OLLAMA_URL: 'http://127.0.0.1:11436',
  REQUIRE_CLIENT_CERT: 'true',
  CERT_USER_MATCH: 'cn',
});

const test = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('child_process');

const { app } = require('../src/server');
const queue = require('../src/queue');
const { parseDn } = require('../src/auth/middleware');

let server; let base; let mock;
const MOCK_LOG = path.join(process.env.DATA_DIR, 'mock.log');
test.before(async () => {
  mock = spawn(process.execPath, [path.join(__dirname, 'mock-ollama.js'), '11436'], {
    stdio: 'ignore', env: { ...process.env, MOCK_LOG: MOCK_LOG },
  });
  await new Promise((r) => setTimeout(r, 400));
  queue.init();
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); mock.kill(); setTimeout(() => process.exit(0), 100); });

function client(cn, serial = '0A') {
  let cookie = '';
  const headers = () => ({
    'X-SSL-Client-Verify': 'SUCCESS',
    'X-SSL-Client-S-DN': `O=White Square Partners,CN=${cn}`,
    'X-SSL-Client-Serial': serial,
    'X-Requested-With': 'anonymizer',
    ...(cookie ? { Cookie: cookie } : {}),
  });
  const call = async (url, opts = {}) => {
    const h = { ...headers(), ...(opts.headers || {}) };
    let { body } = opts;
    if (opts.json) { h['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
    const res = await fetch(base + url, { method: opts.method || 'GET', headers: h, body });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return res;
  };
  return {
    call,
    login: (u) => call('/api/login', { method: 'POST', json: { username: u, password: 'pw' } }),
    json: async (url, opts) => (await call(url, opts)).json(),
  };
}

async function waitJob(c, id) {
  for (let i = 0; i < 100; i++) {
    const { job } = await c.json(`/api/jobs/${id}`);
    if (job.status === 'done' || job.status === 'error') return job;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timeout');
}

test('разбор DN сертификата', () => {
  assert.deepEqual(parseDn('emailAddress=a@b.ru,CN=ivanov,O=White Square Partners'), { EMAILADDRESS: 'a@b.ru', CN: 'ivanov', O: 'White Square Partners' });
});

test('сертификат другого пользователя — вход запрещён', async () => {
  const r = await client('bob').login('alice');
  assert.equal(r.status, 403);
});

test('полный цикл + изоляция пользователей', async () => {
  const alice = client('alice');
  assert.equal((await alice.login('alice')).status, 200);

  const fixture = path.join(__dirname, 'fixtures', 'contract.docx');
  if (!fs.existsSync(fixture)) execFileSync('python3', [path.join(__dirname, 'make_fixtures.py'), fixture]);
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(fixture)]), 'Договор.docx');
  const up = await alice.call('/api/jobs', { method: 'POST', body: fd });
  assert.equal(up.status, 201);
  const { job } = await up.json();
  const done = await waitJob(alice, job.id);
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.resultName, 'Договор_anon.docx');

  const { entities } = await alice.json(`/api/jobs/${job.id}/entities`);
  const per = entities.find((e) => e.type === 'PER');
  const text = `Итог: ${per.token} и [ORG-ZZZZZZ]`;

  const r1 = await alice.json('/api/deanonymize/text', { method: 'POST', json: { text } });
  assert.equal(r1.report.replaced, 1);
  assert.deepEqual(r1.report.unknown, ['[ORG-ZZZZZZ]']);
  assert.ok(r1.text.includes(per.value));

  // Боб не видит задание Алисы и не может восстановить её токены
  const bob = client('bob');
  await bob.login('bob');
  assert.equal((await bob.call(`/api/jobs/${job.id}/entities`)).status, 404);
  assert.equal((await bob.call(`/api/jobs/${job.id}/download`)).status, 404);
  const r2 = await bob.json('/api/deanonymize/text', { method: 'POST', json: { text } });
  assert.equal(r2.report.replaced, 0);
  assert.equal(r2.report.forbidden, 1);

  // Админ может
  const boss = client('boss');
  await boss.login('boss');
  const r3 = await boss.json('/api/deanonymize/text', { method: 'POST', json: { text } });
  assert.equal(r3.report.replaced, 1);
  const { audit } = await boss.json('/api/admin/audit');
  assert.ok(audit.some((a) => a.action === 'deanonymize_text' && a.username === 'bob'));
  assert.equal((await alice.call('/api/admin/audit')).status, 403);

  // Удаление стирает и таблицу замен
  assert.equal((await alice.call(`/api/jobs/${job.id}`, { method: 'DELETE' })).status, 200);
  const r4 = await alice.json('/api/deanonymize/text', { method: 'POST', json: { text } });
  assert.equal(r4.report.replaced, 0);
});

async function uploadText(c, name, text) {
  const fd = new FormData();
  fd.append('file', new Blob([text]), name);
  const { job } = await (await c.call('/api/jobs', { method: 'POST', body: fd })).json();
  return waitJob(c, job.id);
}

test('словарь: известные сущности находятся до LLM и маскируются в тексте для модели', async () => {
  const alice = client('alice');
  await alice.login('alice');
  // 1-й документ — модель находит сущности, они попадают в словарь
  const j1 = await uploadText(alice, 'one.txt', 'Договор между ООО «Ромашка» и АО «Альфа» в лице Иванова Ивана Ивановича.');
  assert.equal(j1.status, 'done', j1.error);

  // 2-й документ — те же сущности должны найтись словарём, а в модель уйти уже скрытыми
  fs.writeFileSync(MOCK_LOG, '');
  const j2 = await uploadText(alice, 'two.txt', 'Акт к договору. ООО «Ромашка», директор Иванова Ивана Ивановича. Адрес: 101000, г. Москва, ул. Мясницкая, д. 1');
  assert.equal(j2.status, 'done', j2.error);
  const sent = fs.readFileSync(MOCK_LOG, 'utf8');
  assert.ok(!sent.includes('Ромашка') && !sent.includes('Иванова'), `в LLM ушли известные значения: ${sent}`);
  assert.ok(sent.includes('[ORG]') && sent.includes('[PER]'), sent);
  assert.ok(sent.includes('Мясницкая'), 'новое (адрес) модель всё ещё видит');
  assert.ok(j2.stats.bySource.dict >= 2, JSON.stringify(j2.stats));
  assert.equal(j2.stats.bySource.llm, 1, 'модель нашла только новый адрес');

  const { entities } = await alice.json(`/api/jobs/${j2.id}/entities`);
  assert.ok(entities.some((e) => e.source === 'dict' && e.value === 'ООО «Ромашка»'));

  // Админ отключает ложное срабатывание — оно больше не заменяется, даже если модель найдёт снова
  const boss = client('boss');
  await boss.login('boss');
  const { items } = await boss.json('/api/admin/dictionary');
  const alfa = items.find((i) => i.value === 'АО «Альфа»');
  assert.ok(alfa);
  assert.equal((await boss.call(`/api/admin/dictionary/${alfa.id}`, { method: 'PATCH', json: { enabled: false } })).status, 200);
  const j3 = await uploadText(alice, 'three.txt', 'Поставщик АО «Альфа» и ООО «Ромашка».');
  const { entities: e3 } = await alice.json(`/api/jobs/${j3.id}/entities`);
  assert.ok(!e3.some((e) => e.value === 'АО «Альфа»'), 'отключённое значение не заменено');
  assert.ok(e3.some((e) => e.value === 'ООО «Ромашка»'));
  assert.equal((await alice.call('/api/admin/dictionary')).status, 403);
});

test('без заголовка mTLS — 403, без CSRF-заголовка — 403', async () => {
  assert.equal((await fetch(`${base}/api/me`)).status, 403);
  const r = await fetch(`${base}/api/logout`, { method: 'POST', headers: { 'X-SSL-Client-Verify': 'SUCCESS' } });
  assert.equal(r.status, 403);
});

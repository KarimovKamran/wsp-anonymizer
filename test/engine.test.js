'use strict';
// Запуск: node --test test/  (поднимает mock-Ollama сам)
process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'anon-test-'));
process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.OLLAMA_URL = 'http://127.0.0.1:11435';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const JSZip = require('jszip');

const { detectRegex } = require('../src/engine/detectors');
const { anonymizeSegments, applySpans } = require('../src/engine/anonymizer');
const { transformDocx } = require('../src/engine/docx');

let mock;
test.before(async () => {
  mock = spawn(process.execPath, [path.join(__dirname, 'mock-ollama.js'), '11435'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 400));
});
test.after(() => mock.kill());

test('регулярки находят реквизиты с проверкой контрольных сумм', () => {
  const found = detectRegex('ИНН 7707083893, ИНН 1234567890, р/с 40702810400000012345, БИК 044525225, ОГРН 1027700132195, карта 4276 3800 1234 5679, тел. 8 (916) 123-45-67, СНИЛС 112-233-445 95');
  const types = found.map((f) => `${f.type}:${f.text}`);
  assert.ok(types.includes('INN:7707083893'));
  assert.ok(types.includes('INN:1234567890'), 'ИНН с ключевым словом ловится даже без валидной КС');
  assert.ok(types.includes('ACC:40702810400000012345'));
  assert.ok(types.includes('BIK:044525225'));
  assert.ok(types.includes('OGRN:1027700132195'));
  assert.ok(types.includes('CARD:4276 3800 1234 5679'));
  assert.ok(types.some((t) => t.startsWith('PHONE:')));
  assert.ok(types.some((t) => t.startsWith('SNILS:')));
  // без ключевого слова невалидный ИНН не трогаем
  assert.equal(detectRegex('Сумма 1234567890 рублей').filter((f) => f.type === 'INN').length, 0);
});

test('LLM + регулярки: одинаковые сущности -> один токен, падежи -> одна группа', async () => {
  const segs = [
    'Между ООО «Ромашка» в лице Иванова Ивана Ивановича и Заказчиком.',
    'Подпись: Иванов И.И., ООО «РОМАШКА», ИНН 7707083893.',
    'Директор Иванов Иван Иванович. Ещё раз ИНН 7707083893.',
  ];
  const { spans, registry } = await anonymizeSegments(segs, { useLlm: true });
  const out = segs.map((s, i) => applySpans(s, spans[i]));
  const joined = out.join('\n');
  assert.ok(!/Ромашк|РОМАШК|Иванов|7707083893/.test(joined), joined);
  assert.ok(/Заказчиком/.test(joined), 'стоп-слова не трогаем');
  const inn = registry.entities.filter((e) => e.type === 'INN');
  assert.equal(inn.length, 1, 'один ИНН — один токен');
  const per = registry.entities.filter((e) => e.type === 'PER');
  assert.equal(new Set(per.map((e) => e.groupId)).size, 1, 'все формы ФИО в одной группе');
  assert.ok(!registry.entities.some((e) => e.value.includes('Галлюцинация')));
});

test('DOCX: сущность, разбитая на run-ы, заменяется; форматирование и метаданные', async () => {
  const fixture = path.join(__dirname, 'fixtures', 'contract.docx');
  if (!fs.existsSync(fixture)) execFileSync('python3', [path.join(__dirname, 'make_fixtures.py'), fixture]);
  let reg;
  const { buffer, segments } = await transformDocx(fs.readFileSync(fixture), async (segs) => {
    const r = await anonymizeSegments(segs, { useLlm: true });
    reg = r.registry;
    return r.spans;
  }, { sanitize: true });
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml').async('string');
  const header = await zip.file('word/header1.xml').async('string');
  const core = await zip.file('docProps/core.xml').async('string');
  const text = xml.replace(/<[^>]+>/g, '');
  for (const s of ['Ромашка', 'Ромаш', 'Иванов', 'Сидоров', '7707083893', '40702810400000012345', 'Тверская', '123456', '4276', 'ivanov@', '15/2024']) {
    assert.ok(!text.includes(s), `в документе остался фрагмент «${s}»`);
  }
  assert.ok(!header.includes('Ромашка'), 'колонтитул анонимизирован');
  assert.ok(!core.includes('Петров'), 'автор удалён из метаданных');
  assert.ok(/<w:b\/>/.test(xml), 'жирный шрифт сохранён');
  assert.ok(segments.length > 5);
  assert.ok(reg.entities.length >= 12, `найдено ${reg.entities.length}`);
});

test('словарь без LLM: известные значения заменяются, разные падежи — одна группа', async () => {
  const known = [
    { text: 'Петров Пётр Петрович', type: 'PER', canonical: 'петров пётр петрович' },
    { text: 'Петрова Петра Петровича', type: 'PER', canonical: 'петров пётр петрович' },
  ];
  const segs = ['В лице Петрова Петра Петровича.', 'Подпись: Петров Пётр Петрович'];
  const { spans, registry, stats } = await anonymizeSegments(segs, { useLlm: false, known });
  const out = segs.map((s, i) => applySpans(s, spans[i])).join(' ');
  assert.ok(!/Петров/.test(out), out);
  assert.equal(new Set(registry.entities.map((e) => e.groupId)).size, 1);
  assert.equal(stats.bySource.dict, 2);
});

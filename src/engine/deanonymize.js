'use strict';
// Деанонимизация: находим токены [ТИП-XXXXXX(-N)] и подставляем исходные значения из БД.
// Пользователь может восстановить только токены из своих заданий (админ — любые).
const { db } = require('../db');
const { decrypt } = require('../crypto');
const { TOKEN_RE } = require('./types');
const { transformDocx } = require('./docx');
const { extractTxt, extractPdf, buildDocx } = require('./extract');
const { applySpans } = require('./anonymizer');

function normToken(m) {
  return `[${m[1]}-${m[2]}${m[3] ? `-${m[3]}` : ''}]`;
}

function findTokens(text) {
  const out = [];
  const re = new RegExp(TOKEN_RE.source, 'g');
  let m;
  while ((m = re.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, token: normToken(m) });
  return out;
}

function lookup(tokens, user) {
  const map = new Map();
  if (!tokens.length) return map;
  const uniq = [...new Set(tokens)];
  for (let i = 0; i < uniq.length; i += 500) {
    // SQLite: не более 999 параметров — режем пачками
    const part = uniq.slice(i, i + 500);
    const rows = db.prepare(`SELECT e.token, e.value_enc, e.job_id, j.user_id FROM entities e JOIN jobs j ON j.id = e.job_id
      WHERE e.token IN (${part.map(() => '?').join(',')})`).all(...part);
    for (const r of rows) {
      if (user.is_admin || r.user_id === user.id) map.set(r.token, { value: decrypt(r.value_enc), jobId: r.job_id });
      else map.set(r.token, { forbidden: true });
    }
  }
  return map;
}

/** Общая часть: по массиву абзацев вернуть спаны замены + отчёт. */
function makeSpans(segments, user) {
  const found = segments.map(findTokens);
  const map = lookup(found.flat().map((f) => f.token), user);
  const report = { replaced: 0, unknown: new Set(), forbidden: new Set(), jobs: new Set() };
  const spans = found.map((list) => list.flatMap((f) => {
    const hit = map.get(f.token);
    if (!hit) { report.unknown.add(f.token); return []; }
    if (hit.forbidden) { report.forbidden.add(f.token); return []; }
    report.replaced++;
    report.jobs.add(hit.jobId);
    return [{ start: f.start, end: f.end, replacement: hit.value }];
  }));
  return { spans, report };
}

function finalizeReport(r) {
  return { replaced: r.replaced, unknown: [...r.unknown], forbidden: r.forbidden.size, jobs: [...r.jobs] };
}

async function deanonymizeFile(type, buf, filePath, user) {
  let report;
  if (type === 'docx') {
    const { buffer } = await transformDocx(buf, async (segs) => {
      const r = makeSpans(segs, user);
      report = r.report;
      return r.spans;
    });
    return { buffer, ext: '.docx', report: finalizeReport(report) };
  }
  if (type === 'txt') {
    const { paragraphs } = extractTxt(filePath);
    const r = makeSpans(paragraphs, user);
    const text = paragraphs.map((p, i) => applySpans(p, r.spans[i])).join('\n');
    return { buffer: Buffer.from(text, 'utf8'), ext: '.txt', report: finalizeReport(r.report) };
  }
  if (type === 'pdf') {
    const { paragraphs } = await extractPdf(filePath);
    const r = makeSpans(paragraphs, user);
    const buffer = await buildDocx(paragraphs.map((p, i) => applySpans(p, r.spans[i])));
    return { buffer, ext: '.docx', report: finalizeReport(r.report) };
  }
  throw new Error('Для деанонимизации поддерживаются DOCX, PDF и TXT');
}

function deanonymizeText(text, user) {
  const lines = String(text).split('\n');
  const r = makeSpans(lines, user);
  return { text: lines.map((p, i) => applySpans(p, r.spans[i])).join('\n'), report: finalizeReport(r.report) };
}

module.exports = { deanonymizeFile, deanonymizeText, findTokens };

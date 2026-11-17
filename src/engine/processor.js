'use strict';
// Пайплайн обработки задания: файл -> абзацы -> сущности -> токены -> результат + таблица соответствий.
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const { encrypt } = require('../crypto');
const { config } = require('../config');
const { anonymizeSegments, applySpans } = require('./anonymizer');
const { transformDocx } = require('./docx');
const { extractPdf, extractImage, extractTxt, buildDocx } = require('./extract');
const dictionary = require('./dictionary');

const qTaken = db.prepare('SELECT 1 FROM entities WHERE group_id = ? LIMIT 1');
const isTaken = (id) => !!qTaken.get(id);

const insEntity = db.prepare(
  'INSERT INTO entities (job_id, token, group_id, type, value_enc, source) VALUES (?, ?, ?, ?, ?, ?)',
);
const saveEntities = db.transaction((jobId, entities) => {
  for (const e of entities) insEntity.run(jobId, e.token, e.groupId, e.type, encrypt(e.value), e.source);
});

function resultName(originalName, ext) {
  const base = path.basename(originalName, path.extname(originalName));
  return `${base}_anon${ext}`;
}

/**
 * @param {{id:string, original_name:string, input_type:string}} job
 * @param {string} inputPath
 * @param {(msg:string)=>void} onProgress
 */
async function processJob(job, inputPath, onProgress) {
  let registry; let stats; let buffer; let ext; let extra = {};
  const run = async (segments) => {
    onProgress('Проверка по словарю известных сущностей');
    const known = dictionary.matchKnown(segments);
    const r = await anonymizeSegments(segments, { isTaken, onProgress, known, blocked: dictionary.blockedKeys() });
    registry = r.registry;
    stats = r.stats;
    return r.spans;
  };

  if (job.input_type === 'docx') {
    ({ buffer } = await transformDocx(fs.readFileSync(inputPath), run, { sanitize: true }));
    ext = '.docx';
  } else if (job.input_type === 'txt') {
    const { paragraphs } = extractTxt(inputPath);
    const spans = await run(paragraphs);
    buffer = Buffer.from(paragraphs.map((p, i) => applySpans(p, spans[i])).join('\n'), 'utf8');
    ext = '.txt';
  } else {
    const ex = job.input_type === 'pdf' ? await extractPdf(inputPath, onProgress) : await extractImage(inputPath, onProgress);
    if (!ex.paragraphs.length) throw new Error('В документе не найден текст (возможно, пустой скан или нет языка OCR)');
    const spans = await run(ex.paragraphs);
    const out = ex.paragraphs.map((p, i) => applySpans(p, spans[i]));
    buffer = await buildDocx(out, {
      note: ex.ocr
        ? 'Документ распознан OCR и анонимизирован. Проверьте результат: ошибки распознавания могли помешать найти часть данных.'
        : null,
    });
    ext = '.docx';
    extra = { ocr: ex.ocr, pages: ex.pages };
  }

  onProgress('Сохранение');
  saveEntities(job.id, registry.entities);
  const learned = dictionary.learn(registry.entities);
  const name = resultName(job.original_name, ext);
  const outPath = path.join(config.resultDir, `${job.id}${ext}`);
  fs.writeFileSync(outPath, buffer, { mode: 0o640 });
  return { resultPath: outPath, resultName: name, stats: { ...stats, ...extra, learned } };
}

module.exports = { processJob };

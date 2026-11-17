'use strict';
// Извлечение текста из PDF / сканов / TXT и сборка результата в DOCX.
// Используются системные утилиты: poppler-utils (pdftotext, pdfinfo, pdftoppm) и tesseract.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Document, Packer, Paragraph, TextRun } = require('docx');
const { config } = require('../config');

const run = promisify(execFile);
const EXEC_OPTS = { maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60 * 1000 };

/** Склеить строки в абзацы: пустая строка = граница абзаца, перенос со знаком «-» склеивается. */
function linesToParagraphs(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\f/g, '\n\n')
    .split(/\n[ \t]*\n+/)
    .map((block) => block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .reduce((acc, line) => {
        if (!acc) return line;
        if (/[\p{Ll}]-$/u.test(acc) && /^\p{Ll}/u.test(line)) return acc.slice(0, -1) + line;
        return `${acc} ${line}`;
      }, ''))
    .filter((p) => p && p.trim());
}

async function pdfPages(file) {
  try {
    const { stdout } = await run('pdfinfo', [file], EXEC_OPTS);
    const m = stdout.match(/^Pages:\s+(\d+)/m);
    return m ? Number(m[1]) : 1;
  } catch { return 1; }
}

// OCR часто путает кириллицу с латиницей (OOO, AO, «Cидоров»). Исправляем:
// слова со смешанными алфавитами и типовые ОПФ, набранные латиницей, переводим в кириллицу.
const LAT2CYR = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У', a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у', k: 'к', m: 'м' };
const LEGAL_FORMS_LAT = new Set(['OOO', 'AO', 'OAO', 'HKO', 'TCH', 'CHT']);
function fixHomoglyphs(text) {
  return text.replace(/[\p{L}]+/gu, (w) => {
    const hasCyr = /\p{Script=Cyrillic}/u.test(w);
    const hasLat = /[A-Za-z]/.test(w);
    if ((hasCyr && hasLat && [...w].every((ch) => !/[A-Za-z]/.test(ch) || LAT2CYR[ch])) || LEGAL_FORMS_LAT.has(w)) {
      return [...w].map((ch) => LAT2CYR[ch] || ch).join('');
    }
    return w;
  });
}

async function ocrImage(file) {
  const { stdout } = await run('tesseract', [file, 'stdout', '-l', config.ocrLangs, '--psm', '3'], EXEC_OPTS);
  return fixHomoglyphs(stdout);
}

async function extractPdf(file, onProgress) {
  const pages = await pdfPages(file);
  onProgress && onProgress('Извлечение текста из PDF');
  const { stdout } = await run('pdftotext', ['-enc', 'UTF-8', file, '-'], EXEC_OPTS);
  const chars = stdout.replace(/\s/g, '').length;
  if (chars / Math.max(pages, 1) >= config.ocrMinCharsPerPage) {
    return { paragraphs: linesToParagraphs(stdout), pages, ocr: false };
  }
  // Скан — распознаём постранично
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anon-ocr-'));
  try {
    onProgress && onProgress('Скан: подготовка страниц для OCR');
    await run('pdftoppm', ['-r', String(config.ocrDpi), '-png', file, path.join(tmp, 'p')], EXEC_OPTS);
    const imgs = fs.readdirSync(tmp).filter((f) => f.endsWith('.png')).sort();
    const out = [];
    for (let i = 0; i < imgs.length; i++) {
      onProgress && onProgress(`OCR: страница ${i + 1} из ${imgs.length}`);
      out.push(...linesToParagraphs(await ocrImage(path.join(tmp, imgs[i]))));
    }
    return { paragraphs: out, pages, ocr: true };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function extractImage(file, onProgress) {
  onProgress && onProgress('OCR изображения');
  return { paragraphs: linesToParagraphs(await ocrImage(file)), pages: 1, ocr: true };
}

function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1251').decode(buf);
  }
}

function extractTxt(file) {
  // В TXT сохраняем построчную структуру как есть
  const lines = decodeText(fs.readFileSync(file)).replace(/\r\n?/g, '\n').split('\n');
  return { paragraphs: lines, pages: 1, ocr: false };
}

async function buildDocx(paragraphs, { title, note } = {}) {
  const children = [];
  if (note) {
    children.push(new Paragraph({ children: [new TextRun({ text: note, italics: true, size: 18, color: '808080' })] }));
    children.push(new Paragraph({ children: [] }));
  }
  for (const p of paragraphs) children.push(new Paragraph({ children: [new TextRun(p)] }));
  const doc = new Document({
    creator: 'WSP Anonymizer',
    title: title || '',
    styles: { default: { document: { run: { font: 'Times New Roman', size: 24 } } } },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

function detectType(filename, mimetype) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp'].includes(ext)) return 'image';
  if (ext === '.txt') return 'txt';
  if (mimetype === 'application/pdf') return 'pdf';
  return null;
}

async function toolsHealth() {
  const res = {};
  for (const [name, args] of [['pdftotext', ['-v']], ['pdftoppm', ['-v']], ['tesseract', ['--list-langs']]]) {
    try {
      const { stdout, stderr } = await run(name, args, { timeout: 5000 });
      res[name] = name === 'tesseract'
        ? config.ocrLangs.split('+').every((l) => new RegExp(`^${l}$`, 'm').test(stdout + stderr))
        : true;
    } catch { res[name] = false; }
  }
  return res;
}

module.exports = { extractPdf, extractImage, extractTxt, buildDocx, detectType, linesToParagraphs, toolsHealth, fixHomoglyphs };

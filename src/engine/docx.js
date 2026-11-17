'use strict';
// Работа с DOCX без потери форматирования: правим только текст в <w:t>, структура документа
// (стили, таблицы, нумерация, колонтитулы) не меняется. Сущность, разбитая Word'ом на
// несколько run'ов, заменяется целиком: токен пишется в первый run, остальные части вырезаются.
const JSZip = require('jszip');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

const TEXT_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/;
const TEXT_TAGS = new Set(['w:t', 'w:delText']);

/** Собрать текстовые узлы абзаца, не заходя во вложенные абзацы (надписи/текстбоксы). */
function collectTextNodes(p) {
  const nodes = [];
  const walk = (el) => {
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      if (c.nodeName === 'w:p') continue; // обработается как отдельный абзац
      if (TEXT_TAGS.has(c.nodeName)) nodes.push(c);
      else walk(c);
    }
  };
  walk(p);
  return nodes;
}

function setText(node, text) {
  while (node.firstChild) node.removeChild(node.firstChild);
  node.appendChild(node.ownerDocument.createTextNode(text));
  node.setAttribute('xml:space', 'preserve');
}

function applySpansToNodes(nodes, spans) {
  const lens = nodes.map((n) => n.textContent.length);
  const starts = [];
  let acc = 0;
  for (const l of lens) { starts.push(acc); acc += l; }

  // Идём с конца: правки более поздних спанов затрагивают только позиции >= их start,
  // поэтому исходные смещения для более ранних спанов остаются валидными.
  for (const s of [...spans].sort((a, b) => b.start - a.start)) {
    let first = true;
    for (let i = 0; i < nodes.length; i++) {
      const ns = starts[i];
      if (ns + lens[i] <= s.start) continue; // узел целиком до спана
      if (ns >= s.end) break; // узел целиком после
      const cur = nodes[i].textContent;
      const a = Math.max(0, s.start - ns);
      const b = Math.min(lens[i], s.end - ns);
      setText(nodes[i], cur.slice(0, a) + (first ? s.replacement : '') + cur.slice(b));
      first = false;
    }
  }
}

function sanitizeMetadataXml(xml, tags) {
  let out = xml;
  for (const t of tags) {
    out = out.replace(new RegExp(`<${t}([^>]*)>[\\s\\S]*?</${t}>`, 'g'), `<${t}$1></${t}>`);
  }
  return out;
}

/**
 * @param {Buffer} buf исходный DOCX
 * @param {(segments:string[]) => Promise<Array<Array<{start:number,end:number,replacement:string}>>>} processSegments
 * @param {{sanitize?: boolean}} opts sanitize — очистить автора/комментаторов/метаданные
 * @returns {Promise<{buffer: Buffer, segments: string[]}>}
 */
async function transformDocx(buf, processSegments, opts = {}) {
  const zip = await JSZip.loadAsync(buf);
  const partNames = Object.keys(zip.files).filter((n) => TEXT_PARTS.test(n))
    .sort((a, b) => (a === 'word/document.xml' ? -1 : b === 'word/document.xml' ? 1 : a.localeCompare(b)));
  if (!partNames.includes('word/document.xml')) throw new Error('Файл не похож на DOCX (нет word/document.xml)');

  const parts = [];
  const paragraphs = []; // { nodes }
  for (const name of partNames) {
    const xml = await zip.file(name).async('string');
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    parts.push({ name, doc });
    const ps = doc.getElementsByTagName('w:p');
    for (let i = 0; i < ps.length; i++) {
      const nodes = collectTextNodes(ps[i]);
      if (nodes.length) paragraphs.push({ nodes });
    }
  }

  const segments = paragraphs.map((p) => p.nodes.map((n) => n.textContent).join(''));
  const spans = await processSegments(segments);
  paragraphs.forEach((p, i) => { if (spans[i] && spans[i].length) applySpansToNodes(p.nodes, spans[i]); });

  for (const { name, doc } of parts) {
    if (opts.sanitize) {
      // Авторы правок и комментариев
      for (const tag of ['w:ins', 'w:del', 'w:comment', 'w:rPrChange', 'w:pPrChange', 'w:moveFrom', 'w:moveTo']) {
        const els = doc.getElementsByTagName(tag);
        for (let i = 0; i < els.length; i++) {
          if (els[i].hasAttribute('w:author')) els[i].setAttribute('w:author', 'Anonymized');
          if (els[i].hasAttribute('w:initials')) els[i].setAttribute('w:initials', 'A');
        }
      }
    }
    zip.file(name, new XMLSerializer().serializeToString(doc));
  }

  if (opts.sanitize) {
    if (zip.file('docProps/core.xml')) {
      const core = await zip.file('docProps/core.xml').async('string');
      zip.file('docProps/core.xml', sanitizeMetadataXml(core,
        ['dc:creator', 'cp:lastModifiedBy', 'dc:title', 'dc:subject', 'dc:description', 'cp:keywords', 'cp:category']));
    }
    if (zip.file('docProps/app.xml')) {
      const app = await zip.file('docProps/app.xml').async('string');
      zip.file('docProps/app.xml', sanitizeMetadataXml(app, ['Company', 'Manager']));
    }
    if (zip.file('word/people.xml')) {
      const people = await zip.file('word/people.xml').async('string');
      zip.file('word/people.xml', people.replace(/(w15?:author|w15:userId)="[^"]*"/g, '$1="Anonymized"'));
    }
    for (const n of Object.keys(zip.files).filter((f) => /^word\/_rels\/.*\.rels$/.test(f))) {
      const rels = await zip.file(n).async('string');
      zip.file(n, rels.replace(/Target="mailto:[^"]*"/g, 'Target="mailto:anonymized"'));
    }
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer, segments };
}

module.exports = { transformDocx, applySpansToNodes, collectTextNodes };

'use strict';
// Ядро: собрать словарь сущностей (регулярки + LLM), найти все вхождения во всех абзацах,
// выдать токены и вернуть «спаны» для замены.
const { randomId } = require('../crypto');
const { detectRegex } = require('./detectors');
const llm = require('./llm');
const { config } = require('../config');

const QUOTES = '["«»“”„\'’]';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Регулярка для поиска фрагмента: гибко к пробелам (в т.ч. неразрывным), кавычкам и регистру. */
function fragmentRegex(text) {
  const body = text
    .split(/(\s+)/)
    .map((part) => (/^\s+$/.test(part) ? '[\\s\\u00A0]+' : escapeRe(part).replace(/["«»“”„'’]/g, QUOTES)))
    .join('');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu');
}

function occursIn(text, haystack) {
  return fragmentRegex(text).test(haystack);
}

function normKey(s) {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/["«»“”„'’]/g, '').replace(/[\s ]+/g, ' ').trim();
}

/** Для ФИО: «Иванов И.И.» -> ключ «иванов|ии», «Иванов Иван Иванович» -> «иванов|ии». */
function personShortKey(canon) {
  const parts = normKey(canon).replace(/\./g, '. ').split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  // Формат «И.И. Иванов» -> переставим
  const isInit = (p) => /^[а-яa-z]\.?$/i.test(p);
  let surname; let rest;
  if (isInit(parts[0])) { surname = parts[parts.length - 1]; rest = parts.slice(0, -1); } else { surname = parts[0]; rest = parts.slice(1); }
  const initials = rest.map((p) => p[0]).join('');
  return initials ? `${surname}|${initials}` : null;
}

class TokenRegistry {
  constructor(isTaken) {
    this.isTaken = isTaken || (() => false);
    this.groups = new Map(); // groupKey -> { baseId, type, variants: Map(surface -> token) }
    this.entities = []; // {token, groupId, type, value, source}
    this.usedIds = new Set();
  }

  newBaseId() {
    for (;;) {
      const id = randomId(6);
      if (!this.usedIds.has(id) && !this.isTaken(id)) { this.usedIds.add(id); return id; }
    }
  }

  token(groupKey, type, surface, source) {
    let g = this.groups.get(groupKey);
    if (!g) {
      g = { baseId: this.newBaseId(), type, variants: new Map() };
      this.groups.set(groupKey, g);
    }
    let tok = g.variants.get(surface);
    if (!tok) {
      const n = g.variants.size + 1;
      tok = n === 1 ? `[${type}-${g.baseId}]` : `[${type}-${g.baseId}-${n}]`;
      g.variants.set(surface, tok);
      this.entities.push({ token: tok, groupId: g.baseId, groupKey, type, value: surface, source });
    }
    return tok;
  }
}

/**
 * Построить словарь: каждая запись — фрагмент + тип + ключ группы.
 * Разные словоформы одной сущности получают один ключ группы (через canonical).
 */
function buildDictionary(found) {
  const byText = new Map();
  // Псевдонимы ключей для ФИО: короткая форма -> полная
  const personAlias = new Map();
  for (const e of found) {
    if (e.type !== 'PER') continue;
    const canon = normKey(e.canonical);
    const sk = personShortKey(canon);
    if (sk && canon.split(' ').filter((p) => p.length > 2 && !p.endsWith('.')).length >= 2) {
      if (!personAlias.has(sk)) personAlias.set(sk, canon);
    }
  }
  for (const e of found) {
    let canon = normKey(e.canonical);
    if (e.type === 'PER') {
      const sk = personShortKey(canon);
      if (sk && personAlias.has(sk)) canon = personAlias.get(sk);
    }
    const key = `${e.text}\u0000${e.type}`;
    if (!byText.has(key)) byText.set(key, { text: e.text, type: e.type, groupKey: `${e.type}|${canon}`, source: e.source });
  }
  // Одинаковый текст разных типов: приоритет регулярок (точные реквизиты)
  const seen = new Map();
  for (const d of byText.values()) {
    const k = d.text.toLowerCase();
    const prev = seen.get(k);
    if (!prev || (prev.source === 'llm' && d.source === 'regex')) seen.set(k, d);
  }
  // Длинные фрагменты — первыми (чтобы «ООО «Ромашка»» победило «Ромашка»)
  return [...seen.values()].sort((a, b) => b.text.length - a.text.length);
}

/** Найти непересекающиеся совпадения словаря в одном абзаце (без выдачи токенов). */
function matchSpans(segment, dict) {
  const cands = [];
  for (const d of dict) {
    const re = d.re || (d.re = fragmentRegex(d.text));
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(segment))) {
      if (!m[0].length) { re.lastIndex++; continue; }
      cands.push({ start: m.index, end: m.index + m[0].length, d, surface: m[0] });
    }
  }
  cands.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out = [];
  let lastEnd = -1;
  for (const c of cands) {
    if (c.start < lastEnd) continue;
    out.push(c);
    lastEnd = c.end;
  }
  return out;
}

/** Найти спаны в абзаце и выдать токены. */
function findSpans(segment, dict, registry) {
  return matchSpans(segment, dict).map((c) => ({
    start: c.start,
    end: c.end,
    replacement: registry.token(c.d.groupKey, c.d.type, c.surface, c.d.source),
    type: c.d.type,
    source: c.d.source,
  }));
}

function applySpans(text, spans) {
  let out = '';
  let pos = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    out += text.slice(pos, s.start) + s.replacement;
    pos = s.end;
  }
  return out + text.slice(pos);
}

/** Плейсхолдер для текста, уходящего в LLM: модель видит, что здесь уже скрытая сущность нужного типа. */
const MASK = (type) => `[${type}]`;

/**
 * Главная функция анонимизации набора абзацев.
 *
 * Порядок:
 *  1. регулярки (реквизиты) + словарь известных сущностей (то, что LLM находила раньше);
 *  2. всё найденное маскируется, и в LLM уходит текст, где осталось искать только новое;
 *  3. итоговый словарь = 1 + 2, замена по всему документу.
 *
 * @param {string[]} segments
 * @param {{isTaken?:(id:string)=>boolean, onProgress?:(m:string)=>void, useLlm?:boolean,
 *          known?: Array<{text:string,type:string,canonical:string}>, maskForLlm?: boolean,
 *          blocked?: Set<string>}} opts  blocked — ключи type|normKey, которые не заменять (отключены админом)
 */
async function anonymizeSegments(segments, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const useLlm = opts.useLlm !== undefined ? opts.useLlm : config.llm.enabled;
  const maskForLlm = opts.maskForLlm !== undefined ? opts.maskForLlm : config.known.maskForLlm;

  onProgress('Поиск реквизитов и известных сущностей');
  const found = [];
  for (const s of segments) found.push(...detectRegex(s));
  const known = (opts.known || []).map((k) => ({ text: k.text, type: k.type, canonical: k.canonical, source: 'dict' }));
  found.push(...known);

  let llmCount = 0;
  if (useLlm) {
    let llmInput = segments;
    if (maskForLlm && found.length) {
      const pre = buildDictionary(found);
      llmInput = segments.map((seg) => {
        let out = '';
        let pos = 0;
        for (const m of matchSpans(seg, pre)) { out += seg.slice(pos, m.start) + MASK(m.d.type); pos = m.end; }
        return out + seg.slice(pos);
      });
      for (const d of pre) delete d.re; // регулярки с состоянием lastIndex не переиспользуем
    }
    // Подсказываем модели нормальные формы уже известных лиц/организаций — чтобы «Иванов И.И.»
    // попал в ту же группу, что и полное ФИО, даже если полное ФИО замаскировано.
    const hints = known.map((k) => [k.canonical, k.type]);
    const blocked = opts.blocked || new Set();
    const llmFound = (await llm.extractEntities(llmInput, onProgress, occursIn, hints))
      .filter((e) => !blocked.has(`${e.type}|${normKey(e.text)}`));
    llmCount = llmFound.length;
    found.push(...llmFound);
  }

  onProgress('Замена');
  const dict = buildDictionary(found);
  const registry = new TokenRegistry(opts.isTaken);
  const spans = segments.map((s) => findSpans(s, dict, registry));

  const byType = {};
  const bySource = {};
  let total = 0;
  for (const list of spans) {
    for (const s of list) {
      byType[s.type] = (byType[s.type] || 0) + 1;
      bySource[s.source] = (bySource[s.source] || 0) + 1;
      total++;
    }
  }
  return {
    spans,
    registry,
    stats: { total, byType, bySource, knownMatched: known.length, llmFound: llmCount, uniqueEntities: registry.groups.size, llm: useLlm },
  };
}

module.exports = { anonymizeSegments, applySpans, findSpans, matchSpans, normKey, buildDictionary, fragmentRegex, occursIn, TokenRegistry, personShortKey };

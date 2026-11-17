'use strict';
// Словарь известных сущностей. Наполняется находками LLM, используется ДО вызова LLM:
// всё, что уже встречалось в прошлых документах, находится детерминированно и маскируется.
//
// Значения хранятся зашифрованными; для поиска по тексту словарь расшифровывается в память
// процесса (кэш), дубликаты в БД отсекаются по HMAC.
const { db } = require('../db');
const { encrypt, decrypt, hmac } = require('../crypto');
const { config } = require('../config');
const { fragmentRegex, normKey } = require('./anonymizer');

const q = {
  all: db.prepare('SELECT id, type, value_enc, canonical_enc, enabled FROM known_entities'),
  byHmac: db.prepare('SELECT id FROM known_entities WHERE value_hmac = ?'),
  insert: db.prepare('INSERT INTO known_entities (value_hmac, type, value_enc, canonical_enc) VALUES (?, ?, ?, ?)'),
  bump: db.prepare("UPDATE known_entities SET hits = hits + 1, last_seen = datetime('now') WHERE id = ?"),
  list: db.prepare('SELECT id, type, value_enc, canonical_enc, enabled, hits, first_seen, last_seen FROM known_entities ORDER BY type, hits DESC, id'),
  setEnabled: db.prepare('UPDATE known_entities SET enabled = ? WHERE id = ?'),
  del: db.prepare('DELETE FROM known_entities WHERE id = ?'),
  purge: db.prepare("DELETE FROM known_entities WHERE last_seen < datetime('now', ?)"),
};

let cache = null; // [{id, type, text, canonical, key, enabled}]

/** Самое длинное слово фрагмента — для быстрого предварительного отбора через indexOf. */
function prefilterKey(text) {
  const words = text.toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) || [];
  return words.sort((a, b) => b.length - a.length)[0] || '';
}

function load() {
  if (cache) return cache;
  cache = q.all.all().map((r) => {
    const text = decrypt(r.value_enc);
    return { id: r.id, type: r.type, text, canonical: decrypt(r.canonical_enc), key: prefilterKey(text), enabled: !!r.enabled };
  });
  return cache;
}

function invalidate() { cache = null; }

/**
 * Какие известные сущности встречаются в документе.
 * @param {string[]} segments
 * @returns {Array<{id:number,type:string,text:string,canonical:string}>}
 */
function matchKnown(segments) {
  if (!config.known.enabled) return [];
  const full = segments.join('\n');
  const lower = full.toLowerCase().replace(/ё/g, 'е');
  const out = [];
  for (const e of load()) {
    if (!e.enabled) continue;
    if (e.key && !lower.includes(e.key)) continue;
    if (fragmentRegex(e.text).test(full)) out.push(e);
  }
  return out;
}

/**
 * Отключённые админом записи = «это не конфиденциальные данные» (ложные срабатывания модели).
 * Возвращает набор ключей type|нормализованный текст, которые нельзя заменять, даже если LLM их снова найдёт.
 */
function blockedKeys() {
  if (!config.known.enabled) return new Set();
  return new Set(load().filter((e) => !e.enabled).map((e) => `${e.type}|${normKey(e.text)}`));
}

const learnTx = db.transaction((items) => {
  let added = 0;
  for (const it of items) {
    const h = hmac(`${it.type}|${it.value}`);
    const row = q.byHmac.get(h);
    if (row) { q.bump.run(row.id); continue; }
    q.insert.run(h, it.type, encrypt(it.value), encrypt(it.canonical));
    added++;
  }
  return added;
});

/**
 * Пополнить словарь сущностями из обработанного документа.
 * Берём только смысловые типы (ФИО, организации, адреса...) — реквизиты и так ловятся регулярками.
 * @param {Array<{value:string,type:string,source:string,groupKey:string}>} entities registry.entities
 */
function learn(entities) {
  if (!config.known.enabled) return 0;
  const seen = new Set();
  const items = [];
  for (const e of entities) {
    if (!['llm', 'dict'].includes(e.source) || !config.known.types.includes(e.type)) continue;
    const value = e.value.trim();
    if (value.length < config.known.minLen) continue;
    const k = `${e.type}|${value}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const canonical = (e.groupKey || '').split('|').slice(1).join('|') || normKey(value);
    items.push({ type: e.type, value, canonical });
  }
  const added = learnTx(items);
  if (added) invalidate();
  return added;
}

function list() {
  return q.list.all().map((r) => ({
    id: r.id,
    type: r.type,
    value: decrypt(r.value_enc),
    canonical: decrypt(r.canonical_enc),
    enabled: !!r.enabled,
    hits: r.hits,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  }));
}

function setEnabled(id, enabled) {
  const r = q.setEnabled.run(enabled ? 1 : 0, id);
  invalidate();
  return r.changes;
}

function remove(id) {
  const r = q.del.run(id);
  invalidate();
  return r.changes;
}

/** Удалить записи, не встречавшиеся дольше срока хранения таблиц замен. */
function purge(days) {
  if (!days) return 0;
  const r = q.purge.run(`-${days} days`);
  if (r.changes) invalidate();
  return r.changes;
}

module.exports = { matchKnown, blockedKeys, learn, list, setEnabled, remove, purge, invalidate };

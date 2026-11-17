'use strict';
// Детерминированные детекторы реквизитов (регулярные выражения + контрольные суммы).
// Они надёжнее LLM для чисел, поэтому работают всегда, даже если модель недоступна.

const digits = (s) => s.replace(/\D/g, '');

function innValid(s) {
  const d = digits(s).split('').map(Number);
  const chk = (w) => (w.reduce((a, k, i) => a + k * d[i], 0) % 11) % 10;
  if (d.length === 10) return chk([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  if (d.length === 12) {
    return chk([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] && chk([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
  }
  return false;
}

function ogrnValid(s) {
  const d = digits(s);
  if (d.length === 13) return Number((BigInt(d.slice(0, 12)) % 11n) % 10n) === Number(d[12]);
  if (d.length === 15) return Number((BigInt(d.slice(0, 14)) % 13n) % 10n) === Number(d[14]);
  return false;
}

function luhn(s) {
  const d = digits(s);
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

function ibanValid(s) {
  const v = s.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v)) return false;
  const r = (v.slice(4) + v.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let m = 0;
  for (const ch of r) m = (m * 10 + Number(ch)) % 97;
  return m === 1;
}

// Каждое правило: re (с флагом d, если есть группа v — берётся только она), type, check(), canon()
const NB = '(?<![\\p{L}\\p{N}])';
const NA = '(?![\\p{L}\\p{N}])';
const SP = '[ \\u00A0]';

const RULES = [
  { type: 'EMAIL', re: new RegExp(`${NB}[\\p{L}\\p{N}._%+-]+@[\\p{L}\\p{N}.-]+\\.[\\p{L}]{2,}${NA}`, 'gud'), canon: (s) => s.toLowerCase() },
  // Расчётные/корр. счета: 20 цифр, допускаем пробелы/точки-группировки
  { type: 'ACC', re: new RegExp(`(?<!\\d)\\d{5}[ .\\u00A0]?\\d{3}[ .\\u00A0]?\\d[ .\\u00A0]?\\d{4}[ .\\u00A0]?\\d{7}(?!\\d)`, 'gud'), check: (s) => digits(s).length === 20, canon: digits },
  { type: 'ACC', re: new RegExp(`(?<!\\d)(?:\\d{4}${SP}?){4}\\d{4}(?!\\d)`, 'gud'), check: (s) => digits(s).length === 20, canon: digits },
  { type: 'CARD', re: new RegExp(`(?<!\\d)\\d{4}(?:[ \\-\\u00A0]?\\d{4}){3}(?!\\d)`, 'gud'), check: luhn, canon: digits },
  { type: 'IBAN', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/gd, check: ibanValid, canon: (s) => s.replace(/\s/g, '') },
  { type: 'SWIFT', re: /(?:SWIFT|BIC)(?:[\s-]*код)?[\s:№]*(?<v>[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\b/gd, canon: (s) => s },
  { type: 'INN', re: new RegExp(`ИНН(?:/КПП)?[\\s:№]*(?<v>\\d{10}|\\d{12})(?!\\d)`, 'giud'), canon: digits },
  { type: 'INN', re: /(?<!\d)(?:\d{10}|\d{12})(?!\d)/gd, check: innValid, canon: digits },
  { type: 'KPP', re: new RegExp(`КПП[\\s:№]*(?<v>\\d{9})(?!\\d)`, 'giud'), canon: digits },
  { type: 'KPP', re: /ИНН\/КПП[\s:№]*\d{10}\s*\/\s*(?<v>\d{9})(?!\d)/giud, canon: digits },
  { type: 'BIK', re: new RegExp(`БИК[\\s:№]*(?<v>\\d{9})(?!\\d)`, 'giud'), canon: digits },
  { type: 'OGRN', re: new RegExp(`ОГРН(?:ИП)?[\\s:№]*(?<v>\\d{13}|\\d{15})(?!\\d)`, 'giud'), canon: digits },
  { type: 'OGRN', re: /(?<!\d)(?:\d{13}|\d{15})(?!\d)/gd, check: ogrnValid, canon: digits },
  { type: 'SNILS', re: /(?<!\d)\d{3}-\d{3}-\d{3}[ \- ]\d{2}(?!\d)/gd, canon: digits },
  // Паспорт РФ — только с контекстом, иначе слишком много ложных срабатываний
  { type: 'PASS', re: new RegExp(`(?:паспорт|серия)[^\\d\\n]{0,40}?(?<v>\\d{2}${SP}?\\d{2}[ \\u00A0]*(?:№|N|номер)?[ \\u00A0]*\\d{6})(?!\\d)`, 'giud'), canon: digits },
  { type: 'PASS', re: new RegExp(`код подразделения[\\s:]*(?<v>\\d{3}-\\d{3})(?!\\d)`, 'giud'), canon: digits },
  // Телефоны: российские и международные
  { type: 'PHONE', re: /(?<![\d+])(?:\+7|8)[ \- ]?\(?\d{3}\)?[ \- ]?\d{3}[ \- ]?\d{2}[ \- ]?\d{2}(?!\d)/gd, canon: (s) => digits(s).replace(/^8/, '7') },
  { type: 'PHONE', re: /(?<![\d+])\+(?!7)\d{1,3}[ \- ]?\(?\d{1,4}\)?(?:[ \- ]?\d{2,4}){2,4}(?!\d)/gd, check: (s) => digits(s).length >= 10 && digits(s).length <= 15, canon: digits },
  // Кадастровый номер
  { type: 'ID', re: /(?<!\d)\d{2}:\d{2}:\d{6,7}:\d{1,6}(?!\d)/gd, canon: (s) => s },
];

/**
 * Найти реквизиты в одном фрагменте текста.
 * @returns {{text:string,type:string,canonical:string,source:'regex'}[]}
 */
function detectRegex(text) {
  const out = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text))) {
      const v = m.groups && m.groups.v !== undefined ? m.groups.v : m[0];
      if (!v || (rule.check && !rule.check(v))) continue;
      out.push({ text: v, type: rule.type, canonical: rule.canon(v), source: 'regex' });
    }
  }
  return out;
}

module.exports = { detectRegex, innValid, ogrnValid, luhn, ibanValid };

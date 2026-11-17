'use strict';
// Извлечение именованных сущностей через локальную модель в Ollama.
// Модель НЕ переписывает текст — она только возвращает список найденных фрагментов,
// а замену делаем детерминированно. Так документ не «плывёт» и галлюцинации отсеиваются
// (фрагмент, которого нет в тексте, просто отбрасывается).
const { config } = require('../config');
const { LLM_TYPES } = require('./types');

const SYSTEM_PROMPT = `Ты — модуль извлечения конфиденциальных данных из юридических документов юридической фирмы.
Найди в тексте ВСЕ упоминания следующих категорий:
- PER — физические лица: полные ФИО, сокращения («Иванов И.И.», «И.И. Иванов»), отдельные фамилии, имена с отчествами — в любых падежах.
- ORG — названия коммерческих и некоммерческих организаций, включая организационно-правовую форму и кавычки, если они стоят рядом («ООО «Ромашка»», «АО "Альфа-Банк"», «Romashka Ltd.»), а также короткие названия без ОПФ («Ромашка»).
- ADDR — адреса (почтовые, юридические, фактические) целиком, вместе с индексом, улицей, домом, офисом.
- DOC — номера договоров, дел, доверенностей, приказов, счетов на оплату и иных документов (только номер, например «№ 15/2024-КП» или «А40-123456/2024»).
- ID — прочие идентифицирующие номера: госномера ТС, VIN, номера лицензий, номера свидетельств, логины.

Правила:
1. "text" — фрагмент ТОЧНО как он написан в тексте, символ в символ (падеж, регистр, кавычки, пробелы). Ничего не исправляй.
2. Если одна и та же сущность встречается в разных формах (падежах, сокращениях) — верни КАЖДУЮ форму отдельным элементом.
3. "canonical" — нормальная форма сущности, одинаковая для всех её упоминаний: для PER — полное ФИО в именительном падеже, если оно известно из текста или из списка уже найденных сущностей, иначе как есть в именительном падеже; для ORG — название в именительном падеже без ОПФ и кавычек; для остальных — сам номер/адрес.
4. Фрагменты вида [PER], [ORG], [INN] и т.п. — уже скрытые данные, их НЕ возвращай.
5. НЕ включай: роли сторон и общие слова («Заказчик», «Исполнитель», «Сторона», «Общество», «Банк», «Генеральный директор»), должности, даты, денежные суммы, названия законов и кодексов, суды и государственные органы, отдельно стоящие названия городов и стран.
6. Если ничего не найдено — верни пустой список.
Ответ — только JSON по схеме.`;

const SCHEMA = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          type: { type: 'string', enum: LLM_TYPES },
          canonical: { type: 'string' },
        },
        required: ['text', 'type', 'canonical'],
      },
    },
  },
  required: ['entities'],
};

// Слова, которые модель иногда ошибочно помечает как сущности
const STOPWORDS = new Set([
  'заказчик', 'исполнитель', 'подрядчик', 'поставщик', 'покупатель', 'продавец', 'арендатор', 'арендодатель',
  'сторона', 'стороны', 'общество', 'компания', 'банк', 'клиент', 'доверитель', 'поверенный', 'займодавец',
  'заемщик', 'заёмщик', 'кредитор', 'должник', 'истец', 'ответчик', 'лицензиар', 'лицензиат', 'принципал',
  'агент', 'работодатель', 'работник', 'генеральный директор', 'директор', 'россия', 'российская федерация',
  'рф', 'москва', 'г. москва', 'санкт-петербург',
]);

/** Делим текст на куски ~chunkChars по границам абзацев. */
function chunkText(paragraphs, maxChars) {
  const chunks = [];
  let cur = '';
  const push = () => { if (cur.trim()) chunks.push(cur); cur = ''; };
  for (const p of paragraphs) {
    if (!p.trim()) continue;
    if (p.length > maxChars) {
      push();
      // длинный абзац режем по предложениям
      let part = '';
      for (const s of p.split(/(?<=[.;!?])\s+/)) {
        if (part.length + s.length > maxChars && part) { chunks.push(part); part = ''; }
        part += (part ? ' ' : '') + s;
      }
      if (part) chunks.push(part);
      continue;
    }
    if (cur.length + p.length + 1 > maxChars) push();
    cur += (cur ? '\n' : '') + p;
  }
  push();
  return chunks;
}

async function ollamaChat(messages) {
  const res = await fetch(`${config.llm.url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(config.llm.timeoutMs),
    body: JSON.stringify({
      model: config.llm.model,
      messages,
      stream: false,
      think: false,
      format: SCHEMA,
      keep_alive: config.llm.keepAlive,
      options: { temperature: 0, num_ctx: config.llm.numCtx },
    }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.message && data.message.content ? data.message.content : '';
}

function parseEntities(content) {
  // На случай, если модель обернула JSON в текст/```json
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('LLM вернула не JSON');
  const obj = JSON.parse(content.slice(start, end + 1));
  return Array.isArray(obj.entities) ? obj.entities : [];
}

/**
 * @param {string[]} paragraphs
 * @param {(msg:string)=>void} onProgress
 * @param {(text:string, chunk:string)=>boolean} occursIn — проверка, что фрагмент реально есть в тексте
 */
async function extractEntities(paragraphs, onProgress, occursIn, initialKnown = []) {
  const chunks = chunkText(paragraphs, config.llm.chunkChars);
  const result = [];
  const known = new Map(initialKnown); // canonical -> type, подсказываем модели для согласованности
  for (let i = 0; i < chunks.length; i++) {
    onProgress && onProgress(`Анализ моделью: фрагмент ${i + 1} из ${chunks.length}`);
    const hint = known.size
      ? `\n\nУже найденные сущности (используй те же canonical для тех же лиц/организаций):\n${[...known]
        .slice(-60).map(([c, t]) => `${t}: ${c}`).join('\n')}`
      : '';
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Текст:\n"""\n${chunks[i]}\n"""${hint}` },
    ];
    let ents;
    for (let attempt = 1; ; attempt++) {
      try {
        ents = parseEntities(await ollamaChat(messages));
        break;
      } catch (e) {
        if (attempt >= 2) throw new Error(`Ошибка LLM на фрагменте ${i + 1}: ${e.message}`);
      }
    }
    for (const e of ents) {
      if (!e || typeof e.text !== 'string' || !LLM_TYPES.includes(e.type)) continue;
      let text = e.text.trim().replace(/^[,.;:]+/, '').replace(/[,;:]+$/, '');
      // Точку в конце убираем, кроме инициалов («Иванов И.И.») и сокращений («Ltd.»)
      if (text.endsWith('.') && !/(?:^|[\s.])\p{Lu}\.$|(?:^|[\s(])(?:Ltd|Inc|Corp|Co|LLC|GmbH|д|оф|кв|стр|корп)\.$/u.test(text)) text = text.slice(0, -1);
      if (text.length < 2 || STOPWORDS.has(text.toLowerCase())) continue;
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      if (/\[[A-Z]{2,5}(?:-[0-9A-Z-]+)?\]/.test(text)) continue; // модель вернула плейсхолдер/токен
      if (!occursIn(text, chunks[i])) continue; // отсекаем галлюцинации
      const canonical = (typeof e.canonical === 'string' && e.canonical.trim()) || text;
      result.push({ text, type: e.type, canonical, source: 'llm' });
      known.set(canonical, e.type);
    }
  }
  return result;
}

async function health() {
  try {
    const res = await fetch(`${config.llm.url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    const hasModel = models.some((m) => m === config.llm.model || m === `${config.llm.model}:latest`);
    return { ok: hasModel, model: config.llm.model, error: hasModel ? null : `Модель ${config.llm.model} не загружена в Ollama` };
  } catch (e) {
    return { ok: false, model: config.llm.model, error: e.message };
  }
}

module.exports = { extractEntities, chunkText, health, SYSTEM_PROMPT };

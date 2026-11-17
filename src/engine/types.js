'use strict';
// Типы сущностей. Код типа попадает в токен: [PER-7K2QX9]
const TYPES = {
  PER: 'ФИО / физлицо',
  ORG: 'Организация',
  ADDR: 'Адрес',
  DOC: 'Номер договора / дела / документа',
  ID: 'Иной идентификатор',
  ACC: 'Банковский счёт',
  CARD: 'Банковская карта',
  IBAN: 'IBAN',
  SWIFT: 'SWIFT/BIC',
  INN: 'ИНН',
  KPP: 'КПП',
  OGRN: 'ОГРН/ОГРНИП',
  BIK: 'БИК',
  SNILS: 'СНИЛС',
  PASS: 'Паспорт',
  PHONE: 'Телефон',
  EMAIL: 'Email',
};

// Типы, которые ищет LLM (остальное — регулярками)
const LLM_TYPES = ['PER', 'ORG', 'ADDR', 'DOC', 'ID'];

// Ключ токена: [ТИП-XXXXXX] или [ТИП-XXXXXX-N] для N-й словоформы той же сущности.
// Допускаем экранирование \[ \] (так иногда отдают markdown-редакторы и внешние LLM).
const TOKEN_RE = /\\?\[([A-Z]{2,5})-([2-9A-HJKMNP-Z]{6})(?:-(\d{1,3}))?\\?\]/g;

module.exports = { TYPES, LLM_TYPES, TOKEN_RE };

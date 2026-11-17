'use strict';
// AES-256-GCM для исходных значений в таблице соответствий.
const crypto = require('crypto');
const { config } = require('./config');

let key;
function getKey() {
  if (!key) key = Buffer.from(config.masterKey, 'base64');
  return key;
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', getKey(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

// HMAC с ключом, производным от мастер-ключа (для поиска значений без расшифровки)
let hkey;
function hmac(data) {
  if (!hkey) hkey = Buffer.from(crypto.hkdfSync('sha256', getKey(), Buffer.alloc(0), 'wsp-anonymizer-hmac', 32));
  return crypto.createHmac('sha256', hkey).update(String(data), 'utf8').digest('base64');
}

// Алфавит без похожих символов (0/O, 1/I/L), чтобы токен не «ломался» при перепечатке
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function randomId(len = 6) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

module.exports = { encrypt, decrypt, hmac, randomId, ALPHABET };

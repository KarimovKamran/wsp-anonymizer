'use strict';
const { config } = require('../config');

/** Разбор DN вида "emailAddress=a@b.ru,CN=ivanov,O=WSP" (RFC 2253, как отдаёт nginx $ssl_client_s_dn). */
function parseDn(dn) {
  const out = {};
  if (!dn) return out;
  for (const part of String(dn).split(/(?<!\\),/)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim().toUpperCase()] = part.slice(i + 1).trim().replace(/\\(.)/g, '$1');
  }
  return out;
}

/**
 * Первый рубеж: приложение слушает только 127.0.0.1, а nginx с ssl_verify_client on
 * пропускает только клиентов с сертификатом нашего УЦ и проставляет заголовки.
 * Здесь дополнительно проверяем, что запрос действительно пришёл через mTLS.
 */
function requireClientCert(req, res, next) {
  if (!config.requireClientCert) { req.clientCert = null; return next(); }
  if (req.get('X-SSL-Client-Verify') !== 'SUCCESS') {
    return res.status(403).json({ error: 'Требуется действительный клиентский сертификат' });
  }
  const dn = req.get('X-SSL-Client-S-DN') || '';
  req.clientCert = { dn, serial: req.get('X-SSL-Client-Serial') || '', fields: parseDn(dn) };
  return next();
}

/** Опционально: сертификат должен принадлежать тому же пользователю, что вошёл в AD. */
function certMatchesUser(cert, user) {
  if (config.certUserMatch === 'off' || !config.requireClientCert) return true;
  if (!cert) return false;
  const cands = [user.username, user.upn, user.email, (user.upn || '').split('@')[0]]
    .filter(Boolean).map((s) => s.toLowerCase());
  const v = config.certUserMatch === 'cn' ? cert.fields.CN : (cert.fields.EMAILADDRESS || cert.fields.E);
  return !!v && cands.includes(v.toLowerCase());
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Требуется вход' });
  // Сертификат не должен меняться в рамках сессии
  if (config.requireClientCert && req.session.certSerial && req.clientCert && req.session.certSerial !== req.clientCert.serial) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Сертификат изменился, войдите заново' });
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.is_admin) return res.status(403).json({ error: 'Только для администраторов' });
  return next();
}

/** Простая защита от CSRF: все изменяющие запросы API должны идти из нашего JS с заголовком. */
function csrfHeader(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'anonymizer') return res.status(403).json({ error: 'CSRF' });
  return next();
}

/** Ограничение перебора паролей: N неудачных попыток за окно -> блок. */
const fails = new Map();
const LIMIT = 5;
const WINDOW = 15 * 60 * 1000;
function loginLimiter(key) {
  const now = Date.now();
  const rec = fails.get(key);
  if (rec && now - rec.first > WINDOW) fails.delete(key);
  return {
    blocked: () => { const r = fails.get(key); return !!r && r.count >= LIMIT; },
    fail: () => { const r = fails.get(key) || { count: 0, first: now }; r.count++; fails.set(key, r); },
    reset: () => fails.delete(key),
  };
}
setInterval(() => { const now = Date.now(); for (const [k, r] of fails) if (now - r.first > WINDOW) fails.delete(k); }, WINDOW).unref();

module.exports = { requireClientCert, certMatchesUser, requireAuth, requireAdmin, csrfHeader, loginLimiter, parseDn };

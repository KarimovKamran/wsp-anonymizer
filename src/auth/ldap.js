'use strict';
// Аутентификация в Active Directory: сервисный bind -> поиск пользователя -> bind паролем пользователя.
// Членство в группах проверяется с учётом вложенности (LDAP_MATCHING_RULE_IN_CHAIN).
const fs = require('fs');
const { Client } = require('ldapts');
const { config } = require('../config');

const IN_CHAIN = '1.2.840.113556.1.4.1941';

function escapeFilter(v) {
  return String(v).replace(/[\\*()\0/]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function client() {
  const c = config.ldap;
  const tlsOptions = c.url.startsWith('ldaps://')
    ? { rejectUnauthorized: c.tlsRejectUnauthorized, ...(c.caFile ? { ca: [fs.readFileSync(c.caFile)] } : {}) }
    : undefined;
  return new Client({ url: c.url, timeout: c.timeoutMs, connectTimeout: c.timeoutMs, tlsOptions });
}

async function inGroup(cl, userDn, groupDn) {
  if (!groupDn) return true;
  const { searchEntries } = await cl.search(userDn, {
    scope: 'base',
    filter: `(memberOf:${IN_CHAIN}:=${escapeFilter(groupDn)})`,
    attributes: ['dn'],
  });
  return searchEntries.length > 0;
}

/**
 * @returns {Promise<{username, displayName, email, upn, isAdmin}>}
 * @throws Error с полем code: 'INVALID' | 'FORBIDDEN' | 'LDAP'
 */
async function authenticate(username, password) {
  const c = config.ldap;
  // Разрешаем ввод в форматах user, DOMAIN\user, user@domain
  const login = String(username).trim().replace(/^.*\\/, '').replace(/@.*$/, '');
  if (!/^[\w.\-]{1,64}$/.test(login) || !password) {
    const e = new Error('Неверный логин или пароль'); e.code = 'INVALID'; throw e;
  }
  const svc = client();
  let entry;
  try {
    await svc.bind(c.bindDn, c.bindPassword);
    const { searchEntries } = await svc.search(c.baseDn, {
      scope: 'sub',
      filter: `(&(objectCategory=person)(objectClass=user)(${c.userAttr}=${escapeFilter(login)})(!(userAccountControl:1.2.840.113556.1.4.803:=2)))`,
      attributes: ['dn', 'sAMAccountName', 'displayName', 'mail', 'userPrincipalName'],
      sizeLimit: 2,
    });
    if (searchEntries.length !== 1) { const e = new Error('Неверный логин или пароль'); e.code = 'INVALID'; throw e; }
    entry = searchEntries[0];

    const allowed = await inGroup(svc, entry.dn, c.allowedGroupDn);
    if (!allowed) { const e = new Error('Нет доступа: учётная запись не входит в разрешённую группу'); e.code = 'FORBIDDEN'; throw e; }
    entry.isAdmin = c.adminGroupDn ? await inGroup(svc, entry.dn, c.adminGroupDn) : false;
  } catch (e) {
    if (!e.code || !['INVALID', 'FORBIDDEN'].includes(e.code)) { const err = new Error(`Ошибка LDAP: ${e.message}`); err.code = 'LDAP'; throw err; }
    throw e;
  } finally {
    await svc.unbind().catch(() => {});
  }

  const usr = client();
  try {
    await usr.bind(entry.dn, password);
  } catch {
    const e = new Error('Неверный логин или пароль'); e.code = 'INVALID'; throw e;
  } finally {
    await usr.unbind().catch(() => {});
  }

  const one = (v) => (Array.isArray(v) ? v[0] : v) || '';
  return {
    username: one(entry.sAMAccountName) || login,
    displayName: one(entry.displayName) || login,
    email: one(entry.mail),
    upn: one(entry.userPrincipalName),
    isAdmin: entry.isAdmin,
  };
}

/** Режим разработки: пользователи из DEV_USERS=user:pass[:admin],... */
async function authenticateDev(username, password) {
  for (const def of config.devUsers) {
    const [u, p, admin] = def.split(':');
    if (u === username && p === password) {
      return { username: u, displayName: u, email: '', upn: '', isAdmin: admin === 'admin' };
    }
  }
  const e = new Error('Неверный логин или пароль'); e.code = 'INVALID'; throw e;
}

module.exports = {
  authenticate: (u, p) => (config.authMode === 'dev' ? authenticateDev(u, p) : authenticate(u, p)),
  escapeFilter,
};

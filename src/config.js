'use strict';
// Конфигурация берётся из переменных окружения (systemd EnvironmentFile=/etc/wsp-anonymizer/anonymizer.env
// или `node --env-file=.env` при разработке). См. .env.example.
const path = require('path');

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));

const config = {
  env: env.NODE_ENV || 'development',
  host: env.HOST || '127.0.0.1',
  port: int(env.PORT, 3000),
  dataDir,
  dbPath: path.join(dataDir, 'anonymizer.db'),
  uploadDir: path.join(dataDir, 'uploads'),
  resultDir: path.join(dataDir, 'results'),
  maxUploadMb: int(env.MAX_UPLOAD_MB, 50),

  // Мастер-ключ (32 байта base64) — шифрует исходные значения в таблице соответствий.
  // Потеря ключа = невозможность деанонимизации. Хранить отдельно от БД, делать бэкап.
  masterKey: env.MASTER_KEY || '',
  sessionSecret: env.SESSION_SECRET || '',
  sessionHours: int(env.SESSION_HOURS, 8),

  // Сохранение
  resultTtlHours: int(env.RESULT_TTL_HOURS, 72), // через сколько удалять готовые файлы
  mappingTtlDays: int(env.MAPPING_TTL_DAYS, 365), // через сколько удалять таблицы соответствий (0 = никогда)

  // Проверка клиентского сертификата (nginx mTLS)
  requireClientCert: bool(env.REQUIRE_CLIENT_CERT, true),
  // off | cn | email — требовать, чтобы CN/email сертификата совпадал с учёткой AD
  certUserMatch: env.CERT_USER_MATCH || 'off',

  // Аутентификация
  authMode: env.AUTH_MODE || 'ldap', // ldap | dev (dev — только для разработки!)
  devUsers: list(env.DEV_USERS || 'admin:admin:admin'), // user:pass[:admin]
  ldap: {
    url: env.LDAP_URL || 'ldaps://dc01.wsp.local:636',
    bindDn: env.LDAP_BIND_DN || '',
    bindPassword: env.LDAP_BIND_PASSWORD || '',
    baseDn: env.LDAP_BASE_DN || 'DC=wsp,DC=local',
    userAttr: env.LDAP_USER_ATTR || 'sAMAccountName',
    allowedGroupDn: env.LDAP_ALLOWED_GROUP_DN || '', // пусто = любой пользователь домена
    adminGroupDn: env.LDAP_ADMIN_GROUP_DN || '',
    caFile: env.LDAP_CA_FILE || '',
    tlsRejectUnauthorized: bool(env.LDAP_TLS_REJECT_UNAUTHORIZED, true),
    timeoutMs: int(env.LDAP_TIMEOUT_MS, 8000),
  },

  // LLM (Ollama)
  llm: {
    enabled: bool(env.LLM_ENABLED, true),
    url: (env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
    model: env.OLLAMA_MODEL || 'qwen3:14b',
    numCtx: int(env.OLLAMA_NUM_CTX, 8192),
    chunkChars: int(env.LLM_CHUNK_CHARS, 3000),
    timeoutMs: int(env.LLM_TIMEOUT_MS, 300000),
    keepAlive: env.OLLAMA_KEEP_ALIVE || '30m',
  },

  // Словарь известных сущностей (проверка до LLM)
  known: {
    enabled: bool(env.KNOWN_DICT_ENABLED, true),
    types: list(env.KNOWN_DICT_TYPES || 'PER,ORG,ADDR,DOC,ID'),
    minLen: int(env.KNOWN_DICT_MIN_LEN, 4),
    // Маскировать уже найденное перед отправкой в LLM: модель ищет только новое
    maskForLlm: bool(env.KNOWN_MASK_FOR_LLM, true),
  },

  queueConcurrency: int(env.QUEUE_CONCURRENCY, 1),
  ocrLangs: env.OCR_LANGS || 'rus+eng',
  ocrDpi: int(env.OCR_DPI, 300),
  // Если в PDF в среднем меньше N символов текста на страницу — считаем его сканом
  ocrMinCharsPerPage: int(env.OCR_MIN_CHARS_PER_PAGE, 80),
};

function validate() {
  const errors = [];
  if (Buffer.from(config.masterKey, 'base64').length !== 32) {
    errors.push('MASTER_KEY должен быть 32 байта в base64 (openssl rand -base64 32)');
  }
  if (config.sessionSecret.length < 32) errors.push('SESSION_SECRET должен быть не короче 32 символов');
  if (config.env === 'production' && config.authMode === 'dev') {
    errors.push('AUTH_MODE=dev запрещён при NODE_ENV=production');
  }
  if (config.authMode === 'ldap' && (!config.ldap.bindDn || !config.ldap.bindPassword)) {
    errors.push('Для AUTH_MODE=ldap нужны LDAP_BIND_DN и LDAP_BIND_PASSWORD');
  }
  if (!['off', 'cn', 'email'].includes(config.certUserMatch)) errors.push('CERT_USER_MATCH: off | cn | email');
  return errors;
}

module.exports = { config, validate };

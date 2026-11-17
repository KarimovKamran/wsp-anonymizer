# WSP Anonymizer

Внутренний веб-сервис White Square Partners: загружаешь документ — получаешь копию, где ФИО, организации, адреса, реквизиты и номера документов заменены токенами `[PER-7K2QX9]`. Таблица соответствий хранится зашифрованной в SQLite, по ней документ (или ответ внешнего ИИ) можно вернуть к исходному виду.

## Архитектура

```
Браузер ──mTLS──> nginx :443 ──> Node.js/Express :3000 (127.0.0.1) ──HTTP──> Ollama (GPU-сервер)
           (сертификат                 │  SQLite: users, jobs, entities (AES-256-GCM), audit, sessions
            нашего УЦ)                 │  poppler-utils + tesseract (PDF / OCR)
                                       └─ LDAPS -> Active Directory (логин + группы)
```

**Доступ — два фактора:** без клиентского сертификата nginx не откроет даже страницу входа; дальше логин/пароль AD + проверка членства в группе. При `CERT_USER_MATCH=cn` сертификат должен быть выписан на того же пользователя. Смена сертификата посреди сессии = разлогин.

## Как находятся данные

| Что | Чем | Типы |
|---|---|---|
| Реквизиты | регулярки + контрольные суммы (ИНН, ОГРН, Луна для карт, mod‑97 для IBAN) | ACC, CARD, IBAN, SWIFT, INN, KPP, OGRN, BIK, SNILS, PASS, PHONE, EMAIL, кадастровые номера |
| Смысловые сущности | локальная LLM через Ollama (JSON по схеме) | PER, ORG, ADDR, DOC, ID |

- Модель **не переписывает текст** — только возвращает список найденных фрагментов. Замена детерминированная; фрагменты, которых нет в тексте (галлюцинации), отбрасываются.
- Все формы одной сущности получают одну группу: `[PER-7K2QX9]` — «Иванова Ивана Ивановича», `[PER-7K2QX9-2]` — «Иванов И.И.». Внешний ИИ видит, что это один человек, а деанонимизация вернёт точную словоформу.
- Найденная сущность заменяется **по всему документу**, даже там, где модель её пропустила.

### Словарь известных сущностей (проверка до LLM)

Порядок обработки документа:

1. Регулярки находят реквизиты, **словарь** — ФИО, организации, адреса и номера, которые модель уже находила в прошлых документах.
2. Всё найденное в тексте для модели заменяется плейсхолдерами (`[ORG]`, `[PER]`, …). Модель видит, что там скрытая сущность, и ищет только **новое**. Нормальные формы известных лиц передаются ей подсказкой, чтобы «Иванов И.И.» попал в ту же группу, что и полное ФИО.
3. Новые находки модели пополняют словарь (`known_entities`: значения зашифрованы, дубли отсекаются по HMAC).

Что это даёт: уже встречавшиеся значения находятся всегда, даже если модель в этот раз их пропустит; модель тратит меньше внимания на известное.

Вкладка **«Словарь»** (только админы): поиск, счётчик документов, отключение и удаление. **Отключённая** запись — это «не конфиденциально» (например, ошибочно найденное «Генеральный директор»): она не заменяется, даже если модель найдёт её снова. Удалённая — вернётся, если модель снова её найдёт.

Словарь общий для всех пользователей, но никому не показывает чужие значения: он лишь находит в документе то, что уже в этом документе есть. Токены по-прежнему свои у каждого задания, так что изоляция деанонимизации сохраняется. Записи, не встречавшиеся дольше `MAPPING_TTL_DAYS`, удаляются.

Настройки: `KNOWN_DICT_ENABLED`, `KNOWN_DICT_TYPES`, `KNOWN_DICT_MIN_LEN` (короче — не запоминаем), `KNOWN_MASK_FOR_LLM`.

## Форматы

| Вход | Выход | Примечание |
|---|---|---|
| DOCX | DOCX | Форматирование, таблицы, колонтитулы, сноски, примечания сохраняются. Чистятся автор, «кем изменено», авторы правок/комментариев, mailto-ссылки |
| PDF с текстом | DOCX | Текст по абзацам, вёрстка не сохраняется |
| Скан PDF / PNG / JPG / TIFF | DOCX | OCR tesseract rus+eng, исправление латиницы/кириллицы (OOO → ООО) |
| TXT / вставка текста | TXT | |

Деанонимизация: DOCX, PDF, TXT или вставленный текст. Пользователь восстанавливает только токены своих заданий, администратор — любые.

**Ограничения:** текст внутри картинок в DOCX (печати, подписи, сканы-вставки) не обрабатывается. Результат OCR надо проверять глазами.

## Установка (CentOS Stream 9)

```bash
git clone … /root/wsp-anonymizer && cd /root/wsp-anonymizer
bash deploy/install.sh                 # пакеты, пользователь, /opt, systemd, nginx, SELinux, firewall
bash deploy/pki/init-ca.sh             # УЦ клиентских сертификатов (пароль ключа — в Teampass)
cp server.crt server.key /etc/wsp-anonymizer/tls/   # серверный сертификат (лучше от AD CS)
vi /etc/wsp-anonymizer/anonymizer.env  # LDAP_*, OLLAMA_*
systemctl restart wsp-anonymizer && nginx -t && systemctl restart nginx
```

### AD

1. Сервисная учётка `svc-anonymizer` (только чтение каталога, без входа на ПК).
2. Группы `GG-Anonymizer-Users` и `GG-Anonymizer-Admins` (вложенные группы работают).
3. Корневой сертификат AD CS в PEM → `LDAP_CA_FILE` (для ldaps).

### Клиентские сертификаты

```bash
bash deploy/pki/issue-client.sh ivanov ivanov@whitesquarepartners.com   # -> /etc/wsp-anonymizer/pki/out/ivanov.p12 + пароль
bash deploy/pki/revoke-client.sh ivanov                                   # отзыв + обновление CRL + reload nginx
```
`.p12` раздать через ManageEngine Endpoint Central или вручную («Текущий пользователь» → «Личное»). Пароль — отдельным каналом.
Альтернатива: шаблон автоматической выдачи в корпоративном AD CS — тогда в nginx `ssl_client_certificate` = цепочка AD CS, а `CERT_USER_MATCH=email`.

### Ollama (на GPU-машине)

```bash
curl -fsSL https://ollama.com/install.sh | sh
systemctl edit ollama   # [Service]
                        # Environment="OLLAMA_HOST=0.0.0.0:11434"
                        # Environment="OLLAMA_NUM_PARALLEL=2"
                        # Environment="OLLAMA_MAX_LOADED_MODELS=2"
systemctl restart ollama && ollama pull qwen3:14b
firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=<IP анонимайзера>/32 port port=11434 protocol=tcp accept'
firewall-cmd --reload
```
У Ollama нет аутентификации — порт 11434 открывать **только** для сервера анонимайзера (и других доверенных внутренних сервисов). Модель меняется в `OLLAMA_MODEL`; на GPU с 24–32 ГБ разумно попробовать `qwen3:32b` / `gemma3:27b`.

## Резервное копирование

Нужны **оба**: БД и `MASTER_KEY`. Без ключа таблицы замен не расшифровать.
```bash
sqlite3 /var/lib/wsp-anonymizer/anonymizer.db ".backup '/backup/anonymizer-$(date +%F).db'"
```
`MASTER_KEY` — в Teampass, не рядом с бэкапом БД.

## Сроки хранения

- исходный файл — удаляется сразу после обработки;
- результат — `RESULT_TTL_HOURS` (по умолчанию 72 ч);
- таблица замен — `MAPPING_TTL_DAYS` (по умолчанию 365 дн., 0 — бессрочно); удаление задания в интерфейсе стирает её сразу;
- журнал действий — 3 года.

## Разработка

```bash
npm install
cp .env.example .env   # AUTH_MODE=dev, DEV_USERS=admin:admin:admin, REQUIRE_CLIENT_CERT=false, NODE_ENV=development
npm run dev
npm test               # поднимает mock-Ollama сам; нужны python3-docx, poppler-utils, tesseract
```

## API

| Метод | Путь | |
|---|---|---|
| POST | `/api/login` `/api/logout` | `{username, password}` |
| GET | `/api/me` `/api/health` | |
| POST | `/api/jobs` | multipart `file` → задание в очередь |
| GET | `/api/jobs[?all=1]` `/api/jobs/:id` | |
| GET | `/api/jobs/:id/download` `/api/jobs/:id/entities` | |
| DELETE | `/api/jobs/:id` | вместе с таблицей замен |
| POST | `/api/deanonymize` | multipart `file` → файл, отчёт в заголовке `X-Deanon-Report` |
| POST | `/api/deanonymize/text` | `{text}` → `{text, report}` |
| GET | `/api/admin/audit` | только админ |
| GET / PATCH / DELETE | `/api/admin/dictionary[/:id]` | словарь: список, `{enabled}`, удаление (только админ) |

Все POST/DELETE требуют заголовок `X-Requested-With: anonymizer` (защита от CSRF).

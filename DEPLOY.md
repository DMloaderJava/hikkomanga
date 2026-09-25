# Деплой Hikkomanga

Короткая шпаргалка по выкладке. Подробности и troubleshooting —
[`SETUP_SUPABASE.md`](./SETUP_SUPABASE.md) (раздел 9 — «Приём заявок»).

## Что деплоится автоматически

- **Vercel** — фронтенд, при пуше в `main`.
- **Supabase Edge Functions** — вручную, через CLI (см. ниже).
- **Миграции SQL** — вручную, через CLI (`supabase db query`) или SQL Editor.

Supabase-проект: `islgkqdsztchzajnulof` (он же в `supabase/.temp/project-ref`,
`.env.production` и в `supabase link`). Сверить одной командой:

```bash
npm run check:supabase
```

## Порядок первого деплоя системы заявок (анонимные `new_title`)

### 1. Миграции Supabase

SQL Editor → выполнить по порядку:

- `supabase/migrations/00000000000010_submission_columns.sql`
- `supabase/migrations/00000000000011_requests_rls_anon.sql`
- `supabase/migrations/00000000000012_rate_limit_ip.sql`
- `supabase/migrations/00000000000013_submissions_cleanup.sql`
- `supabase/migrations/00000000000014_new_title_trigger.sql`
- `supabase/migrations/00000000000015_chapter_submissions.sql` (заявки на главы)
- `supabase/migrations/00000000000017_user_api_keys.sql` (персональные Gemini-ключи)

Отдельно, если `npm run check:supabase` показывает ✗ у бакета: выполнить
`insert` из `00000000000002_storage_buckets.sql` (создаёт `manga` и
`hikko-originals` с политиками).

Или через CLI (по одному файлу):

```bash
supabase db query --linked -f supabase/migrations/00000000000010_submission_columns.sql
supabase db query --linked -f supabase/migrations/00000000000011_requests_rls_anon.sql
supabase db query --linked -f supabase/migrations/00000000000012_rate_limit_ip.sql
supabase db query --linked -f supabase/migrations/00000000000013_submissions_cleanup.sql
supabase db query --linked -f supabase/migrations/00000000000014_new_title_trigger.sql
supabase db query --linked -f supabase/migrations/00000000000015_chapter_submissions.sql
supabase db query --linked -f supabase/migrations/00000000000017_user_api_keys.sql
```

> ⚠️ **`supabase db push` на этом проекте не работает.** Локальная история
> миграций Supabase пуста (схема 00–08 накатывалась руками через SQL Editor),
> поэтому `db push` пытается выполнить 01–08 повторно и падает на
> `policy already exists`, не доходя до новых файлов. Накатывайте файлы по
> одному (`supabase db query --linked -f …`) — они идемпотентны. Команды
> `supabase db execute` в CLI 2.x больше нет, её заменил `db query`.

Проверка, что применилось (SQL Editor):

```sql
select column_name from information_schema.columns
where table_name = 'admin_requests'
  and column_name in ('ip_hash','user_agent','turnstile_ok','public_token','submitter_email','conflict');
-- должно вернуть 6 строк

select id, public from storage.buckets where id = 'submissions';
-- должно вернуть одну строку с public = true

select proname from pg_proc
where proname in ('check_ip_rate_limit','cleanup_ip_rate_limit','cleanup_rejected_submissions','slugify_title');
-- должно вернуть 4 строки
```

### 2. Секреты edge-функций

```bash
supabase secrets set \
  RATE_LIMIT_SALT="$(openssl rand -hex 32)" \
  CAPTCHA_PROVIDER=recaptcha \
  RECAPTCHA_SECRET_KEY="<secret key того же виджета>" \
  USER_KEY_ENC_SECRET="$(openssl rand -base64 32)"
```

- Капча: провайдер должен совпадать с site key, зашитым в сборку
  (`.env.production` → `VITE_CAPTCHA_PROVIDER=recaptcha`). Альтернативы:
  `CAPTCHA_PROVIDER=turnstile TURNSTILE_SECRET_KEY=0x...` или
  `CAPTCHA_PROVIDER=hcaptcha HCAPTCHA_SECRET_KEY=0x...`.
  Если секрет провайдера не задан, `submit-title`/`submit-chapters` отвечают
  400 `*_secret_missing` — заявки не проходят.
- `USER_KEY_ENC_SECRET` — ключ шифрования персональных Gemini-ключей админов
  (AES-256-GCM, `/admin/settings`). **Потеря или смена секрета делает все
  сохранённые ключи нечитаемыми** — порядок ротации в SETUP_SUPABASE.md,
  «Ротация USER_KEY_ENC_SECRET».

`RESEND_API_KEY` и `OWNER_NOTIFY_EMAIL` уже используются Login Guard; ими же
подписывается письмо заявителю (`notify-submitter`), поэтому повторно задавать
их не нужно (опционально `OWNER_NOTIFY_FROM`).

Проверка: `supabase secrets list` (значения не показываются — это нормально).

### 3. Деплой edge-функций

```bash
# Публичные (заявки без JWT) и функции под сессией: какие именно значения
# verify_jwt нужны каждой функции, зафиксировано в supabase/config.toml,
# поэтому флаги больше не нужны — CLI читает файл. Флаг --no-verify-jwt
# по-прежнему перекрывает значение из config.toml, но помнить о нём не надо.
supabase functions deploy submit-title
supabase functions deploy get-submission
supabase functions deploy submit-chapters

# Под сессией (JWT проверяет сама функция — см. config.toml):
supabase functions deploy gemini-proxy               # AI-анализ и озвучка страниц
supabase functions deploy dialog-tts                 # озвучка диалога (Speaker N: …) → WAV
supabase functions deploy chat                       # support-чат в боковой панели (SSE)
supabase functions deploy admin-api-keys             # /admin/settings: свой Gemini key
supabase functions deploy notify-submitter           # письмо заявителю о решении
supabase functions deploy finalize-chapter-submission # перенос глав при approve

# Login Guard — только если менялся их код:
supabase functions deploy login-notify
supabase functions deploy login-confirm
```

> `supabase/config.toml` в репозитории есть с миграции 17 (2026-09). Раньше его
> не было, и публичные функции деплоились только с флагом `--no-verify-jwt` —
> без флага шлюз отдавал 401 ещё до кода функции. Если правите деплой-скрипты,
> сверяйтесь с файлом, а не с этой шпаргалкой: истина по `verify_jwt` — в нём.

`submit-title` / `submit-chapters` — публичные: rate-limit по
`sha256(ip + RATE_LIMIT_SALT)` → капча → валидация → upload в бакет
`submissions` под `service_role` → INSERT в `admin_requests`. Запись анонима
напрямую в таблицу закрыта RLS («no anon insert»).
`gemini-proxy` / `dialog-tts` / `admin-api-keys` работают на **персональном**
ключе админа из `user_api_keys` (общего `GEMINI_API_KEY` в прод-пути нет).
`chat` берёт ключ так: свой → ключ владельца проекта → ключ первого админа,
у которого он сохранён (читателю свой ключ завести негде, но чат ему нужен);
роль admin для чата не требуется, только авторизация.

### 4. Vercel env + Redeploy

Vercel → Settings → Environment Variables (Production и Preview):

- `VITE_SITE_URL=https://<домен>` (canonical, sitemap, og:url)
- `VITE_CAPTCHA_PROVIDER=recaptcha` + `VITE_RECAPTCHA_SITE_KEY=...`
  (`recaptcha` уже зашит в `.env.production`, так что переменные на Vercel
  нужны только чтобы переопределить провайдера при смене виджета)

После сохранения — обязательный **Redeploy**: Vite вшивает env на этапе сборки.
Секреты (`RECAPTCHA_SECRET_KEY`, `USER_KEY_ENC_SECRET`, `RATE_LIMIT_SALT`)
остаются только в Supabase — на Vercel их быть не должно.

Если Supabase-значения на Vercel названы по Next.js-шаблону
(`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`), дублировать их в
`VITE_*` не обязательно: `envPrefix` в `vite.config.ts` читает и `NEXT_PUBLIC_*`.
Проверка после пересборки — первый раздел `npm run check:supabase`: там видно,
какой URL/ключ увидела сборка. Не переименовывайте переменные в
`SUPABASE_ANON_KEY`: префикс `SUPABASE_` в браузерный бандл не попадает (защита
от `SUPABASE_SERVICE_ROLE_KEY`), для клиента нужно имя `VITE_SUPABASE_ANON_KEY`.

### 5. Свой Gemini key у админа (после миграции 17 и деплоя функций)

Каждый админ заходит в `/admin/settings`, вставляет ключ из Google AI Studio
(`AQ.…` или `AIza…`) и получает статус «подключён». Пока ключа нет,
`gemini-proxy` отвечает 403 `gemini_key_missing`. Общий `GEMINI_API_KEY`
в проде не нужен (он остался только для dev-мидлвари `npm run dev`).

### 6. Cron (опционально)

Supabase Dashboard → Database → Cron:

```sql
select cron.schedule('cleanup-submissions', '0 4 * * *',
  $$select public.cleanup_rejected_submissions()$$);
select cron.schedule('cleanup-ip-rate-limit', '5 4 * * *',
  $$select public.cleanup_ip_rate_limit()$$);
```

### 7. Проверка

```bash
npm run check:covers
npm run check:supabase
# живая база: нужны SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY в env
SUPABASE_URL=https://islgkqdsztchzajnulof.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=... npm run check:submissions
```

`npm run check:supabase` печатает таблицы (включая `user_api_keys`), RPC, бакеты
и деплой функций (`login-*`, `gemini-proxy`, `dialog-tts`, `chat`,
`admin-api-keys`): 404 = функция не задеплоена, 401 с нашим телом
`unauthorized` = задеплоена и закрыта.

Smoke без браузера (ключ publishable публичный):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "https://islgkqdsztchzajnulof.supabase.co/functions/v1/get-submission" \
  -H "apikey: <publishable-key>" -H "Content-Type: application/json" \
  -d '{"token":"nonexistent"}'
# ожидаемо: 404 (заявки с таким токеном нет); 401 = verify_jwt включился
# при деплое без --no-verify-jwt

curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "https://islgkqdsztchzajnulof.supabase.co/functions/v1/submit-chapters" \
  -H "apikey: <publishable-key>" -H "Content-Type: application/json" -d '{}'
# ожидаемо: 400 (валидация тела), 404 = функция не задеплоена
```

И вручную: прод → «+» → «Предложить тайтл» → заполнить → отправить → заявка
видна в `/admin/requests`; письмо о решении уходит, если заявитель оставил email.
Отдельно: `/admin/settings` → вставить ключ Gemini → статус «подключён».

## Откат

```bash
git revert <merge-commit>
git push
```

Vercel поднимет предыдущую сборку. Миграции откатываются вручную
(`drop table public.ip_rate_limit`, `drop function …`, удаление колонок
`admin_requests`), edge-функции — повторным `supabase functions deploy`
из предыдущего коммита.

## Известные особенности

- Бакет `hikko-originals` из `00000000000002_storage_buckets.sql` на проекте
  отсутствует (`npm run check:supabase` показывает ✗) — файл накатывался руками
  до правок, нужно выполнить его `insert into storage.buckets …` отдельно.
- `verify_jwt` для каждой функции зафиксирован в `supabase/config.toml`
  (раньше файла не было, и значение задавалось только флагом деплоя).
  Публичные (`submit-title`, `get-submission`, `submit-chapters`) — `false`,
  AI-функции под сессией (`gemini-proxy`, `dialog-tts`, `chat`) — тоже `false`,
  потому что вход они проверяют сами и должны отдавать свои коды ошибок.
  Проверка: анонимный POST без `Authorization` отвечает 400 (ок) или 401
  (verify_jwt включился, заявки сломаны); `npm run check:supabase` показывает
  и то, и другое по всем функциям сразу.
- Edge-функции **не** покрыты `npm run typecheck` (`tsconfig.json` → `include: ["src"]`),
  поэтому ошибки вроде вызова RPC с чужим именем параметра ловятся только
  вызовом функции. После деплоя всегда проверяйте её вызовом (см. раздел 7).

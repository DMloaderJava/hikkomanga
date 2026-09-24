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

Или через CLI (по одному файлу):

```bash
supabase db query --linked -f supabase/migrations/00000000000010_submission_columns.sql
supabase db query --linked -f supabase/migrations/00000000000011_requests_rls_anon.sql
supabase db query --linked -f supabase/migrations/00000000000012_rate_limit_ip.sql
supabase db query --linked -f supabase/migrations/00000000000013_submissions_cleanup.sql
supabase db query --linked -f supabase/migrations/00000000000014_new_title_trigger.sql
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
  CAPTCHA_PROVIDER=turnstile \
  TURNSTILE_SECRET_KEY="0x..."
```

Для hCaptcha вместо Turnstile:

```bash
supabase secrets set CAPTCHA_PROVIDER=hcaptcha HCAPTCHA_SECRET_KEY="0x..."
```

`RESEND_API_KEY` и `OWNER_NOTIFY_EMAIL` уже используются Login Guard; ими же
подписывается письмо заявителю (`notify-submitter`), поэтому повторно задавать
их не нужно (опционально `OWNER_NOTIFY_FROM`).

Проверка: `supabase secrets list` (значения не показываются — это нормально).

### 3. Деплой edge-функций

```bash
supabase functions deploy submit-title
supabase functions deploy get-submission
supabase functions deploy notify-submitter   # опционально
```

`submit-title` — публичная (клиент шлёт только `apikey`), защита внутри:
rate-limit по `sha256(ip + RATE_LIMIT_SALT)` → Turnstile/hCaptcha → валидация →
upload в бакет `submissions` под `service_role` → INSERT в `admin_requests`.
Запись анонима напрямую в таблицу закрыта RLS («no anon insert»).

### 4. Vercel env + Redeploy

Vercel → Settings → Environment Variables (Production и Preview):

- `VITE_CAPTCHA_PROVIDER=turnstile` (или `hcaptcha`)
- `VITE_TURNSTILE_SITE_KEY=...` (или `VITE_HCAPTCHA_SITE_KEY=...` при hCaptcha)

После сохранения — обязательный **Redeploy**: Vite вшивает env на этапе сборки.

Если Supabase-значения на Vercel названы по Next.js-шаблону
(`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`), дублировать их в
`VITE_*` не обязательно: `envPrefix` в `vite.config.ts` читает и `NEXT_PUBLIC_*`.
Проверка после пересборки — первый раздел `npm run check:supabase`: там видно,
какой URL/ключ увидела сборка. Не переименовывайте переменные в
`SUPABASE_ANON_KEY`: префикс `SUPABASE_` в браузерный бандл не попадает (защита
от `SUPABASE_SERVICE_ROLE_KEY`), для клиента нужно имя `VITE_SUPABASE_ANON_KEY`.

### 5. Cron (опционально)

Supabase Dashboard → Database → Cron:

```sql
select cron.schedule('cleanup-submissions', '0 4 * * *',
  $$select public.cleanup_rejected_submissions()$$);
select cron.schedule('cleanup-ip-rate-limit', '5 4 * * *',
  $$select public.cleanup_ip_rate_limit()$$);
```

### 6. Проверка

```bash
npm run check:covers
npm run check:supabase
# живая база: нужны SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY в env
SUPABASE_URL=https://islgkqdsztchzajnulof.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=... npm run check:submissions
```

Smoke без браузера (ключ publishable публичный):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "https://islgkqdsztchzajnulof.supabase.co/functions/v1/get-submission" \
  -H "apikey: <publishable-key>" -H "Content-Type: application/json" \
  -d '{"token":"nonexistent"}'
# ожидаемо: 404 (заявки с таким токеном нет)
```

И вручную: прод → «+» → «Предложить тайтл» → заполнить → отправить → заявка
видна в `/admin/requests`; письмо о решении уходит, если заявитель оставил email.

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
- Edge-функции **не** покрыты `npm run typecheck` (`tsconfig.json` → `include: ["src"]`),
  поэтому ошибки вроде `p_limit` вместо `p_limit: limit` ловятся только
  smoke-тестом. После деплоя функции всегда проверяйте её вызовом.

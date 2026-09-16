# Подключение Supabase (в том числе через интеграцию в Lovable)

Клиент Supabase живёт в `src/integrations/supabase/`, а все обращения к данным —
в `src/data/*`. Каждый модуль устроен одинаково:

```ts
if (isSupabaseConfigured) { /* реальный Supabase */ }
/* иначе — fallback на mockStore (localStorage) */
```

Поэтому **без переменных окружения приложение не падает**, а молча работает на
локальном mock-хранилище. Это главный источник «Supabase подключён, но ничего не
сохраняется».

## 1. Переменные окружения

`src/integrations/supabase/config.ts` читает:

| Переменная | Обязательна | Откуда берётся |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | да | Supabase → Project Settings → API |
| `VITE_SUPABASE_ANON_KEY` **или** `VITE_SUPABASE_PUBLISHABLE_KEY` | да | там же (anon / publishable key) |
| `VITE_SUPABASE_PROJECT_ID` | нет | инжектит Lovable |
| `GEMINI_API_KEY` | для AI-фич | **без** префикса `VITE_` — это секрет |

Lovable при подключении проекта через **More → Cloud → «Already have a Supabase
project? Connect it here»** инжектит `VITE_SUPABASE_URL`,
`VITE_SUPABASE_PUBLISHABLE_KEY` и `VITE_SUPABASE_PROJECT_ID`. Раньше код знал
только `VITE_SUPABASE_ANON_KEY`, из-за чего `isSupabaseConfigured` оставался
`false` и приложение уходило в mockStore. Теперь принимаются оба имени.

Service-role key в браузер класть нельзя — в `VITE_*` он не читается специально.

Локально: создайте `.env` в корне (файл в `.gitignore`), затем `npm run dev`:

```bash
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon или publishable key>
GEMINI_API_KEY=<ключ Gemini>   # только для AI-анализа и озвучки в dev
```

## 2. Схема и RLS

Миграции лежат в `supabase/migrations/` — при подключении своего проекта Lovable
умеет накатывать их сам (показывает SQL и спрашивает подтверждение в чате), но
проще и надёжнее выполнить их по порядку в Supabase → SQL Editor:

1. `00000000000000_init.sql` — таблицы `genres`, `titles`, `title_genres`,
   `chapters`, `pages`, `user_roles`, функция `has_role()`, RLS-политики.
2. `00000000000001_voiceovers.sql` — `chapter_voiceovers` + бакет `voiceovers`.
3. `00000000000002_storage_buckets.sql` — бакеты `manga` (публичный) и
   `manga-originals` (приватный) + политики.
4. `00000000000003_login_challenges.sql` — таблица `login_challenges` + RPC
   `create_login_challenge` / `resolve_login_challenge` /
   `latest_login_challenge_status` (обязательное подтверждение входа).
5. `00000000000004_roles_and_requests.sql` — `has_role` (owner→admin), таблица
   `admin_requests`, rate-limit trigger.
6. `00000000000005_rate_limit_log.sql` — лог rate-limit.
7. `00000000000006_ads.sql` — таблица `ads` + RLS.
8. `00000000000007_apply_admin_request.sql` — триггер: approve → delete/create.
9. `00000000000008_login_challenge_multidevice.sql` — Login Guard multi-device:
   колонка `session_id` + `create_login_challenge(…, p_session_id)` /
   `latest_login_challenge_status` фильтрует по JWT `session_id`.
   Ноут (S1 approved) и телефон (S2 pending) независимы; новый login =
   новый session_id = снова письмо. **Не** «любой approved навсегда».

Если накатываете руками — держите файлы в репозитории в том же виде, чтобы
Lovable не предложил «создать схему заново» и не наплодил дублей таблиц.

## 3. Первый админ

RLS в `user_roles` разрешает только SELECT своих ролей, поэтому первую запись
нужно сделать через **Table Editor** или SQL Editor (оба обходят RLS):

1. Authentication → Users → **Add user** → email + пароль, галочка
   «Auto Confirm User» (или отключите *Confirm email* в
   Authentication → Providers → Email на время тестов — иначе `signInWithPassword`
   вернёт `Email not confirmed`).
2. Скопируйте UUID пользователя и выполните:

```sql
insert into public.user_roles (user_id, role)
values ('<uuid-пользователя>', 'admin')
on conflict do nothing;

grant execute on function public.has_role(uuid, text) to anon, authenticated;

select public.has_role('<uuid-пользователя>', 'admin'); -- должно вернуть true
```

Без строки в `user_roles` вход пройдёт, но `hasRole()` вернёт `false` и
админ-панель не пустит никого.

## 4. Edge-функция для Gemini

AI-анализ страниц и озвучка идут через `supabase/functions/gemini-proxy`
(роуты `/analyze` и `/tts`). Lovable деплоит функции сам, если попросить в чате;
вручную — так:

```bash
supabase functions deploy gemini-proxy --project-ref <project-ref>
supabase secrets set GEMINI_API_KEY=<ключ> --project-ref <project-ref>
```

Функция требует валидный `Authorization` (пользователь с ролью `admin`) и
возвращает 403 всем остальным.

В `vite.config.ts` есть dev-middleware `/api/gemini/*` — оно работает **только**
в `npm run dev`. На Lovable Cloud / Vercel этого middleware нет, там нужен
именно edge function; в `src/data/gemini.ts` функция и так вызывается первой, а
`/api/gemini/*` — запасной путь.

## 5. Как проверить, что Supabase действительно работает

1. В `npm run dev` в консоли **нет** предупреждения `[supabase] ... не заданы`.
2. DevTools → Network: запросы на `https://<ref>.supabase.co/rest/v1/titles?...`
   со статусом 200 (а не только на `localhost`).
3. Создайте тайтл в админке → он виден в Supabase → Table Editor → `titles`.
4. Откройте сайт в режиме инкогнито (другой localStorage) → данные на месте.
   Если в инкогнито пусто — вы всё ещё на mockStore.

В демо-режиме (`mockStore`, без Supabase) форма входа принимает любые непустые
email и пароль — это заглушка для локальной разработки, никаких учётных данных
в коде нет. В продакшене всегда используется Supabase Auth; демо-fallback
отключён автоматически при наличии `VITE_SUPABASE_URL` и ключа.

## 6. Login Guard: обязательное подтверждение входа

После верного пароля **вход ещё не открыт**. Владелец получает письмо на
`OWNER_NOTIFY_EMAIL` (обязателен, без placeholder `@example.com`) со ссылками
«Подтвердить — это я» / «Это не я». Пока challenge не в статусе `approved`,
`hasRole(..., 'admin')` возвращает `false` и админ-роуты редиректят на
`/admin/login` (экран ожидания).

Если письмо отправить не удалось — сессия сразу откатывается (`signOut`):
**без письма подтверждения входа нет**.

Флоу:

1. `signIn` → пароль ок + роль admin.
2. Edge/dev создаёт запись в `login_challenges` (status=`pending`, TTL 15 мин)
   и шлёт письмо с токеном.
3. Владелец открывает `/admin/login/confirm?token=…&action=approve|deny`.
4. Устройство, с которого входили, polling'ом видит `approved` и пускает в
   `/admin`. При `deny` / `expired` — выход.

Миграция: `supabase/migrations/00000000000003_login_challenges.sql`.

Транспорты:

1. **Edge `login-notify`** + **`login-confirm`** (прод, Resend).
2. **Dev-мидлварь Vite** `/api/login-notify`, `/api/login-confirm`,
   `/api/login-challenge-status` — без `RESEND_API_KEY` письмо эмулируется
   (консоль + кнопки «Подтвердить (dev)» на экране ожидания).

### Настройка

Локально (`.env` в корне, файл в `.gitignore`):

```bash
OWNER_NOTIFY_EMAIL=you@yourdomain.com
RESEND_API_KEY=re_xxxxxxxxxxxx   # без ключа — эмуляция
```

Прод (секреты в Supabase, не в репозитории):

```bash
# 1) Секреты СНАЧАЛА (login-notify fail-fast без них)
supabase secrets set RESEND_API_KEY=re_xxxxxxxxxxxx \
  OWNER_NOTIFY_EMAIL=you@yourdomain.com \
  --project-ref <project-ref>

# 2) Миграции 03→08 ОДНИМ заходом (SQL Editor или db push).
#    08 DROP'ает 5-arg create_login_challenge и ставит 6-arg + session_id.
supabase db push
# или вручную: 03_login_challenges … 08_login_challenge_multidevice.sql

# 3) Edge СРАЗУ после миграций (в одной сессии, без захода в /admin/login между шагами).
#    Окно: старый edge + новая схема (или наоборот) → login fail до redeploy.
supabase functions deploy login-notify --project-ref <project-ref>
supabase functions deploy login-confirm --project-ref <project-ref>
```

**Порядок критичен для 08:** между `db push` и `functions deploy login-notify`
не открывайте `/admin/login` — 5-arg/6-arg mismatch даёт «нет challenge» или
«function does not exist» на ≤1 мин. Делайте 2→3 подряд.

Multi-device smoke (после деплоя, SQL Editor) —
`supabase/scripts/smoke_login_challenge_session.sql`:
`BEGIN` + `session_replication_role=replica` (обход FK) + вызов
`latest_login_challenge_status()` под двумя JWT claims → 4× `PASS` + `ROLLBACK`.
Если INSERT падает на FK — скрипт запущен не под superuser (откройте SQL Editor
как postgres / Dashboard).

Отправитель по умолчанию — `Hikkomanga Login Guard <onboarding@resend.dev>`.
Для своего домена: подтвердите его в Resend и задайте `OWNER_NOTIFY_FROM`.

Шаблон — `supabase/functions/_shared/loginMailTemplate.ts`. Клиент:
`src/data/notify.ts` + `src/data/auth.ts` (`pendingConfirmation`).

### Роли owner / admin и заявки

- `owner` в `user_roles` автоматически проходит `has_role(uid, 'admin')`
  (миграция `04_roles_and_requests.sql`).
- Admin **не** удаляет тайтлы/главы напрямую: кнопка «Запросить удаление»
  создаёт строку в `admin_requests`. Owner разбирает их в `/admin/requests`.
- **Approve = apply** (миграция `07_apply_admin_request.sql`, BEFORE UPDATE):
  - `delete_title` → `DELETE FROM titles` (каскад глав/страниц);
  - `delete_chapter` → `DELETE FROM chapters`;
  - `new_chapter` → `INSERT` черновика главы (`payload.suggested_number`);
    retry-loop на `unique_violation` (UNIQUE `chapters(title_id, number)` —
    уже в `00_init`, плюс идемпотентная страховка в `07`),
    чтобы параллельный INSERT не ронял UPDATE заявки;
    в `payload` пишутся `created_chapter_id` / `created_number`;
  - `ad_request` → только status; баннер owner создаёт в `/admin/ads`.
  - Триггер всегда пишет `resolved_at` / `resolved_by` (`COALESCE(..., auth.uid())`),
    даже если UPDATE пришёл не из UI.
  - Проверка UNIQUE перед продом:
    ```sql
    SELECT conname, pg_get_constraintdef(oid)
    FROM pg_constraint
    WHERE conrelid = 'public.chapters'::regclass AND contype = 'u';
    ```
- CRUD рекламы: `/admin/ads` (только owner). Публичная `/advertise` пишет
  `type = ad_request` (можно без сессии).
- Interstitial каждые 5 глав: `useChapterProgress` + `AdInterstitial`.

### Login Guard без Resend (прод)

Без `RESEND_API_KEY` + задеплоенного `login-notify` вход **невозможен**
(by design: письмо = второй фактор). Форма `/admin/login` показывает
подсказку: «Обратитесь к владельцу для настройки Resend». В `npm run dev`
без ключа письмо эмулируется (кнопки на экране ожидания).

CSP на Vercel (`vercel.json`): `img-src` — `'self' data: blob: https://*.supabase.co https://*.supabase.in`
(внешние CDN для баннеров не пройдут — только Supabase Storage). `script-src 'self'` (prod-сборка Vite без
inline-скриптов). `style-src` оставляет `'unsafe-inline'` — Tailwind/runtime
иногда инжектит style-атрибуты.

### Тесты

```bash
npm run test          # smoke data-layer + unit Login Guard / ads / requests
npm run test:unit     # только unit-auth-notify.mjs
npm run test:smoke    # только smoke-data-layer.mjs
```

## 7. Если брать встроенный бэкенд Lovable (Cloud), а не свой проект

Lovable Cloud — это отдельный управляемый бэкенд (он «использует open-source
основу Supabase», но это не ваш Supabase-проект). У него другие переменные,
своя схема и свои in-editor вьюхи (Database / Users / Storage / Secrets).
Автоматической миграции между Cloud и своим Supabase-проектом нет **в обе
стороны**. Для этого репозитория вариант один: подключить именно свой
Supabase-проект через коннектор — тогда код менять почти не нужно.

## 8. Особенности Lovable при импорте этого репозитория

- Проект на Vite + React + TS импортируется через GitHub-синк; обратно в GitHub
  синхронизируется **только дефолтная ветка** — изменения, сделанные в Arena,
  нужно сначала смержить в `main`.
- Lovable по умолчанию тянет свой шаблон (`react-router-dom`, `src/lib/supabase.ts`).
  Здесь роутинг на **TanStack Router** (файлы `src/routes/*.tsx` + генерируемый
  `src/routeTree.gen.ts`), а клиент — в `src/integrations/supabase/`. В промпте
  прямо пишите: «не заменяй роутер и не создавай новый Supabase-клиент, используй
  существующий `src/data/client.ts`», иначе AI перепишет маршруты и получит два
  конфликтующих клиента.
- Секреты для edge-функций хранятся в самом Supabase-проекте (Edge Functions →
  Secrets), а не в репозитории.

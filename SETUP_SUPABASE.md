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
   `hikko-originals` (приватный) + политики.
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

### Обложки не грузятся (Covers troubleshooting)

Обложки тайтлов — файлы репозитория: `public/media/covers/{slug}.webp`,
в `titles.cover_url` хранится относительный путь вида `/media/covers/{slug}.webp`.
Supabase Storage для обложек НЕ используется (Storage остался только для
страниц глав и озвучек — см. подраздел ниже). Рендер обложки — только
`src/components/manga/CoverImage.tsx`: пустой/битый путь → статический
плейсхолдер `/media/placeholder-cover.svg` + `data-cover-error` в DOM
(в dev — ещё и `console.warn('[cover] failed …')`, в прод — счётчик
`cover_error` в Vercel Analytics). Если видите плейсхолдер — идите по цепочке:

1. **Файл существует?** Проверьте наличие `public/media/covers/{имя}.webp`
   локально и в git. Сид-обложки генерируются разово:
   `npm i --no-save sharp && node scripts/generate-seed-covers.mjs`
   (тот же визуальный генератор, что в демо-режиме, WebP 800px).
2. **Путь в БД совпадает с именем файла?** Путь регистрозависим и должен
   начинаться с `/`. Меняется в админке (TitleForm → «Обложка тайтла») или
   руками в Table Editor. Внешние `http(s)://` URL больше не поддерживаются —
   форма их отклоняет, а `normalizeMediaUrl` возвращает относительные пути
   как есть.
3. **og:image абсолютный в пререндере?** `src/lib/seo.ts` собирает
   `og:image` как `SITE_URL + cover_url`; без `VITE_SITE_URL` абсолютной
   ссылки не будет. Проверка: `grep og:image dist/title/{slug}/index.html`.

Проверить ВСЕ тайтлы живой базы одним скриптом (без походов в сеть — только
список slug + cover_url из БД и файловая система):

```bash
npm run check:covers
# Exit: 0 — все файлы на месте; 1 — есть битые пути/файлы;
#       2 — сама БД недоступна (переменные/сеть).
```

Вес каталога обложек ограничен бюджетом 500 kB (`scripts/check-budgets.mjs`,
входит в `npm run build`): новая обложка — это осознанный коммит WebP-файла
в `public/media/covers/`. CSP `img-src` при этом не менялся: обложки
укладываются в `'self'`, страницы/озвучки — `*.supabase.co`; при полном
переезде медиа в репозиторий CSP можно ужесточить.

#### Страницы и озвучки (всё ещё Supabase Storage)

Для `pages.image_url` и `chapter_voiceovers.audio_url` актуально прежнее:

1. **Бакеты.** `manga` — public (миграция `00000000000002_storage_buckets.sql`),
   `voiceovers` и `hikko-originals` — приватные. Приватный `manga` = 400/403
   на каждую страницу главы.
2. **RLS на `storage.objects`.** После пересоздания проекта политики бакетов
   не появляются сами — SQL для сверки в разделе «Если проект Supabase
   пересоздавали или удаляли».
3. **Мёртвый ref.** URL указывает на удалённый проект → `LEGACY_SUPABASE_REFS`
   в `src/lib/storageUrl.ts` переадресует его на текущий; файл должен быть
   реально перенесён, иначе 404. Нормализация `http→https` и проверка CSP —
   там же (`normalizeMediaUrl`).
4. **Живая проверка доступности** — `npm run check:supabase` (раздел
   «8. Публичные медиа») или HEAD-запросом по URL из БД.

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
# На проекте, где часть миграций уже применялась руками (SQL Editor), db push
# доходит до повторной попытки и падает на `policy already exists` (01/02
# создают полисы без DROP IF EXISTS) — накатывайте только недостающие файлы,
# см. «Если проект Supabase пересоздавали или удаляли».

# 3) Edge СРАЗУ после миграций (в одной сессии, без захода в /admin/login между шагами).
#    Окно: старый edge + новая схема (или наоборот) → login fail до redeploy.
supabase functions deploy login-notify --project-ref <project-ref>
supabase functions deploy login-confirm --project-ref <project-ref>
```

Всё то же одной командой (секреты → деплой → проверка, секреты в лог не
печатаются):

```bash
node scripts/setup-login-guard.mjs \
  --project-ref <project-ref> \
  --owner-email you@yourdomain.com \
  --resend-key re_xxxxxxxxxxxx
# --from "Name <noreply@yourdomain.tld>" — если домен подтверждён в Resend
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

### Диагностика: что означает ошибка входа

Форма `/admin/login` показывает **вид причины** (`errorKind`), поэтому по тексту
ошибки сразу видно, что чинить:

| Текст в скобках ошибки | Причина | Как чинить владельцу |
| --- | --- | --- |
| `в этой сборке вообще не настроен Supabase …` (`demo-build`) | Прод собран без `VITE_SUPABASE_URL` / ключа — сайт в демо-режиме, письмо слать нечем | Задать переменные сборки (Vercel/Lovable → Env), пересобрать, затем секреты + деплой функций |
| `не задеплоена` (HTTP 404) (`fn-not-deployed`) | `login-notify` нет в проекте | `supabase functions deploy login-notify --project-ref <ref>` (+ `login-confirm`) |
| `не задан OWNER_NOTIFY_EMAIL` / `не задан RESEND_API_KEY` (`secrets-missing`) | Функция задеплоена, но секретов нет | `supabase secrets set OWNER_NOTIFY_EMAIL=… RESEND_API_KEY=… --project-ref <ref>` |
| `Resend не принял письмо: …` (`resend`) | Ключ/домен отправителя не прошли в Resend | Проверить `RESEND_API_KEY`; `onboarding@resend.dev` шлёт **только на адрес аккаунта** — иначе подтвердить домен и задать `OWNER_NOTIFY_FROM` |
| `Не удалось достучаться до Edge Function … сетевая ошибка, блокировка или CORS` (`network`) | Запрос не дошёл до edge-гейтвея: DNS/CORS/файрвол/блокировщик (приходит как FunctionsFetchError без context/status) | Проверить доступность `<ref>.supabase.co`; curl-проверка ниже; если curl показывает 404 — задеплоить функцию; если 000 — чинить сеть. **Если домен не резолвится (NXDOMAIN) — проект удалён, а бандл собран со старым ref: см. «Если проект Supabase пересоздавали или удаляли»** |

Быстрая самопроверка без браузера (функция жива ⇒ не 404). Ожидания по коду
функций **разные**:

```bash
# 1) Задеплоена ли функция. Без Authorization 401 отдаёт сам шлюз Edge
#    Functions — этого достаточно, чтобы понять: функция на месте.
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://<project-ref>.supabase.co/functions/v1/login-notify
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' -d '{}' \
  https://<project-ref>.supabase.co/functions/v1/login-confirm
# 401 = задеплоена (шлюз: Missing authorization header)
# 404 = функция не задеплоена
# 000 = сеть/DNS (или удалённый project-ref)

# 2) Живой ли код функции. Шлюз пропускает запрос только с валидным JWT —
#    подойдёт publishable/anon ключ в Authorization.
curl -s -X POST -H "Authorization: Bearer $ANON_KEY" \
  -H 'Content-Type: application/json' -d '{}' \
  https://<project-ref>.supabase.co/functions/v1/login-confirm
# → 400 {"ok":false,"error":"token and action=approve|deny required"}

curl -s -X POST -H "Authorization: Bearer $ANON_KEY" \
  -H 'Content-Type: application/json' -d '{}' \
  https://<project-ref>.supabase.co/functions/v1/login-notify
# → 401 {"ok":false,"error":"Unauthorized"} — пользовательской сессии нет
```

Ту же проверку целиком (окружение, DNS, таблицы, RPC, бакеты, функции, Auth)
делает одна команда: `npm run check:supabase` — она печатает список задач,
если чего-то не хватает.

Письма от `onboarding@resend.dev` часто падают в спам; если письмо не
приходит вовсе — почти наверняка `OWNER_NOTIFY_EMAIL` не совпадает с адресом
аккаунта, в котором создан `RESEND_API_KEY` (см. таблицу выше, строка `resend`).

### Если проект Supabase пересоздавали или удаляли

Симптом: в базе пусто, а прод «работает» с демо-данными. Причина — клиентский
бандл собран со **старым** ref: домен удалённого проекта не резолвится
(NXDOMAIN), запросы падают, а `src/data/*` молча уходят на `mockStore`.
`/admin/login` в такой сборке жалуется на сеть (`errorKind: network`), хотя
функции просто не задеплоены.

Что реально зашито в прод-бандл:

```bash
curl -s https://<ваш-домен>/ | grep -o '/assets/[^"]*\.js'          # чанки
curl -s https://<ваш-домен>/assets/client-*.js | grep -o '[a-z0-9]\{20\}\.supabase\.co'
# вывод должен совпасть с Settings → General → Reference ID актуального проекта
```

Порядок починки — все шаги обязательны, иначе ref останется мёртвым:

1. `.env.production` в репозитории: новый `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID` (или
   `VITE_SUPABASE_ANON_KEY`, если ключ формата `eyJ…`).
2. Хостинг → Environment Variables (Production **и** Preview): те же `VITE_*`
   + `VITE_SITE_URL`. Vite отдаёт приоритет `process.env`, поэтому при пустых
   переменных на Vercel сборка молча берёт значения из `.env.production`.
3. Redeploy без кэша сборки.
4. Сверить **фактическую** схему, а не содержимое `supabase/migrations/`:
   ```sql
   select version, name from supabase_migrations.schema_migrations order by version;
   select id, name, public from storage.buckets order by id;
   select policyname, cmd from pg_policies
     where schemaname = 'storage' and tablename = 'objects';
   select tgname from pg_trigger
     where tgrelid = 'public.admin_requests'::regclass and not tgisinternal;
   ```
   Отсутствующие файлы накатывайте по отдельности (`db push` на таком проекте
   упадёт на `policy already exists` и не даст остальное). Проверить RPC без
   браузера можно publishable-ключом:
   ```bash
   curl -s -X POST https://<ref>.supabase.co/rest/v1/rpc/has_role \
     -H 'apikey: <publishable-key>' -H 'Content-Type: application/json' \
     -d '{"uid":"00000000-0000-0000-0000-000000000000","role_to_check":"admin"}'
   # должно вернуть false (не 404) — значит 00+04 накатаны; анонимный вызов разрешён намеренно
   ```
5. Секреты + деплой функций с **тем же** ref — иначе на `functions/v1/login-notify`
   будет 404 при живом проекте.
6. Первый админ: `user_roles` пустая → Auth → Users → Add user (Auto Confirm),
   затем `INSERT` с ролью `owner` (не `admin`), если нужны баннеры — политика
   `owner manages ads` из `06_ads.sql` требует именно `owner`.

`supabase/.temp/` (ref, pooler-url, кэш версий CLI) — в `.gitignore`, не коммитить.

### Тесты

```bash
npm run test          # smoke data-layer + unit Login Guard / ads / requests
npm run test:unit     # только unit-auth-notify.mjs
npm run test:smoke    # только smoke-data-layer.mjs
```

Тесты слоя данных проверяют **демо-режим** (mockStore), поэтому Supabase-
переменные в них принудительно обнуляются через `scripts/lib/demo-mode.mjs`.
Иначе настроенный `.env` уводил бы тесты в реальную базу: анонимный `INSERT`
падал бы на RLS, а результат зависел бы от применённых миграций и содержимого
проекта. `prerender.mjs` / `generate-sitemap.mjs` наоборот работают с реальной
базой и демо-режим не включают.

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

## 9. Приём заявок на тайтл (анонимные заявки new_title)

Аноним подаёт заявку через кнопку «+» → «Предложить тайтл» (капча, без
регистрации). Заявка попадает в `admin_requests` (type=new_title, status=pending)
с обложкой в бакете `submissions`. Owner решает в `/admin/requests`: approve
создаёт **черновик** тайтла (published=false; занятый slug → предупреждение,
черновика нет), reject требует причину, spam помечает нарушителя. Заявитель
следит за статусом по персональной ссылке `/s/{token}` (токен — единственный
ключ, payload по нему не отдаётся) и может отменить заявку в первые 5 минут.

### 9.1 Ключи Cloudflare Turnstile (провайдер по умолчанию)

1. dash.cloudflare.com → Turnstile → Add site: тип **Widget**, домен сайта
   (при смене домена добавьте новый hostname в тот же widget — ключи менять
   не нужно).
2. Site key → Vercel `VITE_TURNSTILE_SITE_KEY` (пересборка).
3. Secret key → `supabase secrets set TURNSTILE_SECRET_KEY=...`.

### 9.2 Деплой edge-функций и секреты

```bash
# секреты (salt — случайная строка, минимум 32 символа):
supabase secrets set RATE_LIMIT_SALT="$(openssl rand -hex 32)" \
  TURNSTILE_SECRET_KEY="0x..." CAPTCHA_PROVIDER=turnstile

supabase functions deploy submit-title
supabase functions deploy get-submission
supabase functions deploy notify-submitter   # опционально: email заявителю

# для писем о решении (уже используемый Resend):
supabase secrets set RESEND_API_KEY=re_... # OWNER_NOTIFY_FROM уже задан для login-notify
```

Лимиты (считает RPC `check_ip_rate_limit` по `sha256(ip+RATE_LIMIT_SALT)`,
сырой IP нигде не хранится): 15/мин, 100/час, 300/сутки на заявку;
`get-submission` — 30/мин на IP. Превышение → 429 + `Retry-After`.

### 9.3 Миграции и cron

```sql
-- SQL Editor, по порядку:
-- 00000000000010_submission_columns.sql   (колонки admin_requests + enum-значения + бакет submissions)
-- 00000000000011_requests_rls_anon.sql    (anon INSERT запрещён — заявки пишет только edge)
-- 00000000000012_rate_limit_ip.sql        (ip_rate_limit + check_ip_rate_limit)
-- 00000000000013_submissions_cleanup.sql  (cleanup_rejected_submissions: rejected/spam >90д → purged)
-- 00000000000014_new_title_trigger.sql    (apply_admin_request: ветка new_title, slugify_title)
```

Cron (Supabase Dashboard → Database → Cron или pg_cron):

```sql
select cron.schedule('cleanup-submissions', '0 4 * * *',
  $$select public.cleanup_rejected_submissions()$$);
select cron.schedule('cleanup-ip-rate-limit', '5 4 * * *',
  $$select public.cleanup_ip_rate_limit()$$);
```

### 9.4 Переключение на hCaptcha (без правок кода)

```bash
supabase secrets set CAPTCHA_PROVIDER=hcaptcha \
  HCAPTCHA_SECRET_KEY=0x...
```
и на Vercel: `VITE_CAPTCHA_PROVIDER=hcaptcha`, `VITE_HCAPTCHA_SITE_KEY=...`.
CSP уже допускает оба провайдера (vercel.json: script/frame/connect-src).
Ключи старого провайдера можно не удалять — они просто перестают читаться.

### Google reCAPTCHA v2 (галочка «Я не робот»)

Виджет поддерживает `VITE_CAPTCHA_PROVIDER=recaptcha` и
`VITE_RECAPTCHA_SITE_KEY`. Публичный site key настроен в `.env.production`;
для локальной разработки задайте эти переменные в `.env.local`.
Переменные Vercel имеют приоритет над файлом: удалите старое значение
`VITE_CAPTCHA_PROVIDER=turnstile` или замените его на `recaptcha` и пересоберите сайт.

1. В Google reCAPTCHA Admin Console выберите ключ **v2 → Checkbox**.
2. Разрешите `hikkomanga.vercel.app`, а для проверки — `localhost` и точный
   hostname Live Preview (без `https://` и пути). Не отключайте проверку домена.
3. В Supabase Dashboard → Edge Functions → Secrets задайте
   `CAPTCHA_PROVIDER=recaptcha` и `RECAPTCHA_SECRET_KEY` от **того же** виджета.
   Secret Key не помещайте в `VITE_*`, Git или чат.
4. Обновите обе функции:
   ```bash
   supabase functions deploy submit-title
   supabase functions deploy submit-chapters
   ```

CSP в `vercel.json` разрешает загрузку Google API и iframe reCAPTCHA.
Одного Site Key недостаточно для отправки заявок в реальную базу: серверная
проверка требует Secret Key. В локальном демо-режиме заявки сохраняются в
браузере, полноценная серверная проверка токена не выполняется.

### 9.5 Проверка и troubleshooting

Локальные тесты логики (без Supabase): `npm run test:submissions`,
диагностика базы: `npm run check:submissions` (с `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY` в env — по живой базе).

| Симптом | Причина / что делать |
| --- | --- |
| 429 при подаче | Исчерпан лимит IP (15/мин/100/час/300/сутки). Ждать окно или менять константы в `submit-title/index.ts`. Клиент показывает `Retry-After`. |
| 400 `captcha_failed` | Токен капчи не принят: site/secret key от разных виджетов, домен не добавлен в Turnstile, или CAPTCHA_PROVIDER ≠ провайдеру site key. |
| 403/401 от functions | Не задеплоены функции или не выставлены apikey/Authorization — см. раздел 5. |
| «Обложка не подходит» | Файл >5 MB, не JPEG/PNG/WebP или соотношение не 3:4 (±10%). Проверка по magic-bytes, расширение не доверяется. |
| Заявка есть, инбокс пуст | Owner видит pending через `listForOwner`; проверьте фильтры «В очереди/Решённые» и тип «Новые тайтлы». |
| Approve, но «slug занят» | Тайтл с таким названием уже есть — заявка помечена `conflict=true`, черновик не создан. Пополните существующий тайтл главами. |
| Черновик создан, обложка не видна | Обложка заявки лежит в бакете `submissions` (URL в payload.cover_url). Каталог ТЗ-2 показывает только `/media/covers/` — при публикации перенесите файл в репозиторий `public/media/covers/{slug}.webp` и обновите cover_url (см. раздел «Обложки»). |

> **Не сделано сознательно:** перенос файла обложки из бакета `submissions`
> в репозиторий при approve. Триггер SQL не имеет доступа к файловой системе
> репозитория, а автоматическая загрузка в git из edge — отдельная инфра-
> структура (webhook + CI). До ручного переноса у черновика в каталоге будет
> плейсхолдер вместо обложки (CoverImage → placeholder), сам черновик работает.


## 10. Заявки на главы (new_chapters) и массовый импорт глав

Три связанных флоу используют один редактор глав (`src/components/requests/ChaptersEditor.tsx`):

1. **`/admin/titles/$id/chapters/import`** — владелец импортирует главы из CSV
   (`number,name[,description]`) и привязывает страницы по именам файлов
   (`{гл}.{стр}.{ext}`, `{гл}/{стр}.{ext}`, `{гл}-{стр}.{ext}`, `{гл}.pdf`).
   Супabase-миграций не требует: работают обычные `chapters`/`pages` и бакет `manga`.
2. **«Предложить главу»** (публичное меню «+») — анонимная заявка на 1–5 глав
   опубликованного тайтла через edge `submit-chapters`.
3. **«Предложить тайтл» + главы** — та же заявка `new_title` с приложенными
   главами (edge `submit-title` принимает поле `chapters` и файловые части).

### 10.1 Миграция

```sql
-- supabase/migrations/00000000000015_chapter_submissions.sql
DO $$ BEGIN
  ALTER TYPE public.request_type ADD VALUE IF NOT EXISTS 'new_chapters';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

alter table public.admin_requests
  add column if not exists finalized_at timestamptz,
  add column if not exists finalized_error text;

alter table public.chapters
  add column if not exists description text;

create index if not exists admin_requests_type_status_idx
  on public.admin_requests (type, status, created_at desc);
```

Бакет `submissions` и `check_ip_rate_limit` уже созданы миграциями 10 и 12 —
новых объектов хранения не нужно.

> `ALTER TYPE ... ADD VALUE` нельзя использовать в той же транзакции, где новое
> значение применяется. Если накатываете миграцию руками в SQL Editor, выполните
> DO-блок отдельным запросом, а остальные строки — следующим.

### 10.2 Деплой edge-функций

```bash
supabase functions deploy submit-chapters              # подача заявки на главы
supabase functions deploy finalize-chapter-submission  # перенос файлов при approve
supabase functions deploy submit-title                 # перезалить: теперь принимает главы
```

Секреты те же, что для `submit-title`: `RATE_LIMIT_SALT`,
`TURNSTILE_SECRET_KEY` (или `HCAPTCHA_SECRET_KEY` + `CAPTCHA_PROVIDER=hcaptcha`).
Новых секретов не требуется.

**Порядок:** сначала миграция 15, затем деплой функций. До применения миграции
`submit-chapters` упадёт на INSERT (`type new_chapters` не существует в enum), а
`finalize-chapter-submission` — на UPDATE `finalized_at`.

### 10.3 Как это работает

| Шаг | Что происходит |
| --- | --- |
| Подача | `submit-chapters`: rate limit 3/мин · 30/час · 100/сутки по `sha256(ip + ':chapters' + RATE_LIMIT_SALT)` → согласие → капча → payload → тайтл опубликован → файлы → upload в `submissions/{token}/ch-{n}/page-{m}.{ext}` → INSERT `admin_requests` (`type='new_chapters'`, `published` глав ещё нет) |
| Модерация | `/admin/requests`, тип «Заявки на главы»: тайтл, главы с превью первой страницы, счётчики страниц и объёма, Approve/Reject/Spam |
| Approve | UPDATE статуса (триггер `apply_admin_request` для `new_chapters` ничего не делает) → клиент зовёт `finalize-chapter-submission` |
| Финал | Для каждой главы: INSERT `chapters` (`published=false`, при занятом номере — следующий свободный) → download из `submissions` → upload в `manga/{chapterId}/…` → INSERT `pages` → удаление исходников → `finalized_at` |

Идемпотентность: `finalized_at IS NOT NULL` → повторный вызов возвращает
`skipped=true` и ничего не создаёт. Сбой на k-й главе оставляет заявку
`approved` с `finalized_error` — в карточке появляется кнопка
**«Завершить импорт»**, повтор продолжает с k-й главы.

Прогресс пишется в payload **двумя чекпоинтами на главу**, и это не случайность:

1. `finalized_chapter_id` + `finalized_done: false` — сразу после INSERT главы,
   **до** загрузки страниц. Без этого сбой на копировании страницы оставил бы
   главу в БД без отметки, и повтор создал бы вторую (первая — сирота без страниц).
2. `finalized_pages` + `finalized_done: true` — после всех страниц главы.

Пути уже перенесённых страниц хранятся в `payload.chapters[i].finalized_source_paths`,
поэтому повтор не копирует их дважды, а `page_order` продолжает плотную
нумерацию 1..N. Исходники перенесённых страниц удаляются и при повторе.

Лимиты (валидируются и на клиенте, и в edge): ≤5 глав, ≤100 страниц на главу,
≤20 MB изображение, ≤200 MB PDF, ≤500 MB суммарно.

### 10.4 Проверка и troubleshooting

Локально без Supabase: `npm run test:submit-chapters` (ядро подачи и
финализации) и `npm run test:chapters-import` (CSV, имена файлов, план импорта).

| Симптом | Причина / что делать |
| --- | --- |
| 429 при подаче главы | Исчерпано окно 3/мин · 30/час · 100/сутки. Счётчик отдельный от заявок на тайтл (суффикс `:chapters`), ждать окно. |
| 400 `consent_required` | Не отмечен чекбокс согласия; сервер не доверяет клиенту и требует поле `consent`. |
| 400 `title_id` = «Тайтл не найден / не опубликован» | Заявка на главы принимается только к опубликованному тайтлу. |
| 400 с ключами вида `ch-1-page-2.webp` | Файлы не совпали с payload: лишний файл, не хватает файла или другое расширение. |
| Approve прошёл, глав нет | `finalized_error` в строке заявки; в карточке «Завершить импорт». Частая причина — функция не задеплоена (404 от `/functions/v1/finalize-chapter-submission`). |
| 403 на финализации | Функцию может вызвать только `owner` (проверка `has_role(uid,'owner')`), как и approve заявки. |
| Глава создана с другим номером | Номер был занят — сдвиг виден в `payload.finalized.renumbered` и в отчёте импорта. |

Отклонённые и спам-заявки файлы в `submissions` **не** удаляются: cron
`cleanup_rejected_submissions()` (миграция 13) через 90 дней помечает строку
`payload.purged=true` и стирает персональные поля, а сами объекты бакета
зачищаются вручную (Dashboard → Storage → `submissions/{token}/`) — как и для
заявок на тайтл.

### 10.5 Известные ограничения финализации (бэклог)

Оба пункта — не блокеры, оба про редкие сценарии, но зафиксированы здесь, чтобы
их не пришлось выводить заново.

**A. Параллельный finalize одной заявки.** Два одновременных вызова (две
вкладки, повторный клик после зависшего запроса) оба видят `finalized_at IS
NULL` и идут создавать главы. Дубль с **тем же** номером невозможен:
`chapters` имеет `UNIQUE (title_id, number)` (`00000000000000_init.sql:41`,
контрольно повторяется в миграции 07), поэтому второй INSERT упадёт на
`unique_violation` → 500 `finalize_failed`. Остаточный риск другой:
`resolveChapterNumber` берёт «следующий свободный», поэтому если первый вызов
успел вставить главу до того, как второй посчитал номер, второй создаст ту же
главу под сдвинутым номером. Клиент глушит кнопку через `running`, но это
защита per-tab. Лечение (отдельной итерацией): промежуточный статус
`finalizing` с условным UPDATE (`… SET status='finalizing' WHERE id=$1 AND
status='approved' AND finalized_at IS NULL` и продолжать только если затронута
строка) либо `pg_advisory_xact_lock(hashtext(request_id))` в начале функции.

**B. Сбой чекпоинта сразу после INSERT главы.** Если UPDATE payload не прошёл
между созданием главы и записью `finalized_chapter_id`, отметки нет и повтор
создаст главу заново (со сдвигом номера — см. A). Окно в одну операцию,
принципиально не закрывается без транзакции: INSERT главы и UPDATE заявки —
два отдельных вызова PostgREST, а `finalize` намеренно не обёрнут в
`rpc`-транзакцию (внутри цикла download/upload в Storage, которые в
транзакцию не помещаются). Последствие ограничено: лишняя глава-черновик
(`published=false`), которую видно в списке глав и можно удалить руками.

> **Не сделано сознательно:** разбивка PDF на стороне сервера. В Deno-рантайме
> нет pdf.js-пайплайна проекта (canvas + WASM-декодеры), поэтому PDF режется на
> страницы в браузере (`src/lib/pdfToPages.ts`, лимит 500 страниц), а edge
> принимает уже готовые страницы и, опционально, оригинал `ch-{n}.pdf` для
> модератора. Оригинал при финализации не переносится в `manga` — строка в
> `pages` указывала бы ридеру на PDF; файл удаляется вместе с исходниками.


## Загрузка страниц глав

В `/admin/titles/$id/chapters/$cid` доступны выбор нескольких файлов и drag-and-drop.

- Форматы: JPG/JPEG, PNG, WebP, GIF, AVIF, BMP, TIFF/TIF, HEIC/HEIF, PDF.
- Изображение — **до 20 MB**, PDF — **до 200 MB**, **до 100 файлов** за один выбор (не лимит страниц главы). MB здесь означает 1024² байт.
- PDF — **до 500 страниц**. Положительное целое `VITE_MAX_PDF_PAGES` переопределяет лимит на этапе сборки; некорректное значение возвращает 500.
- Содержимое проверяется по magic bytes. Расширение не является источником истины: PNG с именем `.jpg` принимается как PNG с предупреждением в консоли. TXT/ZIP/SVG не принимаются.
- Изображения конвертируются в WebP шириной до 1600 px. HEIC/HEIF и TIFF декодируются lazy-модулями; для многостраничных HEIF/TIFF используется первое изображение.
- **Анимированный GIF не сжимается**: его байты сохраняются в `manga` с MIME `image/gif`. Неоднозначные/повреждённые GIF консервативно сохраняются без сжатия. Статичный GIF → WebP.
- PDF сохраняется один раз в приватном `hikko-originals`; `pdfjs-dist` рендерит страницы последовательно в WebP (качество 0.85), каждая загружается в публичный `manga` и записывается в `pages`. Все страницы ссылаются на общий путь PDF в `original_url`. Читалка не изменена.
- Сортировка натуральная по имени (`1, 2, 10`), PDF после изображений. Порядок новых страниц начинается после максимального `page_order`, а не количества существующих страниц.
- Каждый файл получает статус, прогресс и отмену. Ошибка не останавливает очередь. Для экономии памяти фазы «Разбор PDF (n/N)» и «Загрузка страниц (n/N)» чередуются **для каждой страницы**, а не накапливают весь результат перед загрузкой.
- Отмена прерывает pdf.js/render-task; уже записанные страницы сохраняются. Supabase SDK не предоставляет AbortSignal для upload: уже отправленный запрос завершается, его страница сохраняется, следующая не начинается. Нативное декодирование обычной картинки также заканчивает текущую операцию.
- `detectFormat`/`validateFile` асинхронны (`Promise`), поскольку браузер читает `File` асинхронно. Лимит количества страниц проверяется pdf.js до первого рендера, а не проверкой заголовка файла.
- `pdfToPages` сохраняет API с массивом для внешних потребителей. UI использует потоковые `iteratePdfPages`/`iteratePdfUploads`: в памяти только один canvas/результат, но исходные PDF-байты и внутренние структуры pdf.js остаются до завершения. `uploadPdfAsPages` при ошибке добавляет успешно загруженные записи в `error.uploaded`.

### Storage и CSP

Проверьте **глобальный** лимит Storage в Supabase Dashboard: для PDF он должен разрешать 200 MB (возможности зависят от тарифа), а лимит `hikko-originals` — не ниже 200 MB. Для `manga` нужны `image/webp` и `image/gif`; для originals — перечисленные изображения и `application/pdf`, если включён MIME allowlist. Клиент не обходит тарифные или серверные ограничения.

**PDF-оригиналы не удаляются автоматически**, ни при удалении страницы, ни при удалении главы. Также остаются PDF, обработка которых закончилась ошибкой или отменой. Очищайте их вручную в Storage → `hikko-originals/{chapterId}/`, предварительно проверив ссылки из `pages.original_url`. Удаление обычных страниц/глав удаляет публичные файлы и не-PDF оригиналы; массовое удаление разбито на батчи по 100 путей.

pdf.js и heic2any загружаются только при обработке соответствующего формата. PDF worker лежит в `dist/assets/pdf.worker.min-*.mjs`, дополнительные шрифты/CMaps/декодеры — в `dist/assets/pdfjs/`. CDN не используется. PDF использует JS fallback-декодеры вместо WASM, чтобы сохранить строгий CSP.

`build-plugins/heic-worker.ts` выносит worker heic2any в локальный `heic-decoder-worker-*.js`. Только **ответ этого worker** получает `script-src 'self' 'unsafe-eval'` (требование libheif внутри heic2any); CSP HTML не ослабляется. При переносе с Vercel воспроизведите это узкое правило из `vercel.json`. При обновлении heic2any проверьте извлечение worker и CSP.

### Ошибки загрузки

| Ситуация | Сообщение |
|---|---|
| Формат не поддерживается | Файл `{name}`: формат `{ext}` не поддерживается. Допустимо: JPG, PNG, WebP, GIF, AVIF, BMP, TIFF, HEIC, PDF. |
| Пустой файл | Файл `{name}` пуст. |
| Изображение > 20 MB | Файл `{name}` больше 20 MB. Сожмите или загрузите по частям. |
| PDF > 200 MB | PDF `{name}` больше 200 MB — лимит хранения. |
| PDF > лимита страниц | PDF содержит {n} страниц, лимит — {limit}. Разделите на части |
| PDF защищён | PDF `{name}` защищён паролем — загрузка невозможна. |
| PDF повреждён | PDF `{name}` не читается (повреждён). |
| Не удалось сжать | Не удалось обработать `{name}`. Попробуйте другой файл. |
| Ошибка сети | Не удалось загрузить `{name}`: проверьте соединение. |
| RLS запрещает | Нет прав на загрузку в этот тайтл. |
| Storage переполнен | Не хватает места в Storage. Освободите или обратитесь к администратору. |
| > 100 файлов | Выбрано {n} файлов. За один раз можно загрузить не более 100 файлов. |

### Проверки и ручной QA

`npm run test:page-formats` проверяет сигнатуры, границы GIF-блоков, размеры, порядок и изоляцию ошибок. `npm run test:pdf` — **mock pdf.js + canvas**, проверяет 3 страницы, размеры, прогресс, отмену, ошибки, лимит до рендера и очистку. Оба включены в `npm test`; mock не заменяет браузерную проверку.

Перед релизом на реальном Supabase:
1. В пустую главу перетащить `10.jpg`, `2.png`, `1.webp`, анимированный GIF и PDF на 5+ страниц. Проверить порядок, preview, оба статуса PDF, количество записей и открытие в читалке.
2. Добавить TXT/ZIP и правильную картинку в одном выборе: ошибка только у неподдерживаемых файлов. Проверить 101 файл, пустой файл и файлы сверх размеров.
3. Проверить HEIC, TIFF, AVIF, BMP, статичный GIF; в Network убедиться в lazy-загрузке декодеров и отсутствии CSP-ошибок.
4. Отменить PDF при рендере и при сетевой загрузке; уже добавленные страницы должны остаться. Проверить защищённый/повреждённый PDF и лимит страниц.
5. Открыть GIF в читалке и убедиться в анимации. Удалить PDF-страницу/главу: оригинал PDF должен остаться. Проверить Network offline, RLS и квоту на отдельном тестовом проекте.

Результат автоматизированного браузерного прогона текущей реализации — `docs/page-upload-qa.md`.

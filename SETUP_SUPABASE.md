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

## 6. Если брать встроенный бэкенд Lovable (Cloud), а не свой проект

Lovable Cloud — это отдельный управляемый бэкенд (он «использует open-source
основу Supabase», но это не ваш Supabase-проект). У него другие переменные,
своя схема и свои in-editor вьюхи (Database / Users / Storage / Secrets).
Автоматической миграции между Cloud и своим Supabase-проектом нет **в обе
стороны**. Для этого репозитория вариант один: подключить именно свой
Supabase-проект через коннектор — тогда код менять почти не нужно.

## 7. Особенности Lovable при импорте этого репозитория

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

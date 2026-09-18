# hikkomanga

Читалка манги с админ-панелью: тайтлы, главы, страницы, жанры и AI-озвучка
(Gemini) глав.

Стек: Vite + React 19 + TypeScript, TanStack Router, TanStack Query, Tailwind 4,
Supabase (Auth / Postgres / Storage / Edge Functions).

## Запуск

Нужен Node.js **22.12.0 или новее** (см. `engines` в `package.json`).

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # прод-сборка в dist/
npm run typecheck
```

## Поисковая индексация (SEO)

Приложение — SPA, поэтому поисковики по умолчанию видят пустой `index.html`.
Чтобы тайтлы и главы попадали в индекс, используются четыре механизма:

1. **Пререндер** (`scripts/prerender.mjs`) — рендерит публичные маршруты в Node
   и раскладывает готовый HTML в `dist/` (`/`, `/advertise`, `/title/$slug`,
   `/title/$slug/chapter/$number`). Бот получает контент, `<title>`,
   `description`, `og:*` и `canonical` без запуска JS.
2. **sitemap.xml + robots.txt** (`scripts/generate-sitemap.mjs`) — список
   опубликованных тайтлов и глав из Supabase; `/admin` и `/api` закрыты.
3. **Мета-теги** (`src/lib/seo.ts`) — единое описание метаданных маршрута,
   используется и клиентом, и пререндером. Админка и страницы ошибок получают
   `<meta name="robots" content="noindex, nofollow">`.
4. **Динамический рендеринг** (`middleware.ts` + `api/render.mjs`) — Edge
   Middleware на Vercel распознаёт бота по User-Agent и рерайтит его запрос на
   serverless-функцию, которая рендерит страницу в момент запроса. Покрывает
   то, чего нет в статике: тайтлы и главы, опубликованные **после** сборки, и
   страницы за лимитом `PRERENDER_MAX_URLS`. Результат кэшируется в памяти
   функции и на CDN (`s-maxage`). Подробности и схему — в
   **[docs/dynamic-rendering.md](./docs/dynamic-rendering.md)**.

Нужные переменные:

| Переменная | Зачем |
| --- | --- |
| `VITE_SITE_URL` | канонический домен (`https://example.com`, без слэша) — нужен для `canonical`, `og:url` и sitemap. **Без него sitemap соберётся на `https://hikkomanga.vercel.app`** |
| `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` | список тайтлов/глав для sitemap и пререндера (без них — только `/` и `/advertise`) |
| `PRERENDER_CHAPTERS=0` | не пререндерить страницы глав |
| `PRERENDER_MAX_URLS=1000` | лимит страниц за сборку |
| `DYNAMIC_RENDER_TTL=900` | сколько секунд держать рендер в памяти функции (по умолчанию 15 мин) |
| `DYNAMIC_RENDER_S_MAXAGE=3600` | сколько секунд CDN Vercel кэширует отрендеренный HTML |

Отдельные команды: `npm run sitemap`, `npm run prerender`,
`npm run build:spa` (сборка без sitemap/пререндера), `npm run build:ssr`
(только SSR-бандл рендера), `npm run preview:dynamic` (локальный сервер с
поведением прода — см. ниже).

После деплоя: в Google Search Console и Яндекс.Вебмастер добавить
`https://<домен>/sitemap.xml` (вкладка «Файлы Sitemap»).

### Динамический рендеринг: как проверить локально

`npm run preview:dynamic` поднимает сервер (порт 4173), который повторяет
поведение Vercel: статика из `dist/`, ботам — серверный рендер, остальным —
SPA-шелл.

```bash
npm run build && npm run preview:dynamic

# Бот получает готовый HTML с контентом и мета-тегами:
curl -s -A "Mozilla/5.0 (compatible; Googlebot/2.1)" \
  http://localhost:4173/title/magicheskaya-bitva | grep -m1 "<title>"

# Обычный браузер получает SPA-шелл (контент дорисует JS):
curl -s http://localhost:4173/title/magicheskaya-bitva | grep -c 'id="root"><'  # 0

# Несуществующий тайтл — честный 404, а не soft-404:
curl -s -o /dev/null -w "%{http_code}\n" -A "Googlebot" http://localhost:4173/title/net-takogo
```

Тот же результат на проде: `curl -s -A "Googlebot" https://<домен>/title/<slug>`
вернёт отрендеренную страницу с заголовком `X-Dynamic-Render: rendered`.

### Подтверждение владения в Google Search Console

Для метода **HTML-файл** используется `public/google65ee958671ecedb0.html`.
Vite копирует его без изменений в корень `dist/`. Маршруты в `vercel.json`
исключают файлы подтверждения Google/Яндекс из SPA fallback: по этим URL
нельзя отдавать главную страницу приложения.

После деплоя проверьте **тот же домен, который добавлен в Search Console**:

```bash
npm run test:verification
npm run test:verification -- --url https://your-domain.example
```

Вторая команда проверяет HTTP 200 без редиректов и содержимое **обоих** файлов
(Google и Яндекс) на сайте. Проверки конфигурации и `--built` проверяют только
локальные маршруты и артефакты: они не доказывают, что продакшен отдаёт файл,
а не SPA shell. Проверка `--url` после деплоя обязательна. По адресу
`https://your-domain.example/google65ee958671ecedb0.html` должна быть только строка:

```text
google-site-verification: google65ee958671ecedb0.html
```

Затем нажмите «Подтвердить» в Search Console. Локальные проверки не подтверждают
владение в Google автоматически. Если Search Console предлагает другое имя файла,
скачайте именно этот файл, положите его без изменений в `public/`, обновите имя
в `scripts/check-verification.mjs` и повторно выполните деплой. Не удаляйте файл
после успешного подтверждения.

Файл Яндекса: `public/yandex_4ba4f536815316a1.html` — HTML с
`Verification: 4ba4f536815316a1` в `<body>`. Скрипт проверяет наличие и содержимое
обоих файлов в `public/`, а с `--built` — также в `dist/` после пререндера.
Пробелы по краям файлов и форматирование между HTML-тегами Яндекса допускаются;
неверные токены, SPA shell и посторонние вставки — нет.

Метод **HTML-тег** использует отдельный токен из Search Console: ID из имени
HTML-файла нельзя подставлять в `<meta name="google-site-verification">`.

## Быстрая загрузка

Полный аудит и метрики — в [docs/perf-baseline.md](./docs/perf-baseline.md).
Ключевые приёмы (сборка + runtime):

- **Код-сплиттинг** — `manualChunks` (vendor-react / tanstack / supabase / ui),
  авто-сплиттинг роутов; Supabase SDK вынесен из initial bundle и грузится
  лениво при входе в админку.
- **Preconnect к Supabase** — плагин `injectResourceHints` в `vite.config.ts`
  добавляет в `<head>` `preconnect`/`dns-prefetch`: соединение к API и Storage
  открывается параллельно с загрузкой JS, а не после первого запроса.
- **Приоритет обложек (LCP)** — первый ряд каталога грузится `eager` +
  `fetchpriority="high"`, остальные — `loading="lazy"` + `decoding="async"`
  (`TitleCard`/`TitleGrid`).
- **`content-visibility: auto`** — длинный список глав рендерится браузером
  только при скролле (класс `cv-auto`), контент при этом виден ботам.
- **Кэш данных TanStack Query** — главы и страницы immutable (`staleTime:
  Infinity`), следующая глава префетчится на предпоследней странице.
- **Виртуализация читалки** — в DOM держатся только страницы у вьюпорта
  (`IntersectionObserver`), 80+ страниц не грузят GPU.
- **Иммутабельное кэширование статики** — `/assets/*` отдаются с
  `Cache-Control: max-age=31536000, immutable` (vercel.json), сжатие brotli —
  автоматически на CDN Vercel.
- **Пререндер главной** — пользователь (и бот) получает HTML каталога с
  обложками уже в первом ответе, до загрузки JS.

## Бэкенд

Данные берутся из Supabase, если заданы `VITE_SUPABASE_URL` и
`VITE_SUPABASE_ANON_KEY` (или `VITE_SUPABASE_PUBLISHABLE_KEY` — так их инжектит
Lovable при подключении Supabase-проекта). Если переменных нет, приложение не
падает, а работает на локальном хранилище в `localStorage` — это легко принять
за «Supabase подключён», поэтому подробности, миграции, создание первого админа
и деплой edge-функции описаны в **[SETUP_SUPABASE.md](./SETUP_SUPABASE.md)**.

Шаблон переменных — в [`.env.example`](./.env.example).

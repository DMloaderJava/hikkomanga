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
Чтобы тайтлы и главы попадали в индекс, сборка делает три вещи:

1. **Пререндер** (`scripts/prerender.mjs`) — рендерит публичные маршруты в Node
   и раскладывает готовый HTML в `dist/` (`/`, `/advertise`, `/title/$slug`,
   `/title/$slug/chapter/$number`). Бот получает контент, `<title>`,
   `description`, `og:*` и `canonical` без запуска JS.
2. **sitemap.xml + robots.txt** (`scripts/generate-sitemap.mjs`) — список
   опубликованных тайтлов и глав из Supabase; `/admin` и `/api` закрыты.
3. **Мета-теги** (`src/lib/seo.ts`) — единое описание метаданных маршрута,
   используется и клиентом, и пререндером. Админка и страницы ошибок получают
   `<meta name="robots" content="noindex, nofollow">`.

Нужные переменные:

| Переменная | Зачем |
| --- | --- |
| `VITE_SITE_URL` | канонический домен (`https://example.com`, без слэша) — нужен для `canonical`, `og:url` и sitemap. **Без него sitemap соберётся на `https://hikkomanga.vercel.app`** |
| `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` | список тайтлов/глав для sitemap и пререндера (без них — только `/` и `/advertise`) |
| `PRERENDER_CHAPTERS=0` | не пререндерить страницы глав |
| `PRERENDER_MAX_URLS=1000` | лимит страниц за сборку |

Отдельные команды: `npm run sitemap`, `npm run prerender`,
`npm run build:spa` (сборка без sitemap/пререндера).

После деплоя: в Google Search Console и Яндекс.Вебмастер добавить
`https://<домен>/sitemap.xml` (вкладка «Файлы Sitemap»).

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

## Бэкенд

Данные берутся из Supabase, если заданы `VITE_SUPABASE_URL` и
`VITE_SUPABASE_ANON_KEY` (или `VITE_SUPABASE_PUBLISHABLE_KEY` — так их инжектит
Lovable при подключении Supabase-проекта). Если переменных нет, приложение не
падает, а работает на локальном хранилище в `localStorage` — это легко принять
за «Supabase подключён», поэтому подробности, миграции, создание первого админа
и деплой edge-функции описаны в **[SETUP_SUPABASE.md](./SETUP_SUPABASE.md)**.

Шаблон переменных — в [`.env.example`](./.env.example).

Загрузка страниц глав: JPG/JPEG, PNG, WebP, GIF (анимация сохраняется), AVIF, BMP, TIFF/TIF, HEIC/HEIF и PDF → WebP-страницы; лимиты и настройка описаны в [SETUP_SUPABASE.md](SETUP_SUPABASE.md#загрузка-страниц-глав).

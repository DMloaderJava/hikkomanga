# Динамический рендеринг для поисковых ботов и краулеров

> Дополнение к build-time пререндеру (`scripts/prerender.mjs`). Оба механизма
> рендерят **одно и то же приложение** — меняется только момент времени:
> пререндер — на сборке, динамический рендер — в момент запроса бота.

## Зачем

Пререндер кладёт в `dist/` статический HTML только для URL, известных на
момент сборки. Если владелец публикует новый тайтл или главу — до следующего
деплоя бот по такому URL получил бы пустой SPA-шелл (нет `<title>`, нет
описания, нет контента). Динамический рендер закрывает этот хвост: любой
публичный маршрут рендерится на сервере по запросу, без пересборки.

## Как это работает

```
                        ┌──────────────────────────── Vercel ────────────────────────────┐
Googlebot / YandexBot   │                                                                │
──────────────────────►│  middleware.ts (Edge)                                          │
"GET /title/new-slug"   │   1. User-Agent — бот?  (src/lib/bots.mjs)                     │
                        │   2. Путь — публичный маршрут? (/, /advertise, /title/...)     │
                        │      иначе → пропускаем как есть (пользователь, ассет, админка)│
                        │   3. rewrite → /api/render?path=/title/new-slug                │
                        │                          │                                     │
                        │                          ▼                                     │
                        │  api/render.mjs (serverless, Node)                              │
                        │   4. кэш памяти (TTL 15 мин) ── попадание? ───► готовый HTML   │
                        │   5. промах → dist-ssr/render.mjs                               │
                        │        (SSR-бандл: react-dom/server + TanStack Router)          │
                        │        loader'ы читают Supabase → renderToString → buildHtml    │
                        │   6. Cache-Control: s-maxage=3600 → CDN кэширует ответ          │
                        └────────────────────────────────────────────────────────────────┘

Обычный браузер
──────────────────────►│  middleware пропускает → dist/title/new-slug/index.html
                       │  (пререндер со сборки) или SPA-шелл (rewrite → /index.html)
```

Порядок маршрутизации Vercel: **middleware → filesystem → rewrites**. Поэтому
пользователи вообще не касаются функции рендера, а боты не получают шелл.

## Составные части

| Файл | Роль |
| --- | --- |
| `src/lib/bots.mjs` | Список User-Agent ботов + валидация рендеримых путей. Один источник для middleware, функции и скриптов (plain JS — его собирает и edge-runtime, и Node) |
| `middleware.ts` | Edge Middleware: детект бота → `rewrite()` из `@vercel/functions`. Matcher исключает `api/`, `assets/`, `media/`, `admin`, `_vercel`, sitemap/robots/файлы подтверждения |
| `api/render.mjs` | Serverless-функция: GET/HEAD `/api/render?path=…`, заголовки кэширования, `Retry-After` на 5xx |
| `scripts/lib/dynamic-render.mjs` | Общий рантайм: ленивая загрузка SSR-бандла, in-memory кэш (FIFO, 256 записей), `cacheControlFor()` |
| `src/entry-render.ts` | Entry SSR-сборки: `renderPage(path)` → полный HTML; 404 для `notFound()`, 503 при сбоях данных |
| `vite.ssr.config.ts` | Сборка `dist-ssr/render.mjs` — самодостаточный ESM-бандл (react-dom/server и зависимости внутри) |
| `scripts/serve-dynamic.mjs` | Локальный сервер `npm run preview:dynamic` с тем же поведением, что прод |

## Сборка

`npm run build` = клиентская сборка → **SSR-сборка** → sitemap → пререндер →
проверки. Важные детали:

- Клиентская сборка сохраняет нетронутый SPA-шелл в `dist/ssr-shell.html`
  (плагин `preserve-ssr-shell`): дальше `dist/index.html` перезаписывает
  пререндер главной, а SSR-сборка и `prerender.mjs` используют как шаблон
  именно чистый шелл.
- SSR-сборка (`vite build --config vite.ssr.config.ts`) вшивает шаблон в бандл
  `?raw`-импортом и поэтому всегда запускается **после** клиентской.
- `import.meta.env.VITE_*` (Supabase URL/ключ) инлайнятся в SSR-бандл на
  сборке — функция читает ту же базу, что и браузер.

## Статусы ответов

| Ситуация | Статус | Кэш |
| --- | --- | --- |
| Страница есть, отрендерена | 200 | память 15 мин + CDN `s-maxage` 1 ч + SWR 24 ч |
| Тайтл/глава не существуют (`throw notFound()` в loader) | **404** + SPA-шелл | память 15 мин, CDN ≤ 10 мин |
| Supabase недоступен / ошибка loader'а | **503** + `Retry-After` | память ≤ 60 с, CDN `no-store` |
| Путь не публичный (админка, api, ассеты) | 404 текст | — |

Честный 404 вместо 200-с-шеллом важен: иначе в поиске копятся soft-404.
Отсутствие данных в loader'ах публичных маршрутов помечено `notFound()`
(TanStack Router), SPA при этом показывает `notFoundComponent` с `noindex`.

## Кэширование

1. **Память функции** (`DYNAMIC_RENDER_TTL`, по умолчанию 900 с) — тёплый
   инстанс отдаёт повторные запросы за миллисекунды; 503 кэшируется не дольше
   60 с, чтобы временный сбой СУБД не «прилип».
2. **CDN Vercel** — `Cache-Control: s-maxage=…` на ответе функции: первый
   рендер пути раздаётся всем ботам с края. 404 кэшируется краем короче
   (≤ 10 мин), 5xx не кэшируются вовсе.
3. Пользовательский трафик через `/api/render` не идёт, так что раздельного
   кэширования «бот vs человек» не требуется (и нет риска склеить их варианты).

## Окружение

| Переменная | По умолчанию | Смысл |
| --- | --- | --- |
| `DYNAMIC_RENDER_TTL` | `900` | TTL живого кэша рендера в памяти функции, сек |
| `DYNAMIC_RENDER_S_MAXAGE` | `3600` | `s-maxage` для CDN, сек |
| `DYNAMIC_RENDER_SWR` | `86400` | окно `stale-while-revalidate`, сек |

## Кого считаем ботом

`src/lib/bots.mjs`: Googlebot (вкл. mobile и InspectionTool), Bingbot,
Yandex-боты, DuckDuckBot, Baiduspider, Applebot, PetalBot, Sogou, соцсети и
мессенджеры (Twitterbot, Facebook, Telegram, WhatsApp, Slack, Discord,
LinkedIn, Pinterest, ВК, Viber, Skype), SEO-краулеры (Semrush, Ahrefs,
MJ12, DotBot, Screaming Frog), AI-краулеры (GPTBot, ClaudeBot, Perplexity,
Bytespider, CCFbot) и инструменты аудита (Lighthouse, HeadlessChrome — им
тоже полезнее честный отрендеренный HTML).

Токены подобраны так, чтобы не ловить обычные браузеры: `YaBrowser` и
`YaApp` не совпадают с `yandexbot`/`yandeximages` (проверяется юнит-тестами).

## Anti-cloaking

Боту отдаётся **тот же контент, что видит пользователь** после загрузки JS:
рендерится то же React-приложение тем же кодом, что и пререндер. Различается
только способ доставки (готовый HTML vs SPA-шелл) — это рекомендованный
Google сценарий dynamic rendering, а не клоакинг.

## Ограничения и заметки

- Задержка для бота на холодном старте — сотни миллисекунд (рендер в памяти
  CDN кэшируется), для пользователей задержки нет вовсе: middleware для
  не-ботов делает одну проверку User-Agent и пропускает запрос.
- Проверка «настоящий ли Googlebot» (reverse DNS) не выполняется — контент
  публичный, подделка UA ничего не даёт.
- `DYNAMIC_RENDER_*` меняют поведение без пересборки (переменные функции).
- Локально всё то же самое проверяет `npm run preview:dynamic`
  (см. README, раздел «Динамический рендеринг: как проверить локально»).

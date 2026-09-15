# hikkomanga

Читалка манги с админ-панелью: тайтлы, главы, страницы, жанры и AI-озвучка
(Gemini) глав.

Стек: Vite + React 19 + TypeScript, TanStack Router, TanStack Query, Tailwind 4,
Supabase (Auth / Postgres / Storage / Edge Functions).

## Запуск

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # прод-сборка в dist/
npm run typecheck
```

## Бэкенд

Данные берутся из Supabase, если заданы `VITE_SUPABASE_URL` и
`VITE_SUPABASE_ANON_KEY` (или `VITE_SUPABASE_PUBLISHABLE_KEY` — так их инжектит
Lovable при подключении Supabase-проекта). Если переменных нет, приложение не
падает, а работает на локальном хранилище в `localStorage` — это легко принять
за «Supabase подключён», поэтому подробности, миграции, создание первого админа
и деплой edge-функции описаны в **[SETUP_SUPABASE.md](./SETUP_SUPABASE.md)**.

Шаблон переменных — в [`.env.example`](./.env.example).

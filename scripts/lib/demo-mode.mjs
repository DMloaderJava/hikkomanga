/**
 * Принудительный демо-режим для тестов слоя данных.
 *
 * `smoke-data-layer.mjs` и `unit-auth-notify.mjs` проверяют mockStore, а не
 * Supabase. Но `src/integrations/supabase/config.ts` читает VITE_*, и если у
 * разработчика настроен `.env` (штатная ситуация, см. `.env.example`), модули
 * уходят в реальную базу: анонимные INSERT падают на RLS, а результат теста
 * начинает зависеть от состояния проекта и применённых миграций.
 *
 * Vite-функция `loadEnv()` копирует `process.env.VITE_*` ПОВЕРХ значений из
 * .env-файлов, поэтому пустая строка здесь гарантированно побеждает файл.
 * Дополнительно сервер создаётся с `envFile: false`.
 *
 * Не применять в `prerender.mjs` / `generate-sitemap.mjs` — им нужна реальная
 * база.
 */

/** Переменные, по которым `isSupabaseConfigured` включает реальный клиент. */
export const SUPABASE_ENV_KEYS = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_SUPABASE_PUBLIC_KEY',
];

/** Обнуляет Supabase-переменные. Вызывать ДО `createServer()`. */
export function forceDemoMode() {
  for (const key of SUPABASE_ENV_KEYS) process.env[key] = '';
}

/** Опции Vite-сервера для тестов: .env-файлы не читаются вообще. */
export const DEMO_SERVER_OPTIONS = {
  envFile: false,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
};
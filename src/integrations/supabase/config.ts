/**
 * Supabase connection settings.
 *
 * The key can arrive under different names depending on where the app is built:
 *   - VITE_SUPABASE_ANON_KEY        → classic Supabase project (.env / Vercel)
 *   - VITE_SUPABASE_PUBLISHABLE_KEY → what Lovable injects when a Supabase
 *                                     project is connected through its
 *                                     integration (new `sb_publishable_...` keys)
 *   - NEXT_PUBLIC_SUPABASE_*        → hosts whose project keeps the Next.js
 *                                     naming; `envPrefix` in vite.config.ts
 *                                     whitelists that prefix for the bundle
 *   - VITE_SUPABASE_SERVICE_KEY     → never use a service key in the browser,
 *                                     deliberately NOT read here
 * Bare `SUPABASE_URL` / `SUPABASE_ANON_KEY` are intentionally NOT read on the
 * client: the `SUPABASE_` prefix is not whitelisted (it also covers
 * `SUPABASE_SERVICE_ROLE_KEY`, which must never reach the browser). Rename them
 * to `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` on the host instead.
 *
 * Both the legacy anon JWT (`eyJ...`) and the new publishable key
 * (`sb_publishable_...`) are valid for `createClient`, so we just take
 * whichever one is present.
 */
const env = import.meta.env as Record<string, string | undefined>;

/** Первое непустое значение из списка имён: пустая строка не «перебивает» алиас. */
function firstValue(...names: string[]): string {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

export const SUPABASE_URL = firstValue('VITE_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');

export const SUPABASE_ANON_KEY = firstValue(
  'VITE_SUPABASE_ANON_KEY',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_SUPABASE_PUBLIC_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SUPABASE_PUBLIC_KEY',
  'NEXT_PUBLIC_SUPABASE_KEY'
);

/** Lovable also exposes the project reference; handy for links to the dashboard. */
export const SUPABASE_PROJECT_ID = firstValue(
  'VITE_SUPABASE_PROJECT_ID',
  'NEXT_PUBLIC_SUPABASE_PROJECT_ID'
);

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/* Without these variables every data module silently degrades to the
   localStorage mockStore, which looks exactly like a working app — you only
   notice when data disappears on another device. Shout about it in dev. */
if (!isSupabaseConfigured && env.DEV) {
  console.warn(
    '[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (или ' +
      'VITE_SUPABASE_PUBLISHABLE_KEY, или NEXT_PUBLIC_SUPABASE_*) не заданы — приложение работает на ' +
      'локальном mockStore в localStorage, а не на реальной базе. ' +
      'См. SETUP_SUPABASE.md.'
  );
}

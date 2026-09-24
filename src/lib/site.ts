/**
 * Базовый адрес сайта. Нужен для абсолютных ссылок в canonical / og:url /
 * sitemap.xml. Задаётся переменной `VITE_SITE_URL` (см. .env.example) — на
 * проде это https-домен без завершающего слэша. Принимается и
 * `NEXT_PUBLIC_SITE_URL` (такое имя env бывает у проектов, заведённых по
 * шаблону Next.js, см. `envPrefix` в vite.config.ts).
 *
 * В браузере, если переменная не задана, подставляется текущий origin.
 * В Node (скрипты сборки) `window` нет — тогда остаётся только переменная.
 */
const env = import.meta.env as Record<string, string | undefined>;

const configured = (env.VITE_SITE_URL || env.NEXT_PUBLIC_SITE_URL || '')
  .trim()
  .replace(/\/+$/, '');

export const SITE_URL: string =
  configured || (typeof window !== 'undefined' ? window.location.origin : '');

export const SITE_NAME = 'Hikkomanga';

export const DEFAULT_DESCRIPTION =
  'Онлайн читалка манги и манхвы: каталог тайтлов, удобный читатель глав и ' +
  'AI-озвучка. Читайте популярные произведения бесплатно.';

/** Абсолютный URL для внутреннего пути; без SITE_URL — undefined. */
export function absoluteUrl(path?: string): string | undefined {
  if (!SITE_URL) return undefined;
  if (!path) return SITE_URL;
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

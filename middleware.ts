/**
 * Edge Middleware: динамический рендеринг для поисковых ботов и краулеров.
 *
 * Выполняется на каждом запросе до статики и rewrites (порядок маршрутизации
 * Vercel: middleware → filesystem → rewrites), поэтому:
 *
 *   пользователь → middleware пропускает → пререндеренный HTML из dist/
 *                  (если собран) или SPA-шелл по rewrite из vercel.json;
 *   бот         → rewrite на /api/render?path=... → серверный рендер SPA
 *                  тем же кодом, что и build-time пререндер.
 *
 * Зачем это нужно вместе со build-time пререндером: статика готова только
 * для URL, известных на момент сборки. Динамический рендер покрывает хвост —
 * тайтлы и главы, опубликованные после деплоя, а также страницы за лимитом
 * PRERENDER_MAX_URLS. Бот всегда получает контент, <title>, description,
 * og:* и canonical без выполнения JS.
 *
 * Файл не входит в tsconfig (include: ["src"]) — его собирает Vercel.
 */
import { rewrite } from '@vercel/functions';
import { isBotUserAgent, isRenderablePath, normalizeRenderPath } from './src/lib/bots.mjs';

// Не запускаем middleware на всём, что рендерить не нужно: ассеты, api,
// админка, файлы подтверждения, sitemap/robots. Суффиксы не отсекаем по
// точке: у глав бывают дробные номера (/title/slug/chapter/1.5).
export const config = {
  matcher: [
    '/((?!api|assets|media|admin|_vercel|_next|sitemap\\.xml|robots\\.txt|google[^/]*\\.html|yandex_[^/]*\\.html|favicon\\.ico).*)',
  ],
};

export default function middleware(request: Request) {
  const userAgent = request.headers.get('user-agent');
  if (!userAgent || !isBotUserAgent(userAgent)) {
    return undefined; // обычный посетитель — без единого байта накладных расходов
  }

  const url = new URL(request.url);
  const path = normalizeRenderPath(url.pathname);
  if (!isRenderablePath(path)) {
    return undefined; // бот в админке/на служебном пути — отдаём как есть
  }

  // Исходный query (utm и пр.) в рендер и CDN-ключ не попадает.
  const target = new URL('/api/render', url);
  target.searchParams.set('path', path);
  return rewrite(target);
}

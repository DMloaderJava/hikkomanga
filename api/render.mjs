/**
 * Vercel-функция динамического рендеринга: /api/render?path=/title/...
 *
 * Сюда попадает rewrite из middleware.ts, когда страницу запросил поисковый
 * бот или краулер. Функция рендерит SPA на сервере (dist-ssr/render.mjs),
 * кэширует результат в памяти тёплого инстанса и отдаёт с Cache-Control
 * s-maxage — CDN Vercel кэширует ответ, поэтому рендер каждого пути
 * выполняется не чаще раза в час (DYNAMIC_RENDER_S_MAXAGE).
 *
 * Пользователи сюда не попадают никогда: middleware рерайтит только ботов,
 * robots.txt закрывает /api/, а прямой заход отдаёт тот же публичный контент.
 */
import { renderer, cacheControlFor } from '../scripts/lib/dynamic-render.mjs';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Method Not Allowed');
    return;
  }

  let pathname = '/';
  try {
    const base = `http://${req.headers.host || 'localhost'}`;
    pathname = new URL(req.url || '/', base).searchParams.get('path') || '/';
  } catch {
    // некорректный URL — рендерим главную
  }

  const entry = await renderer.render(pathname);
  if (!entry.html) {
    // not-renderable (404) или сбой SSR-бандла (503)
    res.statusCode = entry.status || 503;
    if (res.statusCode >= 500) res.setHeader('Retry-After', '600');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Dynamic render unavailable');
    return;
  }

  res.statusCode = entry.status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', cacheControlFor(entry));
  res.setHeader('X-Dynamic-Render', entry.reason);
  res.end(req.method === 'HEAD' ? undefined : entry.html);
}

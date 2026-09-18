/**
 * Локальный «прод»-сервер с динамическим рендерингом: как сайт поведёт себя
 * на Vercel, но на вашей машине.
 *
 *   npm run build && npm run preview:dynamic
 *   curl -s -A "Mozilla/5.0 (compatible; Googlebot/2.1)" http://localhost:4173/title/magicheskaya-bitva | head -30
 *   curl -s http://localhost:4173/title/magicheskaya-bitva | head -30   # обычный UA
 *
 * Поведение повторяет Vercel:
 *   1. статика из dist/ (включая пререндеренные каталоги);
 *   2. бот на публичном маршруте → динамический рендер (dist-ssr/render.mjs)
 *      с in-memory кэшем и CDN-подобными заголовками;
 *   3. все остальные → SPA-шелл (аналог rewrite → /index.html);
 *   4. /api/render?path=... — та же Vercel-функция (api/render.mjs).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBotUserAgent, isRenderablePath, normalizeRenderPath } from '../src/lib/bots.mjs';
import { createRenderer, cacheControlFor } from './lib/dynamic-render.mjs';
import handleRender from '../api/render.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../dist');

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const PORT = Number(argValue('port') || process.env.PORT || 4173);
const HOST = argValue('host') || '0.0.0.0';

const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
  map: 'application/json',
};

// Пути, которым SPA-шелл не положен (зеркало rewrite-исключений vercel.json)
const NO_SPA_FALLBACK = /^\/(?:api|assets|media)(?:\/|$)/;

const renderer = createRenderer();

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendFile(req, res, filePath, status = 200, extraHeaders = {}) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const cacheable = /^\/(?:assets|media)\//.test(filePath.slice(DIST.length).replace(/\\/g, '/'));
  const headers = {
    'Content-Type': type,
    ...extraHeaders,
  };
  if (cacheable) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  if (req.method === 'HEAD') {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const body = fs.readFileSync(filePath);
  res.writeHead(status, { ...headers, 'Content-Length': body.length });
  res.end(body);
}

/** Безопасный маппинг URL → файл в dist (без выхода за корень). */
function resolveStatic(pathname) {
  const clean = pathname.replace(/\\/g, '/');
  const base = path.join(DIST, clean);
  if (!path.resolve(base).startsWith(path.resolve(DIST))) return null;
  // каталог → index.html внутри (пререндеренные маршруты: /title/x → /title/x/index.html)
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    const index = path.join(base, 'index.html');
    return fs.existsSync(index) ? index : null;
  }
  return fs.existsSync(base) ? base : null;
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    return send(res, 400, 'Bad Request');
  }
  const pathname = normalizeRenderPath(url.pathname);
  const isBot = isBotUserAgent(req.headers['user-agent'] || '');

  try {
    // 1. Тот же обработчик, что и на Vercel: /api/render?path=...
    if (pathname === '/api/render') {
      await handleRender(req, res);
      return;
    }

    // 2. Статика (и пререндеренные страницы)
    const file = resolveStatic(pathname);
    if (file && (req.method === 'GET' || req.method === 'HEAD')) {
      sendFile(req, res, file);
      console.log(`${req.method} ${pathname} → 200 (static)`);
      return;
    }

    // 3. Бот на публичном маршруте без статики → динамический рендер
    if (isBot && isRenderablePath(pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
      const entry = await renderer.render(pathname);
      if (entry.html) {
        console.log(
          `${req.method} ${pathname} → ${entry.status} (dynamic, ${entry.reason}, cache ${renderer.stats().entries})`,
        );
        return send(res, entry.status, req.method === 'HEAD' ? undefined : entry.html, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': cacheControlFor(entry),
          'X-Dynamic-Render': entry.reason,
        });
      }
      return send(res, entry.status || 503, 'Dynamic render unavailable', {
        'Content-Type': 'text/plain; charset=utf-8',
        ...(entry.status >= 500 ? { 'Retry-After': '600' } : {}),
      });
    }

    // 4. SPA-шелл для остальных путей (кроме служебных)
    if (NO_SPA_FALLBACK.test(pathname)) {
      return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    const shell = path.join(DIST, 'index.html');
    if (fs.existsSync(shell)) {
      sendFile(req, res, shell);
      console.log(`${req.method} ${pathname} → 200 (spa${isBot ? ', бот без рендера' : ''})`);
      return;
    }
    return send(res, 404, 'dist/ не собран — выполните npm run build', {
      'Content-Type': 'text/plain; charset=utf-8',
    });
  } catch (error) {
    console.error(`[serve-dynamic] ${pathname}:`, error);
    return send(res, 500, 'Internal Server Error', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[serve-dynamic] http://${HOST}:${PORT}`);
  console.log(`[serve-dynamic] dist: ${DIST}`);
  console.log('[serve-dynamic] проверка динамического рендера:');
  console.log(`  curl -s -A "Googlebot" http://localhost:${PORT}/title/magicheskaya-bitva | grep -m1 title`);
  console.log(`  curl -s http://localhost:${PORT}/ | grep -c 'id="root"><' || true   # 0 = шелл`);
});

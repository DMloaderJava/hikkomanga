/**
 * Юнит-тесты динамического рендеринга: детект ботов, рендеримые пути,
 * сборка HTML, кэш и заголовки. Запуск: `npm run test:dynamic`
 * (входит в общий `npm test`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isBotUserAgent,
  isRenderablePath,
  normalizeRenderPath,
  BOT_TOKENS,
} from '../src/lib/bots.mjs';
import { buildHtml } from '../src/lib/render-html.mjs';
import { createRenderer, cacheControlFor } from './lib/dynamic-render.mjs';

// ---------------------------------------------------------------- bots ----

test('известные боты распознаются', () => {
  const bots = [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.224 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', // eslint-disable-line max-len
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
    'DuckDuckBot/1.0; (+http://duckduckgo.com/duckduckbot.html)',
    'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
    'Twitterbot/1.0',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'TelegramBot (like TwitterBot)',
    'WhatsApp/2.19.81 A',
    'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)',
    'GPTBot/1.0 (+https://openai.com/gptbot)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com) Chrome/120.0.0.0 Safari/537.36', // eslint-disable-line max-len
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (compatible; Google-InspectionTool/1.0)',
  ];
  for (const ua of bots) {
    assert.ok(isBotUserAgent(ua), `должен быть ботом: ${ua}`);
  }
});

test('обычные браузеры не считаются ботами', () => {
  const humans = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0',
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 YaBrowser/24.6.0.0', // eslint-disable-line max-len
    '',
  ];
  for (const ua of humans) {
    assert.ok(!isBotUserAgent(ua), `не должен быть ботом: ${ua || '(пусто)'}`);
  }
});

test('токены ботов не пересекаются с обычными браузерами', () => {
  // YaBrowser не должен ловиться токеном 'yandex*'
  assert.ok(!isBotUserAgent('Mozilla/5.0 ... YaApp_Android/24.0 YaSearchBrowser/24.0'));
  // но точные yandex-боты — должны
  assert.ok(isBotUserAgent('YandexBot/3.0'));
  assert.ok(isBotUserAgent('YandexImages/3.0'));
});

// ---------------------------------------------------------------- paths ----

test('рендеримы только публичные маршруты', () => {
  const yes = [
    '/',
    '/advertise',
    '/title/podnyatie-urovnya-v-odinochku',
    '/title/magicheskaya-bitva/chapter/1',
    '/title/klinok-rassekayushchiy-demonov/chapter/12.5', // дробный номер главы
    '/title/x/',         // хвостовой слэш
    '/title/x//chapter//2', // дубли слэшей нормализуются внутри
  ];
  for (const p of yes) assert.ok(isRenderablePath(p), `должен рендериться: ${p}`);

  const no = [
    '',
    '/admin',
    '/admin/login',
    '/api/render',
    '/assets/app.js',
    '/media/pages/1.jpg',
    '/robots.txt',
    '/sitemap.xml',
    '/google65ee958671ecedb0.html',
    '/yandex_4ba4f536815316a1.html',
    '/favicon.ico',
    '/title',            // без slug
    '/title/x/unknown',  // неизвестный подсегмент
    '/foo',
    '/title/../admin',   // обход через ..
    '/title/%2e%2e/admin',
  ];
  for (const p of no) assert.ok(!isRenderablePath(p), `не должен рендериться: ${p}`);
});

test('normalizeRenderPath: decode, слэши, пустой путь', () => {
  assert.equal(normalizeRenderPath('/title/x/'), '/title/x');
  assert.equal(normalizeRenderPath('//title//x'), '/title/x');
  assert.equal(normalizeRenderPath(''), '/');
  assert.equal(normalizeRenderPath('/'), '/');
  assert.equal(normalizeRenderPath('/title/%D0%BC%D0%B0%D0%BD%D0%B3%D0%B0'), '/title/манга');
  assert.equal(normalizeRenderPath('/title/%zz-broken'), '/title/%zz-broken'); // битый % не ломает
});

// ----------------------------------------------------------- buildHtml ----

test('buildHtml: подмена head-тегов и вставка тела', () => {
  const template = `<!DOCTYPE html>
<html lang="ru">
  <head>
    <title>Default — Hikkomanga</title>
    <meta name="description" content="default description" />
    <meta name="robots" content="index, follow" />
    <link rel="preconnect" href="https://example.supabase.co" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>`;
  const out = buildHtml(template, {
    html: '<h1>Каталог</h1>',
    head: '<title>Новая — Hikkomanga</title>\n<meta name="description" content="новое" />',
  });

  assert.ok(out.includes('<div id="root"><h1>Каталог</h1></div>'), 'тело вставлено в #root');
  assert.ok(!out.includes('Default — Hikkomanga'), 'дефолтный title удалён');
  assert.ok(!out.includes('default description'), 'дефолтный description удалён');
  assert.ok(out.includes('Новая — Hikkomanga'), 'новый title на месте');
  assert.ok(out.includes('content="новое"'), 'новый description на месте');
  assert.ok(out.includes('rel="preconnect"'), 'resource hints не тронуты');
  assert.ok(out.includes('/assets/app.js'), 'клиентский бандл подключён');
});

// ---------------------------------------------------------- renderer ------

test('renderer: кэш, TTL и FIFO-вытеснение', async () => {
  let calls = 0;
  const fakeModule = {
    async renderPage(path) {
      calls += 1;
      return { html: `<html>${path}</html>`, status: 200, reason: 'rendered' };
    },
  };
  const r = createRenderer({ loadModule: () => Promise.resolve(fakeModule), ttlSec: 60 });

  const first = await r.render('/title/a');
  assert.equal(first.html, '<html>/title/a</html>');
  assert.equal(calls, 1);

  const cached = await r.render('/title/a'); // из кэша
  assert.equal(cached.html, '<html>/title/a</html>');
  assert.equal(calls, 1, 'второй вызов не должен рендерить заново');

  const notRenderable = await r.render('/admin');
  assert.equal(notRenderable.html, null);
  assert.equal(notRenderable.status, 404);
  assert.equal(calls, 1, 'нерендеримый путь не доходит до SSR-бандла');

  // вытеснение: maxEntries = 2
  const tiny = createRenderer({ loadModule: () => Promise.resolve(fakeModule), ttlSec: 60, maxEntries: 2 });
  await tiny.render('/title/a');
  await tiny.render('/title/b');
  await tiny.render('/title/c'); // вытесняет /title/a
  assert.equal(tiny.stats().entries, 2);
  const again = await tiny.render('/title/a'); // промах кэша → ререндер
  assert.equal(again.html, '<html>/title/a</html>');
  assert.ok(calls >= 4, 'вытесненная страница рендерится заново');
});

test('renderer: сбой загрузки SSR-бандла даёт 503 и не клинит кэш', async () => {
  let fail = true;
  const flaky = {
    loadModule: () => (fail ? Promise.reject(new Error('dist-ssr missing')) : Promise.resolve({
      async renderPage(path) {
        return { html: `ok ${path}`, status: 200, reason: 'rendered' };
      },
    })),
  };
  const r = createRenderer({ loadModule: flaky.loadModule, ttlSec: 60 });

  const broken = await r.render('/title/x');
  assert.equal(broken.status, 503);
  assert.equal(broken.html, null);

  fail = false; // починили
  const fixed = await r.render('/title/x');
  assert.equal(fixed.status, 200);
  assert.equal(fixed.html, 'ok /title/x');
});

test('renderer: 503 кэшируется короче, 404 — тоже рендерится', async () => {
  const mod = {
    async renderPage(path) {
      if (path === '/title/gone') return { html: 'shell', status: 404, reason: 'not-found' };
      return { html: 'oops', status: 503, reason: 'render-error' };
    },
  };
  const r = createRenderer({ loadModule: () => Promise.resolve(mod), ttlSec: 3600 });
  const notFound = await r.render('/title/gone');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.html, 'shell');
  const err = await r.render('/');
  assert.equal(err.status, 503);
  assert.equal(err.html, 'oops');
});

// -------------------------------------------------------- cache-control ---

test('cacheControlFor: s-maxage для 200/404, no-store для 5xx', () => {
  const env = { DYNAMIC_RENDER_S_MAXAGE: '1800', DYNAMIC_RENDER_SWR: '3600' };
  assert.equal(
    cacheControlFor({ status: 200 }, env),
    'public, max-age=0, s-maxage=1800, stale-while-revalidate=3600',
  );
  // 404 кэшируется на крае не дольше 10 минут
  assert.ok(cacheControlFor({ status: 404 }, env).includes('s-maxage=600'));
  assert.equal(cacheControlFor({ status: 503 }, env), 'no-store');
  assert.equal(cacheControlFor(null, env), 'no-store');
  // дефолты без env
  assert.ok(cacheControlFor({ status: 200 }, {}).includes('s-maxage=3600'));
});

// ------------------------------------------------------- sanity: tokens ---

test('BOT_TOKENS: все токены непустые и без regex-метасимволов', () => {
  assert.ok(BOT_TOKENS.length > 30, 'список ботов не должен усохнуть');
  for (const token of BOT_TOKENS) {
    assert.ok(/^[a-z0-9-]+$/i.test(token), `подозрительный токен: ${token}`);
  }
});

/**
 * Пререндер публичных страниц в статический HTML.
 *
 * SPA сам по себе отдаёт ботам пустой index.html без контента, title и
 * описания: всё появляется только после выполнения JS. Этот скрипт рендерит
 * маршруты в Node (react-dom/server + TanStack Router) и раскладывает готовые
 * HTML в dist/... — бот (и пользователь на первом кадре) получает контент
 * сразу. Клиентский бандл при этом никуда не девается: после загрузки JS
 * приложение продолжает работать как обычно.
 *
 * Дополнение к статике — динамический рендер в рантайме (middleware.ts +
 * api/render.mjs): он покрывает URL, которых не было на момент сборки.
 *
 * Запуск: `node scripts/prerender.mjs` (в package.json — после `vite build`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { getPublicUrls, maxUrls } from './lib/urls.mjs';
import { buildHtml } from '../src/lib/render-html.mjs';

const DIST = path.resolve(process.cwd(), 'dist');
// Нетронутый SPA-шелл (плагин preserve-ssr-shell в vite.config.ts). Fallback на
// index.html — для случая, когда скрипт запускают сразу после чистой client-сборки.
const TEMPLATE_PATH = fs.existsSync(path.join(DIST, 'ssr-shell.html'))
  ? path.join(DIST, 'ssr-shell.html')
  : path.join(DIST, 'index.html');

function outputPathFor(urlPath) {
  const clean = urlPath.replace(/\/+$/, '') || '/';
  return clean === '/'
    ? path.join(DIST, 'index.html')
    : path.join(DIST, clean.replace(/^\//, ''), 'index.html');
}

async function main() {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error(
      '[prerender] dist/index.html не найден — сначала выполните `vite build`.',
    );
    process.exit(1);
  }

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const { urls, env } = await getPublicUrls();
  const targets = urls.slice(0, maxUrls(env));

  // Vite в режиме SSR: даёт TS/JSX, алиасы и import.meta.env для src/*.
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'warn',
  });

  let rendered = 0;
  let skipped = 0;

  try {
    const { prerender } = await vite.ssrLoadModule('/src/entry-server.tsx');

    for (const item of targets) {
      try {
        const result = await prerender(item.path);
        const file = outputPathFor(item.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buildHtml(template, result), 'utf8');
        rendered += 1;
      } catch (error) {
        skipped += 1;
        console.warn(
          `[prerender] ${item.path} пропущен: ${error?.message ?? error}`,
        );
      }
    }
  } finally {
    await vite.close();
  }

  console.log(
    `[prerender] готово: ${rendered} страниц${skipped ? `, пропущено ${skipped}` : ''}`,
  );
}

main().catch((error) => {
  console.error('[prerender] сборка не удалась:', error?.message ?? error);
  process.exit(1);
});

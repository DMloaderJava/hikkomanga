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
 * Запуск: `node scripts/prerender.mjs` (в package.json — после `vite build`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { getPublicUrls, maxUrls } from './lib/urls.mjs';

const DIST = path.resolve(process.cwd(), 'dist');
const TEMPLATE_PATH = path.join(DIST, 'index.html');
const ROOT_MARKER = '<div id="root"></div>';

// Теги, которыми управляет пререндер: удаляем дефолтные из шаблона,
// чтобы в <head> не оказалось двух description / canonical.
const MANAGED_META =
  /<meta[^>]*(?:name|property)\s*=\s*"(?:description|robots|og:[^"]*|twitter:[^"]*)"/i;
const MANAGED_LINK = /<link[^>]*rel\s*=\s*"canonical"/i;
const TITLE_TAG = /<title[\s\S]*?<\/title>/i;

function outputPathFor(urlPath) {
  const clean = urlPath.replace(/\/+$/, '') || '/';
  return clean === '/'
    ? path.join(DIST, 'index.html')
    : path.join(DIST, clean.replace(/^\//, ''), 'index.html');
}

/** Собирает итоговый HTML: новые <head>-теги + отрендеренное тело. */
function buildHtml(template, { html, head }) {
  const withoutManaged = template
    .split('\n')
    .filter(
      (line) =>
        !MANAGED_META.test(line) &&
        !MANAGED_LINK.test(line) &&
        !TITLE_TAG.test(line),
    )
    .join('\n');

  let result = withoutManaged;
  if (result.includes('</head>')) {
    result = result.replace('</head>', `    ${head}\n  </head>`);
  } else {
    // На всякий случай: шаблон без </head> — просто дописываем в начало.
    result = result.replace('<head>', `<head>\n    ${head}`);
  }

  if (result.includes(ROOT_MARKER)) {
    result = result.replace(ROOT_MARKER, `<div id="root">${html}</div>`);
  } else {
    console.warn('[prerender] в шаблоне нет <div id="root"></div> — пропуск вставки.');
  }

  return result;
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

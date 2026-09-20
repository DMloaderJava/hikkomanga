#!/usr/bin/env node
/**
 * Генерация сид-обложек в public/media/covers/ (WebP, ширина 800px).
 *
 * Обложки тайтлов — часть контента, который готовим сами: они лежат в
 * репозитории, а не в Supabase Storage. В БД (titles.cover_url) хранится
 * относительный путь /media/covers/{slug}.webp.
 *
 * Скрипт рендерит тот же генератор плейсхолдеров, что использует приложение
 * (src/lib/placeholder-cover.ts), поэтому визуал сид-обложек совпадает с тем,
 * что показывал демо-режим раньше.
 *
 * Разовые зависимости (в package.json НЕ добавляются — см. ATTRIBUTION.md):
 *   npm i --no-save sharp
 *   node scripts/generate-seed-covers.mjs
 *
 * Список тайтлов берётся из сидов mockStore — единого источника правды:
 * добавили сид → перезапустите скрипт, обложка появится по slug.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';

const OUT_DIR = path.resolve(process.cwd(), 'public/media/covers');
const WIDTH = 800; // как compressToWebP для обложек (maxWidth 800)
const QUALITY = 82;

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
  mode: 'production',
});

try {
  const { generatePlaceholderCover } = await server.ssrLoadModule(
    '/src/lib/placeholder-cover.ts'
  );
  const { mockStore } = await server.ssrLoadModule('/src/data/mockStore.ts');

  // В SSR нет localStorage — конструктор mockStore держит сиды в памяти.
  const seeds = mockStore.getTitles(false).map((t) => ({ slug: t.slug, title: t.title }));
  if (seeds.length === 0) throw new Error('сиды mockStore пусты — нечего генерировать');

  fs.mkdirSync(OUT_DIR, { recursive: true });

  let total = 0;
  console.log('slug'.padEnd(34), 'файл', ' '.repeat(10), 'размер');
  console.log('-'.repeat(70));

  for (const { slug, title } of seeds) {
    const dataUrl = generatePlaceholderCover(title);
    const svg = decodeURIComponent(dataUrl.slice(dataUrl.indexOf(',') + 1));

    // density: SVG 300×420 растрируется крупнее, чтобы resize до 800px
    // был даунскейлом (чёткий текст), а не размытым апскейлом.
    const density = Math.ceil((WIDTH / 300) * 72);
    const outPath = path.join(OUT_DIR, `${slug}.webp`);

    const sharp = (await import('sharp')).default;
    await sharp(Buffer.from(svg), { density })
      .resize({ width: WIDTH, withoutEnlargement: false })
      .webp({ quality: QUALITY })
      .toFile(outPath);

    const size = fs.statSync(outPath).size;
    total += size;
    console.log(slug.padEnd(34), `${slug}.webp`.padEnd(14), `${(size / 1024).toFixed(1)} kB`);
  }

  console.log('-'.repeat(70));
  console.log(
    `ИТОГО: ${seeds.length} файла(ов), ${(total / 1024).toFixed(1)} kB ` +
      `(бюджет 500 kB — scripts/check-budgets.mjs)\n` +
      `Сид-обложки готовы. В mockStore пути: /media/covers/{slug}.webp`
  );
} finally {
  await server.close();
}

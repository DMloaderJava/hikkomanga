#!/usr/bin/env node
/**
 * Бюджеты размеров прод-сборки — защита от незаметной регрессии.
 *
 *   node scripts/check-budgets.mjs            # запуск после build (см. package.json)
 *   BUDGET_INITIAL_GZIP_KB=150 node …        # переопределить бюджет initial JS
 *   BUDGET_CATALOG_MEDIA_KB=350 node …       # переопределить бюджет медиа на «/»
 *
 * Что проверяется:
 *   1. Initial JS главной (dist/index.html: <script> + modulepreload), gzip —
 *      ≤ BUDGET_INITIAL_GZIP_KB (по умолчанию 145 kB). Калибровка: main на
 *      момент ввода проверки — 139.8 kB gzip (136 kB из docs/perf-baseline.md
 *      устарели из-за минорных обновлений зависимостей); запас ~3% гасит
 *      дрейф минорок, но ловит настоящий регресс (до оптимизаций было 185).
 *   2. Локальные /media/*, на которые ссылается пререндеренный index.html
 *      («первый экран каталога»), raw — ≤ BUDGET_CATALOG_MEDIA_KB (300 kB).
 *      Обложки из Supabase Storage статически не измеряются — их вес
 *      контролируется на этапе загрузки (compressToWebP, 800px, q0.85)
 *      и монитором check-covers.mjs.
 *
 * Exit 1 при пробитии бюджета — сборка падает до деплоя.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DIST = path.resolve(process.cwd(), 'dist');
const INDEX = path.join(DIST, 'index.html');
const BUDGET_INITIAL_GZIP_KB = Number(process.env.BUDGET_INITIAL_GZIP_KB || 145);
const BUDGET_CATALOG_MEDIA_KB = Number(process.env.BUDGET_CATALOG_MEDIA_KB || 300);

if (!fs.existsSync(INDEX)) {
  console.error('check-budgets: dist/index.html не найден — сначала `vite build` (+ пререндер).');
  process.exit(1);
}

const kb = (bytes) => (bytes / 1024).toFixed(2);

function distFile(rel) {
  const p = path.join(DIST, rel);
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  return { rel, raw: buf.length, gzip: zlib.gzipSync(buf).length };
}

// ── 1. Initial JS ────────────────────────────────────────────────────────────
const html = fs.readFileSync(INDEX, 'utf8');
const jsRefs = [
  ...Array.from(html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)).map((m) => m[1]),
  ...Array.from(html.matchAll(/<link[^>]+rel=["']modulepreload["'][^>]+href=["']([^"']+)["']/g)).map((m) => m[1]),
]
  .map((u) => u.replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '').split('?')[0])
  .filter((u) => u.endsWith('.js'));

const initial = Array.from(new Set(jsRefs)).map(distFile).filter(Boolean);

console.log('=== Бюджет initial JS (главная, gzip) ===');
let initialGz = 0;
for (const f of initial) {
  initialGz += f.gzip;
  console.log(`  ${f.rel.padEnd(50)} gzip ${kb(f.gzip).padStart(8)} kB`);
}
const initialOk = initialGz <= BUDGET_INITIAL_GZIP_KB * 1024;
console.log(
  `ИТОГО: ${kb(initialGz)} kB gzip из ${BUDGET_INITIAL_GZIP_KB} kB — ` +
    `${initialOk ? 'OK' : 'ПРЕВЫШЕН'}\n`
);

// ── 2. Медиа первого экрана каталога ────────────────────────────────────────
const mediaRefs = Array.from(html.matchAll(/(?:src|content)=["'](\/media\/[^"']+)["']/g)).map(
  (m) => m[1].split('?')[0]
);
const mediaFiles = Array.from(new Set(mediaRefs)).map(distFile).filter(Boolean);

console.log('=== Бюджет /media на первом экране каталога (raw) ===');
let mediaRaw = 0;
for (const f of mediaFiles) {
  mediaRaw += f.raw;
  console.log(`  ${f.rel.padEnd(50)} raw ${kb(f.raw).padStart(8)} kB`);
}
if (mediaFiles.length === 0) {
  console.log('  (пререндеренный index.html не ссылается на локальные /media — нечего мерить)');
}
const mediaOk = mediaRaw <= BUDGET_CATALOG_MEDIA_KB * 1024;
console.log(
  `ИТОГО: ${kb(mediaRaw)} kB raw из ${BUDGET_CATALOG_MEDIA_KB} kB — ` +
    `${mediaOk ? 'OK' : 'ПРЕВЫШЕН'}\n`
);

const failures = [];
if (!initialOk) failures.push(`initial JS ${kb(initialGz)} kB gzip > ${BUDGET_INITIAL_GZIP_KB} kB`);
if (!mediaOk) failures.push(`медиа каталога ${kb(mediaRaw)} kB raw > ${BUDGET_CATALOG_MEDIA_KB} kB`);

if (failures.length) {
  console.error('check-budgets: ПРЕВЫШЕН БЮДЖЕТ СБОРКИ:');
  failures.forEach((f) => console.error(`  - ${f}`));
  console.error('Оптимизируйте чанки/ассеты или осознанно поднимите бюджет через env.');
  process.exit(1);
}
console.log('check-budgets: OK');

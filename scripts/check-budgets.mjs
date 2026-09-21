#!/usr/bin/env node
/**
 * Бюджеты размеров прод-сборки — защита от незаметной регрессии.
 *
 *   node scripts/check-budgets.mjs            # запуск после build (см. package.json)
 *   BUDGET_INITIAL_GZIP_KB=150 node …        # переопределить бюджет initial JS
 *   BUDGET_CATALOG_MEDIA_KB=350 node …       # переопределить бюджет медиа на «/»
 *   BUDGET_COVERS_KB=600 node …              # переопределить бюджет обложек
 *
 * Что проверяется:
 *   1. Initial JS главной (dist/index.html: <script> + modulepreload), gzip —
 *      ≤ BUDGET_INITIAL_GZIP_KB (по умолчанию 155 kB). Калибровка: main на
 *      момент ввода проверки — 139.8 kB gzip (136 kB из docs/perf-baseline.md
 *      устарели из-за минорных обновлений зависимостей); после заявок на главы
 *      — 143.6 kB локально и 146.04 kB на Vercel (дрейф Vite/Rollup между
 *      Node-версиями). Запас гасит этот дрейф, но ловит настоящий регресс
 *      (до оптимизаций было 185).
 *   2. Локальные /media/*, на которые ссылается пререндеренный index.html
 *      («первый экран каталога»), raw — ≤ BUDGET_CATALOG_MEDIA_KB (300 kB).
 *   3. Каталог обложек dist/media/covers/ (обложки тайтлов — файлы
 *      репозитория), raw — ≤ BUDGET_COVERS_KB (по умолчанию 500 kB:
 *      ~3–5 обложек по ~100 kB + запас на рост; сиды занимают ~23 kB).
 *      Лимит держит git и первый экран лёгкими: новая обложка — осознанный
 *      коммит файла в public/media/covers/.
 *
 * Exit 1 при пробитии бюджета — сборка падает до деплоя.
 *
 * TODO(что делать при пробитии 155 kB): бюджет дальше НЕ поднимать. Сначала
 * `npm run analyze` (rollup-plugin-visualizer) — найти, что именно легло в
 * initial, и вынести это в lazy-чанк (паттерн: динамический import по
 * состоянию, как у модалок заявок — React.lazy в пререндере ломается).
 * Кандидаты: перекройка чанков chapters/pages, из-за которой заявки на главы
 * дали прирост без нового кода в initial. Факт пробития и что вынесли —
 * фиксировать в docs/perf-baseline.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DIST = path.resolve(process.cwd(), 'dist');
const INDEX = path.join(DIST, 'index.html');
// 155 kB: запас под неизбежный дрейф Vite/Rollup между Node-версиями
// (~2.4 kB между локальным Node 22.x и Vercel) + рост от заявок на главы.
// База 2093830 — 142.48 kB; после заявок — 146.04 kB на Vercel.
// Если пробьёт 155 — не поднимать дальше, а выносить чанк (см. TODO выше).
const BUDGET_INITIAL_GZIP_KB = Number(process.env.BUDGET_INITIAL_GZIP_KB || 155);
const BUDGET_CATALOG_MEDIA_KB = Number(process.env.BUDGET_CATALOG_MEDIA_KB || 300);
/** Суммарный вес обложек тайтлов (public/media/covers/ → dist/media/covers/). */
const BUDGET_COVERS_KB = Number(process.env.BUDGET_COVERS_KB || 500);

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

// ── 3. Каталог обложек (репозиторий → dist/media/covers/) ───────────────────
const coversDir = path.join(DIST, 'media/covers');
const coverFiles = fs.existsSync(coversDir)
  ? fs.readdirSync(coversDir).filter((f) => f.endsWith('.webp'))
  : [];

console.log('=== Бюджет обложек тайтлов (dist/media/covers/, raw) ===');
let coversRaw = 0;
for (const f of coverFiles) {
  const size = fs.statSync(path.join(coversDir, f)).size;
  coversRaw += size;
  console.log(`  media/covers/${f.padEnd(44)} raw ${kb(size).padStart(8)} kB`);
}
if (coverFiles.length === 0) {
  console.log('  (dist/media/covers/ пуст или отсутствует — сгенерируйте scripts/generate-seed-covers.mjs)');
}
const coversOk = coversRaw <= BUDGET_COVERS_KB * 1024;
console.log(
  `ИТОГО: ${coverFiles.length} файл(ов), ${kb(coversRaw)} kB raw из ${BUDGET_COVERS_KB} kB — ` +
    `${coversOk ? 'OK' : 'ПРЕВЫШЕН'}\n`
);

const failures = [];
if (!initialOk) failures.push(`initial JS ${kb(initialGz)} kB gzip > ${BUDGET_INITIAL_GZIP_KB} kB`);
if (!mediaOk) failures.push(`медиа каталога ${kb(mediaRaw)} kB raw > ${BUDGET_CATALOG_MEDIA_KB} kB`);
if (!coversOk) failures.push(`обложки ${kb(coversRaw)} kB raw > ${BUDGET_COVERS_KB} kB`);

if (failures.length) {
  console.error('check-budgets: ПРЕВЫШЕН БЮДЖЕТ СБОРКИ:');
  failures.forEach((f) => console.error(`  - ${f}`));
  console.error('Оптимизируйте чанки/ассеты или осознанно поднимите бюджет через env.');
  process.exit(1);
}
console.log('check-budgets: OK');

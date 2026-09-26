/**
 * Проверка админ-ссылок: «кнопка ведёт на плейсхолдер вместо UUID».
 *
 *   node scripts/unit-admin-links.mjs
 *
 * Регресс, который ловим: <Link to="/admin/titles/$id/chapters/$cid"> без
 * `params` — роутер оставляет в адресе литералы `$id`/`$cid`, дальше лоадер
 * шлёт в PostgREST `?id=eq.%24id`, получает 400 и показывает «Тайтл не найден».
 *
 * Проверяем двумя способами, без браузера:
 *   1. статически — у каждого <Link to="..."> с сегментами `$param`
 *      в том же JSX-элементе есть `params={{ ... }}` со всеми параметрами;
 *   2. рантайм — assertEntityId из src/lib/routeParams.ts отсекает
 *      плейсхолдеры и пропускает настоящие UUID/демо-id.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures.push(name);
};

// ── 1. Статический разбор всех <Link to="..."> в src ───────────────────────
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk('src');
const linkRe = /<Link\b([\s\S]*?)>/g;
const badLinks = [];

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  let m;
  while ((m = linkRe.exec(src))) {
    const attrs = m[1];
    const to = attrs.match(/\bto=(?:"([^"]*)"|\{'([^']*)'\})/);
    const target = to?.[1] ?? to?.[2];
    if (!target) continue;
    const needed = [...target.matchAll(/\$([A-Za-z0-9_]+)/g)].map((x) => x[1]);
    if (needed.length === 0) continue;
    const paramsBlock = attrs.match(/\bparams=\{\{([\s\S]*?)\}\}/);
    // Ключ может быть обычным (`id: title.id`) или сокращённым (`{ slug, number }`).
    const missing = paramsBlock
      ? needed.filter(
          (p) =>
            !new RegExp(`(^|[\\s,{])${p}\\s*:`).test(paramsBlock[1]) &&
            !new RegExp(`(^|[\\s,{])${p}\\s*(,|$|\\})`).test(paramsBlock[1])
        )
      : needed;
    if (missing.length) {
      const line = src.slice(0, m.index).split('\n').length;
      badLinks.push(`${file}:${line} → ${target} (нет params: ${missing.join(', ')})`);
    }
  }
}

check(
  'Все <Link> с $-параметрами передают params',
  badLinks.length === 0,
  badLinks.join(' | ')
);

// Кнопка «Страницы и загрузка» — конкретный регресс из отчёта.
const chaptersFile = 'src/routes/admin.titles.$id.chapters.index.tsx';
const chaptersSrc = readFileSync(chaptersFile, 'utf8');
const pagesButtonIdx = chaptersSrc.indexOf('Страницы и загрузка');
const linkBefore = chaptersSrc.lastIndexOf('<Link', pagesButtonIdx);
const pagesLink = chaptersSrc.slice(linkBefore, pagesButtonIdx);
check(
  'Кнопка «Страницы и загрузка» ведёт на $id/$cid с params',
  pagesButtonIdx > 0 &&
    pagesLink.includes('/admin/titles/$id/chapters/$cid') &&
    /params=\{\{[^}]*id:\s*title\.id[^}]*cid:\s*ch\.id/.test(pagesLink),
  pagesLink.replace(/\s+/g, ' ').trim().slice(0, 140)
);

// Старый адрес /pages должен существовать как редирект, а не 404.
const routeFiles = readdirSync('src/routes');
check(
  'Есть совместимый роут .../chapters/$cid/pages (редирект)',
  routeFiles.includes('admin.titles.$id.chapters.$cid_.pages.tsx')
);

// ── Кнопка «Импорт глав» (массовый импорт из CSV) ──────────────────────────
check(
  'Есть роут .../chapters/import',
  routeFiles.includes('admin.titles.$id.chapters.import.tsx')
);

const importButtonIdx = chaptersSrc.indexOf('Импорт глав');
const importLinkBefore = chaptersSrc.lastIndexOf('<Link', importButtonIdx);
const importLink = chaptersSrc.slice(importLinkBefore, importButtonIdx);
check(
  'Кнопка «Импорт глав» ведёт на $id/chapters/import с params',
  importButtonIdx > 0 &&
    importLink.includes('/admin/titles/$id/chapters/import') &&
    /params=\{\{[^}]*id:\s*title\.id/.test(importLink),
  importLink.replace(/\s+/g, ' ').trim().slice(0, 140)
);

const importRouteSrc = readFileSync('src/routes/admin.titles.$id.chapters.import.tsx', 'utf8');
check(
  'Лоадер импорта глав проверяет params через assertEntityId',
  importRouteSrc.includes('assertEntityId(params.id')
);
check(
  'Импорт глав создаёт главы черновиками (published: false)',
  /published:\s*false/.test(importRouteSrc)
);
check(
  'Конфликт номера главы — пропуск с отчётом, а не падение',
  importRouteSrc.includes('DuplicateChapterError') && /пропущена/.test(importRouteSrc)
);
const publishBannerSrc = readFileSync('src/components/admin/PublishTitleBanner.tsx', 'utf8');
check(
  'Черновик тайтла публикуется отдельной кнопкой, не только свитчем в таблице',
  chaptersSrc.includes('PublishTitleBanner') &&
    readFileSync('src/routes/admin.titles.$id.chapters.$cid.tsx', 'utf8').includes('PublishTitleBanner') &&
    publishBannerSrc.includes('Опубликовать тайтл') &&
    publishBannerSrc.includes('setPublished')
);

// ── 2. Рантайм-проверка валидатора параметров ──────────────────────────────
const { isValidEntityId, assertEntityId } = await import('../src/lib/routeParams.ts').catch(
  async () => {
    // routeParams.ts — чистый TS без JSX, но с типами: грузим через vite.
    const { createServer } = await import('vite');
    const { forceDemoMode, DEMO_SERVER_OPTIONS } = await import('./lib/demo-mode.mjs');
    forceDemoMode();
    const vite = await createServer({ ...DEMO_SERVER_OPTIONS, mode: 'test' });
    const mod = await vite.ssrLoadModule('/src/lib/routeParams.ts');
    await vite.close();
    return mod;
  }
);

const placeholders = ['$id', '$cid', ':id', '<title-id>', '<chapter-id>', '%3Ctitle-id%3E', '', '   '];
check(
  'assertEntityId отвергает плейсхолдеры',
  placeholders.every((v) => {
    try {
      assertEntityId(v, 'тайтл');
      return false;
    } catch {
      return true;
    }
  }),
  placeholders.join(' ')
);

const valid = ['3f6d4f2e-7f5f-4f2a-9a5f-9c1a2b3c4d5e', 't-1', 'c-2', 'p-1-1'];
check(
  'assertEntityId пропускает UUID и демо-id',
  valid.every((v) => isValidEntityId(v) && assertEntityId(v, 'тайтл') === v),
  valid.join(' ')
);

// ── 3. Админ-лоадеры валидируют params до запроса в базу ───────────────────
for (const f of [
  'src/routes/admin.titles.$id.chapters.$cid.tsx',
  'src/routes/admin.titles.$id.chapters.index.tsx',
  'src/routes/admin.titles.$id.index.tsx',
]) {
  const src = readFileSync(f, 'utf8');
  check(
    `Лоадер ${path.basename(f)} проверяет params через assertEntityId`,
    src.includes('assertEntityId(params.'),
    ''
  );
  check(
    `Лоадер ${path.basename(f)} не ходит в базу с сырым params`,
    !/(getById|listByTitle|listByChapter)\(\s*params\./.test(src)
  );
}

console.log('');
if (failures.length) {
  console.error(`unit-admin-links: провалено ${failures.length}: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('unit-admin-links: все проверки пройдены');

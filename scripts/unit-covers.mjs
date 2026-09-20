/**
 * Unit-тесты обложек: src/lib/storageUrl.ts + components/manga/CoverImage.tsx
 * + seo.ts (og:image) + сквозное поведение cover_url в data-слое (demo).
 *
 *   node scripts/unit-covers.mjs
 *
 * Обложки тайтлов — файлы репозитория (public/media/covers/*.webp),
 * в titles.cover_url — относительный путь. Supabase Storage остаётся только
 * для страниц глав и озвучек — их URL-логика (dead-refs, http→https) здесь
 * тоже проверяется, чтобы не регрессировала.
 *
 * Без браузера: CoverImage проверяется SSR-рендером (react-dom/server),
 * data-слой — через Vite ssrLoadModule, как в smoke/unit-auth-notify.
 */
import { createServer } from 'vite';
import { forceDemoMode, DEMO_SERVER_OPTIONS } from './lib/demo-mode.mjs';

const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures.push(name);
};

const React = (await import('react')).default;
const { renderToString } = await import('react-dom/server');

const TEST_REF = 'https://test-ref.supabase.co';
const TEST_SITE = 'https://covers.example';
process.env.VITE_SUPABASE_URL = TEST_REF;
process.env.VITE_SUPABASE_ANON_KEY = 'test-anon-key';
process.env.VITE_SITE_URL = TEST_SITE;

const server = await createServer({
  ...DEMO_SERVER_OPTIONS,
  mode: 'test',
});

try {
  const storageUrl = await server.ssrLoadModule('/src/lib/storageUrl.ts');

  // ── normalizeMediaUrl: относительные пути обложек — не трогаем ────────
  check(
    'normalize: /media/covers/x.webp → как есть',
    storageUrl.normalizeMediaUrl('/media/covers/x.webp') === '/media/covers/x.webp'
  );
  check(
    'normalize: относительный путь с пробелами — только trim, без dead-refs/https',
    storageUrl.normalizeMediaUrl('  /media/covers/тайтл.webp  ') === '/media/covers/тайтл.webp'
  );
  check(
    'normalize: произвольный https-домен возвращается как есть (не превращается в Supabase)',
    storageUrl.normalizeMediaUrl('https://example.com/x.webp') === 'https://example.com/x.webp'
  );
  check('normalize: пустая строка/пробелы → null', storageUrl.normalizeMediaUrl('   ') === null && storageUrl.normalizeMediaUrl('') === null);
  check('normalize: null/undefined → null', storageUrl.normalizeMediaUrl(null) === null && storageUrl.normalizeMediaUrl(undefined) === null);

  // ── normalizeMediaUrl: страницы/озвучки в Supabase Storage (не регресс) ─
  check(
    'normalize: http→https (pages/voiceovers из Storage)',
    storageUrl.normalizeMediaUrl('  HTTP://cdn.example.com/x.jpg  ') === 'https://cdn.example.com/x.jpg'
  );
  check(
    'normalize: мёртвый ref → текущий проект (pages/voiceovers)',
    storageUrl.normalizeMediaUrl('https://vokzyxwkhappwnggjxf.supabase.co/storage/v1/object/public/manga/c.webp') ===
      `${TEST_REF}/storage/v1/object/public/manga/c.webp`
  );
  check('normalize: data:URL проходит без изменений', storageUrl.normalizeMediaUrl('data:image/svg+xml;utf8,<svg/>') === 'data:image/svg+xml;utf8,<svg/>');
  check('normalize: голый путь бакета не ломается', storageUrl.normalizeMediaUrl('ch1/1-123-original.jpg') === 'ch1/1-123-original.jpg');

  // ── supabaseStoragePublicUrl / storagePathFromUrl (pages/voiceovers) ──
  const built = storageUrl.supabaseStoragePublicUrl('manga', 'ch1/1-2.webp');
  check('publicUrl собирается из пути бакета', built === `${TEST_REF}/storage/v1/object/public/manga/ch1/1-2.webp`, built);
  check(
    'storagePathFromUrl: URL → путь (query срезается)',
    storageUrl.storagePathFromUrl(`${TEST_REF}/storage/v1/object/public/manga/ch1/1-2.webp?token=1`, 'manga') === 'ch1/1-2.webp'
  );
  check('storagePathFromUrl: data: → null', storageUrl.storagePathFromUrl('data:image/png;base64,xx', 'manga') === null);
  check('storagePathFromUrl: чужой бакет → null', storageUrl.storagePathFromUrl(`${TEST_REF}/storage/v1/object/public/voiceovers/a.wav`, 'manga') === null);

  // ── isMediaUrlCspAllowed (vercel.json img-src) ────────────────────────
  check(
    'csp: относительный путь обложки разрешён (self)',
    storageUrl.isMediaUrlCspAllowed('/media/covers/x.webp') === true
  );
  check('csp: data:/blob: разрешены', storageUrl.isMediaUrlCspAllowed('data:image/png') && storageUrl.isMediaUrlCspAllowed('blob:https://x/y', { isBlob: true }));
  check('csp: Supabase Storage разрешён (pages/voiceovers)', storageUrl.isMediaUrlCspAllowed(`${TEST_REF}/storage/v1/object/public/manga/c.webp`));
  check('csp: внешний CDN запрещён (защита от опечаток в пути)', storageUrl.isMediaUrlCspAllowed('https://cdn.example.com/cover.jpg') === false);

  // ── CoverImage (SSR) ──────────────────────────────────────────────────
  const { CoverImage } = await server.ssrLoadModule('/src/components/manga/CoverImage.tsx');
  const render = (props) => renderToString(React.createElement(CoverImage, props));

  const emptyHtml = render({ src: null, title: 'Название тайтла' });
  check('cover: без src → статический плейсхолдер', emptyHtml.includes('media/placeholder-cover.svg'));
  check('cover: без src помечается data-cover-error', emptyHtml.includes('data-cover-error'));
  check('cover: alt по умолчанию «Обложка: …»', emptyHtml.includes('alt="Обложка: Название тайтла"'));
  check('cover: lazy + decoding=async по умолчанию', emptyHtml.includes('loading="lazy"') && emptyHtml.includes('decoding="async"'));

  // Относительный путь — штатный случай: рендерится как есть, без пометки ошибки.
  const localHtml = render({ src: '/media/covers/test.webp', title: 'Тайтл' });
  check(
    'cover: относительный src → <img src="/media/covers/test.webp"> без data-cover-error',
    localHtml.includes('src="/media/covers/test.webp"') && !localHtml.includes('data-cover-error')
  );
  // Никаких следов srcset/трансформаций не осталось.
  check('cover: srcset нигде не генерируется', !localHtml.toLowerCase().includes('srcset='));

  const prioHtml = render({ src: '/media/covers/test.webp', title: 'Тайтл', priority: true });
  // React 19 SSR отдаёт атрибуты в camelCase (fetchPriority) — браузеры парсят
  // HTML-атрибуты case-insensitively, поэтому сравниваем без учёта регистра.
  const prioLower = prioHtml.toLowerCase();
  check('cover: priority → eager + fetchpriority=high', prioLower.includes('loading="eager"') && prioLower.includes('fetchpriority="high"'));

  const altHtml = render({ src: '/media/covers/test.webp', title: 'Тайтл', alt: 'Кастомный alt' });
  check('cover: явный alt уважается', altHtml.includes('alt="Кастомный alt"'));

  // ── SEO: og:image из относительного пути → абсолютный в head ──────────
  const seo = await server.ssrLoadModule('/src/lib/seo.ts');
  const head = seo.renderHeadTags(
    { title: 'Тайтл', description: 'Описание', image: '/media/covers/test.webp' },
    '/title/test'
  );
  check(
    'seo: og:image абсолютный (SITE_URL + путь обложки)',
    head.includes(`<meta property="og:image" content="${TEST_SITE}/media/covers/test.webp" />`),
    head.match(/og:image[^>]+/)?.[0] || '(нет og:image)'
  );
  check('seo: twitter:image тоже абсолютный', head.includes(`<meta name="twitter:image" content="${TEST_SITE}/media/covers/test.webp" />`));

  const headNoCover = seo.renderHeadTags({ title: 'Тайтл', description: 'Описание', image: null }, '/title/test');
  check(
    'seo: без обложки → плейсхолдер с абсолютным SITE_URL',
    headNoCover.includes(`<meta property="og:image" content="${TEST_SITE}/media/placeholder-cover.svg" />`)
  );
} finally {
  await server.close();
}

// ── Демо-режим: сквозное поведение cover_url в data-слое ────────────────────
forceDemoMode();
const serverC = await createServer({ ...DEMO_SERVER_OPTIONS, mode: 'test' });
try {
  const { titles } = await serverC.ssrLoadModule('/src/data/titles.ts');
  const created = await titles.create({
    slug: 'cover-local-e2e',
    title: 'E2E: локальная обложка',
    cover_url: '  /media/covers/test.webp  ',
    published: true,
  });
  check(
    'e2e: create сохраняет относительный путь как есть (только trim)',
    created.cover_url === '/media/covers/test.webp',
    created.cover_url || '(null)'
  );
  const listed = (await titles.listAll()).find((t) => t.slug === 'cover-local-e2e');
  check('e2e: чтение из списка не искажает путь', listed?.cover_url === '/media/covers/test.webp', listed?.cover_url || '(null)');

  // Сиды ссылаются на файлы /media/covers/, а не на data-URL.
  const seeds = await titles.listAll();
  check(
    'seeds: сид-обложки — пути /media/covers/{slug}.webp',
    seeds.filter((t) => ['podnyatie-urovnya-v-odinochku', 'magicheskaya-bitva', 'klinok-rassekayushchiy-demonov'].includes(t.slug))
      .every((t) => t.cover_url === `/media/covers/${t.slug}.webp`)
  );

  const cleared = await titles.update(created.id, { cover_url: '   ' });
  check('e2e: пустая строка в update → null (не мусор в БД)', cleared.cover_url === null);
  await titles.delete(created.id);
  check('e2e: тестовый тайтл удалён, сиды целы', (await titles.listAll()).length === 3);
} finally {
  await serverC.close();
}

console.log(failures.length === 0 ? '\nALL COVER CHECKS PASS' : `\n${failures.length} FAILURES`);
process.exit(failures.length ? 1 : 0);

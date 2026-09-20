/**
 * Unit-тесты обложек: src/lib/storageUrl.ts + components/manga/CoverImage.tsx
 * + сквозная нормализация cover_url в data-слое (demo-режим).
 *
 *   node scripts/unit-covers.mjs
 *
 * Без браузера: CoverImage проверяется SSR-рендером (react-dom/server),
 * data-слой — через Vite ssrLoadModule, как в smoke/unit-auth-notify.
 *
 * Три сервера Vite с разным окружением:
 *   A — SUPABASE_URL=test-ref + VITE_COVER_TRANSFORMS=1 (сборка URL, srcset, SSR);
 *   B — трансформации выключены (srcset-гейт);
 *   C — демо-режим (сквозная нормализация cover_url в mockStore).
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
process.env.VITE_SUPABASE_URL = TEST_REF;
process.env.VITE_SUPABASE_ANON_KEY = 'test-anon-key';
process.env.VITE_COVER_TRANSFORMS = '1';

const serverA = await createServer({
  ...DEMO_SERVER_OPTIONS,
  mode: 'test',
});

try {
  const storageUrl = await serverA.ssrLoadModule('/src/lib/storageUrl.ts');

  // ── normalizeMediaUrl ─────────────────────────────────────────────────
  check('normalize: пустая строка/пробелы → null', storageUrl.normalizeMediaUrl('   ') === null && storageUrl.normalizeMediaUrl('') === null);
  check('normalize: null/undefined → null', storageUrl.normalizeMediaUrl(null) === null && storageUrl.normalizeMediaUrl(undefined) === null);
  check(
    'normalize: trim + http→https',
    storageUrl.normalizeMediaUrl('  HTTP://cdn.example.com/x.jpg  ') === 'https://cdn.example.com/x.jpg'
  );
  check(
    'normalize: мёртвый ref → текущий проект',
    storageUrl.normalizeMediaUrl('https://vokzyxwkhappwnggjxf.supabase.co/storage/v1/object/public/manga/c.webp') ===
      `${TEST_REF}/storage/v1/object/public/manga/c.webp`
  );
  check('normalize: data:URL проходит без изменений', storageUrl.normalizeMediaUrl('data:image/svg+xml;utf8,<svg/>') === 'data:image/svg+xml;utf8,<svg/>');
  check('normalize: локальный /media проходит как есть', storageUrl.normalizeMediaUrl('/media/placeholder-cover.svg') === '/media/placeholder-cover.svg');
  check('normalize: голый путь бакета не ломается', storageUrl.normalizeMediaUrl('ch1/1-123-original.jpg') === 'ch1/1-123-original.jpg');

  // ── supabaseStoragePublicUrl / storagePathFromUrl ─────────────────────
  const built = storageUrl.supabaseStoragePublicUrl('manga', 'covers/x.webp');
  check('publicUrl собирается из пути бакета', built === `${TEST_REF}/storage/v1/object/public/manga/covers/x.webp`, built);
  check(
    'storagePathFromUrl: URL → путь (query срезается)',
    storageUrl.storagePathFromUrl(`${TEST_REF}/storage/v1/object/public/manga/covers/x.webp?token=1`, 'manga') === 'covers/x.webp'
  );
  check('storagePathFromUrl: голый путь проходит', storageUrl.storagePathFromUrl('covers/x.webp', 'manga') === 'covers/x.webp');
  check('storagePathFromUrl: data: → null', storageUrl.storagePathFromUrl('data:image/png;base64,xx', 'manga') === null);
  check('storagePathFromUrl: чужой бакет → null', storageUrl.storagePathFromUrl(`${TEST_REF}/storage/v1/object/public/voiceovers/a.wav`, 'manga') === null);

  // ── isMediaUrlCspAllowed (vercel.json img-src) ────────────────────────
  check('csp: data:/blob:/относительный — разрешены', storageUrl.isMediaUrlCspAllowed('data:image/png') && storageUrl.isMediaUrlCspAllowed('/media/x.jpg') && storageUrl.isMediaUrlCspAllowed('blob:https://x/y', { isBlob: true }));
  check('csp: Supabase Storage разрешён (http сам апгрейдится)', storageUrl.isMediaUrlCspAllowed(`${TEST_REF}/storage/v1/object/public/manga/c.webp`));
  check('csp: внешний CDN запрещён', storageUrl.isMediaUrlCspAllowed('https://cdn.example.com/cover.jpg') === false);

  // ── coverSrcSet (гейт VITE_COVER_TRANSFORMS=1 — включён в этом сервере) ─
  const srcset = storageUrl.coverSrcSet(`${TEST_REF}/storage/v1/object/public/manga/covers/x.webp`);
  check(
    'srcset: строит 400w/800w через render-эндпоинт',
    typeof srcset === 'string' && srcset.includes('/storage/v1/image/public/') && srcset.includes('400w') && srcset.includes('800w'),
    srcset || '(undefined)'
  );
  check('srcset: не-supabase URL → undefined', storageUrl.coverSrcSet('/media/placeholder-cover.svg') === undefined);
  check('srcset: пустой src → undefined', storageUrl.coverSrcSet(null) === undefined);

  // ── CoverImage (SSR) ──────────────────────────────────────────────────
  const { CoverImage } = await serverA.ssrLoadModule('/src/components/manga/CoverImage.tsx');
  const render = (props) => renderToString(React.createElement(CoverImage, props));

  const emptyHtml = render({ src: null, title: 'Название тайтла' });
  check('cover: без src → статический плейсхолдер', emptyHtml.includes('media/placeholder-cover.svg'), '');
  check('cover: без src помечается data-cover-error', emptyHtml.includes('data-cover-error'));
  check('cover: alt по умолчанию «Обложка: …»', emptyHtml.includes('alt="Обложка: Название тайтла"'));
  check('cover: lazy + decoding=async по умолчанию', emptyHtml.includes('loading="lazy"') && emptyHtml.includes('decoding="async"'));

  const coverUrl = `${TEST_REF}/storage/v1/object/public/manga/covers/c.webp`;
  const realHtml = render({ src: coverUrl, title: 'Тайтл' });
  check('cover: реальный src рендерится без пометки ошибки', realHtml.includes(coverUrl) && !realHtml.includes('data-cover-error'));

  const prioHtml = render({ src: coverUrl, title: 'Тайтл', priority: true });
  // React 19 SSR отдаёт атрибуты в camelCase (fetchPriority) — браузеры парсят
  // HTML-атрибуты case-insensitively, поэтому сравниваем без учёта регистра.
  const prioLower = prioHtml.toLowerCase();
  check('cover: priority → eager + fetchpriority=high', prioLower.includes('loading="eager"') && prioLower.includes('fetchpriority="high"'));

  const altHtml = render({ src: coverUrl, title: 'Тайтл', alt: 'Кастомный alt' });
  check('cover: явный alt уважается', altHtml.includes('alt="Кастомный alt"'));

  // srcset в SSR: transform-эндпоинт включён → srcset присутствует у supabase-URL
  check('cover: srcset попадает в разметку', realHtml.toLowerCase().includes('srcset=') && realHtml.includes('400w'));
} finally {
  await serverA.close();
}

// ── Сервер B: трансформации выключены (по умолчанию) ────────────────────────
delete process.env.VITE_COVER_TRANSFORMS;
const serverB = await createServer({ ...DEMO_SERVER_OPTIONS, mode: 'test' });
try {
  const { coverSrcSet } = await serverB.ssrLoadModule('/src/lib/storageUrl.ts');
  check(
    'srcset: без VITE_COVER_TRANSFORMS выключен (нет двойных запросов на проектах без трансформаций)',
    coverSrcSet('https://any-ref.supabase.co/storage/v1/object/public/manga/c.webp') === undefined
  );
} finally {
  await serverB.close();
}

// ── Сервер C: демо-режим, сквозная нормализация в data-слое ─────────────────
forceDemoMode();
const serverC = await createServer({ ...DEMO_SERVER_OPTIONS, mode: 'test' });
try {
  const { titles } = await serverC.ssrLoadModule('/src/data/titles.ts');
  const created = await titles.create({
    slug: 'cover-normalize-e2e',
    title: 'E2E: нормализация обложки',
    cover_url: '  HTTP://Example.supabase.co/storage/v1/object/public/manga/e2e.webp  ',
    published: true,
  });
  check(
    'e2e: create нормализует cover_url до записи (trim + http→https)',
    created.cover_url === 'https://Example.supabase.co/storage/v1/object/public/manga/e2e.webp',
    created.cover_url || '(null)'
  );
  const listed = (await titles.listAll()).find((t) => t.slug === 'cover-normalize-e2e');
  check('e2e: тайтл с обложкой виден в списке', Boolean(listed && listed.cover_url));
  const cleared = await titles.update(created.id, { cover_url: '   ' });
  check('e2e: пустая строка в update → null (не мусор в БД)', cleared.cover_url === null);
  await titles.delete(created.id);
  check('e2e: тестовый тайтл удалён, сиды целы', (await titles.listAll()).length === 3);
} finally {
  await serverC.close();
}

console.log(failures.length === 0 ? '\nALL COVER CHECKS PASS' : `\n${failures.length} FAILURES`);
process.exit(failures.length ? 1 : 0);

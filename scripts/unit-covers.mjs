/**
 * Unit-тесты обложек: src/lib/storageUrl.ts + src/lib/coverUpload.ts
 * + src/data/storage.ts (uploadCover/deleteCover) + components/manga/CoverImage.tsx
 * + components/admin/TitleForm.tsx + seo.ts (og:image) + сквозное поведение
 * cover_url в data-слое (demo).
 *
 *   node scripts/unit-covers.mjs
 *
 * Обложка тайтла бывает двух видов, и проверяются оба:
 *   A) файл репозитория (public/media/covers/*.webp, относительный путь в
 *      titles.cover_url) — сиды и «вечные» картинки;
 *   B) загрузка из админки (TitleForm → storage.uploadCover → публичный бакет
 *      `covers`), в демо-режиме — data-URL.
 * Supabase Storage остаётся и для страниц глав/озвучек — их URL-логика
 * (dead-refs, http→https) здесь тоже проверяется, чтобы не регрессировала.
 *
 * Без браузера: CoverImage/TitleForm проверяются SSR-рендером
 * (react-dom/server), data-слой и storage — через Vite ssrLoadModule, как в
 * smoke/unit-auth-notify. Canvas в Node нет, поэтому prepareCoverImage здесь
 * идёт по ветке «WebP-энкодер недоступен → грузим исходник» (в браузере —
 * сжатие в WebP ≤800 px); предупреждение [covers] в выводе — ожидаемое.
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

  // ── isSupabaseStorageUrl: «загружено из админки» vs «файл репозитория» ──
  const coverObjUrl = `${TEST_REF}/storage/v1/object/public/covers/test-abc-123.webp`;
  check('storage-url: URL бакета covers распознаётся', storageUrl.isSupabaseStorageUrl(coverObjUrl) === true, coverObjUrl);
  check('storage-url: относительный путь репозитория — не Storage', storageUrl.isSupabaseStorageUrl('/media/covers/x.webp') === false);
  check('storage-url: data-URL — не Storage', storageUrl.isSupabaseStorageUrl('data:image/png;base64,xx') === false);
  check('storage-url: внешний домен — не Storage', storageUrl.isSupabaseStorageUrl('https://cdn.example.com/storage/v1/object/public/covers/x.webp') === false);
  check('storage-url: пусто/мусор — false', storageUrl.isSupabaseStorageUrl(null) === false && storageUrl.isSupabaseStorageUrl('   ') === false);
  check(
    'storage-url: загруженная обложка проходит CSP',
    storageUrl.isMediaUrlCspAllowed(coverObjUrl) === true
  );

  // ── coverUpload: валидация файла до загрузки ────────────────────────────
  const coverUpload = await server.ssrLoadModule('/src/lib/coverUpload.ts');
  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const webpBytes = new Uint8Array(Buffer.from('RIFF0000WEBP'));
  const jpgBytes = new Uint8Array([255, 216, 255, 1, 2, 3]);

  check('validate: PNG проходит', (await coverUpload.validateCoverFile(new File([pngBytes], 'cover.png'))).ok === true);
  check('validate: JPEG проходит', (await coverUpload.validateCoverFile(new File([jpgBytes], 'cover.jpg'))).ok === true);
  check('validate: WebP проходит', (await coverUpload.validateCoverFile(new File([webpBytes], 'cover.webp'))).ok === true);
  check(
    'validate: расширение не решает — PNG под именем .jpg проходит (сигнатура)',
    (await coverUpload.validateCoverFile(new File([pngBytes], 'cover.jpg'))).ok === true
  );
  {
    const pdf = new File([new Uint8Array(Buffer.from('%PDF-1.7'))], 'cover.pdf');
    const rejected = await coverUpload.validateCoverFile(pdf);
    check('validate: PDF отклоняется с внятной причиной', rejected.ok === false && /JPEG, PNG или WebP/.test(rejected.reason), rejected.reason);
  }
  {
    const empty = await coverUpload.validateCoverFile(new File([], 'empty.png'));
    check('validate: пустой файл отклоняется', empty.ok === false && /пуст/i.test(empty.reason), empty.reason);
  }
  {
    const huge = new File([pngBytes], 'huge.png');
    Object.defineProperty(huge, 'size', { value: coverUpload.COVER_MAX_BYTES + 1 });
    const rejected = await coverUpload.validateCoverFile(huge);
    check('validate: файл больше лимита отклоняется', rejected.ok === false && /больше/i.test(rejected.reason), rejected.reason);
  }
  check(
    'validate: без файла — тоже ошибка, а не exception',
    (await coverUpload.validateCoverFile(null)).ok === false
  );

  // ── coverUpload: имя объекта в бакете ───────────────────────────────────
  const p1 = coverUpload.coverObjectPath('magicheskaya-bitva');
  check('path: slug → читаемое имя .webp', /^magicheskaya-bitva-[a-z0-9]+-[a-f0-9]+\.webp$/.test(p1), p1);
  const p2 = coverUpload.coverObjectPath('Магическая Битва!!');
  check('path: кириллица/пробелы нормализуются в [a-z0-9-]', /^[a-z0-9-]+\.[a-z]+$/.test(p2) && !/[А-Яа-я\s!]/.test(p2), p2);
  const p3 = coverUpload.coverObjectPath('');
  check('path: пустой slug → cover-…', p3.startsWith('cover-'), p3);
  check('path: повторная загрузка не перетирает файл (имена уникальны)', coverUpload.coverObjectPath('x') !== coverUpload.coverObjectPath('x'));
  check('path: длинный slug обрезается', coverUpload.coverObjectPath('a'.repeat(200)).length < 90);

  // ── coverUpload: подготовка файла (в Node — ветка без WebP-энкодера) ────
  {
    const prepared = await coverUpload.prepareCoverImage(new File([pngBytes], 'cover.png'));
    check('prepare: без canvas грузится исходник (compressed=false)', prepared.compressed === false && prepared.blob.size === pngBytes.length, `${prepared.blob.type} ${prepared.blob.size}B`);
    check('prepare: MIME сохранён', prepared.blob.type === 'image/png', prepared.blob.type);
    const thrown = await coverUpload.prepareCoverImage(new File([new Uint8Array(Buffer.from('%PDF-1.7'))], 'c.pdf')).then(() => null, (e) => e.message);
    check('prepare: не-картинка → ошибка с текстом для формы', typeof thrown === 'string' && /JPEG, PNG или WebP/.test(thrown), String(thrown));
  }

  // ── TitleForm (SSR): загрузка файла рядом с полем пути ──────────────────
  const { TitleForm } = await server.ssrLoadModule('/src/components/admin/TitleForm.tsx');
  const formHtml = renderToString(React.createElement(TitleForm, { allGenres: [], onSubmit: async () => {} }));
  check('form: есть input[type=file] с accept JPEG/PNG/WebP', /<input[^>]*type="file"[^>]*accept="image\/jpeg,image\/png,image\/webp"/.test(formHtml), formHtml.match(/<input[^>]*type="file"[^>]*>/)?.[0] || '(нет)');
  check('form: кнопка «Загрузить файл» на месте', formHtml.includes('Загрузить файл'));
  check('form: поле пути к файлу репозитория осталось', formHtml.includes('/media/covers/slug.webp'));
  check('form: подсказка про бакет covers', formHtml.includes('covers'));
  check('form: без обложки — понятное пустое состояние, а не битая картинка', formHtml.includes('Обложка не задана'));
  const uploadedFormHtml = renderToString(
    React.createElement(TitleForm, {
      allGenres: [],
      onSubmit: async () => {},
      initialData: {
        id: 't-cover',
        slug: 'cover-title',
        title: 'Тайтл с загруженной обложкой',
        author: null,
        description: null,
        cover_url: coverObjUrl,
        status: 'ongoing',
        published: true,
        created_at: '2026-01-01T00:00:00.000Z',
        genres: [],
      },
    })
  );
  check('form: загруженная обложка показывается в превью', uploadedFormHtml.includes(`src="${coverObjUrl}"`), uploadedFormHtml.match(/<img[^>]*>/)?.[0] || '(нет img)');
  check('form: подписано, откуда обложка', uploadedFormHtml.includes('загружена в Storage'));
  check('form: для загруженной обложки есть кнопка «Убрать»', uploadedFormHtml.includes('Убрать'));

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
  const { storage } = await serverC.ssrLoadModule('/src/data/storage.ts');

  // ── storage.uploadCover в демо-режиме (Supabase не настроен) ────────────
  // Canvas в Node нет → грузится исходник, а вместо бакета covers получается
  // data-URL: тот же контракт, что у страниц глав в демо-режиме. В браузере с
  // настроенным Supabase здесь будет …/storage/v1/object/public/covers/….
  const demoPng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 8, 7, 6]);
  const uploaded = await storage.uploadCover(new File([demoPng], 'cover.png'), { key: 'Тест Тайтл' });
  check(
    'upload: без Supabase обложка возвращается data-URL (демо-флоу работает)',
    uploaded.url.startsWith('data:image/png;base64,'),
    uploaded.url.slice(0, 40)
  );
  check('upload: байты не потеряны (размер и содержимое)', uploaded.bytes === demoPng.length, `${uploaded.bytes}B`);
  {
    const decoded = Buffer.from(uploaded.url.split(',')[1], 'base64');
    check('upload: data-URL декодируется в исходные байты', decoded.length === demoPng.length && decoded[0] === 137 && decoded[7] === 10);
  }
  const rejectedUpload = await storage
    .uploadCover(new File([new Uint8Array(Buffer.from('%PDF-1.7'))], 'cover.pdf'))
    .then(() => null, (e) => e.message);
  check('upload: не-картинка не долетает до Storage', typeof rejectedUpload === 'string' && /JPEG, PNG или WebP/.test(rejectedUpload), String(rejectedUpload));

  // deleteCover в демо — no-op: ни сети, ни исключения (чистить нечего).
  await storage.deleteCover(uploaded.url);
  await storage.deleteCover('/media/covers/x.webp');
  await storage.deleteCover(null);
  check('delete: демо/no-op не роняет сохранение тайтла', true);

  // Сообщения об ошибках загрузки: для обложек — свои подсказки (миграция 18,
  // роль admin), для страниц глав — прежние (не регрессировали).
  const { uploadErrorMessage } = await serverC.ssrLoadModule('/src/data/storage.ts');
  const noBucket = uploadErrorMessage(new Error('Bucket not found'), 'cover.png', 'covers');
  check('err: нет бакета covers → подсказка накатить миграцию 18', /00000000000018_title_covers\.sql/.test(noBucket), noBucket);
  const noRights = uploadErrorMessage(new Error('new row violates row-level security policy'), 'cover.png', 'covers');
  check('err: RLS на covers → подсказка про роль admin', /admin/i.test(noRights) && /covers/.test(noRights), noRights);
  check(
    'err: страницы глав — прежнее сообщение (без bucket-контекста)',
    uploadErrorMessage(new Error('new row violates row-level security policy'), 'p.webp', 'manga') === 'Нет прав на загрузку в этот тайтл.'
  );
  check(
    'err: сетевой сбой обложки — общий текст с именем файла',
    uploadErrorMessage(new Error('fetch failed'), 'my-cover.png', 'covers').includes('my-cover.png')
  );

  // ── Загруженная обложка проходит через data-слой без искажений ──────────
  const storageCover = 'https://demo-ref.supabase.co/storage/v1/object/public/covers/test-abc-123.webp';
  const createdUploaded = await titles.create({
    slug: 'cover-uploaded-e2e',
    title: 'E2E: загруженная обложка',
    cover_url: `  ${storageCover}  `,
    published: true,
  });
  check('e2e: URL бакета covers сохраняется как есть (только trim)', createdUploaded.cover_url === storageCover, createdUploaded.cover_url || '(null)');
  const listedUploaded = (await titles.listAll()).find((t) => t.slug === 'cover-uploaded-e2e');
  check('e2e: чтение из списка не искажает URL Storage', listedUploaded?.cover_url === storageCover, listedUploaded?.cover_url || '(null)');
  await titles.delete(createdUploaded.id);

  // ── Локальная обложка (файл репозитория) — прежний способ не сломан ─────
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

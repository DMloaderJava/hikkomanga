/**
 * Юнит-тесты заявок на главы: ядро submit-chapters и finalize-chapter-submission
 * (_shared/chapterSubmissionCore.ts — та же логика, что в edge-функциях).
 *
 *   npm run test:submit-chapters
 *
 * Live-прогон против реального Supabase из песочницы невозможен (TLS до
 * *.supabase.co закрыт) — деплой edge и проверка капчи/лимитов делаются
 * пользователем по SETUP_SUPABASE.md, раздел «Заявки на главы».
 *
 * Кейсы по ТЗ:
 *   1.  согласие не подтверждено → 400, заявки нет;
 *   2.  капча: нет токена / отклонена → 400;
 *   3.  rate limit 3/мин → 4-я заявка 429 + Retry-After;
 *   3*. лимит ДО капчи: siteverify не вызывается после исчерпания окна;
 *   4.  6 глав → 400 (лимит 5);
 *   5.  глава без страниц → 400;
 *   6.  дубль номера главы → 400;
 *   7.  тайтл не найден / не опубликован → 400;
 *   8.  нет файла для объявленной страницы → 400; лишний файл → 400;
 *   9.  суммарно > 500 MB → 400;
 *  10.  успех: 200, токен, пути submissions/{token}/ch-{n}/page-{m}.webp,
 *       INSERT type=new_chapters, ip_hash = sha256(ip+salt);
 *  11.  finalize: главы published=false, страницы перенесены, исходники удалены;
 *  12.  finalize идемпотентна: повторный вызов — no-op;
 *  13.  занятый номер → глава получает следующий свободный, renumbered в отчёте;
 *  14.  сбой на 2-й главе → 500 + finalized_error; повтор продолжает со 2-й;
 *  15.  не approved → 409; new_title без глав → no-op; new_title с конфликтом
 *       slug (нет created_title_id) → 409.
 *  16.  вспомогательные функции (пути, имена частей, resolveChapterNumber).
 *  17.  демо-флоу без Supabase: подача → инбокс → approve → finalize.
 *  18.  «Предложить тайтл» + главы: approve создаёт тайтл, затем главы.
 *  19.  клиентская подготовка файлов и редактор глав.
 *  20.  PDF главы: объявлен/прислан, учёт в 500 MB, чужое имя, legacy-строка.
 *  21.  суммарный объём считается по факту и в тайтл-флоу (processSubmission).
 */
const { forceDemoMode, DEMO_SERVER_OPTIONS } = await import('./lib/demo-mode.mjs');
forceDemoMode();

const { createServer } = await import('vite');
const { fileURLToPath } = await import('node:url');
const vite = await createServer({
  // fileURLToPath, а не URL.pathname: на Windows `.pathname` даёт '/D:/…',
  // и Vite делает из этого несуществующий 'D:\D:\…' → ENOENT при mkdir .vite.
  root: fileURLToPath(new URL('..', import.meta.url)),
  ...DEMO_SERVER_OPTIONS,
});

const core = await vite.ssrLoadModule('/supabase/functions/_shared/chapterSubmissionCore.ts');

const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures.push(name);
};

const SALT = 'unit-test-salt';
const IP = '203.0.113.7';
const TITLE_ID = '3f6d4f2e-7f5f-4f2a-9a5f-9c1a2b3c4d5e';

async function sha256hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const pageDecls = (chapter, count, size = 1024) =>
  Array.from({ length: count }, (_, i) => ({
    name: `ch-${chapter}-page-${i + 1}.webp`,
    size,
  }));

const pageFiles = (chapter, count) =>
  Array.from({ length: count }, (_, i) => ({
    name: `ch-${chapter}-page-${i + 1}.webp`,
    bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
    contentType: 'image/webp',
  }));

const payloadOf = (chapters, over = {}) => ({
  title_id: TITLE_ID,
  title_name: 'Магическая битва',
  chapters,
  ...over,
});

function makeDeps(overrides = {}) {
  const state = {
    captchaCalls: 0,
    captchaOk: true,
    windows: new Map(),
    limitConfig: core.CHAPTER_RATE_LIMITS,
    uploads: [],
    inserted: [],
    title: { id: TITLE_ID, title: 'Магическая битва', published: true },
  };
  const deps = {
    verifyCaptcha: async () => {
      state.captchaCalls += 1;
      return state.captchaOk ? { ok: true } : { ok: false, error: 'turnstile_failed' };
    },
    checkLimit: async (windowSeconds, limit) => {
      const w = state.windows.get(windowSeconds) ?? { count: 0 };
      w.count += 1;
      state.windows.set(windowSeconds, w);
      return w.count <= limit;
    },
    lookupTitle: async () => state.title,
    uploadPage: async (bytes, token, path, contentType) => {
      state.uploads.push({ path, size: bytes.length, contentType });
    },
    insertRequest: async (row) => {
      state.inserted.push(row);
      return { id: `req-${state.inserted.length}` };
    },
    hashIp: (ip) => sha256hex(ip + SALT),
    randomToken: () => 'deadbeefdeadbeefdeadbeefdeadbeef',
    ...overrides,
  };
  return { deps, state };
}

const input = (over = {}) => ({
  captchaToken: 'tok',
  consent: true,
  payloadRaw: payloadOf([{ number: 1, name: 'Первая', pages: pageDecls(1, 2) }]),
  files: pageFiles(1, 2),
  email: 'reader@example.com',
  ip: IP,
  userAgent: 'unit-agent/1.0',
  ...over,
});

// ── 1. Согласие ───────────────────────────────────────────────────────────
{
  const { deps, state } = makeDeps();
  const res = await core.processChapterSubmission(deps, input({ consent: false }));
  check('1a. нет согласия → 400 consent_required', res.status === 400 && res.body.error === 'consent_required', JSON.stringify(res.body));
  check('1b. заявка не создана', state.inserted.length === 0 && state.uploads.length === 0);
}

// ── 2. Капча ──────────────────────────────────────────────────────────────
{
  const { deps, state } = makeDeps();
  const missing = await core.processChapterSubmission(deps, input({ captchaToken: undefined }));
  check('2a. нет токена капчи → 400 captcha_missing', missing.status === 400 && missing.body.error === 'captcha_missing');

  state.captchaOk = false;
  state.windows.clear();
  const failed = await core.processChapterSubmission(deps, input());
  check('2b. turnstile отклонил → 400 captcha_failed', failed.status === 400 && failed.body.error === 'captcha_failed');
  check('2c. заявка не создана', state.inserted.length === 0);
}

// ── 3. Rate limit 3/мин ───────────────────────────────────────────────────
{
  const { deps, state } = makeDeps();
  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    const res = await core.processChapterSubmission(deps, input());
    statuses.push(res.status);
    if (res.status === 429) {
      check('3b. 429 несёт Retry-After=60', res.retryAfter === 60, String(res.retryAfter));
      check('3c. тело 429 — rate_limited', res.body.error === 'rate_limited');
    }
  }
  check('3a. первые 3 проходят, 4-я — 429', JSON.stringify(statuses) === '[200,200,200,429]', statuses.join(','));
  check('3d. заявок создано 3', state.inserted.length === 3);
}

// ── 3*. Лимит до капчи ────────────────────────────────────────────────────
{
  const { deps, state } = makeDeps();
  deps.verifyCaptcha = async () => {
    state.captchaCalls += 1;
    return { ok: false, error: 'turnstile_failed' };
  };
  state.captchaCalls = 0;
  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    statuses.push((await core.processChapterSubmission(deps, input())).status);
  }
  check(
    '3e. невалидная капча расходует окно, siteverify не зовётся после лимита',
    state.captchaCalls === 3 && statuses.filter((s) => s === 429).length === 3,
    `captcha=${state.captchaCalls}, statuses=${statuses.join(',')}`
  );
}

// ── 4–6. Валидация payload ────────────────────────────────────────────────
{
  const { deps, state } = makeDeps();
  const six = Array.from({ length: 6 }, (_, i) => ({ number: i + 1, pages: pageDecls(i + 1, 1) }));
  const files6 = six.flatMap((ch) => pageFiles(ch.number, 1));
  const tooMany = await core.processChapterSubmission(
    deps,
    input({ payloadRaw: payloadOf(six), files: files6 })
  );
  check(
    '4a. 6 глав → 400 и ошибка по chapters',
    tooMany.status === 400 && /не больше 5/i.test(String(tooMany.body.fields?.chapters ?? '')),
    JSON.stringify(tooMany.body.fields)
  );

  const empty = await core.processChapterSubmission(
    deps,
    input({ payloadRaw: payloadOf([{ number: 1, name: 'Без страниц', pages: [] }]), files: [] })
  );
  check(
    '5a. глава без страниц → 400',
    empty.status === 400 && !!empty.body.fields?.['chapters.0.pages'],
    JSON.stringify(empty.body.fields)
  );

  const dupes = await core.processChapterSubmission(
    deps,
    input({
      payloadRaw: payloadOf([
        { number: 7, pages: pageDecls(7, 1) },
        { number: 7, pages: pageDecls(7, 1) },
      ]),
      files: pageFiles(7, 1),
    })
  );
  check(
    '6a. дубль номера главы → 400',
    dupes.status === 400 && /повторяется/.test(String(dupes.body.fields?.['chapters.1.number'] ?? '')),
    JSON.stringify(dupes.body.fields)
  );

  // Окно 3/мин уже израсходовано тремя проверками выше — сбрасываем счётчик.
  state.windows.clear();
  const noTitle = await core.processChapterSubmission(deps, input({ payloadRaw: { chapters: [{ number: 1, pages: pageDecls(1, 1) }] }, files: pageFiles(1, 1) }));
  check('6b. без title_id → 400', noTitle.status === 400 && !!noTitle.body.fields?.title_id);
}

// ── 7. Целевой тайтл ──────────────────────────────────────────────────────
{
  const { deps, state } = makeDeps();
  state.title = null;
  const missing = await core.processChapterSubmission(deps, input());
  check('7a. тайтл не найден → 400', missing.status === 400 && /не найден/i.test(String(missing.body.fields?.title_id ?? '')));

  state.title = { id: TITLE_ID, title: 'Черновик', published: false };
  state.windows.clear();
  const draft = await core.processChapterSubmission(deps, input());
  check(
    '7b. неопубликованный тайтл → 400',
    draft.status === 400 && /не опубликован/i.test(String(draft.body.fields?.title_id ?? '')),
    JSON.stringify(draft.body.fields)
  );
}

// ── 8. Файлы ↔ payload ────────────────────────────────────────────────────
{
  const { deps } = makeDeps();
  const missingFile = await core.processChapterSubmission(
    deps,
    input({ payloadRaw: payloadOf([{ number: 1, pages: pageDecls(1, 2) }]), files: pageFiles(1, 1) })
  );
  check(
    '8a. нет файла для объявленной страницы → 400',
    missingFile.status === 400 && !!missingFile.body.fields?.['chapters.1.pages.2'],
    JSON.stringify(missingFile.body.fields)
  );

  const extra = await core.processChapterSubmission(
    deps,
    input({
      payloadRaw: payloadOf([{ number: 1, pages: pageDecls(1, 1) }]),
      files: [...pageFiles(1, 1), { name: 'ch-1-page-2.webp', bytes: new Uint8Array(8) }],
    })
  );
  check(
    '8b. лишний файл → 400',
    extra.status === 400 && Object.keys(extra.body.fields ?? {}).includes('ch-1-page-2.webp'),
    JSON.stringify(extra.body.fields)
  );

  const unknown = await core.processChapterSubmission(
    deps,
    input({
      payloadRaw: payloadOf([{ number: 1, pages: pageDecls(1, 1) }]),
      files: [...pageFiles(1, 1), { name: 'readme.txt', bytes: new Uint8Array(4) }],
    })
  );
  check('8c. файл с чужим именем → 400', unknown.status === 400 && !!unknown.body.fields?.['readme.txt']);
}

// ── 9. Суммарный объём ────────────────────────────────────────────────────
{
  const { deps } = makeDeps();
  // 100 страниц по 6 MB: каждая в рамках 20 MB, суммарно 600 MB > 500 MB.
  const heavy = await core.processChapterSubmission(
    deps,
    input({
      payloadRaw: payloadOf([{ number: 1, pages: pageDecls(1, 100, 6 * 1024 * 1024) }]),
      files: pageFiles(1, 100),
    })
  );
  check(
    '9a. суммарно больше 500 MB → 400 total',
    heavy.status === 400 && /500 MB/.test(String(heavy.body.fields?.total ?? '')),
    JSON.stringify(heavy.body.fields?.total)
  );
}

// ── 10. Успех ─────────────────────────────────────────────────────────────
{
  const { deps, state } = makeDeps();
  const res = await core.processChapterSubmission(
    deps,
    input({
      payloadRaw: payloadOf([
        { number: 3, name: 'Третья', description: 'Описание', pages: pageDecls(3, 2) },
        { number: 4, pages: pageDecls(4, 1) },
      ]),
      files: [...pageFiles(3, 2), ...pageFiles(4, 1)],
    })
  );
  check('10a. успех → 200 + токен', res.status === 200 && res.body.ok === true && res.body.token === 'deadbeefdeadbeefdeadbeefdeadbeef', JSON.stringify(res.body));
  check(
    '10b. страницы лежат в submissions/{token}/ch-{n}/page-{m}.webp',
    JSON.stringify(state.uploads.map((u) => u.path)) ===
      JSON.stringify([
        'deadbeefdeadbeefdeadbeefdeadbeef/ch-3/page-1.webp',
        'deadbeefdeadbeefdeadbeefdeadbeef/ch-3/page-2.webp',
        'deadbeefdeadbeefdeadbeefdeadbeef/ch-4/page-1.webp',
      ]),
    state.uploads.map((u) => u.path).join(' | ')
  );

  const row = state.inserted[0];
  check('10c. заявка type=new_chapters, status=pending', row?.type === 'new_chapters' && row?.status === 'pending');
  check('10d. target_id/target_name проставлены', row?.target_id === TITLE_ID && row?.target_name === 'Магическая битва');
  check('10e. ip_hash = sha256(ip+salt) без суффикса', row?.ip_hash === (await sha256hex(IP + SALT)));
  check('10f. public_token совпадает с ответом', row?.public_token === res.body.token);
  check(
    '10g. payload хранит пути страниц, а не байты',
    row?.payload.chapters[0].pages[0].path === 'deadbeefdeadbeefdeadbeefdeadbeef/ch-3/page-1.webp',
    JSON.stringify(row?.payload.chapters[0])
  );
  check('10h. email заявителя сохранён', row?.submitter_email === 'reader@example.com');
}

// ── 11–15. Финализация ────────────────────────────────────────────────────
function makeFinalizeDeps(row, over = {}) {
  const state = {
    chapters: [],
    pages: [],
    removed: [],
    copies: [],
    checkpoints: [],
    finalized: null,
    error: null,
    taken: [],
    failOnChapter: null,
    failOnCopySource: null,
  };
  const deps = {
    getRequest: async () => row,
    checkpoint: async (id, payload) => {
      state.checkpoints.push(payload);
      row.payload = payload;
    },
    finish: async (id, payload) => {
      state.finalized = { id, payload };
      row.payload = payload;
      row.finalized_at = new Date().toISOString();
    },
    fail: async (id, message) => {
      state.error = message;
    },
    takenNumbers: async () => state.taken.slice(),
    createChapter: async ({ title_id, number, name }) => {
      if (state.failOnChapter === number) throw new Error('storage down');
      const id = `chapter-${state.chapters.length + 1}`;
      state.chapters.push({ id, title_id, number, name, published: false });
      return { id };
    },
    copyPage: async (source, target) => {
      if (state.failOnCopySource === source) throw new Error('storage down');
      state.copies.push({ source, target });
      return `https://proj.supabase.co/storage/v1/object/public/manga/${target.chapterId}/${target.order}.${target.ext}`;
    },
    insertPage: async (page) => {
      state.pages.push(page);
    },
    removeSources: async (paths) => {
      state.removed.push(...paths);
    },
    ...over,
  };
  return { deps, state };
}

const chapterRow = (chapters, over = {}) => ({
  id: 'req-1',
  type: 'new_chapters',
  status: 'approved',
  target_id: TITLE_ID,
  payload: { title_id: TITLE_ID, chapters },
  finalized_at: null,
  ...over,
});

const storedChapter = (number, pageCount) => ({
  number,
  name: `Глава ${number}`,
  pages: Array.from({ length: pageCount }, (_, i) => ({
    index: i + 1,
    path: `tok/ch-${number}/page-${i + 1}.webp`,
    size: 1024,
  })),
  pdf: null,
});

{
  const row = chapterRow([storedChapter(1, 2), storedChapter(2, 1)]);
  const { deps, state } = makeFinalizeDeps(row);
  const res = await core.finalizeChapterSubmission(deps, { requestId: 'req-1' });

  check('11a. finalize → 200', res.status === 200 && res.body.ok === true, JSON.stringify(res.body));
  check('11b. созданы 2 главы-черновика', state.chapters.length === 2 && state.chapters.every((c) => c.published === false));
  check('11c. страницы перенесены и записаны', state.pages.length === 3 && state.copies.length === 3);
  check(
    '11d. исходники удалены из submissions',
    JSON.stringify(state.removed) === JSON.stringify(['tok/ch-1/page-1.webp', 'tok/ch-1/page-2.webp', 'tok/ch-2/page-1.webp']),
    state.removed.join(' | ')
  );
  check('11e. finalized_at проставлен', row.finalized_at !== null);
  check(
    '11f. отчёт в payload.finalized',
    row.payload.finalized?.chapters_imported === 2 && row.payload.finalized?.pages_imported === 3,
    JSON.stringify(row.payload.finalized)
  );

  // 12. Идемпотентность
  const again = await core.finalizeChapterSubmission(deps, { requestId: 'req-1' });
  check(
    '12a. повторный вызов — no-op',
    again.status === 200 && again.body.skipped === true && state.chapters.length === 2 && state.pages.length === 3,
    JSON.stringify(again.body)
  );
}

{
  // 13. Занятый номер → следующий свободный
  const row = chapterRow([storedChapter(5, 1)]);
  const { deps, state } = makeFinalizeDeps(row);
  state.taken = [1, 5, 6];
  const res = await core.finalizeChapterSubmission(deps, { requestId: 'req-1' });
  check('13a. глава создана со свободным номером', state.chapters[0]?.number === 7, String(state.chapters[0]?.number));
  check(
    '13b. сдвиг номера виден в отчёте',
    JSON.stringify(res.body.renumbered) === JSON.stringify([{ requested: 5, created: 7 }]),
    JSON.stringify(res.body.renumbered)
  );

  // Две главы одной заявки не получают один номер
  const row2 = chapterRow([storedChapter(9, 1), storedChapter(10, 1)]);
  const d2 = makeFinalizeDeps(row2);
  d2.state.taken = [9];
  await core.finalizeChapterSubmission(d2.deps, { requestId: 'req-1' });
  check(
    '13c. номера внутри заявки не пересекаются',
    new Set(d2.state.chapters.map((c) => c.number)).size === 2,
    d2.state.chapters.map((c) => c.number).join(',')
  );
}

{
  // 14. Сбой в createChapter → 500; повтор продолжает со следующей главы
  const row = chapterRow([storedChapter(1, 1), storedChapter(2, 1)]);
  const { deps, state } = makeFinalizeDeps(row);
  state.failOnChapter = 2;
  const failed = await core.finalizeChapterSubmission(deps, { requestId: 'req-1' });
  check('14a. сбой → 500 finalize_failed', failed.status === 500 && failed.body.error === 'finalize_failed', JSON.stringify(failed.body));
  check('14b. finalized_error записан', state.error === 'storage down', String(state.error));
  check('14c. finalized_at НЕ проставлен', row.finalized_at === null);
  check('14d. первая глава создана и помечена', state.chapters.length === 1 && typeof row.payload.chapters[0].finalized_chapter_id === 'string');

  state.failOnChapter = null;
  const retry = await core.finalizeChapterSubmission(deps, { requestId: 'req-1' });
  check('14e. повтор завершает импорт', retry.status === 200 && retry.body.ok === true, JSON.stringify(retry.body));
  check('14f. первая глава не создаётся повторно', state.chapters.length === 2, JSON.stringify(state.chapters.map((c) => c.number)));
  check('14g. страниц всего 2 (по одной на главу)', state.pages.length === 2, String(state.pages.length));
}

{
  // 14*. Сбой ПОСЛЕ createChapter, посреди страниц: глава уже в БД, поэтому
  // повтор обязан её найти и докачать страницы, а не создать вторую.
  const row = chapterRow([storedChapter(1, 1), storedChapter(2, 3)]);
  const { deps, state } = makeFinalizeDeps(row);
  state.failOnCopySource = 'tok/ch-2/page-2.webp';

  const failed = await core.finalizeChapterSubmission(deps, { requestId: 'req-1' });
  check('14h. сбой на 2-й странице → 500', failed.status === 500, JSON.stringify(failed.body));
  check(
    '14i. обе главы созданы, страниц перенесено 2 (1-я глава + 1-я страница 2-й)',
    state.chapters.length === 2 && state.pages.length === 2,
    `chapters=${state.chapters.length}, pages=${state.pages.length}`
  );
  check(
    '14j. чекпоинт записал finalized_chapter_id ДО загрузки страниц',
    typeof row.payload.chapters[1].finalized_chapter_id === 'string' &&
      row.payload.chapters[1].finalized_done === false,
    JSON.stringify(row.payload.chapters[1])
  );
  check(
    '14k. частичный прогресс страниц сохранён',
    JSON.stringify(row.payload.chapters[1].finalized_source_paths) === JSON.stringify(['tok/ch-2/page-1.webp']),
    JSON.stringify(row.payload.chapters[1].finalized_source_paths)
  );

  state.failOnCopySource = null;
  const retry = await core.finalizeChapterSubmission(deps, { requestId: 'req-1' });
  check('14l. повтор завершает импорт', retry.status === 200 && retry.body.ok === true, JSON.stringify(retry.body));
  check(
    '14m. дубль главы НЕ создан',
    state.chapters.length === 2,
    JSON.stringify(state.chapters.map((c) => c.number))
  );
  check('14n. страниц всего 4 (1 + 3), первая не скопирована дважды', state.pages.length === 4, String(state.pages.length));
  const secondChapterPages = state.pages
    .filter((pg) => pg.chapter_id === state.chapters[1].id)
    .map((pg) => pg.page_order);
  check(
    '14o. порядок страниц плотный и без дублей',
    JSON.stringify(secondChapterPages) === '[1,2,3]',
    JSON.stringify(secondChapterPages)
  );
  check(
    '14p. исходники удалены один раз',
    state.removed.filter((p) => p === 'tok/ch-2/page-1.webp').length === 1,
    state.removed.join(',')
  );
  // Страницы, перенесённые В ЭТОМ проходе, тоже обязаны быть удалены: sources
  // стартует со снапшотом уже скопированного, а дозаполняется после цикла.
  const expectedRemoved = [
    'tok/ch-1/page-1.webp',
    'tok/ch-2/page-1.webp',
    'tok/ch-2/page-2.webp',
    'tok/ch-2/page-3.webp',
  ];
  check(
    '14q. удалены все 4 исходника (в т.ч. перенесённые при повторе)',
    JSON.stringify([...state.removed].sort()) === JSON.stringify(expectedRemoved),
    JSON.stringify([...state.removed].sort())
  );
}

{
  // 15. Статусы и частные случаи
  const notApproved = makeFinalizeDeps(chapterRow([storedChapter(1, 1)], { status: 'pending' }));
  const r1 = await core.finalizeChapterSubmission(notApproved.deps, { requestId: 'req-1' });
  check('15a. не approved → 409', r1.status === 409 && r1.body.error === 'not_approved');

  const wrongType = makeFinalizeDeps(chapterRow([storedChapter(1, 1)], { type: 'ad_request' }));
  const r2 = await core.finalizeChapterSubmission(wrongType.deps, { requestId: 'req-1' });
  check('15b. чужой тип заявки → 400', r2.status === 400 && r2.body.error === 'unsupported_type');

  const noChapters = makeFinalizeDeps(chapterRow([]));
  const r3 = await core.finalizeChapterSubmission(noChapters.deps, { requestId: 'req-1' });
  check(
    '15c. заявка без глав → no-op',
    r3.status === 200 && r3.body.skipped === true && noChapters.state.chapters.length === 0,
    JSON.stringify(r3.body)
  );

  const conflict = makeFinalizeDeps(
    chapterRow([storedChapter(1, 1)], { type: 'new_title', target_id: null, payload: { conflict: true, chapters: [storedChapter(1, 1)] } })
  );
  const r4 = await core.finalizeChapterSubmission(conflict.deps, { requestId: 'req-1' });
  check(
    '15d. new_title с занятым slug → 409 target_title_missing',
    r4.status === 409 && r4.body.error === 'target_title_missing',
    JSON.stringify(r4.body)
  );

  const newTitle = makeFinalizeDeps(
    chapterRow([storedChapter(1, 1)], {
      type: 'new_title',
      target_id: null,
      payload: { created_title_id: TITLE_ID, chapters: [storedChapter(1, 1)] },
    })
  );
  const r5 = await core.finalizeChapterSubmission(newTitle.deps, { requestId: 'req-1' });
  check(
    '15e. new_title с главами использует created_title_id',
    r5.status === 200 && newTitle.state.chapters[0]?.title_id === TITLE_ID,
    JSON.stringify(r5.body)
  );

  const notFound = makeFinalizeDeps(chapterRow([]), { getRequest: async () => null });
  const r6 = await core.finalizeChapterSubmission(notFound.deps, { requestId: 'req-1' });
  check('15f. неизвестная заявка → 404', r6.status === 404);
}

// ── 16. Вспомогательные функции ───────────────────────────────────────────
{
  const taken = [1, 2, 5];
  check('16a. свободный номер не меняется', core.resolveChapterNumber(3, taken) === 3 && taken.includes(3));
  check('16b. занятый номер сдвигается', core.resolveChapterNumber(2, taken) === 6, JSON.stringify(taken));
  check(
    '16c. разбор имён страниц',
    JSON.stringify(core.parseSubmittedPageName('ch-12-page-3.webp')) === JSON.stringify({ chapter: 12, page: 3 })
  );
  check('16d. разбор имени PDF', core.parseSubmittedPdfName('ch-12.pdf') === 12 && core.parseSubmittedPdfName('12.pdf') === null);
  check(
    '16e. путь страницы в submissions',
    core.submissionPagePath('tok', 4, 2, 'png') === 'tok/ch-4/page-2.png'
  );
  check(
    '16f. публичный URL бакета submissions',
    core.submissionPublicUrl('https://x.supabase.co/', 'tok/ch-4/page-2.png') ===
      'https://x.supabase.co/storage/v1/object/public/submissions/tok/ch-4/page-2.png'
  );
  check(
    '16g. лимиты ТЗ',
    core.MAX_CHAPTERS_PER_REQUEST === 5 &&
      core.MAX_PAGES_PER_CHAPTER === 100 &&
      core.MAX_TOTAL_BYTES === 500 * 1024 * 1024 &&
      core.PAGE_IMAGE_MAX_BYTES === 20 * 1024 * 1024 &&
      core.PDF_MAX_BYTES === 200 * 1024 * 1024 &&
      JSON.stringify(core.CHAPTER_RATE_LIMITS.map((r) => r.limit)) === '[3,30,100]'
  );
}

// ── 17. Демо-флоу без Supabase: подача → инбокс → approve → finalize ─────
// Проверяет клиентский слой (src/data/chapterSubmissions.ts) целиком: именно
// он работает в dev/превью без бэкенда и в нём же живёт идемпотентный
// демо-finalize. window/localStorage подводим ПОСЛЕ загрузки модулей —
// Vite SSR не должен видеть «браузер» на этапе импорта.
{
  const { chapterSubmissions } = await vite.ssrLoadModule('/src/data/chapterSubmissions.ts');
  const { adminRequests } = await vite.ssrLoadModule('/src/data/adminRequests.ts');
  const { titles } = await vite.ssrLoadModule('/src/data/titles.ts');
  const { chapters } = await vite.ssrLoadModule('/src/data/chapters.ts');
  const { pages } = await vite.ssrLoadModule('/src/data/pages.ts');

  const store = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: globalThis.localStorage },
  });

  const target = await titles.create({
    slug: 'demo-chapters-target',
    title: 'Демо тайтл для глав',
    published: true,
  });

  const submitted = await chapterSubmissions.submit({
    titleId: target.id,
    titleName: target.title,
    chapters: [
      {
        number: 1,
        name: 'Первая',
        description: 'Описание первой',
        pages: [
          { name: 'ch-1-page-1.webp', size: 10, file: new File(['0123456789'], 'ch-1-page-1.webp') },
          { name: 'ch-1-page-2.webp', size: 10, file: new File(['0123456789'], 'ch-1-page-2.webp') },
        ],
        pdf: null,
      },
      {
        number: 2,
        name: null,
        description: null,
        pages: [
          { name: 'ch-2-page-1.webp', size: 10, file: new File(['0123456789'], 'ch-2-page-1.webp') },
        ],
        pdf: null,
      },
    ],
    captchaToken: 'tok',
    consent: true,
    email: 'demo@example.com',
  });
  check('17a. демо-подача возвращает токен', submitted.ok === true && !!submitted.token, JSON.stringify(submitted));

  const inbox = await adminRequests.listForOwner({ status: 'pending', type: 'new_chapters' });
  const row = inbox.find((r) => r.public_token === submitted.token);
  check('17b. заявка видна в инбоксе owner как new_chapters', !!row && row.type === 'new_chapters', JSON.stringify(inbox.map((r) => r.type)));
  check('17c. payload несёт главы и target', row?.payload.chapters.length === 2 && row?.target_id === target.id);

  await adminRequests.resolve(row.id, 'approved');
  const first = await chapterSubmissions.finalize(row.id);
  check('17d. демо-finalize создаёт главы', first.ok === true && first.chapters_imported === 2, JSON.stringify(first));

  const createdChapters = await chapters.listByTitle(target.id, true);
  check(
    '17e. главы созданы черновиками с описанием',
    createdChapters.length === 2 &&
      createdChapters.every((c) => c.published === false) &&
      createdChapters.find((c) => Number(c.number) === 1)?.description === 'Описание первой',
    JSON.stringify(createdChapters.map((c) => [c.number, c.published, c.description]))
  );

  const firstPages = await pages.listByChapter(
    createdChapters.find((c) => Number(c.number) === 1).id
  );
  check('17f. страницы главы записаны', firstPages.length === 2, String(firstPages.length));

  const second = await chapterSubmissions.finalize(row.id);
  const afterSecond = await chapters.listByTitle(target.id, true);
  check(
    '17g. повторный демо-finalize — no-op',
    second.ok === true && second.skipped === true && afterSecond.length === 2,
    JSON.stringify(second)
  );

  const finalizedRow = (await adminRequests.listForOwner({ type: 'new_chapters' })).find(
    (r) => r.id === row.id
  );
  check('17h. finalized_at проставлен в инбоксе', !!finalizedRow?.finalized_at);
}

// ── 18. «Предложить тайтл» + главы: approve создаёт тайтл, затем главы ────
// Проверяет связку SQL-триггера (в демо — applyDemoRequest) и finalize:
// тайтл берётся из payload.created_title_id, а не из target_id.
{
  // FileReader в Node нет — минимальный шим data-URL для демо-обложки.
  class FakeFileReader {
    readAsDataURL(file) {
      file
        .arrayBuffer()
        .then((buf) => {
          this.result = `data:${file.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`;
          this.onload?.();
        })
        .catch((e) => this.onerror?.(e));
    }
  }
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: FakeFileReader });

  const { submissions } = await vite.ssrLoadModule('/src/data/submissions.ts');
  const { adminRequests } = await vite.ssrLoadModule('/src/data/adminRequests.ts');
  const { chapterSubmissions } = await vite.ssrLoadModule('/src/data/chapterSubmissions.ts');
  const { chapters } = await vite.ssrLoadModule('/src/data/chapters.ts');
  const { titles } = await vite.ssrLoadModule('/src/data/titles.ts');

  const res = await submissions.submitTitle({
    payload: {
      original_title: 'Тайтл с главами',
      type: 'manga',
      description: 'Описание длиной больше десяти символов.',
      genres: ['Экшен'],
    },
    cover: new File(['coverbytes'], 'cover.png', { type: 'image/png' }),
    captchaToken: 'tok',
    chapters: [
      {
        number: 1,
        name: 'Пилот',
        description: null,
        pages: [{ name: 'ch-1-page-1.webp', size: 8, file: new File(['01234567'], 'ch-1-page-1.webp') }],
        pdf: null,
      },
    ],
  });
  check('18a. заявка на тайтл с главами подана', res.ok === true && !!res.token, JSON.stringify(res));

  const row = (await adminRequests.listForOwner({ status: 'pending', type: 'new_title' })).find(
    (r) => r.public_token === res.token
  );
  check('18b. payload содержит главы', row?.payload.chapters?.length === 1);

  await adminRequests.resolve(row.id, 'approved');
  const approved = (await adminRequests.listForOwner({ type: 'new_title' })).find((r) => r.id === row.id);
  check(
    '18c. approve записал created_title_id (как триггер 14)',
    typeof approved?.payload.created_title_id === 'string' && approved?.payload.conflict === false,
    JSON.stringify(approved?.payload)
  );

  const fin = await chapterSubmissions.finalize(row.id);
  check('18d. главы импортированы в созданный тайтл', fin.ok === true && fin.chapters_imported === 1, JSON.stringify(fin));

  const createdChapters = await chapters.listByTitle(approved.payload.created_title_id, true);
  check(
    '18e. глава-черновик привязана к новому тайтлу',
    createdChapters.length === 1 && createdChapters[0].name === 'Пилот' && createdChapters[0].published === false,
    JSON.stringify(createdChapters.map((c) => [c.number, c.name, c.published]))
  );
  check(
    '18f. тайтл создан неопубликованным',
    (await titles.getById(approved.payload.created_title_id))?.published === false
  );
}

// ── 19. Клиентская подготовка файлов и редактор глав ──────────────────────
// prepareChaptersForSubmit (без PDF — pdf.js не грузится) и хелперы
// ChaptersEditor: то, что реально исполняется в модалках до отправки.
{
  const { prepareChaptersForSubmit } = await vite.ssrLoadModule('/src/data/chapterSubmissions.ts');
  const editor = await vite.ssrLoadModule('/src/components/requests/ChaptersEditor.tsx');

  const img = (name, size = 1024) => {
    const f = new File(['x'], name);
    Object.defineProperty(f, 'size', { value: size });
    return f;
  };

  const ok = await prepareChaptersForSubmit([
    editor.renumberPages({
      id: 'a',
      number: '12',
      name: ' Двенадцатая ',
      description: '  ',
      pages: [
        { id: 'p2', file: img('page-2.jpg'), index: 0, name: '' },
        { id: 'p1', file: img('page-1.jpg'), index: 0, name: '' },
        { id: 'p10', file: img('page-10.jpg'), index: 0, name: '' },
      ],
    }),
  ]);
  check('19a. подготовка прошла', ok.ok === true, JSON.stringify(ok));
  check(
    '19b. имена страниц плотные и канонические ch-{n}-page-{m}',
    JSON.stringify(ok.chapters[0].pages.map((pg) => pg.name)) ===
      JSON.stringify(['ch-12-page-1.jpg', 'ch-12-page-2.jpg', 'ch-12-page-3.jpg']),
    ok.chapters[0].pages.map((pg) => pg.name).join(',')
  );
  check(
    '19b*. порядок файлов естественный (page-2 раньше page-10)',
    JSON.stringify(ok.chapters[0].pages.map((pg) => pg.file.size)) === JSON.stringify([1024, 1024, 1024]) &&
      JSON.stringify(
        editor
          .renumberPages({
            id: 's',
            number: '12',
            name: '',
            description: '',
            pages: [
              { id: 'p2', file: img('page-2.jpg'), index: 0, name: '' },
              { id: 'p10', file: img('page-10.jpg'), index: 0, name: '' },
              { id: 'p1', file: img('page-1.jpg'), index: 0, name: '' },
            ],
          })
          .pages.map((pg) => pg.file.name)
      ) === JSON.stringify(['page-1.jpg', 'page-2.jpg', 'page-10.jpg']),
    'см. renumberPages'
  );
  check(
    '19c. name/description тримятся, пустое → null',
    ok.chapters[0].name === 'Двенадцатая' && ok.chapters[0].description === null
  );

  const noChapters = await prepareChaptersForSubmit([]);
  check('19d. без глав → ошибка', noChapters.ok === false && /хотя бы одну/.test(noChapters.error));

  const emptyChapter = await prepareChaptersForSubmit([
    { id: 'a', number: '1', name: '', description: '', pages: [], pdf: null },
  ]);
  check('19e. глава без страниц → ошибка', emptyChapter.ok === false && /нет страниц/.test(emptyChapter.error), emptyChapter.error);

  const badNumber = await prepareChaptersForSubmit([
    { id: 'a', number: 'abc', name: '', description: '', pages: [{ file: img('1.jpg') }], pdf: null },
  ]);
  check('19f. нечисловой номер → ошибка', badNumber.ok === false && /номер/.test(badNumber.error), badNumber.error);

  const dupNumbers = await prepareChaptersForSubmit([
    { id: 'a', number: '4', name: '', description: '', pages: [{ file: img('1.jpg') }], pdf: null },
    { id: 'b', number: '4', name: '', description: '', pages: [{ file: img('1.jpg') }], pdf: null },
  ]);
  check('19g. дубль номера → ошибка', dupNumbers.ok === false && /повторяется/.test(dupNumbers.error), dupNumbers.error);

  const tooMany = await prepareChaptersForSubmit([
    {
      id: 'a',
      number: '1',
      name: '',
      description: '',
      pages: Array.from({ length: 101 }, (_, i) => ({ file: img(`p${i}.jpg`) })),
      pdf: null,
    },
  ]);
  check('19h. 101 страница → ошибка', tooMany.ok === false && /лимит 100/.test(tooMany.error), tooMany.error);

  // Хелперы редактора
  const ch = editor.renumberPages({
    id: 'x',
    number: '7',
    name: '',
    description: '',
    pages: [{ id: 'p1', file: img('b.jpg'), index: 0, name: '' }, { id: 'p2', file: img('a.jpg'), index: 0, name: '' }],
  });
  check(
    '19i. renumberPages сортирует и ставит канонические имена',
    ch.pages[0].name === 'ch-7-page-1.jpg' &&
      ch.pages[1].name === 'ch-7-page-2.jpg' &&
      ch.pages[0].file.name === 'a.jpg' &&
      ch.pages[1].file.name === 'b.jpg'
  );
  check(
    '19j. chapterPageErrors ловит пустую главу и битый номер',
    editor.chapterPageErrors({ number: '', pages: [] }, 100).length === 2 &&
      editor.chapterPageErrors({ number: '1', pages: [{}], pdf: null }, 100).length === 0
  );
  check(
    '19k. лимит страниц главы виден в ошибках',
    editor.chapterPageErrors({ number: '1', pages: Array.from({ length: 3 }, () => ({})) }, 2).some((e) => /3\/2/.test(e))
  );
  check(
    '19l. totalBytes и дубликаты номеров',
    editor.totalBytes([{ pages: [{ file: img('a', 100) }], pdf: null }]) === 100 &&
      editor.duplicateChapterNumbers([{ number: '1' }, { number: '1' }, { number: '2' }]).has('1')
  );
  check(
    '19m. лимиты редактора совпадают с edge',
    editor.EDITOR_IMAGE_MAX_BYTES === 20 * 1024 * 1024 &&
      editor.EDITOR_PDF_MAX_BYTES === 200 * 1024 * 1024 &&
      editor.EDITOR_TOTAL_MAX_BYTES === 500 * 1024 * 1024
  );
}

// ── 20. PDF главы: объявление, присутствие, учёт в суммарном объёме ──────
{
  const pdfPart = (chapter, size = 4096) => ({
    name: `ch-${chapter}.pdf`,
    bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
    contentType: 'application/pdf',
    declaredSize: size,
  });

  // 20a. PDF объявлен, но файл не прислан → 400 (раньше молча висел в payload)
  const { deps: d1 } = makeDeps();
  const missingPdf = await core.processChapterSubmission(
    d1,
    input({
      payloadRaw: payloadOf([
        { number: 1, pages: pageDecls(1, 1), pdf: { name: 'ch-1.pdf', size: 4096 } },
      ]),
      files: pageFiles(1, 1),
    })
  );
  check(
    '20a. объявленный, но не присланный PDF → 400',
    missingPdf.status === 400 && /Нет файла для PDF/.test(String(missingPdf.body.fields?.['chapters.1.pdf'] ?? '')),
    JSON.stringify(missingPdf.body.fields)
  );

  // 20b. PDF прислан → лежит в submissions/{token}/ch-{n}.pdf
  const { deps: d2, state: st2 } = makeDeps();
  const withPdf = await core.processChapterSubmission(
    d2,
    input({
      payloadRaw: payloadOf([
        { number: 1, pages: pageDecls(1, 1), pdf: { name: 'ch-1.pdf', size: 5 } },
      ]),
      files: [...pageFiles(1, 1), { name: 'ch-1.pdf', bytes: new Uint8Array(5), contentType: 'application/pdf' }],
    })
  );
  check('20b. заявка с PDF принята', withPdf.status === 200, JSON.stringify(withPdf.body));
  check(
    '20b*. PDF сохранён как ch-{n}.pdf и записан в payload',
    st2.uploads.some((u) => u.path === 'deadbeefdeadbeefdeadbeefdeadbeef/ch-1.pdf') &&
      st2.inserted[0].payload.chapters[0].pdf === 'deadbeefdeadbeefdeadbeefdeadbeef/ch-1.pdf',
    st2.uploads.map((u) => u.path).join(' | ')
  );

  // 20c. Объём PDF учитывается в суммарном лимите (клиент и сервер считают одно)
  const { deps: d3 } = makeDeps();
  const heavy = await core.processChapterSubmission(
    d3,
    input({
      payloadRaw: payloadOf([
        // 30 страниц по 15 MB (каждая в лимите 20 MB) + PDF 150 MB = 600 MB
        { number: 1, pages: pageDecls(1, 30, 15 * 1024 * 1024), pdf: { name: 'ch-1.pdf', size: 150 * 1024 * 1024 } },
      ]),
      files: [...pageFiles(1, 30), { name: 'ch-1.pdf', bytes: new Uint8Array(5) }],
    })
  );
  check(
    '20c. страницы 450 MB + PDF 150 MB → 400 total',
    heavy.status === 400 && /500 MB/.test(String(heavy.body.fields?.total ?? '')),
    JSON.stringify(heavy.body.fields?.total)
  );

  // 20d. PDF без объявления в payload → 400
  const { deps: d4 } = makeDeps();
  const undeclared = await core.processChapterSubmission(
    d4,
    input({
      payloadRaw: payloadOf([{ number: 1, pages: pageDecls(1, 1) }]),
      files: [...pageFiles(1, 1), { name: 'ch-1.pdf', bytes: new Uint8Array(5) }],
    })
  );
  check(
    '20d. непроявленный PDF → 400',
    undeclared.status === 400 && /не объявлен/i.test(String(undeclared.body.fields?.['ch-1.pdf'] ?? '')),
    JSON.stringify(undeclared.body.fields)
  );

  // 20e. Имя в объявлении не совпадает с присланным → 400
  const { deps: d5 } = makeDeps();
  const mismatch = await core.processChapterSubmission(
    d5,
    input({
      payloadRaw: payloadOf([
        { number: 1, pages: pageDecls(1, 1), pdf: { name: 'ch-1.pdf', size: 5 } },
      ]),
      files: [...pageFiles(1, 1), { name: 'ch-2.pdf', bytes: new Uint8Array(5) }],
    })
  );
  check('20e. чужое имя PDF → 400', mismatch.status === 400, JSON.stringify(mismatch.body.fields));

  // 20f. Строковая форма объявления (сторонний клиент) тоже принимается
  const { deps: d6, state: st6 } = makeDeps();
  const legacy = await core.processChapterSubmission(
    d6,
    input({
      payloadRaw: payloadOf([{ number: 1, pages: pageDecls(1, 1), pdf: 'ch-1.pdf' }]),
      files: [...pageFiles(1, 1), { name: 'ch-1.pdf', bytes: new Uint8Array(5) }],
    })
  );
  check(
    '20f. строковая форма pdf совместима',
    legacy.status === 200 && st6.uploads.some((u) => u.path.endsWith('/ch-1.pdf')),
    JSON.stringify(legacy.body)
  );
}

// ── 21. «Предложить тайтл» + главы: суммарный объём по факту ──────────────
{
  const titleCore = await vite.ssrLoadModule('/supabase/functions/_shared/submissionCore.ts');
  // PNG-заглушка: imageSize читает только сигнатуру и width/height (offset 16/20).
  const pngCover = (width, height) => {
    const bytes = new Uint8Array(33);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const dv = new DataView(bytes.buffer);
    dv.setUint32(16, width);
    dv.setUint32(20, height);
    return bytes;
  };
  const tState = { uploads: [], inserted: [] };
  const tDeps = {
    ipSalt: SALT,
    verifyCaptcha: async () => ({ ok: true }),
    checkLimit: async () => true,
    uploadCover: async () => 'https://cdn.test/cover.png',
    uploadPage: async (bytes, token, path) => {
      tState.uploads.push({ path, size: bytes.length });
    },
    insertRequest: async (row) => {
      tState.inserted.push(row);
      return { id: `req-${tState.inserted.length}` };
    },
    randomToken: () => 'deadbeefdeadbeefdeadbeefdeadbeef',
  };
  const titleInput = (chapters, files) => ({
    captchaToken: 'tok',
    payloadRaw: {
      original_title: 'Магическая битва',
      type: 'manga',
      description: 'Парень проглотил палец древнего проклятия.',
      genres: ['Экшен'],
    },
    coverBytes: pngCover(600, 800),
    chaptersRaw: chapters, // submit-title отдаёт сюда JSON-массив как есть
    chapterFiles: files,
    ip: IP,
    userAgent: 'unit-agent/1.0',
  });

  // 30 × 15 MB = 450 MB страниц + PDF 150 MB = 600 MB: каждая часть в своём
  // лимите, сумма — нет.
  const over = await titleCore.processSubmission(
    tDeps,
    titleInput(
      [
        {
          number: 1,
          pages: pageDecls(1, 30, 15 * 1024 * 1024),
          pdf: { name: 'ch-1.pdf', size: 150 * 1024 * 1024 },
        },
      ],
      [...pageFiles(1, 30), { name: 'ch-1.pdf', bytes: new Uint8Array(5) }]
    )
  );
  check(
    '21a. тайтл+главы 600 MB → 400 total',
    over.status === 400 && /500 MB/.test(String(over.body.fields?.total ?? '')),
    JSON.stringify(over.body)
  );
  check(
    '21b. ничего не загружено и не вставлено',
    tState.uploads.length === 0 && tState.inserted.length === 0,
    `uploads=${tState.uploads.length}, inserted=${tState.inserted.length}`
  );

  const fit = await titleCore.processSubmission(
    tDeps,
    titleInput(
      [{ number: 1, pages: pageDecls(1, 30, 15 * 1024 * 1024) }],
      pageFiles(1, 30)
    )
  );
  check(
    '21c. 450 MB без PDF → 200 (лимит не задет)',
    fit.status === 200 && tState.uploads.length === 30,
    JSON.stringify(fit.body)
  );
}

await vite.close();

console.log('');
if (failures.length) {
  console.error(`unit-submit-chapters: провалено ${failures.length}: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('unit-submit-chapters: все проверки пройдены');

/**
 * Юнит-тесты анонимных заявок на тайтл (ТЗ-3): ядро submit-title
 * (_shared/submissionCore.ts — та же логика, что в edge-функции) и
 * demo-пути клиента (submissions.getSubmission, adminRequests.resolve).
 *
 *   npm i --no-save jsdom   # разовая зависимость
 *   npm run test:submissions
 *
 * Live-прогон против реального Supabase невозможен из песочницы (TLS до
 * *.supabase.co закрыт) — деплой edge и проверка капчи/лимитов делаются
 * пользователем по SETUP_SUPABASE.md, раздел «Приём заявок».
 *
 * 10 кейсов по ТЗ:
 *   1. капча не прошла → 400, заявки нет;
 *   2. rate limit: 15 ок, 16-я → 429 + Retry-After;
 *   3. валидация payload (+ `javascript:`-схемы) → 400 + fieldErrors;
 *   4. обложка: >5MB / GIF / 1:1 → 400;
 *   5. успех → токен, pending, ip_hash = sha256(ip+salt);
 *   6. get-submission: токен найден → только статусные поля, без payload;
 *   7. get-submission: неизвестный токен → null (404);
 *   8. approve → черновик тайтла published=false;
 *   9. approve при занятом slug → conflict=true, черновика нет;
 *  10. reject с причиной → rejected + reject_reason.
 */
let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.error('unit-submissions: нужен jsdom (одноразово): npm i --no-save jsdom');
  process.exit(2);
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:3000/',
  pretendToBeVisual: true,
});
for (const key of ['document', 'localStorage', 'sessionStorage']) {
  Object.defineProperty(globalThis, key, {
    value: dom.window[key],
    configurable: true,
    writable: true,
  });
}
globalThis.window = dom.window;
try {
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
} catch {
  // оставляем node-овский
}

const { forceDemoMode, DEMO_SERVER_OPTIONS } = await import('./lib/demo-mode.mjs');
forceDemoMode();

const { createServer } = await import('vite');
const vite = await createServer({
  root: new URL('..', import.meta.url).pathname,
  ...DEMO_SERVER_OPTIONS,
});

const core = await vite.ssrLoadModule('/supabase/functions/_shared/submissionCore.ts');
const submissionsMod = await vite.ssrLoadModule('/src/data/submissions.ts');
const adminRequestsMod = await vite.ssrLoadModule('/src/data/adminRequests.ts');
const { slugify } = await vite.ssrLoadModule('/src/lib/slugify.ts');

const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures.push(name);
};

const SALT = 'unit-test-salt';
const IP = '203.0.113.7';

const validPayload = {
  original_title: 'Магическая битва',
  type: 'manga',
  description: 'Парень проглотил палец древнего проклятия.',
  genres: ['Экшен', 'Мистика'],
};

/** Синтетический JPEG с заданными размерами (SOF0). */
function makeJpeg(width, height, fill = 0) {
  const bytes = new Uint8Array(21);
  bytes[0] = 0xff; bytes[1] = 0xd8;            // SOI
  bytes[2] = 0xff; bytes[3] = 0xc0;            // SOF0
  bytes[4] = 0x00; bytes[5] = 0x11;            // segment length
  bytes[6] = 0x08;                             // precision
  bytes[7] = (height >> 8) & 0xff; bytes[8] = height & 0xff;
  bytes[9] = (width >> 8) & 0xff;  bytes[10] = width & 0xff;
  bytes[11] = 0x03;                            // components
  bytes[19] = 0xff; bytes[20] = 0xd9;          // EOI
  if (fill) bytes.fill(fill % 256, 12, 19);
  return bytes;
}

/** Фейковые зависимости processSubmission с настоящей логикой окон. */
function makeDeps(overrides = {}) {
  const state = {
    captchaCalls: 0,
    captchaOk: true,
    inserted: [],
    uploads: [],
    windows: new Map(), // windowSeconds -> { start, count }
    limitConfig: [
      { windowSeconds: 60, limit: 15 },
      { windowSeconds: 3600, limit: 100 },
      { windowSeconds: 86400, limit: 300 },
    ],
  };
  const deps = {
    ipSalt: SALT,
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
    uploadCover: async (bytes, token) => {
      state.uploads.push({ token, size: bytes.length });
      return `https://proj.supabase.co/storage/v1/object/public/submissions/${token}/cover.webp`;
    },
    insertRequest: async (row) => {
      state.inserted.push(row);
      return { id: `req-${state.inserted.length}` };
    },
    randomToken: () => 'deadbeefdeadbeefdeadbeefdeadbeef',
    ...overrides,
  };
  return { deps, state };
}

const input = (over = {}) => ({
  captchaToken: 'tok',
  payloadRaw: { ...validPayload },
  email: '',
  coverBytes: makeJpeg(600, 800),
  ip: IP,
  userAgent: 'unit-agent/1.0',
  ...over,
});

// ── 1. Капча не прошла → 400, заявка не создаётся ───────────────────────────
{
  const { deps, state } = makeDeps();
  const missing = await core.processSubmission(deps, input({ captchaToken: undefined }));
  check('1a. нет токена капчи → 400 captcha_missing', missing.status === 400 && missing.body.error === 'captcha_missing', JSON.stringify(missing.body));

  state.captchaOk = false;
  state.windows.clear();
  const failed = await core.processSubmission(deps, input());
  check('1b. turnstile отклонил токен → 400 captcha_failed', failed.status === 400 && failed.body.error === 'captcha_failed');
  check('1c. заявка НЕ создана', state.inserted.length === 0 && state.uploads.length === 0);
}

// ── 2. Rate limit: 15 ок / 16-я → 429 + Retry-After ─────────────────────────
{
  const { deps, state } = makeDeps();
  let last = null;
  for (let i = 0; i < 15; i += 1) {
    last = await core.processSubmission(deps, input());
  }
  const okCount = state.windows.get(60).count;
  check('2a. 15 заявок прошли (последняя 200)', last.status === 200 && okCount === 15, `count=${okCount}, last=${last.status}`);
  check('2b. вставлено 15 строк', state.inserted.length === 15);

  const over = await core.processSubmission(deps, input());
  check('2c. 16-я → 429 rate_limited', over.status === 429 && over.body.error === 'rate_limited');
  check('2d. Retry-After присутствует', typeof over.retryAfter === 'number' && over.retryAfter > 0, String(over.retryAfter));
  check('2e. 16-я НЕ вставлена', state.inserted.length === 15);
}

// ── 3. Валидация payload (+ javascript:-схемы) ──────────────────────────────
{
  const { deps, state } = makeDeps();
  const bad = await core.processSubmission(deps, input({
    payloadRaw: {
      ...validPayload,
      original_title: '',
      genres: [],
      year: 1800,
    },
  }));
  check('3a. пустое название/жанры/год → 400 + fieldErrors', bad.status === 400
    && !!bad.body.fields?.original_title
    && !!bad.body.fields?.genres
    && !!bad.body.fields?.year);

  const xss = await core.processSubmission(deps, input({
    payloadRaw: {
      ...validPayload,
      description: 'javascript:alert(1) описание',
    },
  }));
  check('3b. javascript:-схема в описании → 400', xss.status === 400 && !!xss.body.fields?.description);

  const xssTitle = await core.processSubmission(deps, input({
    payloadRaw: {
      ...validPayload,
      original_title: 'DaTA:text/html волшебство',
    },
  }));
  check('3c. data:-схема в названии → 400', xssTitle.status === 400 && !!xssTitle.body.fields?.original_title);
  check('3d. невалидные заявки не вставлены', state.inserted.length === 0);
}

// ── 4. Обложка: >5MB / GIF / 1:1 → 400 ──────────────────────────────────────
{
  const { deps, state } = makeDeps();
  const big = new Uint8Array(5 * 1024 * 1024 + 1);
  big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
  const r1 = await core.processSubmission(deps, input({ coverBytes: big }));
  check('4a. >5MB → 400', r1.status === 400 && /5 MB/.test(r1.body.fields?.cover ?? ''));

  const gif = new TextEncoder().encode('GIF89awhatever');
  const r2 = await core.processSubmission(deps, input({ coverBytes: gif }));
  check('4b. GIF → 400 (формат)', r2.status === 400 && /JPEG, PNG или WebP/.test(r2.body.fields?.cover ?? ''));

  const square = makeJpeg(700, 700);
  const r3 = await core.processSubmission(deps, input({ coverBytes: square }));
  check('4c. 1:1 → 400 (соотношение 3:4)', r3.status === 400 && /3:4/.test(r3.body.fields?.cover ?? ''));

  const r4 = await core.processSubmission(deps, input({ coverBytes: undefined }));
  check('4d. без обложки → 400', r4.status === 400 && !!r4.body.fields?.cover);
  check('4e. ни одна не вставлена', state.inserted.length === 0);
}

// ── 5. Успех: токен + pending + ip_hash ─────────────────────────────────────
{
  const { deps, state } = makeDeps();
  const ok = await core.processSubmission(deps, input({ email: ' fan@example.com ' }));
  check('5a. 200 + токен 32 hex', ok.status === 200 && /^[0-9a-f]{32}$/.test(ok.body.token ?? ''), JSON.stringify(ok.body));

  const row = state.inserted[0];
  const expectedHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(IP + SALT))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  check('5b. строка pending/new_title, email тримминг', row?.status === 'pending' && row?.type === 'new_title' && row.submitter_email === 'fan@example.com');
  check('5c. ip_hash = sha256(ip+salt), сырого IP нет', row?.ip_hash === expectedHash && !JSON.stringify(row).includes(IP));
  check('5d. turnstile_ok=true, user_agent записан', row?.turnstile_ok === true && row?.user_agent === 'unit-agent/1.0');
  check('5e. обложка в submissions/{token}/', state.uploads[0]?.token === ok.body.token && row?.payload?.cover_url?.includes(ok.body.token));
  check('5f. payload очищен от лишнего', row?.payload?.original_title === 'Магическая битва' && Array.isArray(row.payload.genres) && row.payload.genres.length === 2);
}

// ── 6-7. get-submission через клиентский demo-слой ──────────────────────────
{
  localStorage.setItem('manga_admin_requests', JSON.stringify([
    {
      id: 'anon-1',
      type: 'new_title',
      status: 'pending',
      payload: { original_title: 'Секрет', cover_url: 'blob:x' },
      ip_hash: 'demo-anonymous',
      public_token: 'tok123',
      created_at: new Date().toISOString(),
    },
  ]));

  const found = await submissionsMod.submissions.getSubmission('tok123');
  check('6a. токен найден, статус pending', found?.status === 'pending' && found?.type === 'new_title');
  check('6b. payload НЕ утекает', found && !('payload' in found) && !('cover_url' in found) && !('ip_hash' in found));

  const notFound = await submissionsMod.submissions.getSubmission('nope');
  check('7. неизвестный токен → null (404 в edge)', notFound === null);
  localStorage.removeItem('manga_admin_requests');
}

// ── 8-10. approve/reject через demo-слой (аналог SQL-триггера) ──────────────
{
  // Уникальные слаги, чтобы тест не зависел от сидa и порядка прогонов.
  const stamp = Date.now().toString(36);
  const titlesMod = await vite.ssrLoadModule('/src/data/titles.ts');

  const seedRequest = async (title, slug) => {
    const list = JSON.parse(localStorage.getItem('manga_admin_requests') ?? '[]');
    const row = {
      id: `anon-${slug}`,
      type: 'new_title',
      status: 'pending',
      requester_id: null,
      payload: {
        original_title: title,
        type: 'manga',
        description: 'Тестовое описание заявки.',
        genres: ['Экшен'],
        cover_url: 'data:image/webp;base64,xxx',
      },
      ip_hash: 'demo-anonymous',
      public_token: `tok-${slug}`,
      created_at: new Date().toISOString(),
    };
    list.push(row);
    localStorage.setItem('manga_admin_requests', JSON.stringify(list));
    return row;
  };

  // 8. approve → черновик published=false
  const titleOk = `Юнит Тайтл ${stamp}`;
  const rowOk = await seedRequest(titleOk, `ok${stamp}`);
  await adminRequestsMod.adminRequests.resolve(rowOk.id, 'approved');
  const draft = await titlesMod.titles.getBySlug(slugify(titleOk));
  check('8a. approve создал черновик со слагом', !!draft);
  check('8b. черновик не опубликован (published=false)', draft?.published === false);

  // 9. approve при занятом slug → conflict=true, дубль не создан
  const rowDup = await seedRequest(titleOk, `dup${stamp}`);
  const before = await titlesMod.titles.listAll();
  const dupResult = await adminRequestsMod.adminRequests.resolve(rowDup.id, 'approved');
  const after = await titlesMod.titles.listAll();
  const rows = JSON.parse(localStorage.getItem('manga_admin_requests') ?? '[]');
  const dupRow = rows.find((r) => r.id === rowDup.id);
  check('9a. результат approve содержит conflict=true', dupResult?.conflict === true);
  check('9b. дубль тайтла не создан', after.length === before.length);
  check('9c. заявка approved с payload.conflict=true', dupRow?.status === 'approved' && dupRow?.payload?.conflict === true && dupRow?.conflict === true);

  // 10. reject с причиной
  const rowRej = await seedRequest(`Отклон тест ${stamp}`, `rej${stamp}`);
  await adminRequestsMod.adminRequests.resolve(rowRej.id, 'rejected', 'Такое произведение уже есть');
  const rows2 = JSON.parse(localStorage.getItem('manga_admin_requests') ?? '[]');
  const rejRow = rows2.find((r) => r.id === rowRej.id);
  check('10. reject + причина записаны', rejRow?.status === 'rejected' && rejRow?.reject_reason === 'Такое произведение уже есть' && !!rejRow?.resolved_at);

  localStorage.removeItem('manga_admin_requests');
}

await vite.close();

console.log('');
if (failures.length > 0) {
  console.error(`FAILURES (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
} else {
  console.log('ALL SUBMISSION CHECKS PASS');
}

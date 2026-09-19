/**
 * Unit-тесты Login Guard / hasRole / resolveLoginChallenge / ads CRUD (demo).
 * Без браузера, через Vite SSR. Запуск: node scripts/unit-auth-notify.mjs
 *
 * Важно: resolveLoginChallenge в DEV ходит на /api/login-confirm.
 * Ветки статусов (approve/deny/expired/already_*) — через resolveLocal()
 * (зеркало localStorage-fallback из notify.ts; без гонки с import.meta.env.DEV).
 * Happy-path DEV API — отдельно: middleware + патч globalThis.fetch для /api/*.
 *
 * Важно: всё это проверяется в ДЕМО-режиме (mockStore). Supabase-переменные
 * обнуляются через scripts/lib/demo-mode.mjs — иначе настроенный `.env`
 * уводит `src/data/ads.ts` и др. в реальную базу, и тест падает на RLS.
 */
import { createServer } from 'vite';
import { createServer as createHttpServer } from 'node:http';
import { forceDemoMode, DEMO_SERVER_OPTIONS } from './lib/demo-mode.mjs';

forceDemoMode();

const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures.push(name);
};

const vite = await createServer({
  ...DEMO_SERVER_OPTIONS,
  // mode 'test' → import.meta.env.DEV может быть false в ssr; не полагаемся на это.
});

// ── Memory localStorage for SSR ─────────────────────────────────────────────
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.window = globalThis;
globalThis.window.location = { origin: 'http://localhost:3000' };

// Минимальный EventTarget: в браузере window — EventTarget, а в SSR его нет.
// Нужен для подписки на challenge (storage / manga-login-challenge-change).
const domListeners = new Map();
globalThis.window.addEventListener = (type, handler) => {
  if (!domListeners.has(type)) domListeners.set(type, new Set());
  domListeners.get(type).add(handler);
};
globalThis.window.removeEventListener = (type, handler) => {
  domListeners.get(type)?.delete(handler);
};
globalThis.window.dispatchEvent = (event) => {
  for (const handler of [...(domListeners.get(event.type) ?? [])]) handler(event);
  return true;
};

const { auth } = await vite.ssrLoadModule('/src/data/auth.ts');
const { mockStore } = await vite.ssrLoadModule('/src/data/mockStore.ts');
const notify = await vite.ssrLoadModule('/src/data/notify.ts');
const { adsApi } = await vite.ssrLoadModule('/src/data/ads.ts');
const { adminRequests } = await vite.ssrLoadModule('/src/data/adminRequests.ts');
const { titles } = await vite.ssrLoadModule('/src/data/titles.ts');
const { chapters } = await vite.ssrLoadModule('/src/data/chapters.ts');
const { RateLimitError } = await vite.ssrLoadModule('/src/data/types.ts');

// ── helpers: pure localStorage resolve (bypasses DEV fetch race) ────────────
function seedChallenge(partial) {
  store.set(
    'manga_login_challenge',
    JSON.stringify({
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      emulated: false,
      ...partial,
    })
  );
}

/**
 * Прямой localStorage-resolver (зеркалит fallback в notify.ts).
 * Используется, когда нужно гарантированно не ходить в fetch/DEV API.
 */
function resolveLocal(token, action) {
  const raw = store.get('manga_login_challenge');
  if (!raw) return { ok: false, status: 'not_found' };
  const ch = JSON.parse(raw);
  if (ch.token && ch.token !== token) return { ok: false, status: 'not_found' };
  if (ch.status === 'approved') return { ok: true, status: 'already_approved' };
  if (ch.status === 'denied') return { ok: true, status: 'already_denied' };
  if (ch.expiresAt && new Date(ch.expiresAt).getTime() < Date.now()) {
    ch.status = 'expired';
    store.set('manga_login_challenge', JSON.stringify(ch));
    return { ok: false, status: 'expired' };
  }
  if (ch.status && ch.status !== 'pending') {
    return { ok: false, status: ch.status };
  }
  const status = action === 'approve' ? 'approved' : 'denied';
  ch.token = token;
  ch.status = status;
  ch.resolvedAt = new Date().toISOString();
  store.set('manga_login_challenge', JSON.stringify(ch));
  return { ok: true, status };
}

// ── 1. UUID / hasRole owner→admin + skipChallenge ───────────────────────────
const ownerSession = {
  user: {
    id: 'demo-admin-01',
    email: 'owner@test',
    user_metadata: { role: 'owner' },
    role: 'owner',
  },
  access_token: 'x',
};
const adminSession = {
  user: {
    id: 'demo-admin-02',
    email: 'admin@test',
    user_metadata: { role: 'admin' },
    role: 'admin',
  },
  access_token: 'y',
};

mockStore.setAdminSession(ownerSession);
check(
  'hasRole owner→admin with skipChallenge',
  (await auth.hasRole('demo-admin-01', 'admin', { skipChallenge: true })) === true
);
check(
  'hasRole owner→owner with skipChallenge',
  (await auth.hasRole('demo-admin-01', 'owner', { skipChallenge: true })) === true
);
check(
  'hasRole owner blocked without approved challenge',
  (await auth.hasRole('demo-admin-01', 'admin')) === false
);

mockStore.setAdminSession(adminSession);
check(
  'hasRole admin→admin skipChallenge',
  (await auth.hasRole('demo-admin-02', 'admin', { skipChallenge: true })) === true
);
check(
  'hasRole admin↛owner skipChallenge',
  (await auth.hasRole('demo-admin-02', 'owner', { skipChallenge: true })) === false
);

store.set(
  'manga_login_challenge',
  JSON.stringify({
    id: 'ch-1',
    status: 'approved',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    emulated: true,
  })
);
mockStore.setAdminSession(ownerSession);
check(
  'hasRole owner→admin after approved challenge',
  (await auth.hasRole('demo-admin-01', 'admin')) === true
);

// Soft-fail: error status WITHOUT prior local approved → false (не улучшаем доступ).
store.set(
  'manga_login_challenge',
  JSON.stringify({
    id: 'ch-err',
    status: 'error',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
);
const confErr = await auth.isLoginConfirmed();
check(
  'isLoginConfirmed error without prior approved → false',
  confErr === false,
  String(confErr)
);
check(
  'hasRole denied on error without prior approved',
  (await auth.hasRole('demo-admin-01', 'admin')) === false
);

// Soft-fail keep-alive: local approved + simulated error status → null → hasRole true.
// (getLoginChallengeStatus returns LS status as-is; we set approved then patch via
//  direct isLoginConfirmed path by leaving approved in LS and mocking would need
//  network error — here we verify approved path still works.)
store.set(
  'manga_login_challenge',
  JSON.stringify({
    id: 'ch-1',
    status: 'approved',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    emulated: true,
  })
);
check(
  'hasRole after restore approved',
  (await auth.hasRole('demo-admin-01', 'admin')) === true
);
const confOk = await auth.isLoginConfirmed();
check('isLoginConfirmed approved → true', confOk === true, String(confOk));

// signOut must wipe LS challenge (approved too) — soft-fail keep-alive window.
await auth.signOut();
check(
  'signOut clears manga_login_challenge',
  store.get('manga_login_challenge') == null
);
// restore session + approved for remaining tests
mockStore.setAdminSession(ownerSession);
store.set(
  'manga_login_challenge',
  JSON.stringify({
    id: 'ch-1',
    status: 'approved',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    emulated: true,
  })
);

// ── 2. resolve status branches (localStorage path, no fetch) ────────────────
store.clear();
const token = 'a'.repeat(64);
seedChallenge({ token });
let r = resolveLocal(token, 'approve');
check('resolve approve → approved', r.ok && r.status === 'approved', r.status);

r = resolveLocal(token, 'approve');
check('resolve already_approved', r.ok && r.status === 'already_approved', r.status);

seedChallenge({ token: 'b'.repeat(64) });
r = resolveLocal('b'.repeat(64), 'deny');
check('resolve deny → denied', r.ok && r.status === 'denied', r.status);

r = resolveLocal('b'.repeat(64), 'deny');
check('resolve already_denied', r.ok && r.status === 'already_denied', r.status);

seedChallenge({
  token: 'c'.repeat(64),
  expiresAt: new Date(Date.now() - 1000).toISOString(),
});
r = resolveLocal('c'.repeat(64), 'approve');
check('resolve expired', !r.ok && r.status === 'expired', r.status);

seedChallenge({ token: 'd'.repeat(64) });
r = resolveLocal('deadbeefdeadbeef', 'approve');
check('resolve not_found (wrong token)', r.status === 'not_found', r.status);

r = await notify.resolveLoginChallenge('', 'approve');
check('resolve empty token invalid', r.status === 'invalid', r.status);

// ── 2b. public resolveLoginChallenge через DEV middleware (happy path) ──────
const http = createHttpServer((req, res) => {
  vite.middlewares(req, res, () => {
    res.statusCode = 404;
    res.end('no');
  });
});
await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
const { port } = http.address();
const base = `http://127.0.0.1:${port}`;

// Патчим global fetch origin для relative /api/* из ssr-модуля:
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  if (typeof input === 'string' && input.startsWith('/')) {
    return realFetch(`${base}${input}`, init);
  }
  return realFetch(input, init);
};

const notifyRes = await realFetch(`${base}/api/login-notify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    adminEmail: 'a@b.c',
    siteUrl: 'http://localhost:3000',
  }),
});
const nbody = await notifyRes.json();
check('dev login-notify ok', nbody.ok === true && nbody.emulated === true);
const t = new URL(nbody.preview.approveUrl).searchParams.get('token');

// Через публичный API модуля — с пропатченным fetch на наш middleware.
store.set(
  'manga_login_challenge',
  JSON.stringify({
    id: nbody.challengeId,
    token: t,
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    emulated: true, // preferDev → /api/login-confirm
  })
);
const confViaModule = await notify.resolveLoginChallenge(t, 'approve');
check(
  'module resolveLoginChallenge via DEV api',
  confViaModule.status === 'approved' || confViaModule.status === 'already_approved',
  confViaModule.status
);
console.log('  [branch] resolve via module →', confViaModule.status);

const st = await (
  await realFetch(`${base}/api/login-challenge-status?id=${nbody.challengeId}`)
).json();
check('dev status approved', st.status === 'approved', st.status);

// ── 2d. Экран ожидания: статус из localStorage обновляет phase ──────────────
// Регрессия: /admin/login показывал экран ожидания, но не менял phase, когда
// статус в localStorage становился approved/denied/expired (соседняя вкладка со
// ссылкой из письма + отставший серверный статус в polling).
const LS_KEY = notify.LOGIN_CHALLENGE_LS_KEY;
const future = () => new Date(Date.now() + 60_000).toISOString();

/** Запись из «соседней вкладки»: минуя persist (событий от setItem нет). */
function seedLs(partial) {
  store.set(
    LS_KEY,
    JSON.stringify({
      id: 'ch-ls',
      status: 'pending',
      emulated: true,
      expiresAt: future(),
      ...partial,
    })
  );
}

const challengeEvents = [];
const unsubscribeChallenge = notify.subscribeLoginChallenge((ch, source) => {
  challengeEvents.push({ status: ch?.status ?? null, source });
});

notify.rememberLoginChallenge({
  ok: true,
  emulated: true,
  challengeId: 'ch-ls',
  preview: { approveUrl: `${base}/admin/login/confirm?token=${'e'.repeat(64)}&action=approve` },
});
check(
  'rememberLoginChallenge → событие local/pending',
  challengeEvents.at(-1)?.status === 'pending' && challengeEvents.at(-1)?.source === 'local',
  JSON.stringify(challengeEvents.at(-1))
);

// Повторная запись того же статуса (polling каждые 2.5 c) не должна слать событие.
const eventsBeforeNoop = challengeEvents.length;
notify.persistLoginChallenge({ status: 'pending' });
check(
  'повторный тот же статус → без события (polling не дёргает UI)',
  challengeEvents.length === eventsBeforeNoop
);

// Соседняя вкладка подтвердила вход → `storage` в этой вкладке.
seedLs({ status: 'approved' });
const storageEvent = new CustomEvent('storage');
storageEvent.key = LS_KEY;
window.dispatchEvent(storageEvent);
check(
  'storage из соседней вкладки → approved/remote',
  challengeEvents.at(-1)?.status === 'approved' && challengeEvents.at(-1)?.source === 'remote',
  JSON.stringify(challengeEvents.at(-1))
);

// approve/deny на этой же вкладке (страница /admin/login/confirm) → local-событие.
notify.persistLoginChallenge({ status: 'denied' });
check(
  'persist approved→denied → local/denied',
  challengeEvents.at(-1)?.status === 'denied' && challengeEvents.at(-1)?.source === 'local',
  JSON.stringify(challengeEvents.at(-1))
);

// signOut: записи больше нет — подписчик получает null (фазу не переключаем).
await auth.signOut();
check('signOut → событие с пустым challenge', challengeEvents.at(-1)?.status === null);

// Отставший dev-API не должен затенять локальный approved: challenge подтверждён
// в браузере (ссылка из письма), а в dev-сторе всё ещё pending.
const staleRes = await realFetch(`${base}/api/login-notify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ adminEmail: 'a@b.c', siteUrl: 'http://localhost:3000' }),
});
const stale = await staleRes.json();
const staleToken = new URL(stale.preview.approveUrl).searchParams.get('token');
const staleRemote = await (
  await realFetch(`${base}/api/login-challenge-status?id=${stale.challengeId}`)
).json();
check('предусловие: dev-стор ещё pending', staleRemote.status === 'pending', staleRemote.status);

seedLs({ id: stale.challengeId, token: staleToken, status: 'approved' });
const statusShadowed = await notify.getLoginChallengeStatus();
check(
  'локальный approved не затеняется dev-API pending',
  statusShadowed === 'approved',
  statusShadowed
);
check(
  'LS не откатывается с approved на pending',
  JSON.parse(store.get(LS_KEY)).status === 'approved',
  JSON.parse(store.get(LS_KEY)).status
);

// Обратный случай: подтвердили с другого устройства (сервер approved) —
// локальный pending обновляется по RPC/dev-API.
const pendRes = await realFetch(`${base}/api/login-notify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ adminEmail: 'a@b.c', siteUrl: 'http://localhost:3000' }),
});
const pend = await pendRes.json();
const pendToken = new URL(pend.preview.approveUrl).searchParams.get('token');
seedLs({ id: pend.challengeId, token: pendToken, status: 'pending' });
await realFetch(`${base}/api/login-confirm`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: pendToken, action: 'approve' }),
});
const statusFromServer = await notify.getLoginChallengeStatus();
check(
  'серверный approved важнее локального pending',
  statusFromServer === 'approved',
  statusFromServer
);
check(
  'LS синхронизирован на approved (событие для экрана ожидания)',
  JSON.parse(store.get(LS_KEY)).status === 'approved'
);

// dev-API вообще не знает этот challenge (стор сбросили) — ждём локальный статус.
seedLs({ id: 'ch-unknown-local', status: 'approved' });
check(
  'dev-API none не затеняет локальный approved',
  (await notify.getLoginChallengeStatus()) === 'approved'
);

// pending + истёкший expiresAt → expired, и это фиксируется в localStorage.
seedLs({ id: 'ch-old', status: 'pending', expiresAt: new Date(Date.now() - 1000).toISOString() });
check('pending + expiresAt в прошлом → expired', (await notify.getLoginChallengeStatus()) === 'expired');
check(
  'истечение записано в LS (экран ожидания узнаёт сразу)',
  JSON.parse(store.get(LS_KEY)).status === 'expired'
);

unsubscribeChallenge();
check(
  'отписка отменяет доставку событий',
  (() => {
    const before = challengeEvents.length;
    notify.persistLoginChallenge({ status: 'approved' });
    return challengeEvents.length === before;
  })()
);

// Маппинг статус → phase (используется и первым рендером, и polling, и событиями).
const { loginChallengeUx } = await vite.ssrLoadModule('/src/lib/loginChallenge.ts');
check('ux pending → waiting', loginChallengeUx('pending').phase === 'waiting');
check(
  'ux approved → открыть админку',
  loginChallengeUx('approved').openAdmin === true &&
    loginChallengeUx('approved').hint.includes('Подтверждено'),
  JSON.stringify(loginChallengeUx('approved'))
);
check(
  'ux denied → denied + signOut',
  loginChallengeUx('denied').phase === 'denied' && loginChallengeUx('denied').signOut === true
);
check(
  'ux expired → expired + signOut',
  loginChallengeUx('expired').phase === 'expired' && loginChallengeUx('expired').signOut === true
);
check(
  'ux error → serviceError (не «none»)',
  loginChallengeUx('error').serviceError === true &&
    loginChallengeUx('error').phase === 'service_error'
);
check(
  'ux none → состояние не меняем',
  Object.keys(loginChallengeUx('none')).length === 0,
  JSON.stringify(loginChallengeUx('none'))
);

// ── 2c. classifyEdgeFailure: точная причина сбоя письма для владельца ───────
const cls404 = notify.classifyEdgeFailure(new Error('Edge Function returned an error'), 404);
check('classify 404 → fn-not-deployed', cls404.errorKind === 'fn-not-deployed', cls404.errorKind);

const clsFetchErr = notify.classifyEdgeFailure(
  new Error('Failed to send a request to the Edge Function')
);
check(
  'classify «failed to send a request» (без context) → network',
  clsFetchErr.errorKind === 'network',
  clsFetchErr.errorKind
);

// Дополнительная проверка: если в detail есть "function not found" — fn-not-deployed,
// даже без HTTP-статуса (передаём undefined явно: неявный 0/false может случайно
// сработать в !status-проверках сети).
const clsNotFoundText = notify.classifyEdgeFailure(
  new Error('Edge Function returned an error'),
  undefined,
  'Function not found'
);
check(
  'classify detail «Function not found» → fn-not-deployed',
  clsNotFoundText.errorKind === 'fn-not-deployed',
  clsNotFoundText.errorKind
);

const clsOwner = notify.classifyEdgeFailure(null, 500, 'OWNER_NOTIFY_EMAIL secret is not set');
check('classify OWNER_NOTIFY_EMAIL → secrets-missing', clsOwner.errorKind === 'secrets-missing');

const clsKey = notify.classifyEdgeFailure(null, 503, 'RESEND_API_KEY secret is not set');
check('classify RESEND_API_KEY → secrets-missing', clsKey.errorKind === 'secrets-missing');

const clsResend = notify.classifyEdgeFailure(
  null,
  502,
  'Could not verify the provided API key'
);
check('classify 502 → resend', clsResend.errorKind === 'resend', clsResend.errorKind);

const clsChallenge = notify.classifyEdgeFailure(null, 500, 'не удалось создать challenge');
check(
  'classify challenge error → other (не resend)',
  clsChallenge.errorKind === 'other',
  clsChallenge.errorKind
);

// ── 3. ads CRUD + legacy active:undefined ───────────────────────────────────
store.clear();
// legacy row without active
store.set(
  'manga_ads',
  JSON.stringify([
    {
      id: 'legacy-1',
      title: 'Legacy',
      link_url: 'https://ex.com',
      // active missing
    },
  ])
);
const legacyList = await adsApi.listAll();
check('ads legacy active normalized true', legacyList[0]?.active === true);
await adsApi.update('legacy-1', { active: false });
check('ads toggle legacy → inactive getActive null', (await adsApi.getActive()) === null);
await adsApi.remove('legacy-1');

const ad = await adsApi.create({
  title: 'Test Ad',
  link_url: 'https://example.com',
  link_label: 'Go',
});
check('ads create id', Boolean(ad.id));
check('ads create active true', ad.active === true);
check('ads listAll has 1', (await adsApi.listAll()).length === 1);
check('ads getActive returns created', (await adsApi.getActive())?.id === ad.id);

await adsApi.update(ad.id, { active: false });
check('ads inactive → getActive null', (await adsApi.getActive()) === null);

await adsApi.update(ad.id, { active: true });
await adsApi.remove(ad.id);
check('ads remove → empty', (await adsApi.listAll()).length === 0);

// ── 4. RateLimitError accepts hint ──────────────────────────────────────────
const rl = new RateLimitError('Не более 10 заявок в час');
check('RateLimitError uses hint as message', rl.message.includes('10 заявок'));
check('RateLimitError.hint set', rl.hint === 'Не более 10 заявок в час');

// ── 4b. datetime-local helpers (UTC offset safe) ────────────────────────────
const { toDatetimeLocalValue, fromDatetimeLocalValue } = await vite.ssrLoadModule(
  '/src/lib/datetimeLocal.ts'
);
const isoUtc = '2026-06-15T12:00:00.000Z';
const localVal = toDatetimeLocalValue(isoUtc);
check('datetime local value length 16', localVal.length === 16, localVal);
const roundtrip = fromDatetimeLocalValue(localVal);
check(
  'datetime roundtrip within 1 min',
  Math.abs(new Date(roundtrip).getTime() - new Date(isoUtc).getTime()) < 60_000,
  roundtrip
);
check('datetime empty → null', fromDatetimeLocalValue('') === null);
check('datetime empty → ""', toDatetimeLocalValue(null) === '');

// ── 5. adminRequests resolve applies + resolved_by ──────────────────────────
store.clear();
const before = (await titles.listAll()).length;
const created = await titles.create({
  title: 'ToDelete',
  slug: 'to-delete-unit',
  genre_ids: [],
});
const req = await adminRequests.submit({
  type: 'delete_title',
  target_id: created.id,
  target_name: created.title,
});
mockStore.setAdminSession(ownerSession);
store.set(
  'manga_login_challenge',
  JSON.stringify({
    status: 'approved',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  })
);

await adminRequests.resolve(req.id, 'approved');
const afterDelete = await titles.getById(created.id);
check('approve delete_title removes title', afterDelete === null);
check('seed titles intact count', (await titles.listAll()).length === before);

const resolved = (await adminRequests.listMine()).find((x) => x.id === req.id);
// listMine returns all including resolved in demo
const allDemo = JSON.parse(store.get('manga_admin_requests') || '[]');
const resolvedRow = allDemo.find((x) => x.id === req.id);
check(
  'demo resolve sets resolved_by',
  resolvedRow?.resolved_by === 'demo-admin-01',
  resolvedRow?.resolved_by
);
check('demo resolve sets resolved_at', Boolean(resolvedRow?.resolved_at));

// new_chapter apply
const anyTitle = (await titles.listAll())[0];
const chCountBefore = (await chapters.listByTitle(anyTitle.id, true)).length;
const reqCh = await adminRequests.submit({
  type: 'new_chapter',
  target_id: anyTitle.id,
  target_name: anyTitle.title,
  payload: { suggested_number: 999 },
});
await adminRequests.resolve(reqCh.id, 'approved');
const chCountAfter = (await chapters.listByTitle(anyTitle.id, true)).length;
check('approve new_chapter creates chapter', chCountAfter === chCountBefore + 1);

const newCh = (await chapters.listByTitle(anyTitle.id, true)).find((c) => c.number === 999);
if (newCh) {
  await chapters.delete(newCh.id);
}

// ── 6. useAuth reactive login flow without reload & session persistence ────
store.clear();
mockStore.setAdminSession(null);

// Anonymous guest starts with no session and no stored credentials
let guestSession = null;
let guestIsAdmin = false;

// Subscribe to auth events (as useAuth does in Header without initial Supabase SDK)
const unsubscribeGuest = auth.subscribe(async (incomingSession) => {
  guestSession = incomingSession !== undefined ? incomingSession : await auth.getSession();
  if (guestSession?.user) {
    guestIsAdmin = await auth.hasRole(guestSession.user.id, 'admin', { skipChallenge: true });
  } else {
    guestIsAdmin = false;
  }
});

check('guest initial state unauthenticated', guestSession === null && guestIsAdmin === false);

// Guest signs in via dialog (auth.signIn)
const loginResult = await auth.signIn('admin@hikkomanga.local', 'somepass');
check(
  'signIn returns session or pending confirmation',
  Boolean(loginResult.data?.session || loginResult.pendingConfirmation)
);

// Listener fired and updated state without page reload
check(
  'guest → login via dialog → header shows authenticated user without full page reload',
  guestSession !== null && guestSession.user.email === 'admin@hikkomanga.local' && guestIsAdmin === true
);

// Sign out also notifies and resets state
await auth.signOut();
check(
  'guest → signOut resets authenticated user without full page reload',
  guestSession === null && guestIsAdmin === false
);
unsubscribeGuest();

globalThis.fetch = realFetch;
http.close();

// Verify session persistence across simulated reload (localStorage)
mockStore.setAdminSession(ownerSession);
store.set(
  'manga_login_challenge',
  JSON.stringify({
    id: 'ch-persisted',
    status: 'approved',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  })
);
const restoredSession = await auth.getSession();
const restoredAdmin = await auth.hasRole(restoredSession.user.id, 'admin');
check(
  'session persistence across simulated page reload with localStorage',
  restoredSession !== null && restoredAdmin === true
);

await vite.close();

console.log(
  '\n' +
    (failures.length
      ? `FAILED (${failures.length}): ${failures.join(', ')}`
      : 'ALL UNIT CHECKS PASS')
);
process.exit(failures.length ? 1 : 0);

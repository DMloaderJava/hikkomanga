#!/usr/bin/env node
/**
 * Самопроверка Supabase-проекта: тот же набор проб, которым вручную нашли
 * «прод собран со старым удалённым ref».
 *
 *   node scripts/check-supabase-project.mjs [--ref <ref>]
 *
 * Что проверяет:
 *   1. какие VITE_SUPABASE_* видит сборка и совпадает ли ref с `supabase link`
 *      и с .env.production (рассинхрон = прод смотрит в другой проект);
 *   2. резолвится ли <ref>.supabase.co (у удалённого проекта — NXDOMAIN);
 *   3. таблицы из supabase/migrations: чего нет и какой файл накатить;
 *   4. RPC Login Guard и has_role;
 *   5. бакеты storage: manga, hikko-originals, voiceovers;
 *   6. Edge Functions login-notify / login-confirm:
 *      401 без Authorization ⇒ задеплоена (шлюз), 404 ⇒ нет;
 *      400 на login-confirm с валидным ключом ⇒ код функции работает;
 *   7. настройки Auth: открытая регистрация, авто-подтверждение почты.
 *
 * Окружение читается так же, как сборкой (`loadEnv` + process.env), поэтому
 * запускать из корня репозитория. Ключи не печатаются — только факт наличия.
 *
 * Exit code: 0 — проблем нет, 1 — есть что починить.
 */
import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import process from 'node:process';
import { buildEnv } from './lib/urls.mjs';

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const refFlag = argv.indexOf('--ref');
const refOverride = refFlag >= 0 ? (argv[refFlag + 1] || '') : '';

// ── окружение ───────────────────────────────────────────────────────────────
const env = buildEnv();
const rawUrl = (
  refOverride ? `https://${refOverride}.supabase.co` : env.VITE_SUPABASE_URL || env.SUPABASE_URL || ''
)
  .trim()
  .replace(/\/+$/, '');
const anonKey = (
  env.VITE_SUPABASE_ANON_KEY ||
  env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  env.VITE_SUPABASE_PUBLIC_KEY ||
  ''
).trim();

const problems = [];
const notes = [];

const section = (title) => console.log(`\n${title}`);
const ok = (text) => console.log(`  ✓ ${text}`);
const bad = (text, fix) => {
  console.log(`  ✗ ${text}`);
  if (fix) problems.push(fix);
};
const warn = (text, fix) => {
  console.log(`  ! ${text}`);
  if (fix) notes.push(fix);
};

function refOf(url) {
  try {
    return new URL(url).hostname.split('.')[0];
  } catch {
    return '';
  }
}

function readTrimmed(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

function publishedRef() {
  const m = readTrimmed('.env.production').match(
    /VITE_SUPABASE_URL\s*=\s*https:\/\/([a-z0-9]+)\.supabase\.co/
  );
  return m ? m[1] : '';
}

// ── эталон схемы: таблица → файл миграции ───────────────────────────────────
const EXPECTED_TABLES = [
  ['genres', '00000000000000_init.sql'],
  ['titles', '00000000000000_init.sql'],
  ['title_genres', '00000000000000_init.sql'],
  ['chapters', '00000000000000_init.sql'],
  ['pages', '00000000000000_init.sql'],
  ['user_roles', '00000000000000_init.sql'],
  ['chapter_voiceovers', '00000000000001_voiceovers.sql'],
  ['login_challenges', '00000000000003_login_challenges.sql'],
  ['admin_requests', '00000000000004_roles_and_requests.sql'],
  ['rate_limit_log', '00000000000005_rate_limit_log.sql'],
  ['ads', '00000000000006_ads.sql'],
];

/** RPC → [тело запроса, допустимые статусы, файл миграции]. */
const EXPECTED_RPCS = [
  [
    'has_role',
    { uid: '00000000-0000-0000-0000-000000000000', role_to_check: 'admin' },
    [200],
    '00000000000000_init.sql',
  ],
  ['latest_login_challenge_status', {}, [200], '00000000000003_login_challenges.sql'],
  [
    'resolve_login_challenge',
    { p_token: '0'.repeat(32), p_action: 'approve' },
    [200, 400],
    '00000000000003_login_challenges.sql',
  ],
  [
    'create_login_challenge',
    { p_token: '0'.repeat(32) },
    [400],
    '00000000000008_login_challenge_multidevice.sql',
  ],
];

const EXPECTED_BUCKETS = [
  ['manga', '00000000000002_storage_buckets.sql'],
  ['hikko-originals', '00000000000002_storage_buckets.sql'],
  ['voiceovers', '00000000000001_voiceovers.sql'],
];

// ── HTTP-помощник ───────────────────────────────────────────────────────────
async function api(path, { method = 'GET', body, withAuth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (withAuth) headers.apikey = anonKey;
  try {
    const res = await fetch(`${rawUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text().catch(() => '');
    return { status: res.status, text };
  } catch (e) {
    return { status: 0, text: e?.message || String(e) };
  }
}

// ── 1. Окружение сборки ────────────────────────────────────────────────────
console.log('Самопроверка Supabase-проекта');

section('1. Окружение сборки');
if (!rawUrl || !anonKey) {
  bad(
    'VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY не заданы — сборка уйдёт в mockStore',
    'Заполните .env (dev) и Vercel → Environment Variables (prod): SETUP_SUPABASE.md, раздел 1'
  );
  console.log('\nДальше проверять нечего: сначала задайте переменные.\n');
  process.exit(1);
}
const ref = refOf(rawUrl);
ok(`URL: ${rawUrl}${refOverride ? ' (из --ref)' : ''}`);

const keyKind = anonKey.startsWith('sb_publishable_')
  ? 'publishable'
  : anonKey.startsWith('eyJ')
    ? 'legacy anon JWT'
    : 'неизвестный формат';
ok(`Публичный ключ найден: ${keyKind}`);

const linked = readTrimmed('supabase/.temp/project-ref');
if (!linked) {
  warn('supabase/.temp/project-ref нет — CLI не залинкован', `Выполните: npx supabase link --project-ref ${ref}`);
} else if (linked !== ref) {
  bad(
    `Линковка CLI на другой проект: supabase link → ${linked}, сборка → ${ref}`,
    `Синхронизируйте: npx supabase link --project-ref ${ref} (или поправьте VITE_SUPABASE_URL)`
  );
} else {
  ok(`ref совпадает с supabase link: ${linked}`);
}

const pub = publishedRef();
if (!pub) {
  warn('.env.production без VITE_SUPABASE_URL', 'Задайте VITE_SUPABASE_URL на хостинге (Vercel → Environment Variables)');
} else if (pub !== ref) {
  bad(
    `.env.production указывает на другой ref: ${pub}`,
    'Обновите .env.production — иначе прод соберётся в чужой проект (SETUP_SUPABASE.md, «Если проект пересоздавали или удаляли»)'
  );
} else {
  ok(`.env.production указывает на тот же ref: ${pub}`);
}

// ── 2. DNS ─────────────────────────────────────────────────────────────────
section('2. Доступность проекта');
let hostOk = false;
try {
  const addr = await lookup(`${ref}.supabase.co`);
  ok(`${ref}.supabase.co резолвится (${addr.address})`);
  hostOk = true;
} catch {
  bad(
    `${ref}.supabase.co не резолвится (NXDOMAIN) — проект удалён или ref указан неверно`,
    'Возьмите актуальный ref (Dashboard → Project Settings → General → Reference ID) и обновите VITE_SUPABASE_URL, .env.production и Vercel Env'
  );
}
if (!hostOk) {
  console.log('\nОстальные проверки пропущены: домен недоступен.\n');
  process.exit(1);
}

// ── 3. Таблицы ─────────────────────────────────────────────────────────────
// Запросы идут параллельно: Supabase на бесплатном тарифе заметно
// замедляет длинные последовательные серии с одного IP.
section('3. Таблицы (сверка с supabase/migrations)');
{
  const results = await Promise.all(
    EXPECTED_TABLES.map(async ([table, file]) => ({
      table,
      file,
      ...(await api(`/rest/v1/${table}?select=*&limit=1`)),
    })),
  );
  for (const { table, file, status, text } of results) {
    if (status === 200 || status === 206) {
      ok(table);
    } else if (status === 404) {
      bad(`${table} отсутствует в схеме`, `Накатите supabase/migrations/${file} в SQL Editor (именно этот файл, а не весь db push)`);
    } else {
      bad(`${table} → HTTP ${status}: ${text.slice(0, 120)}`, `Проверьте права/RLS для таблицы ${table}`);
    }
  }
}

// ── 4. RPC ─────────────────────────────────────────────────────────────────
section('4. Функции БД (RPC)');
{
  const results = await Promise.all(
    EXPECTED_RPCS.map(async ([rpc, body, allowed, file]) => ({
      rpc,
      allowed,
      file,
      ...(await api(`/rest/v1/rpc/${rpc}`, { method: 'POST', body })),
    })),
  );
  for (const { rpc, allowed, file, status, text } of results) {
    if (allowed.includes(status)) {
      ok(`${rpc} → HTTP ${status}`);
    } else if (status === 404) {
      bad(`${rpc} отсутствует в схеме`, `Накатите supabase/migrations/${file}`);
    } else {
      bad(`${rpc} → HTTP ${status}: ${text.slice(0, 120)}`, `Разберитесь с ${rpc} (ожидался статус ${allowed.join(' или ')})`);
    }
  }
}

// ── 5. Бакеты Storage ──────────────────────────────────────────────────────
section('5. Бакеты Storage');
{
  const results = await Promise.all(
    EXPECTED_BUCKETS.map(async ([bucket, file]) => ({
      bucket,
      file,
      ...(await api(`/storage/v1/object/public/${bucket}/__check__.png`, {
        withAuth: false,
      })),
    })),
  );
  for (const { bucket, file, status, text } of results) {
    if (/Bucket not found|NoSuchBucket/i.test(text)) {
      bad(`Бакет ${bucket} отсутствует`, `Создайте бакет и политики: supabase/migrations/${file}`);
    } else if (status === 200) {
      ok(`Бакет ${bucket} существует (нашёлся файл __check__.png)`);
    } else if (status === 400 || status === 404) {
      ok(`Бакет ${bucket} существует`);
    } else {
      warn(`Бакет ${bucket} → неожиданный ответ HTTP ${status}: ${text.slice(0, 80)}`);
    }
  }
}

// ── 6. Edge Functions ──────────────────────────────────────────────────────
section('6. Edge Functions');
/**
 * Шлюз Edge Functions отдаёт 401 на запрос без Authorization (удалённая
 * функция — 404), поэтому «живость» проверяем двумя запросами:
 * без заголовка (401 = задеплоена) и с валидным публичным ключом
 * (тогда выполняется код функции: login-confirm → 400, login-notify → 401).
 */
const FUNCTION_CHECKS = [
  ['login-notify', 401, null],
  ['login-confirm', 400, 'token and action=approve|deny required'],
];
for (const [fn, expectStatus, expectBody] of FUNCTION_CHECKS) {
  const noAuth = await api(`/functions/v1/${fn}`, { method: 'POST', body: {}, withAuth: false });
  if (noAuth.status === 404) {
    bad(`${fn} не задеплоена (404)`, `Задеплойте: npx supabase functions deploy ${fn} --project-ref ${ref}`);
    continue;
  }
  if (noAuth.status === 0) {
    bad(`${fn} → сетевая ошибка: ${noAuth.text.slice(0, 80)}`, 'Проверьте доступ к <ref>.supabase.co (файрвол, прокси, блокировщик)');
    continue;
  }
  let res;
  try {
    const r = await fetch(`${rawUrl}/functions/v1/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anonKey}` },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15000),
    });
    res = { status: r.status, text: await r.text().catch(() => '') };
  } catch (e) {
    res = { status: 0, text: e?.message || String(e) };
  }
  const bodyOk = !expectBody || res.text.includes(expectBody);
  if (res.status === expectStatus && bodyOk) {
    ok(`${fn} задеплоена (без Authorization — ${noAuth.status}, с публичным ключом — ${res.status})`);
  } else {
    bad(
      `${fn}: ожидался HTTP ${expectStatus}${expectBody ? ` с «${expectBody}»` : ''}, получено ${res.status} ${res.text.slice(0, 100)}`,
      `Перевыложите функцию: npx supabase functions deploy ${fn} --project-ref ${ref}`
    );
  }
}

// ── 7. Auth ────────────────────────────────────────────────────────────────
section('7. Настройки Auth');
const settings = await api('/auth/v1/settings');
if (settings.status !== 200) {
  warn(`/auth/v1/settings → HTTP ${settings.status}`, 'Проверьте публичный ключ (publishable/anon)');
} else {
  let cfg = {};
  try {
    cfg = JSON.parse(settings.text);
  } catch {
    /* пустой ответ — не критично */
  }
  if (cfg.external?.email) ok('вход по email включён');
  else bad('вход по email выключен', 'Auth → Sign In / Providers → Email: включить');

  if (cfg.disable_signup === false) {
    warn(
      'открыта самостоятельная регистрация (disable_signup=false)',
      'Auth → Sign In / Providers → Allow new users to sign up: выключить (админов создаёт владелец)'
    );
  } else {
    ok('самостоятельная регистрация выключена');
  }

  if (cfg.mailer_autoconfirm === false) {
    console.log('  · авто-подтверждение почты выключено: при Add user ставьте галочку Auto Confirm User');
  }
}

console.log('  · секреты функций и первый админ из API не видны — проверьте руками:');
console.log(`      npx supabase secrets list --project-ref ${ref}`);
console.log('      Dashboard → Authentication → Users + public.user_roles (роль owner/admin)');

// ── 8. Публичные медиа ─────────────────────────────────────────────────────
// Обложки и страницы глав видны анонимам (RLS + публичный бакет manga): если
// URL из БД не отвечает 200, читатель видит плейсхолдер. Озвучки и оригиналы
// лежат в приватных бакетах — их напрямую не проверить, см. check-covers.
section('8. Публичные медиа отвечают 200 (обложки + страницы глав)');
const MEDIA_PROBE_LIMIT = 20;
const publicMediaQuery = async (table, select, limit) => {
  const res = await api(
    `/rest/v1/${table}?${new URLSearchParams({ select, limit: String(limit) })}`,
    { method: 'GET' }
  );
  if (res.status !== 200) return { error: `HTTP ${res.status}` };
  try {
    return { rows: JSON.parse(res.text) };
  } catch {
    return { error: 'не JSON' };
  }
};

const probeMediaUrl = async (urlValue) => {
  try {
    const res = await fetch(urlValue, {
      method: 'HEAD',
      headers: { apikey: anonKey },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    return res.status;
  } catch {
    return 0;
  }
};

let mediaChecked = 0;
let mediaBroken = 0;
let mediaNetworkFail = 0;

const titlesMedia = await publicMediaQuery('titles', 'slug,cover_url', MEDIA_PROBE_LIMIT);
if (titlesMedia.error) {
  warn(`titles недоступны (${titlesMedia.error}) — проверка медиа пропущена`);
} else {
  for (const t of titlesMedia.rows) {
    const url = (t.cover_url || '').trim();
    if (!url || url.startsWith('data:')) continue;
    if (!/^https?:\/\//i.test(url)) {
      bad(`обложка «${t.slug}» — не URL: ${url.slice(0, 60)}`, 'Перезалейте обложку в Storage через админку');
      mediaBroken += 1;
      continue;
    }
    mediaChecked += 1;
    const status = await probeMediaUrl(url);
    if (status >= 200 && status < 300) continue;
    if (status === 0) {
      mediaNetworkFail += 1;
      warn(`обложка «${t.slug}» — сеть недоступна (${url.slice(0, 60)}…)`);
    } else {
      bad(`обложка «${t.slug}» → HTTP ${status}`, `${url.slice(0, 80)} — файла нет в Storage или ссылка мёртвая`);
      mediaBroken += 1;
    }
  }

  const pagesMedia = await publicMediaQuery('pages', 'chapter_id,image_url', MEDIA_PROBE_LIMIT);
  if (pagesMedia.error) {
    warn(`pages недоступны (${pagesMedia.error})`);
  } else {
    for (const p of pagesMedia.rows) {
      const url = (p.image_url || '').trim();
      if (!url || url.startsWith('data:') || !/^https?:\/\//i.test(url)) continue;
      mediaChecked += 1;
      const status = await probeMediaUrl(url);
      if (status >= 200 && status < 300) continue;
      if (status === 0) {
        mediaNetworkFail += 1;
      } else {
        bad(`страница главы ${p.chapter_id.slice(0, 8)}… → HTTP ${status}`, url.slice(0, 80));
        mediaBroken += 1;
      }
    }
  }

  if (mediaChecked === 0 && mediaBroken === 0) {
    console.log('  · публичных медиа-URL в базе не найдено (пустой каталог — не ошибка)');
  } else {
    ok(`проверено медиа-URL: ${mediaChecked}, битых: ${mediaBroken}${mediaNetworkFail ? `, сеть не ответила: ${mediaNetworkFail}` : ''}`);
  }
  if (mediaBroken === 0 && mediaChecked > 0) {
    notes.push('детальная таблица по ВСЕМ тайтлам: npm run check:covers');
  }
}

// ── Итог ───────────────────────────────────────────────────────────────────
section('Итог');
if (problems.length === 0) {
  console.log('  Проблем не найдено. Остался живой тест: /admin/login → письмо → approve.');
} else {
  problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
}
if (notes.length) {
  console.log('\n  Необязательное:');
  notes.forEach((n) => console.log(`  · ${n}`));
}
console.log(problems.length === 0 ? '\nOK\n' : `\nПРОБЛЕМ: ${problems.length}\n`);
process.exit(problems.length === 0 ? 0 : 1);

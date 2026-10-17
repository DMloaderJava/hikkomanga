#!/usr/bin/env node
/**
 * Перенос контента Hikkomanga из одного Supabase-проекта в другой.
 *
 * Зачем: переезд на новый проект (например, у старого больше нет доступа) —
 * схему создаёт supabase/bootstrap.sql, а контент и файлы переносит этот скрипт.
 * Он рассчитан на запуск с ЛОКАЛЬНОЙ машины (из корня репозитория), потому что
 * работает с REST API обоих проектов. Ключи держите в файле `.env.migrate`
 * (он подпадает под `.env.*` из .gitignore и не уедет в git):
 *
 *   # .env.migrate
 *   OLD_SUPABASE_URL=https://<старый>.supabase.co
 *   OLD_SUPABASE_KEY=<service_role старого, либо anon/publishable>
 *   NEW_SUPABASE_URL=https://<новый>.supabase.co
 *   NEW_SUPABASE_KEY=<service_role нового>
 *
 *   node --env-file=.env.migrate scripts/migrate-supabase-project.mjs --dry-run
 *
 * Пошаговый runbook переезда (схема → админ → контент → секреты → фронтенд):
 * docs/migrate-project.md.
 *
 * Флаги:
 *   --dry-run           ничего не записывать: только прочитать старое,
 *                       посчитать строки/файлы и показать план;
 *   --skip-storage      не копировать файлы (только строки в БД);
 *   --include-requests  перенести историю заявок admin_requests (по умолчанию нет);
 *   --include-originals перенести ещё и оригиналы страниц (приватный бакет
 *                       hikko-originals; нужен service_role старого проекта);
 *   --limit=N           взять только первые N строк каждой таблицы (пробный прогон).
 *
 * Что переносится: genres, titles, title_genres, chapters, pages,
 * chapter_voiceovers, ads + файлы Storage, на которые они ссылаются
 * (manga, title-covers, voiceovers [+ submissions при --include-requests]).
 * Ссылки на медиа переписываются со старого ref на новый.
 *
 * Что НЕ переносится (настраивается руками в новом проекте):
 *   • auth.users — админа создайте заново (Authentication → Users → Add user),
 *     затем `insert into public.user_roles (user_id, role) values ('<uid>', 'owner');`
 *   • user_api_keys — шифруются секретом USER_KEY_ENC_SECRET, ключи Gemini
 *     введите заново в /admin/settings;
 *   • login_challenges / ip_rate_limit / rate_limit_log — эфемерные;
 *   • секреты Edge Functions (RESEND_API_KEY и т.д.) — задаются заново.
 *
 * Скрипт идемпотентен: повторный запуск обновляет существующие строки
 * (upsert по первичному ключу) и пропускает уже скопированные файлы.
 * Ключи никогда не печатаются.
 */
import { readFileSync } from 'node:fs';

// ── аргументы ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(
    [
      'Перенос контента между Supabase-проектами.',
      '',
      'Переменные окружения (обязательные):',
      '  OLD_SUPABASE_URL, OLD_SUPABASE_KEY   — откуда читаем (service_role предпочтительно)',
      '  NEW_SUPABASE_URL, NEW_SUPABASE_KEY   — куда пишем (нужен service_role)',
      '',
      'Флаги: --dry-run | --skip-storage | --include-requests | --include-originals | --limit=N',
      '',
      'Пример (ключи — в файле .env.migrate, он git-ignored):',
      '  node --env-file=.env.migrate scripts/migrate-supabase-project.mjs --dry-run',
      '',
      'Пошаговый runbook: docs/migrate-project.md',
      'Ключи не передавайте в переписке: service_role обходит RLS целиком.',
    ].join('\n')
  );
  process.exit(0);
}

const DRY_RUN = argv.includes('--dry-run');
const SKIP_STORAGE = argv.includes('--skip-storage');
const INCLUDE_REQUESTS = argv.includes('--include-requests');
const INCLUDE_ORIGINALS = argv.includes('--include-originals');
const limitArg = argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) || 0 : 0;

const oldUrl = (process.env.OLD_SUPABASE_URL || '').replace(/\/+$/, '');
const oldKey = (process.env.OLD_SUPABASE_KEY || '').trim();
const newUrl = (process.env.NEW_SUPABASE_URL || '').replace(/\/+$/, '');
const newKey = (process.env.NEW_SUPABASE_KEY || '').trim();

const missing = [
  !oldUrl && 'OLD_SUPABASE_URL',
  !oldKey && 'OLD_SUPABASE_KEY',
  !newUrl && 'NEW_SUPABASE_URL',
  !newKey && 'NEW_SUPABASE_KEY',
].filter(Boolean);
if (missing.length) {
  console.error(`Не заданы переменные окружения: ${missing.join(', ')}`);
  console.error('Подсказка: node scripts/migrate-supabase-project.mjs --help');
  process.exit(1);
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
};
const oldHost = hostOf(oldUrl);
const newHost = hostOf(newUrl);
if (!oldHost || !newHost) {
  console.error('OLD_SUPABASE_URL / NEW_SUPABASE_URL должны быть вида https://<ref>.supabase.co');
  process.exit(1);
}
if (oldHost === newHost) {
  console.error('Старый и новый проект совпадают — переносить нечего.');
  process.exit(1);
}

// ── HTTP-хелперы ───────────────────────────────────────────────────────────
const PAGE_SIZE = 1000; // дефолтный лимит PostgREST

async function req(side, path, { method = 'GET', body, headers = {}, timeoutMs = 60_000 } = {}) {
  const base = side === 'new' ? newUrl : oldUrl;
  const key = side === 'new' ? newKey : oldKey;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => '');
  return { status: res.status, text };
}

/** Все строки таблицы (через Range-пагинацию). */
async function fetchAll(side, table, select = '*') {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    if (LIMIT && rows.length >= LIMIT) break;
    const res = await req(side, `/rest/v1/${table}?select=${encodeURIComponent(select)}`, {
      headers: { Range: `${offset}-${offset + PAGE_SIZE - 1}` },
    });
    if (res.status !== 200 && res.status !== 206) {
      throw new Error(`чтение ${table}: HTTP ${res.status} ${res.text.slice(0, 200)}`);
    }
    let batch;
    try {
      batch = JSON.parse(res.text);
    } catch {
      throw new Error(`чтение ${table}: ответ не JSON: ${res.text.slice(0, 120)}`);
    }
    if (!Array.isArray(batch)) throw new Error(`чтение ${table}: ожидался массив строк`);
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return LIMIT ? rows.slice(0, LIMIT) : rows;
}

/** Upsert пачками: id сохраняются, повторный запуск не плодит дубли (merge по PK). */
async function upsert(side, table, rows, { batch = 200 } = {}) {
  let done = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const res = await req(side, `/rest/v1/${table}`, {
      method: 'POST',
      body: chunk,
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    });
    if (res.status !== 201 && res.status !== 200 && res.status !== 204) {
      throw new Error(
        `запись ${table} (строки ${i}–${i + chunk.length - 1}): HTTP ${res.status} ${res.text.slice(0, 300)}`
      );
    }
    done += chunk.length;
  }
  return done;
}

// ── что переносим ──────────────────────────────────────────────────────────
// Порядок важен: FK (titles до chapters, genres до title_genres...).
const TABLES = [
  { name: 'genres', fields: [] },
  { name: 'titles', fields: ['cover_url'] },
  { name: 'title_genres', fields: [] },
  { name: 'chapters', fields: [] },
  { name: 'pages', fields: ['image_url', 'original_url'] },
  { name: 'chapter_voiceovers', fields: ['audio_url'] },
  { name: 'ads', fields: ['image_url'] },
];
if (INCLUDE_REQUESTS) TABLES.push({ name: 'admin_requests', fields: [] });

/** URL медиа: //<старый-хост>/ → //<новый-хост>/ (bare paths и data: не трогаем). */
function rewriteMediaUrls(row, fields) {
  const out = { ...row };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === 'string' && v.includes(oldHost)) {
      out[f] = v.split(oldHost).join(newHost);
    }
  }
  return out;
}

/** {bucket, path} из публичного URL Storage. */
function objectFromUrl(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/\/storage\/v1\/object\/(?:public\/)?([^/]+)\/(.+)$/);
  if (!m) return null;
  const path = m[2].split('?')[0];
  if (!path) return null;
  return { bucket: m[1], path };
}

// ── Storage ────────────────────────────────────────────────────────────────
async function objectExists(bucket, path) {
  const res = await fetch(`${newUrl}/storage/v1/object/${bucket}/${encodeURI(path)}`, {
    method: 'HEAD',
    headers: { apikey: newKey, Authorization: `Bearer ${newKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  return res.status === 200;
}

/** Скачивание из старого проекта: сначала публичный путь, потом через API (service_role). */
async function downloadObject(bucket, path) {
  const publicRes = await fetch(
    `${oldUrl}/storage/v1/object/public/${bucket}/${encodeURI(path)}`,
    { signal: AbortSignal.timeout(120_000) }
  );
  if (publicRes.status === 200) {
    return { buffer: Buffer.from(await publicRes.arrayBuffer()), type: publicRes.headers.get('content-type') || 'application/octet-stream' };
  }
  const authRes = await fetch(`${oldUrl}/storage/v1/object/${bucket}/${encodeURI(path)}`, {
    headers: { apikey: oldKey, Authorization: `Bearer ${oldKey}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (authRes.status === 200) {
    return { buffer: Buffer.from(await authRes.arrayBuffer()), type: authRes.headers.get('content-type') || 'application/octet-stream' };
  }
  return null;
}

async function uploadObject(bucket, path, buffer, contentType) {
  const res = await fetch(`${newUrl}/storage/v1/object/${bucket}/${encodeURI(path)}`, {
    method: 'POST',
    headers: {
      apikey: newKey,
      Authorization: `Bearer ${newKey}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
      'cache-control': 'max-age=31536000',
    },
    body: buffer,
    signal: AbortSignal.timeout(180_000),
  });
  if (res.status !== 200 && res.status !== 201) {
    const text = await res.text().catch(() => '');
    throw new Error(`загрузка ${bucket}/${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
}

/** Пул воркеров: копируем файлы, не вычерпывая соединения. */
async function runPool(items, workers, worker) {
  const queue = [...items];
  const results = { ok: 0, skipped: 0, failed: 0 };
  const errors = [];
  await Promise.all(
    Array.from({ length: Math.min(workers, queue.length) }, async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) break;
        try {
          const r = await worker(item);
          results[r] += 1;
        } catch (e) {
          results.failed += 1;
          if (errors.length < 10) errors.push(e instanceof Error ? e.message : String(e));
        }
      }
    })
  );
  return { ...results, errors };
}

// ── основной сценарий ──────────────────────────────────────────────────────
const started = Date.now();
console.log(`\nПеренос контента${DRY_RUN ? ' (dry-run, без записи)' : ''}`);
console.log(`  откуда: ${oldHost}`);
console.log(`  куда:   ${newHost}`);
console.log(`  storage: ${SKIP_STORAGE ? 'не копировать (--skip-storage)' : 'копировать'}`);
console.log(`  заявки admin_requests: ${INCLUDE_REQUESTS ? 'переносим' : 'не переносим (--include-requests чтобы включить)'}${LIMIT ? `\n  лимит строк на таблицу: ${LIMIT}` : ''}\n`);

// 0. Проверка, что в новом проекте накатана схема.
if (!DRY_RUN) {
  const probe = await req('new', '/rest/v1/titles?select=id&limit=1');
  if (probe.status >= 400) {
    console.error(
      `Новый проект не отвечает на titles (HTTP ${probe.status}: ${probe.text.slice(0, 160)}).\n` +
        'Сначала накатите схему: supabase/bootstrap.sql в SQL Editor нового проекта\n' +
        '(см. docs/migrate-project.md, шаг 2).'
    );
    process.exit(1);
  }
}

// 1. Чтение + перезапись ссылок.
const collected = {};
const rowsByTable = {};
let totalRows = 0;
for (const t of TABLES) {
  let rows = await fetchAll('old', t.name);
  rows = rows.map((r) => rewriteMediaUrls(r, t.fields));
  rowsByTable[t.name] = rows;
  collected[t.name] = rows.length;
  totalRows += rows.length;
  console.log(`  прочитано ${t.name}: ${rows.length}`);
}

// 2. Запись строк.
if (!DRY_RUN) {
  console.log('');
  for (const t of TABLES) {
    const rows = rowsByTable[t.name];
    if (!rows.length) continue;
    try {
      const written = await upsert('new', t.name, rows);
      console.log(`  ✓ записано ${t.name}: ${written}`);
    } catch (e) {
      console.error(`  ✗ ${e instanceof Error ? e.message : e}`);
      process.exitCode = 1;
    }
  }
}

// 3. Файлы Storage, на которые ссылаются перенесённые строки.
if (!SKIP_STORAGE) {
  const seen = new Set();
  const objects = [];
  for (const t of TABLES) {
    for (const row of rowsByTable[t.name] || []) {
      for (const f of t.fields) {
        let obj = objectFromUrl(row[f]);
        // original_url — голый путь в ПРИВАТНОМ бакете hikko-originals; качаем
        // только по явному запросу: для приватного бакета нужен service_role
        // старого проекта.
        if (!obj && f === 'original_url' && INCLUDE_ORIGINALS) {
          const v = row[f];
          if (typeof v === 'string' && v && !v.includes('://') && v.includes('/')) {
            obj = { bucket: 'hikko-originals', path: v };
          }
        }
        if (!obj) continue;
        const id = `${obj.bucket}/${obj.path}`;
        if (seen.has(id)) continue;
        seen.add(id);
        objects.push(obj);
      }
    }
  }
  console.log(`\n  файлов Storage к переносу: ${objects.length}`);
  if (DRY_RUN) {
    const byBucket = objects.reduce((acc, o) => ((acc[o.bucket] = (acc[o.bucket] || 0) + 1), acc), {});
    for (const [b, n] of Object.entries(byBucket)) console.log(`    ${b}: ${n}`);
  } else if (objects.length) {
    let processed = 0;
    const res = await runPool(objects, 5, async (o) => {
      processed += 1;
      if (processed % 25 === 0) console.log(`    … ${processed}/${objects.length}`);
      if (await objectExists(o.bucket, o.path)) return 'skipped';
      const file = await downloadObject(o.bucket, o.path);
      if (!file) throw new Error(`не удалось скачать ${o.bucket}/${o.path} (нет доступа у старого ключа?)`);
      await uploadObject(o.bucket, o.path, file.buffer, file.type);
      return 'ok';
    });
    console.log(`  ✓ скопировано файлов: ${res.ok}, уже было: ${res.skipped}, ошибок: ${res.failed}`);
    for (const e of res.errors) console.error(`    ✗ ${e}`);
    if (res.failed) process.exitCode = 1;
  }
}

// 4. Сводка.
const seconds = Math.round((Date.now() - started) / 1000);
console.log(`\nИтого за ${seconds} c:`);
for (const [table, n] of Object.entries(collected)) {
  console.log(`  ${table}: ${n}${DRY_RUN ? ' (будет записано)' : ''}`);
}
if (DRY_RUN) {
  console.log('\nЭто был dry-run — ничего не изменено. Уберите --dry-run, чтобы перенести.');
} else {
  console.log(
    [
      '',
      'Дальше (docs/migrate-project.md, шаги 3–6):',
      '  1. создать админа в новом проекте + user_roles(role=owner);',
      '  2. задать секреты Edge Functions и задеплоить функции;',
      '  3. обновить .env.production / Vercel env на новый ref и пересобрать сайт;',
      '  4. npm run check:supabase — разделы 3–5 без ✗.',
    ].join('\n')
  );
}
console.log('');

#!/usr/bin/env node
/**
 * Диагностика обложек тайтлов (и опционально страниц глав) на живой базе.
 *
 *   node scripts/check-covers.mjs [опции]
 *
 * Опции:
 *   --limit N     сколько тайтлов проверять (по умолчанию 100)
 *   --pages       дополнительно проверить страницы глав (pages.image_url, до 30)
 *   --timeout ms  таймаут одного запроса (по умолчанию 10000)
 *   --json        вывести итог JSON-ом (для CI)
 *
 * Переменные берутся как при сборке: .env / .env.production + process.env
 * (VITE_SUPABASE_URL + ключ). Анонимного ключа достаточно: RLS отдаёт только
 * опубликованные тайтлы — именно их и видят читатели.
 *
 * Проверяется каждый cover_url / image_url:
 *   пустой | data:URL | локальный /media | Supabase Storage | внешний домен (CSP его режет!)
 * Доступные по сети URL пробуются HEAD-запросом (fallback GET+Range, если 405).
 *
 * Коды выхода:
 *   0 — битых нет; 1 — есть битые URL; 2 — проверка не состоялась
 *   (не заданы переменные Supabase или база/сеть недоступны целиком).
 */
import { buildEnv } from './lib/urls.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const numArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && Number.isFinite(Number(args[i + 1])) ? Number(args[i + 1]) : def;
};

const LIMIT = Math.max(1, numArg('--limit', 100));
const PAGES_LIMIT = 30;
const CHECK_PAGES = flag('--pages');
const TIMEOUT_MS = Math.max(1000, numArg('--timeout', 10000));
const AS_JSON = flag('--json');

/** Хосты, которые пропускает CSP продакшена (vercel.json → img-src). */
const CSP_HOST_SUFFIXES = ['.supabase.co', '.supabase.in'];

const env = buildEnv();
const rawUrl = (env.VITE_SUPABASE_URL || '').trim().replace(/\/+$/, '');
const anonKey =
  env.VITE_SUPABASE_ANON_KEY ||
  env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  env.VITE_SUPABASE_PUBLIC_KEY ||
  '';

const out = (...a) => (AS_JSON ? null : console.log(...a));

/** Классификация URL без сети. */
function classify(rawUrlValue) {
  const value = typeof rawUrlValue === 'string' ? rawUrlValue.trim() : '';
  if (!value) return { kind: 'empty', label: 'ПУСТО' };
  if (value.startsWith('data:')) return { kind: 'data', label: 'DATA-URL' };
  if (/^https?:\/\//i.test(value)) {
    let host = '';
    try {
      host = new URL(value).host.toLowerCase();
    } catch {
      return { kind: 'malformed', label: 'БИТЫЙ-URL' };
    }
    if (value.startsWith('http://')) return { kind: 'insecure', label: 'HTTP(небезопасно)', host };
    if (CSP_HOST_SUFFIXES.some((s) => host.endsWith(s))) return { kind: 'supabase', label: 'SUPABASE', host };
    return { kind: 'external', label: 'ВНЕШНИЙ(CSP-режет)', host };
  }
  if (value.startsWith('/')) return { kind: 'local', label: 'ЛОКАЛЬНЫЙ' };
  // Голый путь бакета без схемы — storage.ts так не пишет, но в БД может лежать.
  return { kind: 'bare-path', label: 'ПУТЬ-БЕЗ-СХЕМЫ' };
}

/** HEAD → статус; при 405 — GET с Range: bytes=0-0. Возвращает { status, type, size } */
async function probe(urlValue) {
  const doFetch = (method, extraHeaders) =>
    fetch(urlValue, {
      method,
      headers: { apikey: anonKey, ...extraHeaders },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  try {
    let res = await doFetch('HEAD');
    if (res.status === 405 || res.status === 501) {
      res = await doFetch('GET', { Range: 'bytes=0-0' });
    }
    const type = res.headers.get('content-type') || '';
    const lenHeader = res.headers.get('content-length');
    const range = res.headers.get('content-range'); // "bytes 0-0/12345"
    const size = range ? Number(range.split('/')[1]) : lenHeader ? Number(lenHeader) : null;
    return { status: res.status, type, size: Number.isFinite(size) ? size : null };
  } catch (e) {
    return { status: 0, error: e?.message || String(e) };
  }
}

async function fetchRows(table, select, limit) {
  const qs = new URLSearchParams({ select, limit: String(limit) });
  try {
    const res = await fetch(`${rawUrl}/rest/v1/${table}?${qs}`, {
      headers: { apikey: anonKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { rows: await res.json() };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

function shortUrl(u, max = 64) {
  return u.length > max ? `${u.slice(0, max - 1)}…` : u;
}

// ── Основной поток ───────────────────────────────────────────────────────────

if (!rawUrl || !anonKey) {
  console.error(
    'check-covers: VITE_SUPABASE_URL / ключ не заданы — проверять нечего.\n' +
      'Задайте их в .env или окружении CI (как для сборки, см. SETUP_SUPABASE.md §1).'
  );
  process.exit(2);
}

out(`\n=== Проверка обложек тайтлов (${rawUrl}) ===\n`);
out('slug'.padEnd(32), 'ТИП'.padEnd(20), 'СТАТУС'.padEnd(9), 'TYPE/SIZE'.padEnd(22), 'URL');
out('-'.repeat(140));

const result = { checked: 0, problems: [], skipped: 0, unreachableAll: true, items: [] };
/** Проблемы, из-за которых проверка не состоялась (сеть/доступ), а не битые данные. */
let infraFailures = 0;

async function checkRow(kind, slugOrId, urlValue) {
  result.checked += 1;
  const c = classify(urlValue);
  let status = '-';
  let extra = '';
  let verdict = 'OK';

  if (c.kind === 'empty') {
    verdict = 'SKIP';
    result.skipped += 1;
  } else if (c.kind === 'data') {
    verdict = 'WARN';
    extra = 'демо-данные в реальной базе?';
    result.problems.push({ kind, slug: slugOrId, url: shortUrl(urlValue, 120), verdict, note: extra });
  } else if (c.kind === 'bare-path' || c.kind === 'malformed') {
    verdict = 'BROKEN';
    infraFailures += 0; // это битые данные, а не сеть
    result.problems.push({ kind, slug: slugOrId, url: shortUrl(urlValue, 120), verdict, note: 'не является URL' });
  } else if (c.kind === 'insecure' || c.kind === 'external') {
    verdict = c.kind === 'insecure' ? 'BROKEN' : 'BLOCKED';
    extra = 'CSP img-src пропускает только Supabase Storage';
    result.problems.push({ kind, slug: slugOrId, url: shortUrl(urlValue, 120), verdict, note: extra });
  } else {
    // supabase | local — проверяем по сети
    const probeUrl = c.kind === 'local' ? `${(env.VITE_SITE_URL || '').replace(/\/+$/, '')}${urlValue}` : urlValue;
    if (c.kind === 'local' && !env.VITE_SITE_URL) {
      verdict = 'SKIP';
      result.skipped += 1;
      extra = 'VITE_SITE_URL не задан — локальный путь не проверить';
    } else {
      const p = await probe(probeUrl);
      if (p.status === 0) {
        verdict = 'NETWORK';
        extra = p.error;
        result.unreachableAll = false;
        result.problems.push({ kind, slug: slugOrId, url: shortUrl(probeUrl, 120), verdict, note: p.error });
      } else if (p.status >= 200 && p.status < 300) {
        verdict = 'OK';
        extra = `${p.type || '?'}${p.size != null ? ` / ${p.size} B` : ''}`;
      } else {
        verdict = 'BROKEN';
        extra = `HTTP ${p.status}`;
        result.problems.push({ kind, slug: slugOrId, url: shortUrl(probeUrl, 120), verdict, note: extra });
      }
      status = String(p.status);
    }
  }

  if (!AS_JSON) {
    console.log(
      slugOrId.padEnd(32),
      c.label.padEnd(20),
      verdict.padEnd(9),
      `${status} ${extra}`.slice(0, 21).padEnd(22),
      shortUrl(String(urlValue || '—'))
    );
  }
  result.items.push({ kind, slug: slugOrId, kindLabel: c.label, verdict, status, url: String(urlValue || '') });
}

const titlesRes = await fetchRows('titles', 'id,slug,title,cover_url', LIMIT);
if (titlesRes.error) {
  console.error(`\ncheck-covers: не удалось получить titles — ${titlesRes.error}`);
  console.error('Проверка не состоялась: сеть/DNS/RLS. Прод-данные не оценены.');
  process.exit(2);
}

for (const t of titlesRes.rows) {
  await checkRow('cover', t.slug || t.id, t.cover_url);
}

if (CHECK_PAGES) {
  out(`\n=== Страницы глав (pages.image_url, до ${PAGES_LIMIT}) ===\n`);
  const pagesRes = await fetchRows('pages', 'id,chapter_id,image_url', PAGES_LIMIT);
  if (pagesRes.error) {
    out(`  пропущено: ${pagesRes.error}`);
  } else {
    for (const p of pagesRes.rows) await checkRow('page', p.chapter_id || p.id, p.image_url);
  }
}

out(
  `\nИтог: проверено ${result.checked}, без обложки ${result.skipped}, ` +
    `проблем ${result.problems.length}.`
);
if (result.problems.length) {
  out('\nПроблемные URL:');
  for (const p of result.problems) out(`  [${p.verdict}] ${p.slug}: ${p.url} — ${p.note || ''}`);
}

if (AS_JSON) {
  console.log(JSON.stringify({ ...result, infraFailures }, null, 2));
} else {
  out(
    result.problems.length === 0
      ? '\nOK — все обложки доступны.\n'
      : `\nПРОБЛЕМ: ${result.problems.length}\n`
  );
}

// Битые/внешние URL — ошибка данных (exit 1). Повальная NETWORK-недоступность
// (среда без выхода к Supabase) — ошибка окружения (exit 2), не данных.
const dataProblems = result.problems.filter((p) => p.verdict !== 'NETWORK');
const onlyNetwork =
  result.problems.length > 0 && dataProblems.length === 0;
if (onlyNetwork) {
  console.error(
    '\ncheck-covers: до Storage не достучаться ни по одному URL (сеть/DNS/файрвол). ' +
      'Доступность данных в этой среде оценить нельзя.'
  );
  process.exit(2);
}
process.exit(result.problems.length ? 1 : 0);

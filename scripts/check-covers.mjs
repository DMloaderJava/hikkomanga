#!/usr/bin/env node
/**
 * Диагностика обложек тайтлов.
 *
 *   node scripts/check-covers.mjs [опции]
 *
 * Опции:
 *   --limit N     сколько тайтлов проверять (по умолчанию 200)
 *   --timeout ms  таймаут запроса списка (по умолчанию 10000)
 *   --json        вывести итог JSON-ом (для CI)
 *
 * Обложка тайтла бывает двух видов (форму задаёт TitleForm):
 *   A) ФАЙЛ РЕПОЗИТОРИЯ — относительный путь /media/covers/{slug}.webp.
 *      Сети нет: проверяется, что путь относительный, это .webp и файл
 *      реально лежит в public/<путь>.
 *   B) ЗАГРУЗКА ИЗ АДМИНКИ — публичный URL бакета `covers`
 *      (…/storage/v1/object/public/covers/{slug}-{time}.webp). Здесь нужен
 *      один HEAD-запрос на обложку: 200 — картинка живая, 4xx — объект
 *      удалён/не докачался, а cover_url на него всё ещё ссылается.
 *
 * Всё остальное (внешние CDN, http://, data-URL) — проблема: CSP `img-src`
 * пропускает только 'self', data:, blob: и *.supabase.co, так что такая
 * обложка в каталоге молча превратится в плейсхолдер.
 *
 * Переменные те же, что при сборке: .env / .env.production + process.env
 * (VITE_SUPABASE_URL + ключ). RLS отдаёт только опубликованные тайтлы —
 * именно их видят читатели.
 *
 * Коды выхода:
 *   0 — все обложки на месте (файлы в public/ отвечают, URL доступны);
 *   1 — есть битые (файла нет / путь не относительный / не .webp / пусто /
 *       URL в Storage отдаёт не 200);
 *   2 — сама БД недоступна (переменные не заданы или сеть/RLS).
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildEnv } from './lib/urls.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const numArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && Number.isFinite(Number(args[i + 1])) ? Number(args[i + 1]) : def;
};

const LIMIT = Math.max(1, numArg('--limit', 200));
const TIMEOUT_MS = Math.max(1000, numArg('--timeout', 10000));
const AS_JSON = flag('--json');

const PUBLIC_DIR = path.resolve(process.cwd(), 'public');
const COVERS_DIR = path.join(PUBLIC_DIR, 'media/covers');

const env = buildEnv();
const rawUrl = (env.VITE_SUPABASE_URL || '').trim().replace(/\/+$/, '');
const anonKey =
  env.VITE_SUPABASE_ANON_KEY ||
  env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  env.VITE_SUPABASE_PUBLIC_KEY ||
  '';

const result = { checked: 0, ok: 0, problems: [], items: [] };

/** Публичный URL объекта бакета `covers` — обложка, загруженная из админки. */
const isStorageCoverUrl = (value) =>
  /^https?:\/\//i.test(value) && value.includes('/storage/v1/object/public/covers/');

/** HEAD-запрос к Storage: 200 — объект жив, 0 — сети нет. */
async function headStatus(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: res.status };
  } catch (e) {
    return { status: 0, error: e?.message || String(e) };
  }
}

const checkCoverPath = async (urlValue) => {
  result.checked += 1;
  const value = typeof urlValue === 'string' ? urlValue.trim() : '';

  const problem = (verdict, note) => {
    result.problems.push({ url: value || '(пусто)', verdict, note });
    result.items.push({ url: value || '', verdict, ok: false });
  };
  const fine = () => {
    result.ok += 1;
    result.items.push({ url: value, verdict: 'OK', ok: true });
  };

  if (!value) return problem('EMPTY', 'обложка не задана — будет плейсхолдер');

  // ── B. Загруженная обложка: HEAD-запрос в бакет covers ──
  if (isStorageCoverUrl(value)) {
    const { status, error } = await headStatus(value);
    if (status === 200) return fine();
    if (status === 0) {
      return problem('NET', `Storage не отвечает (${error || 'нет соединения'}) — обложка не проверена`);
    }
    return problem(
      `HTTP_${status}`,
      'объекта нет в бакете covers (удалён или не докачался) — загрузите обложку заново в TitleForm'
    );
  }

  // data-URL бывает только в демо-режиме (mockStore/localStorage), в БД ему не место.
  if (value.startsWith('data:')) {
    return problem('DATA_URL', 'data-URL в БД не поддерживается: загрузите файл (бакет covers) или укажите путь в public/');
  }

  // ── A. Файл репозитория ──
  if (!value.startsWith('/')) {
    return problem(
      /^https?:\/\//i.test(value) ? 'EXTERNAL' : 'MALFORMED',
      'допустимы путь /media/covers/{имя}.webp или обложка, загруженная в бакет covers (внешние домены режет CSP)'
    );
  }
  if (!value.toLowerCase().endsWith('.webp')) {
    return problem('FORMAT', 'ожидается .webp (сид-обложки генерируются в WebP 800px)');
  }

  const filePath = path.join(PUBLIC_DIR, value.replace(/^\/+/, ''));
  if (!filePath.startsWith(COVERS_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, value.slice(1))) {
    // Путь вне media/covers допустим (например /media/...), но не вне public/.
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
      return problem('ESCAPE', 'путь выходит за пределы public/');
    }
  }

  if (!fs.existsSync(filePath)) {
    return problem('MISSING', `файла нет: ${path.relative(process.cwd(), filePath)}`);
  }
  return fine();
};

// ── Основной поток ───────────────────────────────────────────────────────────

async function fetchTitles() {
  if (!rawUrl || !anonKey) {
    console.error(
      'check-covers: VITE_SUPABASE_URL / ключ не заданы — список тайтлов взять неоткуда.\n' +
        'Задайте их в .env или окружении CI (как для сборки, см. SETUP_SUPABASE.md §1).'
    );
    process.exit(2);
  }
  const qs = new URLSearchParams({ select: 'id,slug,cover_url', limit: String(LIMIT) });
  try {
    const res = await fetch(`${rawUrl}/rest/v1/titles?${qs}`, {
      headers: { apikey: anonKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`check-covers: titles → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      process.exit(2);
    }
    return (await res.json());
  } catch (e) {
    console.error(`check-covers: БД недоступна (${e?.message || e}). Данные не оценены.`);
    process.exit(2);
  }
}

const titles = await fetchTitles();

if (!AS_JSON) {
  console.log(`\n=== Проверка обложек (${rawUrl}) ===\n`);
  console.log('Каталог файлов:', path.relative(process.cwd(), COVERS_DIR) + '/');
  console.log('slug'.padEnd(34), 'ПУТЬ', ' '.repeat(8), 'СТАТУС');
  console.log('-'.repeat(90));
}

for (const t of titles) {
  const before = result.problems.length;
  await checkCoverPath(t.cover_url);
  const last = result.problems[result.problems.length - 1];
  const bad = result.problems.length > before;
  if (!AS_JSON) {
    console.log(
      (t.slug || t.id).padEnd(34),
      (t.cover_url || '—').slice(0, 44).padEnd(50),
      bad ? `✗ ${last.verdict}: ${last.note}` : '✓'
    );
  }
}

// Бонус без БД: сид-файлы, на которые ссылается mockStore, тоже должны существовать.
if (!AS_JSON) {
  console.log('\nСид-обложки (mockStore):');
  const seedDir = COVERS_DIR;
  if (fs.existsSync(seedDir)) {
    const files = fs.readdirSync(seedDir).filter((f) => f.endsWith('.webp'));
    for (const f of files) {
      const size = fs.statSync(path.join(seedDir, f)).size;
      console.log('  ✓', f.padEnd(44), `${(size / 1024).toFixed(1)} kB`);
    }
    if (files.length === 0) console.log('  (пусто — запустите scripts/generate-seed-covers.mjs)');
  } else {
    console.log('  ✗ каталог public/media/covers/ не существует');
  }
}

if (AS_JSON) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(
    `\nИтог: проверено ${result.checked}, доступно ${result.ok}, проблем ${result.problems.length}.`
  );
  if (result.problems.length) {
    console.log('\nПроблемы:');
    for (const p of result.problems) console.log(`  [${p.verdict}] ${p.url} — ${p.note}`);
    console.log(
      '\nЧинится так: в админке (TitleForm) нажмите «Загрузить файл» — обложка уйдёт ' +
        'в бакет covers, — либо положите WebP в public/media/covers/ и укажите путь ' +
        '/media/covers/{имя}.webp. Сгенерировать сид-обложки: ' +
        'npm i --no-save sharp && node scripts/generate-seed-covers.mjs'
    );
  }
  console.log(result.problems.length === 0 ? '\nOK — все обложки на месте.\n' : `\nПРОБЛЕМ: ${result.problems.length}\n`);
}

process.exit(result.problems.length ? 1 : 0);

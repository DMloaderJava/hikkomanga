#!/usr/bin/env node
/**
 * Переключение репозитория на другой Supabase-проект.
 *
 *   node scripts/switch-supabase-project.mjs --ref <new-ref> \
 *     [--key sb_publishable_…] [--root <папка>] [--dry-run]
 *
 * Меняет ровно то, что лежит в репозитории (это и есть источник правды для
 * сборки): .env.production (VITE_SUPABASE_URL / KEY / PROJECT_ID) и
 * supabase/config.toml (project_id). Остального — Vercel Env, `supabase link`,
 * секретов и деплоя функций — скрипт сделать не может: печатает, что именно
 * осталось, и проверяет новый проект по REST, если передан --key.
 *
 *   --dry-run   показать, что изменится, ничего не записывая.
 *   --root DIR  работать в копии репозитория (для проверки на тестах).
 *
 * Публичный (publishable/anon) ключ — не секрет: он всё равно попадает в
 * браузерный бандл. Service_role ключи сюда не передавайте.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (has('--help') || has('-h')) {
  console.log(
    [
      'Переключение репозитория на другой Supabase-проект.',
      '',
      'Использование:',
      '  node scripts/switch-supabase-project.mjs --ref <new-ref> [--key sb_publishable_…] [--dry-run]',
      '',
      'Что меняет:',
      '  .env.production      VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, VITE_SUPABASE_PROJECT_ID',
      '  supabase/config.toml project_id',
      '',
      'Что остаётся вручную: Vercel → Environment Variables, `supabase link`,',
      'секреты функций и их деплой (docs/migrate-project.md, шаги 4–6).',
    ].join('\n')
  );
  process.exit(0);
}

const ref = (valueOf('--ref') || '').trim();
const key = (valueOf('--key') || '').trim();
const dryRun = has('--dry-run');
const root = resolve(valueOf('--root') || join(dirname(fileURLToPath(import.meta.url)), '..'));

if (!/^[a-z]{20}$/.test(ref)) {
  console.error(
    `--ref должен быть похож на Supabase project ref: 20 строчных латинских букв (получено: ${JSON.stringify(ref)}).\n` +
      'Где взять: Dashboard → Project Settings → General → Reference ID, или из адресной строки.\n' +
      'Подсказка: node scripts/switch-supabase-project.mjs --help'
  );
  process.exit(1);
}
if (key && !/^(sb_publishable_|eyJ)/.test(key)) {
  console.warn('  ! --key не похож ни на sb_publishable_…, ни на JWT (anon key) — проверьте значение.');
}

const newUrl = `https://${ref}.supabase.co`;
const files = [];
const notes = [];

function edit(relPath, transform) {
  const abs = join(root, relPath);
  if (!existsSync(abs)) {
    files.push({ relPath, changed: false, reason: 'файла нет' });
    return;
  }
  const before = readFileSync(abs, 'utf8');
  const after = transform(before);
  files.push({ relPath, changed: after !== before, reason: after === before ? 'уже настроено' : 'изменён' });
  if (after !== before && !dryRun) writeFileSync(abs, after, 'utf8');
}

const envProduction = join(root, '.env.production');
// Что было настроено раньше — пригодится, чтобы напомнить про документацию.
let previousRef = '';
if (existsSync(envProduction)) {
  const m = readFileSync(envProduction, 'utf8').match(/VITE_SUPABASE_PROJECT_ID=([a-z]{20})/);
  if (m) previousRef = m[1];
}

// .env.production
edit('.env.production', (text) => {
  let out = text;
  const put = (name, value) => {
    const re = new RegExp(`^${name}=.*$`, 'm');
    out = re.test(out) ? out.replace(re, `${name}=${value}`) : `${out.trimEnd()}\n${name}=${value}\n`;
  };
  put('VITE_SUPABASE_URL', newUrl);
  if (key) put('VITE_SUPABASE_PUBLISHABLE_KEY', key);
  else notes.push('VITE_SUPABASE_PUBLISHABLE_KEY не изменён: передайте --key <publishable>, иначе ключ останется от старого проекта');
  put('VITE_SUPABASE_PROJECT_ID', ref);
  return out;
});

// supabase/config.toml
edit('supabase/config.toml', (text) => {
  const re = /^project_id = ".*"$/m;
  if (!re.test(text)) {
    notes.push('supabase/config.toml: строка project_id не найдена — задайте project_id вручную');
    return text;
  }
  return text.replace(re, `project_id = "${ref}"`);
});

// Где ещё упоминается старый ref (документация — осознанно правится руками).
const docsWithOldRef = [];
if (previousRef && previousRef !== ref) {
  for (const dir of ['.', 'docs']) {
    const absDir = join(root, dir);
    if (!existsSync(absDir)) continue;
    for (const f of readdirSync(absDir)) {
      if (!f.endsWith('.md')) continue;
      const rel = dir === '.' ? f : `${dir}/${f}`;
      try {
        if (readFileSync(join(root, rel), 'utf8').includes(previousRef)) docsWithOldRef.push(rel);
      } catch {
        /* нечитаемый файл пропускаем */
      }
    }
  }
}

// ── отчёт ──────────────────────────────────────────────────────────────────
console.log(`\nПереключение Supabase-проекта${dryRun ? ' (dry-run)' : ''}`);
console.log(`  новый ref: ${ref}`);
console.log(`  новый URL: ${newUrl}`);
if (previousRef) console.log(`  было:      ${previousRef}\n`);
for (const f of files) console.log(`  ${f.changed && !dryRun ? '✓' : f.changed ? '·' : '·'} ${f.relPath} — ${f.reason}`);
for (const n of notes) console.log(`  ! ${n}`);
if (docsWithOldRef.length) {
  console.log(`\n  Документация, где ещё встречается ${previousRef} (проверьте вручную):`);
  for (const f of docsWithOldRef) console.log(`    · ${f}`);
}

// ── проверка нового проекта ────────────────────────────────────────────────
if (key) {
  const url = `${newUrl}/rest/v1/genres?select=id&limit=1`;
  try {
    const res = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    const text = (await res.text()).slice(0, 200);
    if (res.status === 200) {
      console.log(`\n  ✓ ${ref}: REST отвечает 200 — ключ подходит, схема на месте`);
      if (text.trim() === '[]') console.log('    (таблица genres пуста — контент ещё не перенесён)');
    } else if (/42P01|PGRST205|does not exist/.test(text)) {
      console.log(`\n  ! ${ref}: ключ подходит, но схемы нет — накатите supabase/bootstrap.sql (docs/migrate-project.md, шаг 2)`);
    } else if (res.status === 401 || res.status === 403) {
      console.log(`\n  ! ${ref}: HTTP ${res.status} — ключ не подходит к этому проекту (проверьте --key)`);
    } else {
      console.log(`\n  ! ${ref}: HTTP ${res.status}: ${text}`);
    }
  } catch (e) {
    console.log(`\n  ! ${ref}: домен не отвечает (${e instanceof Error ? e.message : e}) — проект удалён или ref неверный`);
  }
}

console.log(
  [
    '',
    dryRun ? 'Это был dry-run — файлы не изменены.' : 'Файлы репозитория обновлены.',
    '',
    'Осталось вручную (docs/migrate-project.md):',
    '  1. Vercel → Settings → Environment Variables (Production и Preview):',
    '       VITE_SUPABASE_URL=' + newUrl,
    '       VITE_SUPABASE_PUBLISHABLE_KEY=<publishable нового проекта>',
    '     затем обязательный Redeploy (Vite вшивает env на сборке);',
    '  2. supabase link --project-ref ' + ref + '   (нужен для деплоя функций);',
    '  3. секреты функций + `supabase functions deploy …` (шаг 5 runbook);',
    '  4. npm run check:supabase — сверить сборку и проект.',
    '',
  ].join('\n')
);

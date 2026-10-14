#!/usr/bin/env node
/**
 * Собирает supabase/migrations/*.sql в один файл supabase/bootstrap.sql.
 *
 *   npm run bootstrap:sql
 *
 * Зачем: накатить схему на ЧИСТЫЙ проект (переезд на другой Supabase) проще
 * всего одним заходом в SQL Editor — копировать 20 файлов по одному легко
 * ошибиться, а `supabase db push` на этом репозитории не работает (локальная
 * история миграций пуста, см. DEPLOY.md).
 *
 * ВАЖНО: файл — для чистого проекта. Повторный прогон упадёт на
 * `CREATE POLICY ...` (политики создаются без IF NOT EXISTS), это ожидаемо и
 * защищает от незаметной перезаписи работающей схемы. Для уже живущего
 * проекта накатывайте точечные файлы (например, 21_restore_function_grants).
 *
 * Файл генерируется — правьте миграции, а не bootstrap.sql.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'supabase', 'migrations');
const outFile = join(root, 'supabase', 'bootstrap.sql');

// --check: сверить файл на диске с тем, что получилось бы сейчас (для CI).
// Ловит ситуацию «миграцию поправили, bootstrap.sql забыли пересобрать».
const checkOnly = process.argv.includes('--check');

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort(); // имена — с ведущими нулями, лексикографический порядок = порядок наката

if (files.length === 0) {
  console.error('Нет файлов в supabase/migrations — нечего собирать.');
  process.exit(1);
}

// Пара проверок на «нельзя объединять»: транзакции внутри файльов ломают
// единый прогон (BEGIN внутри BEGIN), а \ir/\i — psql-специфичный синтаксис,
// которого SQL Editor не знает.
const problems = [];
for (const f of files) {
  const sql = readFileSync(join(migrationsDir, f), 'utf8');
  if (/^\s*(begin|commit)\s*;/im.test(sql)) problems.push(`${f}: содержит BEGIN/COMMIT — уберите транзакцию`);
  if (/^\s*\\(ir|i)\s/m.test(sql)) problems.push(`${f}: содержит psql-команду \\i / \\ir — SQL Editor её не выполнит`);
}
if (problems.length) {
  console.error('Сборка невозможна:');
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}

const totalBytes = files.reduce((n, f) => n + statSync(join(migrationsDir, f)).size, 0);

const header = `-- ============================================================================
-- supabase/bootstrap.sql — СГЕНЕРИРОВАННЫЙ файл, не правьте его вручную.
-- Регенерация: npm run bootstrap:sql   (собирает supabase/migrations/*.sql)
--
-- ЧТО ЭТО: все миграции репозитория по порядку (${files.length} файлов, ~${Math.round(totalBytes / 1024)} КБ) —
-- схема, RLS, RPC, триггеры, бакеты Storage. Один заход для ЧИСТОГО проекта,
-- например при переезде на новый Supabase (docs/migrate-project.md).
--
-- КАК НАКАТИТЬ (SQL Editor):
--   1. Откройте проект → SQL Editor → New query;
--   2. вставьте этот файл ЦЕЛИКОМ (Ctrl+A на странице файла в GitHub → Copy);
--   3. Run. Ожидаемый результат — "Success. No rows returned";
--   4. проверьте: npm run check:supabase (разделы 3–5 без ✗).
--
-- ВАЖНО:
--   • Только для ПУСТОГО/НОВОГО проекта. На живом проекте повторный прогон
--     упадёт на CREATE POLICY — это защита, а не поломка: накатывайте
--     точечные миграции (DEPLOY.md → «Порядок первого деплоя»).
--   • Пользователи (auth.users) и секреты Edge Functions этим файлом НЕ
--     создаются — см. docs/migrate-project.md, шаги 3–4.
--   • Файл детерминирован: те же миграции → тот же bootstrap.sql.
-- ============================================================================

`;

const parts = files.map((f) => {
  const sql = readFileSync(join(migrationsDir, f), 'utf8').trimEnd();
  return (
    `\n-- ────────────────────────────────────────────────────────────────────────────\n` +
    `-- ${f}\n` +
    `-- ────────────────────────────────────────────────────────────────────────────\n\n` +
    sql +
    '\n'
  );
});

const content = header + parts.join('');

if (checkOnly) {
  let current = '';
  try {
    current = readFileSync(outFile, 'utf8');
  } catch {
    /* файла нет — это и есть рассинхрон */
  }
  if (current !== content) {
    console.error(
      'bootstrap.sql устарел: supabase/migrations изменились после последней сборки.\n' +
        'Пересоберите: npm run bootstrap:sql'
    );
    process.exit(1);
  }
  console.log(`bootstrap.sql актуален (${files.length} миграций)`);
  process.exit(0);
}

writeFileSync(outFile, content, 'utf8');

const outKb = Math.round(statSync(outFile).size / 1024);
console.log(`bootstrap.sql собран: ${files.length} миграций, ~${outKb} КБ`);
console.log(`  ${['supabase', 'bootstrap.sql'].join('/')}`);
console.log('  накат: SQL Editor нового проекта → вставить файл целиком → Run');

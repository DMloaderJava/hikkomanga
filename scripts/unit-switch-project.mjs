#!/usr/bin/env node
/**
 * Тест scripts/switch-supabase-project.mjs: проверяем на временной копии
 * файлов репозитория (--root), что переключение меняет ровно нужные строки,
 * dry-run ничего не пишет и невалидный ref отклоняется.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = join(dirname(fileURLToPath(import.meta.url)), 'switch-supabase-project.mjs');
const OLD_REF = 'islgkqdsztchzajnulof';
const NEW_REF = 'zzzzzzzzzzzzzzzzzzzz'; // 20 букв, домена нет → проверка ключа просто предупредит
const NEW_KEY = 'sb_publishable_NEWKEY123';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'switch-project-'));
  mkdirSync(join(root, 'supabase'), { recursive: true });
  writeFileSync(
    join(root, '.env.production'),
    [
      '# публичные ключи (не секрет)',
      `VITE_SUPABASE_URL=https://${OLD_REF}.supabase.co`,
      'VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_OLD',
      `VITE_SUPABASE_PROJECT_ID=${OLD_REF}`,
      '',
    ].join('\n')
  );
  writeFileSync(
    join(root, 'supabase', 'config.toml'),
    ['# конфиг CLI', `project_id = "${OLD_REF}"`, ''].join('\n')
  );
  writeFileSync(join(root, 'DEPLOY.md'), `Проект: ${OLD_REF}\n`);
  return root;
}

const run = (args, root) =>
  spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });

// 1. Обычный запуск.
{
  const root = makeRoot();
  const r = run(['--ref', NEW_REF, '--key', NEW_KEY], root);
  const env = readFileSync(join(root, '.env.production'), 'utf8');
  const toml = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8');
  check('переключение завершилось успешно', r.status === 0, `exit=${r.status}`);
  check('VITE_SUPABASE_URL обновлён', env.includes(`VITE_SUPABASE_URL=https://${NEW_REF}.supabase.co`));
  check('publishable-ключ обновлён', env.includes(`VITE_SUPABASE_PUBLISHABLE_KEY=${NEW_KEY}`));
  check('PROJECT_ID обновлён', env.includes(`VITE_SUPABASE_PROJECT_ID=${NEW_REF}`));
  check('config.toml project_id обновлён', toml.includes(`project_id = "${NEW_REF}"`));
  check('старый ref в документации найден и перечислен', r.stdout.includes('DEPLOY.md'));
  check('подсказка про Vercel напечатана', r.stdout.includes('Redeploy'));
  rmSync(root, { recursive: true, force: true });
}

// 2. dry-run ничего не меняет.
{
  const root = makeRoot();
  const r = run(['--ref', NEW_REF, '--key', NEW_KEY, '--dry-run'], root);
  const env = readFileSync(join(root, '.env.production'), 'utf8');
  const toml = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8');
  check('dry-run завершился успешно', r.status === 0, `exit=${r.status}`);
  check('dry-run не тронул .env.production', env.includes(OLD_REF) && !env.includes(NEW_REF));
  check('dry-run не тронул config.toml', toml.includes(OLD_REF));
  check('dry-run предупредил, что не изменяет файлы', r.stdout.includes('dry-run — файлы не изменены'));
  rmSync(root, { recursive: true, force: true });
}

// 3. Мусорный ref отклоняется.
{
  const root = makeRoot();
  const r = run(['--ref', 'НЕ-ref', '--key', NEW_KEY], root);
  check('невалидный ref → отказ', r.status === 1 && r.stderr.includes('20 строчных'), `exit=${r.status}`);
  rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\nunit-switch-project: ${failures} проверок провалено` : '\nunit-switch-project: все проверки пройдены');
process.exit(failures ? 1 : 0);

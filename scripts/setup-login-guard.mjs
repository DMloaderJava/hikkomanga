#!/usr/bin/env node
/**
 * Настройка Login Guard в Supabase: секреты + деплой + проверка.
 *
 *   node scripts/setup-login-guard.mjs \
 *     --project-ref <ref> \
 *     --owner-email you@domain.tld \
 *     --resend-key re_xxxxxxxxxxxx \
 *     [--from "Hikkomanga Login Guard <noreply@yourdomain.tld>"] \
 *     [--skip-secrets] [--skip-deploy]
 *
 * Альтернатива флагам — переменные окружения OWNER_NOTIFY_EMAIL / RESEND_API_KEY.
 * Нужен установленный и залогиненный Supabase CLI (`supabase login`) либо
 * токен в SUPABASE_ACCESS_TOKEN (CI). Секреты в лог не печатаются.
 *
 * Что делает:
 *   1. `supabase secrets set --env-file <tmp>` — секреты передаются через
 *      временный файл с режимом 0600; они НЕ попадают ни в лог, ни в argv/ps
 *      процесса. Файл удаляется в собственном `try/finally` сразу после
 *      `secrets set` (не живёт на диске во время deploy/probe). Если команда
 *      падает с ошибкой/ненулевым кодом/сигналом (ENOENT, Ctrl+C) — `run()`
 *      вызывает `fail()`, а тот — `cleanupSecretsFile()` до exit. Хендлеры
 *      SIGINT/SIGTERM/SIGHUP дублируют очистку на случай прерывания МЕЖДУ
 *      spawnSync-вызовами (внутри spawnSync event loop блокирован и туда не
 *      попадает — там отрабатывает ветка r.signal в run()).
 *   2. При --with-db: `supabase link` (с SUPABASE_DB_PASSWORD, если задан) +
 *      `supabase db push`.
 *   3. Проверяет наличие supabase/functions/{login-notify,login-confirm}/index.ts
 *      в репозитории до деплоя.
 *   4. `supabase functions deploy login-notify` + `login-confirm`
 *   5. Проверяет деплой: анонимный запрос к функциям
 *      (ожидаем 401 / «нет токена», но НЕ 404).
 *
 * ВАЖНО про Resend: отправитель по умолчанию — onboarding@resend.dev, он
 * доставляет письма ТОЛЬКО на адрес аккаунта, в котором создан ключ. Для
 * любого другого OWNER_NOTIFY_EMAIL подтвердите домен в Resend и передайте
 * --from (→ секрет OWNER_NOTIFY_FROM).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const args = { projectRef: '', ownerEmail: '', resendKey: '', from: '' };
let skipSecrets = false;
let skipDeploy = false;
let withDb = false;

function usage(code = 0) {
  console.log(
    [
      'Использование:',
      '  node scripts/setup-login-guard.mjs --project-ref <ref> \\',
      '    --owner-email you@domain.tld --resend-key re_xxx \\',
      '    [--from "Name <noreply@domain.tld>"] [--with-db] [--skip-secrets] [--skip-deploy]',
      '',
      '  --with-db  накатить миграции из supabase/migrations (supabase link + db push).',
      '',
      'Секреты можно задать и через окружение: OWNER_NOTIFY_EMAIL, RESEND_API_KEY.',
      'Требуется: supabase CLI (`npm i -g supabase && supabase login`)',
      '           или SUPABASE_ACCESS_TOKEN в окружении (CI).',
    ].join('\n')
  );
  process.exit(code);
}

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i] || usage(1);
  switch (a) {
    case '--project-ref': args.projectRef = next(); break;
    case '--owner-email': args.ownerEmail = next(); break;
    case '--resend-key': args.resendKey = next(); break;
    case '--from': args.from = next(); break;
    case '--skip-secrets': skipSecrets = true; break;
    case '--skip-deploy': skipDeploy = true; break;
    case '--with-db': withDb = true; break;
    case '-h': case '--help': usage(0); break;
    default:
      console.error(`Неизвестный аргумент: ${a}`);
      usage(1);
  }
}

if (argv.includes('--help')) usage(0);

const ownerEmail = (args.ownerEmail || process.env.OWNER_NOTIFY_EMAIL || '').trim();
const resendKey = (args.resendKey || process.env.RESEND_API_KEY || '').trim();
const projectRef = args.projectRef.trim();

// Путь к временному .env.secrets и его родительской директории (mkdtempSync) —
// чтобы fail() / signal-handler могли их удалить до process.exit().
// В Node process.exit() НЕ выполняет блоки finally, поэтому очистка в fail() —
// единственная надёжная точка.
let secretsTmpFile;
let secretsTmpDir;

/** Удалить временный env-file и его директорию, если они существуют. Безопасно звать много раз. */
function cleanupSecretsFile() {
  if (secretsTmpFile) {
    try { rmSync(secretsTmpFile, { force: true }); } catch { /* ignore */ }
    secretsTmpFile = undefined;
  }
  if (secretsTmpDir) {
    try { rmSync(secretsTmpDir, { force: true, recursive: true }); } catch { /* ignore */ }
    secretsTmpDir = undefined;
  }
}

const fail = (msg, code = 1) => {
  cleanupSecretsFile();
  console.error(`\n✗ ${msg}`);
  process.exit(code);
};

// Сигналы МЕЖДУ spawnSync-вызовами (пока event loop жив) — чистим temp и выходим
// стандартным 128+signo. Внутри spawnSync event loop блокирован, там сигнал
// принимает child и прилетает к нам как r.signal — run() обрабатывает это сам.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    cleanupSecretsFile();
    // стандартный выход по сигналу: 128 + signal number
    process.exit(128 + (sig === 'SIGHUP' ? 1 : sig === 'SIGINT' ? 2 : 15));
  });
}

if (!projectRef) fail('Нужен --project-ref (Supabase → Project Settings → General → Reference ID)');
if (!/^[a-z0-9-]{10,30}$/i.test(projectRef)) fail(`Похоже, ${projectRef} не похож на project ref`);
if (/@example\.(com|org|net)$/i.test(ownerEmail)) {
  fail('OWNER_NOTIFY_EMAIL — placeholder вида @example.*; укажите реальный адрес владельца');
}

const mask = (s) => (s.length > 8 ? `${s.slice(0, 7)}…${s.slice(-2)}` : '***');

/**
 * Маскирует секретные значения в аргументах при выводе в лог.
 * Целится по именам (…API_KEY|RESEND|OWNER_NOTIFY|SECRET|TOKEN|FROM) и по голым
 * значениям, похожим на Resend-ключи (re_…). Значения заменяются на `***` через mask();
 * обычные аргументы и именованные флаги с не-секретными значениями не трогаются.
 */
const maskArg = (arg) => {
  if (typeof arg !== 'string') return String(arg);
  const eqIdx = arg.indexOf('=');
  if (eqIdx !== -1) {
    const key = arg.slice(0, eqIdx);
    if (/API_KEY|RESEND|OWNER_NOTIFY|SECRET|TOKEN|FROM/i.test(key)) {
      return `${key}=${mask(arg.slice(eqIdx + 1))}`;
    }
    return arg;
  }
  if (/^re_[A-Za-z0-9_-]{8,}$/.test(arg)) {
    return mask(arg);
  }
  return arg;
};

const run = (cmd, cmdArgs, label, opts = {}) => {
  console.log(`\n→ ${label}`);
  console.log(`  $ ${cmd} ${cmdArgs.map(maskArg).join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', env: process.env, ...opts });
  // spawnSync НЕ бросает при ошибке запуска (ENOENT) / сигнале — кладёт в r.error / r.signal,
  // а r.status при этом === null. Проверяем по порядку, чтобы fail() показал внятную причину
  // и чтобы cleanup отработал до process.exit.
  if (r.error) {
    // ENOENT — supabase не в PATH, иначе — другая ошибка spawn.
    fail(`${label} — не удалось запустить ${cmd}: ${r.error.message}`);
  }
  if (r.signal) {
    // Ctrl+C во время spawnSync: status=null, signal=SIGINT.
    // Завершаем с кодом 130 (SIGINT) / 143 (SIGTERM) как в shell, а не 1.
    // (fail() вызовет cleanupSecretsFile() сам.)
    const code =
      r.signal === 'SIGINT' ? 130 :
      r.signal === 'SIGTERM' ? 143 :
      r.signal === 'SIGHUP' ? 129 :
      1;
    fail(`${label} — прервано сигналом ${r.signal}`, code);
  }
  if (r.status !== 0) {
    fail(`${label} — команда завершилась с кодом ${r.status}`);
  }
};

// ── 0. supabase CLI ─────────────────────────────────────────────────────────
try {
  const v = execFileSync('supabase', ['--version'], { encoding: 'utf8' }).trim();
  console.log(`supabase CLI: ${v}`);
} catch {
  fail(
    'supabase CLI не найден. Установите: `npm i -g supabase` и войдите: `supabase login` ' +
      '(в CI — экспорт SUPABASE_ACCESS_TOKEN).'
  );
}

// ── 1. Секреты (до деплоя: функция без секретов = вход закрыт) ──────────────
// Используем --env-file <tmp>: RESEND_API_KEY не попадает ни в лог (maskArg),
// ни в argv/ps процесса (только имя файла). CLI читает ключ напрямую из файла.
// Файл создаётся с mode 0600 и удаляется сразу после `secrets set`, не живёт
// через последующие шаги (link/db push/deploy/probe).
if (!skipSecrets) {
  if (!ownerEmail) {
    fail('Нужен --owner-email (или переменная OWNER_NOTIFY_EMAIL) — куда слать письма');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) {
    fail(`OWNER_NOTIFY_EMAIL="${ownerEmail}" не похож на email`);
  }
  if (!resendKey) {
    fail('Нужен --resend-key (или переменная RESEND_API_KEY) — ключ с resend.com → API Keys');
  }
  if (!/^re_[A-Za-z0-9_-]{8,}$/.test(resendKey)) {
    fail('RESEND_API_KEY должен начинаться с re_… (resend.com → API Keys)');
  }

  const envLines = [
    `RESEND_API_KEY=${resendKey}`,
    `OWNER_NOTIFY_EMAIL=${ownerEmail}`,
  ];
  if (args.from) envLines.push(`OWNER_NOTIFY_FROM=${args.from}`);

  // Создаём во временной поддиректории с chmod 0700 (mkdtempSync), файл — 0600.
  secretsTmpDir = mkdtempSync(join(tmpdir(), 'supa-secrets-'));
  secretsTmpFile = join(secretsTmpDir, '.env.secrets');
  writeFileSync(secretsTmpFile, envLines.join('\n') + '\n', { mode: 0o600 });

  console.log(
    `\n→ Секреты: RESEND_API_KEY=${mask(resendKey)}, OWNER_NOTIFY_EMAIL=${ownerEmail}` +
      (args.from ? `, OWNER_NOTIFY_FROM="${args.from}"` : '') +
      `\n  (через --env-file ${secretsTmpFile} — ключ не в argv/ps; файл удаляется сразу после secrets set)`
  );
  try {
    run(
      'supabase',
      ['secrets', 'set', '--env-file', secretsTmpFile, '--project-ref', projectRef],
      'secrets set'
    );
  } finally {
    // Удаляем и файл, и временную директорию сразу — до вызова deploy/probe.
    // (При сигнале/ошибке run() вызывает fail() → cleanupSecretsFile() до exit,
    //  но на happy-path finally отработает раньше.)
    cleanupSecretsFile();
  }
} else {
  console.log('\n→ Пропускаю секреты (--skip-secrets)');
}

// ── 1b. Миграции (по флагу --with-db) ───────────────────────────────────────
if (withDb) {
  run(
    'supabase',
    [
      'link',
      '--project-ref',
      projectRef,
      ...(process.env.SUPABASE_DB_PASSWORD
        ? ['--password', process.env.SUPABASE_DB_PASSWORD]
        : []),
    ],
    'supabase link'
  );
  run('supabase', ['db', 'push'], 'db push (миграции из supabase/migrations)');
}

// ── 1c. Проверка, что функции есть в репо — до деплоя ───────────────────────
if (!skipDeploy) {
  for (const n of ['login-notify', 'login-confirm']) {
    if (!existsSync(`supabase/functions/${n}/index.ts`)) {
      fail(`Не найден supabase/functions/${n}/index.ts — деплоить нечего`);
    }
  }
}

// ── 2. Деплой функций ───────────────────────────────────────────────────────
if (!skipDeploy) {
  run(
    'supabase',
    ['functions', 'deploy', 'login-notify', '--project-ref', projectRef],
    'deploy login-notify'
  );
  run(
    'supabase',
    ['functions', 'deploy', 'login-confirm', '--project-ref', projectRef],
    'deploy login-confirm'
  );
} else {
  console.log('\n→ Пропускаю деплой (--skip-deploy)');
}

// ── 3. Проверка: функции отвечают (не 404) ──────────────────────────────────
const base = `https://${projectRef}.supabase.co/functions/v1`;

async function probe(name, body, expectNote) {
  let res;
  try {
    res = await fetch(`${base}/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    fail(`Проверка ${name}: сетевая ошибка — ${e.message}`);
  }
  let text = '';
  try { text = await res.text(); } catch { /* ignore */ }
  if (res.status === 404 || /function not found/i.test(text)) {
    fail(`Проверка ${name}: 404 — функция не задеплоена`);
  }
  console.log(`✓ ${name} отвечает (HTTP ${res.status} — ${expectNote}): ${text.slice(0, 160)}`);
}

console.log('\n→ Проверяю деплой анонимными запросами (токены не нужны)…');
// Без Authorization функция обязана вернуть 401 — значит жива.
await probe('login-notify', {}, 'ожидаем 401 «нет сессии»');
// С мусорным токеном — 200 {ok:false,...} или 400: главное, не 404.
await probe('login-confirm', { token: 'setup-check', action: 'approve' }, 'ожидаем ответ «нет токена»');

console.log(
  [
    '',
    'Готово. Проверка входа:',
    '  1. Откройте /admin/login, введите почту/пароль админа.',
    '  2. Письмо придёт на ' + (ownerEmail || 'OWNER_NOTIFY_EMAIL') + ' (иногда в спам).',
    !args.from
      ? '  ⚠ Отправитель сейчас — onboarding@resend.dev: Resend доставляет с него ТОЛЬКО на адрес аккаунта, в котором создан ключ. Если письмо не пришло — подтвердите свой домен в Resend и задайте секрет OWNER_NOTIFY_FROM.'
      : '',
    '  3. Нажмите в письме «Подтвердить — это я» → вкладка входа откроет админку.',
  ]
    .filter(Boolean)
    .join('\n')
);

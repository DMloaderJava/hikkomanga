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
 *   1. `supabase secrets set RESEND_API_KEY=... OWNER_NOTIFY_EMAIL=... [--from → OWNER_NOTIFY_FROM]`
 *   2. `supabase functions deploy login-notify` + `login-confirm`
 *   3. Проверяет деплой: анонимный запрос к функциям
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

const fail = (msg, code = 1) => {
  console.error(`\n✗ ${msg}`);
  process.exit(code);
};

if (!projectRef) fail('Нужен --project-ref (Supabase → Project Settings → General → Reference ID)');
if (!/^[a-z0-9-]{10,30}$/i.test(projectRef)) fail(`Похоже, ${projectRef} не похож на project ref`);
if (/@example\.(com|org|net)$/i.test(ownerEmail)) {
  fail('OWNER_NOTIFY_EMAIL — placeholder вида @example.*; укажите реальный адрес владельца');
}

const mask = (s) => (s.length > 8 ? `${s.slice(0, 7)}…${s.slice(-2)}` : '***');

/** Маскирует секретные значения в аргументах для безопасного логирования. */
const maskArg = (a) => {
  if (typeof a !== 'string') return String(a);
  if (/^[A-Z][A-Z0-9_]*=/.test(a)) return a.replace(/=.*$/, '=***');
  if (/^re_[A-Za-z0-9_-]{8,}$/.test(a)) return 're_***';
  return a;
};
const maskArgs = (cmdArgs) => cmdArgs.map((a, i) => (cmdArgs[i - 1] === '--password' ? '***' : maskArg(a)));

const run = (cmd, cmdArgs, label, opts = {}) => {
  console.log(`\n→ ${label}`);
  console.log(`  $ ${cmd} ${maskArgs(cmdArgs).join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', env: process.env, ...opts });
  if (r.error) {
    // ENOENT — supabase не в PATH, иначе — другая ошибка spawn
    fail(`${label} — не удалось запустить ${cmd}: ${r.error.message}`);
  }
  if (r.signal) {
    // Ctrl+C во время spawnSync: status=null, signal=SIGINT
    // Завершаем с кодом 130 (SIGINT) / 143 (SIGTERM) как в shell, а не 1
    const code = r.signal === 'SIGINT' ? 130 : r.signal === 'SIGTERM' ? 143 : 1;
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
  const secrets = [`RESEND_API_KEY=${resendKey}`, `OWNER_NOTIFY_EMAIL=${ownerEmail}`];
  if (args.from) secrets.push(`OWNER_NOTIFY_FROM=${args.from}`);
  console.log(
    `\n→ Секреты: RESEND_API_KEY=${mask(resendKey)}, OWNER_NOTIFY_EMAIL=${ownerEmail}` +
      (args.from ? `, OWNER_NOTIFY_FROM="${args.from}"` : '')
  );
  // Пытаемся передать секреты через --env-file, чтобы не светить их в argv (ps aux)
  // и тем более в логах. В свежих версиях CLI флаг поддерживается.
  let tmpDir = '';
  let envFile = '';
  let usedEnvFile = false;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'hikkomanga-'));
    envFile = join(tmpDir, '.env.secrets');
    const content = secrets
      .map((s) => {
        const eq = s.indexOf('=');
        const k = s.slice(0, eq);
        const v = s.slice(eq + 1);
        if (/[\n\r"'`$\\]|\s/.test(v)) {
          return `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
        }
        return `${k}=${v}`;
      })
      .join('\n') + '\n';
    writeFileSync(envFile, content, { mode: 0o600 });
    console.log(`  (пишу секреты во временный --env-file, чтобы не попали в process list)`);
    const r = spawnSync('supabase', ['secrets', 'set', '--env-file', envFile, '--project-ref', projectRef], {
      stdio: 'inherit',
      env: process.env,
    });
    if (r.error) throw r.error;
    if (r.signal) {
      const code = r.signal === 'SIGINT' ? 130 : r.signal === 'SIGTERM' ? 143 : 1;
      fail(`secrets set — прервано сигналом ${r.signal}`, code);
    }
    if (r.status === 0) {
      usedEnvFile = true;
    } else {
      console.warn(`⚠ supabase secrets set --env-file завершился с кодом ${r.status}, пробую inline fallback...`);
    }
  } catch (e) {
    if (e && e.message && !String(e.message).includes('spawn')) {
      console.warn(`⚠ не удалось использовать --env-file: ${e.message}, пробую inline...`);
    }
  } finally {
    try {
      if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
  if (!usedEnvFile) {
    // fallback: inline, но лог уже маскируется через maskArg
    run('supabase', ['secrets', 'set', ...secrets, '--project-ref', projectRef], 'secrets set (inline)');
  }
} else {
  console.log('\n→ Пропускаю секреты (--skip-secrets)');
}

// ── 1b. Миграции (по флагу --with-db) ───────────────────────────────────────
if (withDb) {
  const linkArgs = ['link', '--project-ref', projectRef];
  if (process.env.SUPABASE_DB_PASSWORD) {
    linkArgs.push('--password', process.env.SUPABASE_DB_PASSWORD);
  } else {
    console.warn('⚠ SUPABASE_DB_PASSWORD не задан — supabase link может интерактивно спросить DB-пароль и повесить CI');
  }
  run('supabase', linkArgs, 'supabase link');
  run('supabase', ['db', 'push'], 'db push (миграции из supabase/migrations)');
}

// ── 2. Деплой функций ───────────────────────────────────────────────────────
if (!skipDeploy) {
  for (const n of ['login-notify', 'login-confirm']) {
    if (!existsSync(`supabase/functions/${n}/index.ts`)) {
      fail(`Не найден supabase/functions/${n}/index.ts — деплоить нечего`);
    }
  }
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

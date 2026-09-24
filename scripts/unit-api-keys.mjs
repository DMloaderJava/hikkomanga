/**
 * Unit-тесты персонального Gemini API key админа.
 *
 *   node scripts/unit-api-keys.mjs
 *
 * Что проверяется без браузера, Supabase и Deno:
 *   1. crypto.ts — AES-256-GCM round-trip, случайный IV, AAD, битый секрет;
 *   2. контракт edge-функций — gemini-proxy больше НЕ читает GEMINI_API_KEY,
 *      CORS admin-api-keys совпадает с gemini-proxy, формат ключа в клиенте
 *      и на сервере — одна и та же регулярка;
 *   3. миграция — RLS, 4 политики, unique-версии файлов;
 *   4. демо-режим data-слоя: ключ не сохраняется и не утекает в storage;
 *   5. SSR-рендер /admin/settings: баннер «ключ не задан», маска `••••••••XXXX`
 *      и отсутствие плейнтекста в разметке.
 *
 * Плейнтексты тестовых ключей — синтетические (`AIza` + 35 символов = 39 и
 * новый auth-ключ `AQ.…`), реальных секретов в репозитории нет.
 *
 * Отдельная тема — форматы ключей: с мая 2026 AI Studio выдаёт auth-ключи
 * `AQ.Ab…`, и старая проверка «AIza + 35 символов» отклоняла их ещё до запроса
 * к Google. Здесь проверяются оба формата и то, что префикс больше не
 * зашит в валидацию (ни в клиент, ни в edge-функцию).
 */
import { createServer } from 'vite';
import { readFileSync, readdirSync } from 'node:fs';
import { forceDemoMode, DEMO_SERVER_OPTIONS } from './lib/demo-mode.mjs';

forceDemoMode();

const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures.push(name);
};

const read = (path) => readFileSync(path, 'utf8');

/**
 * Комментарии не считаем при проверках «старой логики больше нет»: в доках
 * мы специально цитируем прежнюю регулярку `AIza…`, объясняя, почему её убрали.
 */
const stripComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

// Синтетический «старый» standard key: AIza + 35 символов = 39.
const VALID_KEY = `AIza${'SyTestKey0123456789'.padEnd(31, 'x')}wxyz`;
// Синтетический «новый» auth key: AI Studio с мая 2026 выдаёт ключи вида
// `AQ.<случайные символы>` (пользовательский пример в багрепорте —
// `AQ.Ab8RN6LzQh0yu_zDGMhlbalfpE`). Секрета здесь нет — строка выдумана.
const AUTH_KEY = 'AQ.Ab8RN6LzUnitTestKey_0123456789zyxw';
const SECRET = Buffer.from('unit-test-secret-32-bytes-long!!').toString('base64');

const vite = await createServer({ ...DEMO_SERVER_OPTIONS, mode: 'test' });

try {
  // ── 1. crypto.ts ──────────────────────────────────────────────────────────
  const {
    CryptoError,
    ENC_SECRET_ENV,
    decryptSecret,
    encryptSecret,
    secretAad,
  } = await vite.ssrLoadModule('/supabase/functions/_shared/crypto.ts');

  check('1a. ENC_SECRET_ENV = USER_KEY_ENC_SECRET', ENC_SECRET_ENV === 'USER_KEY_ENC_SECRET', ENC_SECRET_ENV);
  check(
    '1a*. тестовые ключи: старый AIza… (39) и новый AQ.… — разной длины',
    VALID_KEY.length === 39 && AUTH_KEY.startsWith('AQ.') && AUTH_KEY.length !== 39,
    `${VALID_KEY.length} / ${AUTH_KEY.length}`
  );

  const encrypted = await encryptSecret(VALID_KEY, { secret: SECRET });
  check(
    '1b. round-trip: расшифровка возвращает исходный ключ',
    (await decryptSecret(encrypted, { secret: SECRET })) === VALID_KEY
  );
  check(
    '1c. шифротекст не содержит плейнтекста',
    !encrypted.ciphertext.includes(VALID_KEY) &&
      !Buffer.from(encrypted.ciphertext, 'base64').toString('utf8').includes('AIza')
  );
  check('1d. IV — 12 байт', Buffer.from(encrypted.iv, 'base64').length === 12);

  const again = await encryptSecret(VALID_KEY, { secret: SECRET });
  check(
    '1e. IV и шифротекст уникальны на каждое шифрование',
    again.iv !== encrypted.iv && again.ciphertext !== encrypted.ciphertext
  );

  const otherSecret = Buffer.from('another-unit-test-secret-32bytes').toString('base64');
  check(
    '1f*. секрет для проверки — тоже base64 от 32 байт',
    Buffer.from(otherSecret, 'base64').length === 32
  );
  const wrongSecret = await decryptSecret(encrypted, { secret: otherSecret }).then(
    () => null,
    (error) => error
  );
  check(
    '1f. другой секрет → decrypt_failed',
    wrongSecret instanceof CryptoError && wrongSecret.code === 'decrypt_failed',
    wrongSecret?.code
  );

  const aadA = secretAad('user-a', 'gemini');
  const aadB = secretAad('user-b', 'gemini');
  const withAad = await encryptSecret(VALID_KEY, { secret: SECRET, aad: aadA });
  check(
    '1g. AAD своего пользователя расшифровывается',
    (await decryptSecret(withAad, { secret: SECRET, aad: aadA })) === VALID_KEY
  );
  const swapped = await decryptSecret(withAad, { secret: SECRET, aad: aadB }).then(
    () => null,
    (error) => error
  );
  check(
    '1h. чужой AAD (перенос строки в другую запись) → decrypt_failed',
    swapped instanceof CryptoError && swapped.code === 'decrypt_failed'
  );

  const noSecret = await encryptSecret(VALID_KEY).then(
    () => null,
    (error) => error
  );
  check(
    '1i. без USER_KEY_ENC_SECRET → enc_secret_missing',
    noSecret instanceof CryptoError && noSecret.code === 'enc_secret_missing',
    noSecret?.code
  );

  for (const [label, secret] of [
    ['не base64', '!!! not base64 !!!'],
    ['16 байт вместо 32', Buffer.from('0123456789abcdef').toString('base64')],
  ]) {
    const error = await encryptSecret(VALID_KEY, { secret }).then(
      () => null,
      (e) => e
    );
    check(
      `1j. секрет (${label}) → enc_secret_invalid`,
      error instanceof CryptoError && error.code === 'enc_secret_invalid',
      error?.code
    );
  }

  // ── 2. Контракт edge-функций ─────────────────────────────────────────────
  const adminFn = read('supabase/functions/admin-api-keys/index.ts');
  const proxyFn = read('supabase/functions/gemini-proxy/index.ts');
  const clientData = read('src/data/apiKeys.ts');

  const envGet = (source, name) =>
    new RegExp(`Deno\\.env\\.get\\(['"]${name}['"]\\)`).test(source);

  check(
    '2a. gemini-proxy не читает общий GEMINI_API_KEY',
    !envGet(proxyFn, 'GEMINI_API_KEY')
  );
  check(
    '2b. gemini-proxy берёт ключ из user_api_keys и расшифровывает его',
    proxyFn.includes("from('user_api_keys')") &&
      proxyFn.includes('decryptSecret') &&
      proxyFn.includes('secretAad')
  );
  check(
    '2c. gemini-proxy отдаёт код gemini_key_missing (403)',
    proxyFn.includes('gemini_key_missing') && /gemini_key_missing[\s\S]{0,400}403|403[\s\S]{0,400}gemini_key_missing/.test(proxyFn)
  );
  check(
    '2d. admin-api-keys не читает GEMINI_API_KEY',
    !envGet(adminFn, 'GEMINI_API_KEY')
  );

  const corsOf = (source) => {
    const origin = source.match(/'Access-Control-Allow-Origin':\s*'([^']+)'/)?.[1];
    const headers = source.match(/'Access-Control-Allow-Headers':\s*'([^']+)'/)?.[1];
    const methods = source.match(/'Access-Control-Allow-Methods':\s*'([^']+)'/)?.[1];
    return { origin, headers, methods };
  };
  const proxyCors = corsOf(proxyFn);
  const adminCors = corsOf(adminFn);
  check(
    '2e. CORS admin-api-keys совпадает с gemini-proxy (origin/headers)',
    adminCors.origin === proxyCors.origin && adminCors.headers === proxyCors.headers,
    `${adminCors.origin} | ${adminCors.headers}`
  );
  check(
    '2f. методы admin-api-keys: GET, POST, DELETE, OPTIONS',
    ['GET', 'POST', 'DELETE', 'OPTIONS'].every((m) => adminCors.methods?.includes(m)),
    adminCors.methods
  );

  // Тело регулярки берём по имени константы (клиент — GEMINI_API_KEY_RE,
  // сервер — GEMINI_KEY_RE) и сравниваем побайтово: одна проверка на двоих.
  const patternSourceOf = (source, where, name) => {
    const literal = source.match(new RegExp(`(?:export )?const ${name} = \\/(.+)\\/;`))?.[1];
    if (!literal) throw new Error(`Не найден regex формата ключа: ${where}`);
    return literal;
  };
  const serverPattern = patternSourceOf(adminFn, 'admin-api-keys', 'GEMINI_KEY_RE');
  const clientPattern = patternSourceOf(clientData, 'src/data/apiKeys.ts', 'GEMINI_API_KEY_RE');
  const serverRe = new RegExp(serverPattern);
  const clientRe = new RegExp(clientPattern);
  check(
    '2g. формат ключа на клиенте и на сервере — одна регулярка',
    serverPattern === clientPattern && serverRe.source === clientRe.source,
    `/${serverPattern}/`
  );
  check(
    '2g*. префикс AIza больше не зашит в валидацию',
    !serverPattern.includes('AIza') && !clientPattern.includes('AIza'),
    `/${serverPattern}/`
  );
  const samples = [
    [VALID_KEY, true], // старый standard key, 39 символов
    [AUTH_KEY, true], // новый auth key AQ.…
    [`AQ.${'A'.repeat(400)}`, true], // будущие длинные ключи (лимит 512)
    [`AIza${'x'.repeat(38)}`, true], // длина — не контракт: 38 символов не блокируем
    ['short_key_18_chars', false], // 18 символов — короче минимума
    [`AIza${'x'.repeat(600)}`, false], // 604 символа — длиннее лимита
    ['AQ.ключ-кириллицей-0123456789', false], // не ASCII
    [` ${VALID_KEY} `, false], // пробелы (форма тримит до проверки)
  ];
  check(
    '2h. валидация ключа: оба формата проходят, мусор и границы — нет (клиент + сервер)',
    samples.every(([key, ok]) => serverRe.test(key) === ok && clientRe.test(key) === ok)
  );

  // ── 3. Миграция ──────────────────────────────────────────────────────────
  const migrations = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql'));
  const versions = migrations.map((f) => f.split('_')[0]);
  check(
    '3a. версии миграций уникальны',
    new Set(versions).size === versions.length,
    versions.length + ' файлов'
  );
  const migrationName = '00000000000017_user_api_keys.sql';
  check('3b. миграция user_api_keys на месте', migrations.includes(migrationName));
  const migration = read(`supabase/migrations/${migrationName}`);
  check(
    '3c. RLS включён, 4 политики только для своей строки и роли admin',
    /enable row level security/i.test(migration) &&
      (migration.match(/create policy "user_api_keys_/g) || []).length === 4 &&
      (migration.match(/has_role\(auth\.uid\(\), 'admin'\)/g) || []).length >= 4 &&
      (migration.match(/user_id = auth\.uid\(\)/g) || []).length >= 4
  );
  check(
    '3d. updated_at обновляется триггером',
    migration.includes('user_api_keys_updated_at') && /before update/i.test(migration)
  );
  check(
    '3e. anon не имеет доступа к таблице',
    /revoke all on public\.user_api_keys from anon/i.test(migration)
  );

  // ── 4. Data-слой ─────────────────────────────────────────────────────────
  const { apiKeys, ApiKeyError } = await vite.ssrLoadModule('/src/data/apiKeys.ts');

  const status = await apiKeys.status();
  check(
    '4a. демо-режим: статуса нет, флаг demo выставлен',
    status.key === null && status.demo === true,
    JSON.stringify(status)
  );

  const badFormat = await apiKeys.save('AIza-короткий').then(
    () => null,
    (error) => error
  );
  check(
    '4b. формат проверяется до сети: мусор → invalid_key_format',
    badFormat instanceof ApiKeyError && badFormat.code === 'invalid_key_format',
    badFormat?.code
  );

  const demoSave = await apiKeys.save(VALID_KEY).then(
    () => null,
    (error) => error
  );
  check(
    '4c. демо-режим: сохранение → demo_mode, ключ никуда не уходит',
    demoSave instanceof ApiKeyError && demoSave.code === 'demo_mode',
    demoSave?.code
  );

  // Главная регрессия багрепорта: новый auth-ключ AQ.… доходит до сети
  // (в демо-режиме это demo_mode), а не падает на «должен начинаться с AIza».
  const authSave = await apiKeys.save(AUTH_KEY).then(
    () => null,
    (error) => error
  );
  check(
    '4c*. новый ключ AQ.… проходит клиентскую валидацию (доходит до demo_mode)',
    authSave instanceof ApiKeyError && authSave.code === 'demo_mode',
    authSave?.code
  );
  const clientCode = stripComments(clientData);
  check(
    '4c**. текст invalid_key_format больше не требует префикса AIza и 39 символов',
    !/начинаться с AIza|содержать 39/.test(clientCode) &&
      !/AIza\[0-9/.test(clientCode) &&
      !/AIza\[0-9/.test(stripComments(adminFn))
  );
  const demoRemove = await apiKeys.remove().then(
    () => null,
    (error) => error
  );
  check(
    '4d. демо-режим: удаление → demo_mode',
    demoRemove instanceof ApiKeyError && demoRemove.code === 'demo_mode'
  );

  // ── 5. SSR-рендер страницы настроек ──────────────────────────────────────
  const React = (await import('react')).default;
  const { renderToString } = await import('react-dom/server');
  // Provider берём из ТОГО ЖЕ (vite-SSR) инстанса react-query, что и компонент:
  // у vite-сборки @tanstack/react-query свой QueryClientContext, и провайдер из
  // node-инстанса компонент не увидит ("No QueryClient set").
  const { QueryClient, QueryClientProvider } = await vite.ssrLoadModule(
    '@tanstack/react-query'
  );
  const { API_KEY_ERROR_MESSAGES } = await vite.ssrLoadModule('/src/data/apiKeys.ts');
  const { API_KEY_QUERY_KEY, ApiKeySettings } = await vite.ssrLoadModule(
    '/src/components/admin/ApiKeySettings.tsx'
  );

  const renderSettings = (cached) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(API_KEY_QUERY_KEY, cached);
    return renderToString(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(ApiKeySettings)
      )
    );
  };

  const missingHtml = renderSettings({ key: null, demo: false });
  check(
    '5a. без ключа: баннер «Ключ не задан — озвучка недоступна» + статус «не задан»',
    missingHtml.includes('Ключ не задан — озвучка недоступна') &&
      missingHtml.includes('не задан')
  );
  check(
    '5b. без ключа: кнопки сохранения и удаления неактивны/не отрисованы',
    missingHtml.includes('Сохранить') &&
      !missingHtml.includes('Удалить ключ') &&
      // Плейсхолдер принимает оба формата ключа — новый AQ.… и старый AIza…
      missingHtml.includes('AQ.… или AIza…')
  );

  const connectedHtml = renderSettings({
    key: { provider: 'gemini', last4: '9xYZ', updated_at: '2026-09-23T10:00:00.000Z' },
    demo: false,
  });
  check(
    '5c. с ключом: показана маска ••••••••9xYZ (без префикса AIza) и статус «подключён»',
    connectedHtml.includes('••••••••9xYZ') &&
      connectedHtml.includes('подключён') &&
      !connectedHtml.includes('AIza…••••')
  );
  check(
    '5d. с ключом: есть замена и удаление, плейнтекста в разметке нет',
    connectedHtml.includes('Заменить') &&
      connectedHtml.includes('Удалить ключ') &&
      !connectedHtml.includes(VALID_KEY)
  );

  const demoHtml = renderSettings({ key: null, demo: true });
  check(
    '5e. демо-режим объяснён на странице, поля disabled',
    demoHtml.includes('Демо-режим: Supabase не настроен') &&
      demoHtml.includes(API_KEY_ERROR_MESSAGES.demo_mode.slice(0, 18)) &&
      (demoHtml.match(/disabled=""/g) || []).length >= 2
  );

  // ── 6. Роут, навигация, документация ─────────────────────────────────────
  check(
    '6a. роут /admin/settings объявлен (flat-файл, как остальные admin.*)',
    read('src/routes/admin.settings.tsx').includes("createFileRoute('/admin/settings')")
  );
  check(
    '6b. routeTree.gen.ts знает про /admin/settings',
    read('src/routeTree.gen.ts').includes("'/admin/settings'")
  );
  check(
    '6c. ссылка «Настройки» есть в шапке админки',
    read('src/components/layout/AdminHeader.tsx').includes('to="/admin/settings"')
  );

  const setup = read('SETUP_SUPABASE.md');
  check(
    '6d. SETUP_SUPABASE.md: деплой admin-api-keys и секрет шифрования',
    setup.includes('USER_KEY_ENC_SECRET') &&
      setup.includes('supabase functions deploy admin-api-keys')
  );
  check(
    '6e. SETUP_SUPABASE.md: ротация секрета удаляет мёртвые записи',
    setup.includes('delete from public.user_api_keys')
  );
} finally {
  await vite.close();
}

if (failures.length) {
  console.error(`\nunit-api-keys: провалено проверок — ${failures.length}`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exitCode = 1;
} else {
  console.log('\nunit-api-keys: все проверки пройдены');
}

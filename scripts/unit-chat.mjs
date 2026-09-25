/**
 * Unit-тесты support-чата: конвертация сообщений в формат Gemini и разбор SSE.
 *
 *   node scripts/unit-chat.mjs
 *
 * Проверяем без сети, Deno и браузера:
 *   1. `toGeminiContents`: assistant → model, строка → parts, части
 *      text / inlineData / image_url, разбор data-URL, пустые сообщения;
 *   2. `parseGeminiSSE`: буферизация по \n (фрейм может прийти разрезанным),
 *      пропуск комментариев и `thought: true`, остановка на `[DONE]`, abort;
 *   3. контракт edge-функции `chat`: одна модель (MODEL_ID), SSE-эндпоинт
 *      streamGenerateContent, systemInstruction, thinkingBudget с fallback,
 *      проксирование потока как text/event-stream;
 *   4. запреты ТЗ: `LOVABLE_API_KEY` и `GEMINI_API_KEY` не упоминаются в
 *      `src/**` (без комментариев — в них эти имена только объясняются).
 */
import { createServer } from 'vite';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { forceDemoMode, DEMO_SERVER_OPTIONS } from './lib/demo-mode.mjs';

forceDemoMode();

const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures.push(name);
};

const read = (path) => readFileSync(path, 'utf8');

/** Комментарии не считаем: в них мы объясняем, почему ключей здесь нет. */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Собирает SSE-поток из строк (или готовых байтов) — как придёт из сети. */
function streamOf(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

const vite = await createServer({ ...DEMO_SERVER_OPTIONS, mode: 'test' });

try {
  const { parseDataUrl, toGeminiContents } = await vite.ssrLoadModule(
    '/supabase/functions/_shared/gemini-chat.ts'
  );
  const { CHAT_DEMO_MESSAGE, CHAT_ERROR_MESSAGES, ChatError, parseGeminiSSE, streamChat } =
    await vite.ssrLoadModule('/src/data/chat.ts');

  // ── 1. Конвертация сообщений ──────────────────────────────────────────────
  const history = toGeminiContents([
    { role: 'user', content: 'Как загрузить мангу?' },
    { role: 'assistant', content: 'Откройте админку…' },
    { role: 'user', content: 'Не работает' },
  ]);
  check(
    '1a. assistant → model, остальные → user',
    JSON.stringify(history.map((item) => item.role)) === JSON.stringify(['user', 'model', 'user'])
  );
  check(
    '1b. строка → parts: [{ text }]',
    history[0].parts.length === 1 && history[0].parts[0].text === 'Как загрузить мангу?'
  );

  const withImage = toGeminiContents([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Что тут не так?' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
      ],
    },
  ]);
  check(
    '1c. text + image_url → parts: [{ text }, { inlineData }]',
    withImage[0].parts.length === 2 &&
      withImage[0].parts[0].text === 'Что тут не так?' &&
      withImage[0].parts[1].inlineData?.mimeType === 'image/jpeg' &&
      withImage[0].parts[1].inlineData?.data === 'QUJD'
  );

  const inlinePart = toGeminiContents([
    { role: 'user', content: [{ type: 'inlineData', mimeType: 'image/png', data: 'QUJD' }] },
  ]);
  check(
    '1d. inlineData прокидывается как inlineData',
    inlinePart[0].parts[0].inlineData?.mimeType === 'image/png' &&
      inlinePart[0].parts[0].inlineData?.data === 'QUJD'
  );

  check(
    '1e. data-URL разбирается в mimeType + base64',
    JSON.stringify(parseDataUrl('data:image/jpeg;base64,xxx')) ===
      JSON.stringify({ mimeType: 'image/jpeg', data: 'xxx' })
  );
  check(
    '1f. не-data-URL и не-base64 data-URL отбрасываются',
    parseDataUrl('https://example.com/page.png') === null &&
      parseDataUrl('data:image/png,%89PNG') === null
  );

  const withEmpty = toGeminiContents([
    { role: 'user', content: '   ' },
    { role: 'assistant', content: [] },
    { role: 'user', content: 'Один вопрос' },
  ]);
  check(
    '1g. пустые сообщения выбрасываются (Gemini отвечает 400 на parts: [])',
    withEmpty.length === 1 && withEmpty[0].parts[0].text === 'Один вопрос'
  );

  check('1h. мусор вместо массива сообщений не ломает конвертацию', toGeminiContents(null).length === 0);

  // ── 2. Разбор SSE ─────────────────────────────────────────────────────────
  const sseChunks = [
    'data: {"candidates":[{"content":{"parts":[{"text":"Привет"}]}}]}\n\n',
    ': keep-alive\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"При"}]}}]}', // фрейм разрезан посреди строки
    '\ndata: {"candidates":[{"content":{"parts":[{"text":"РАЗМЫШЛЕНИЕ","thought":true}]}}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"!"}]}}]}\n\n',
    'data: [DONE]\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"после DONE"}]}}]}\n\n',
  ];

  const tokens = [];
  for await (const token of parseGeminiSSE(streamOf(sseChunks))) tokens.push(token);

  check(
    '2a. токены собираются по мере поступления (разрезанный фрейм не теряется)',
    JSON.stringify(tokens) === JSON.stringify(['Привет', 'При', '!']),
    JSON.stringify(tokens)
  );

  const aborted = new AbortController();
  aborted.abort();
  const afterAbort = [];
  for await (const token of parseGeminiSSE(streamOf(sseChunks), aborted.signal)) afterAbort.push(token);
  check('2b. отменённый streamChat не отдаёт ни одного токена', afterAbort.length === 0);

  // несколько parts в одном чанке склеиваются (Gemini иногда шлёт их отдельно)
  const multiPart = [];
  for await (const token of parseGeminiSSE(
    streamOf(['data: {"candidates":[{"content":{"parts":[{"text":"а"},{"text":"б"}]}}]}\n\n'])
  )) {
    multiPart.push(token);
  }
  check('2c. несколько text-частей в одном чанке склеиваются', multiPart.join('') === 'аб');

  check(
    '2d. CHAT_ERROR_MESSAGES описывает все коды ChatError',
    ['unauthorized', 'gemini_key_missing', 'rate_limit', 'unknown'].every(
      (code) => typeof CHAT_ERROR_MESSAGES[code] === 'string' && CHAT_ERROR_MESSAGES[code]
    )
  );

  // Демо-режим (тесты идут с forceDemoMode): без VITE_SUPABASE_* обращаться
  // некуда, и сообщение обязано говорить про конфиг окружения, а не про
  // незадеплоенную функцию — иначе админ чинит не то.
  let demoError = null;
  try {
    await streamChat({ messages: [{ role: 'user', content: 'привет' }] });
  } catch (error) {
    demoError = error;
  }
  check(
    '2e. в демо-режиме streamChat ругается на окружение, а не на деплой функции',
    demoError instanceof ChatError &&
      demoError.message === CHAT_DEMO_MESSAGE &&
      /Демо-режим/.test(demoError.message) &&
      !/deploy/.test(demoError.message),
    demoError?.message
  );

  // ── 3. Контракт edge-функции chat ─────────────────────────────────────────
  const fn = read('supabase/functions/chat/index.ts');
  // Ищем именно версию модели (`gemini-<цифра>…`), чтобы импорты вида
  // `../_shared/gemini-chat.ts` не считались «моделью».
  const models = [...stripComments(fn).matchAll(/gemini-\d[a-z0-9.\-]*/gi)].map((match) => match[0]);

  check(
    '3a. в chat/index.ts ровно одна модель — gemini-2.5-flash (MODEL_ID)',
    models.length === 1 && models[0] === 'gemini-2.5-flash' && fn.includes("const MODEL_ID = 'gemini-2.5-flash'"),
    models.join(', ')
  );
  check(
    '3b. стрим идёт на streamGenerateContent с alt=sse',
    fn.includes(':streamGenerateContent?alt=sse')
  );
  check(
    '3c. systemInstruction + thinkingBudget 0 с fallback на 1',
    fn.includes('systemInstruction') && fn.includes('thinkingBudget: 0') && fn.includes('thinkingBudget}') === false
  );
  check(
    '3d. поток проксируется как text/event-stream (no-cache)',
    fn.includes("'Content-Type': 'text/event-stream'") &&
      fn.includes("'Cache-Control': 'no-cache'") &&
      fn.includes('new Response(upstream.body')
  );
  check(
    '3e. ключ берётся из user_api_keys с фолбэком на owner/админа',
    fn.includes("from('user_api_keys')") &&
      fn.includes("from('user_roles')") &&
      fn.includes('gemini_key_missing') &&
      fn.includes('gemini_key_unreadable')
  );
  check(
    '3f. системный промпт — поддержка hikkomanga на русском',
    fn.includes('ассистент поддержки сайта hikkomanga') && fn.includes('на русском языке')
  );
  check(
    '3g. ADMIN-роль в чате не требуется (только JWT)',
    !fn.includes("role_to_check: 'admin'")
  );

  // ── 4. Запреты ТЗ по клиенту ──────────────────────────────────────────────
  const srcFiles = walkFiles('src');
  const offenders = { lovable: [], geminiKey: [], models: [] };

  for (const file of srcFiles) {
    const code = stripComments(read(file));
    if (code.includes('LOVABLE_API_KEY')) offenders.lovable.push(file);
    if (/\bGEMINI_API_KEY\b/.test(code)) offenders.geminiKey.push(file);
    if (file.endsWith('data/chat.ts') && /gemini-\d/.test(code)) offenders.models.push(file);
  }

  check(
    '4a. LOVABLE_API_KEY не упоминается в src/** (шлюза Lovable у проекта нет)',
    offenders.lovable.length === 0,
    offenders.lovable.join(', ')
  );
  check(
    '4b. GEMINI_API_KEY не упоминается в src/** (ключ живёт только на сервере)',
    offenders.geminiKey.length === 0,
    offenders.geminiKey.join(', ')
  );
  check(
    '4c. клиент чата не знает имён моделей — их выбирает edge-функция',
    offenders.models.length === 0,
    offenders.models.join(', ')
  );
  check(
    '4d. клиент обходит invoke только там, где нужен SSE/audio (chat → invoke)',
    read('src/data/chat.ts').includes("functions.invoke('chat'")
  );
} finally {
  await vite.close();
}

if (failures.length) {
  console.error(`\nunit-chat: провалено проверок — ${failures.length}`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exitCode = 1;
} else {
  console.log('\nunit-chat: все проверки пройдены');
}

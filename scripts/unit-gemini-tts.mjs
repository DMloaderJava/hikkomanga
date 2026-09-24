/**
 * Unit-тесты сборки запросов Gemini TTS и анализа.
 *
 *   node scripts/unit-gemini-tts.mjs
 *
 * Что проверяется без сети, браузера и Deno:
 *   1. форма запроса к Gemini 3.8 TTS: одиночный голос, диалог на двух
 *      персонажей, разбиение главы с 3+ персонажами на чанки (лимит Gemini —
 *      2 голоса на запрос) и склейка PCM обратно в один поток;
 *   2. голоса: валидное имя из voiceMap, дефолты Kore/Puck, откат на дефолт
 *      для неизвестного имени (иначе Gemini отвечает 400);
 *   3. авторизация: ключ уходит заголовком x-goog-api-key, `?key=` в проекте
 *      не осталось — новые auth-ключи `AQ.…` с query-параметром не работают;
 *   4. контракт с клиентом: ответ `/tts` читается тем же путём, что и раньше
 *      (`candidates[0].content.parts[0].inlineData.data`);
 *   5. прод и dev не разъезжаются: edge-функция gemini-proxy и dev-middleware
 *      в vite.config.ts используют один модуль `_shared/gemini-tts.ts`;
 *   6. ошибки: пустая озвучка и «слишком много персонажей» — понятные коды,
 *      а не таймаут edge-функции.
 */
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import { forceDemoMode, DEMO_SERVER_OPTIONS } from './lib/demo-mode.mjs';

forceDemoMode();

const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures.push(name);
};

const read = (path) => readFileSync(path, 'utf8');

const vite = await createServer({ ...DEMO_SERVER_OPTIONS, mode: 'test' });

const line = (speaker, text) => ({ speaker, text });

try {
  const {
    DEFAULT_TTS_VOICES,
    GEMINI_ANALYZE_MODEL,
    GEMINI_TTS_MODEL,
    PREBUILT_TTS_VOICES,
    TTS_MAX_REQUESTS,
    TTS_MAX_SPEAKERS_PER_REQUEST,
    TtsPlanError,
    buildTtsResponse,
    extractTtsAudio,
    geminiEndpoint,
    geminiErrorMessage,
    geminiHeaders,
    mergeTtsAudio,
    normalizeTtsVoice,
    planTtsRequests,
  } = await vite.ssrLoadModule('/supabase/functions/_shared/gemini-tts.ts');

  // ── 1. Модели и эндпоинты ────────────────────────────────────────────────
  check(
    '1a. TTS идёт на gemini-3.8-flash-tts (GA), анализ — на gemini-3.8-flash',
    GEMINI_TTS_MODEL === 'gemini-3.8-flash-tts' && GEMINI_ANALYZE_MODEL === 'gemini-3.8-flash',
    `${GEMINI_TTS_MODEL} / ${GEMINI_ANALYZE_MODEL}`
  );
  check(
    '1b. эндпоинт — generateContent, без ?key= в URL',
    geminiEndpoint(GEMINI_TTS_MODEL).endsWith('/gemini-3.8-flash-tts:generateContent') &&
      !geminiEndpoint(GEMINI_TTS_MODEL).includes('?')
  );
  const headers = geminiHeaders('AQ.unit-test-key-0123456789');
  check(
    '1c. ключ уходит заголовком x-goog-api-key (так работают AQ.… ключи)',
    headers['x-goog-api-key'] === 'AQ.unit-test-key-0123456789' &&
      !JSON.stringify(headers).includes('?key=')
  );
  check(
    '1d. список prebuilt-голосов — 30 имён, включая Kore и Puck',
    PREBUILT_TTS_VOICES.length === 30 &&
      ['Kore', 'Puck'].every((voice) => PREBUILT_TTS_VOICES.includes(voice))
  );
  check(
    '1e. лимит Gemini — 2 голоса на запрос',
    TTS_MAX_SPEAKERS_PER_REQUEST === 2
  );
  check(
    '1f. нормализация голоса: регистр и мусор',
    normalizeTtsVoice('kore') === 'Kore' &&
      normalizeTtsVoice('  Puck ') === 'Puck' &&
      normalizeTtsVoice('Fola') === null && // голоса «Fola» у Gemini нет
      normalizeTtsVoice(undefined) === null
  );

  // ── 2. Один персонаж ─────────────────────────────────────────────────────
  const single = planTtsRequests([line('Narrator', 'Пролог.'), line('Narrator', 'Глава первая.')]);
  check('2a. один персонаж → один запрос', single.length === 1, String(single.length));
  const singleBody = single[0].body;
  const singleSpeechConfig = singleBody.generationConfig.speechConfig;
  check(
    '2b. один персонаж → single-speaker voiceConfig, без multiSpeaker',
    singleSpeechConfig.voiceConfig?.prebuiltVoiceConfig?.voiceName === 'Kore' &&
      !singleSpeechConfig.multiSpeakerVoiceConfig
  );
  check(
    '2c. каждая реплика — отдельный part, в single-speaker без speech_metadata',
    singleBody.contents[0].parts.length === 2 &&
      singleBody.contents[0].parts.every((part) => !('speech_metadata' in part)) &&
      singleBody.generationConfig.responseModalities.join(',') === 'AUDIO'
  );

  // ── 3. Диалог на двух персонажей ─────────────────────────────────────────
  const duo = planTtsRequests([
    line('Narrator', 'Он вошёл.'),
    line('Hikki', 'Привет.'),
    line('Narrator', 'Тишина.'),
    line('Hikki', 'Ну?'),
  ]);
  const duoBody = duo[0].body;
  const duoConfig = duoBody.generationConfig.speechConfig.multiSpeakerVoiceConfig;
  check('3a. два персонажа → по-прежнему один запрос', duo.length === 1, String(duo.length));
  check(
    '3b. multiSpeakerVoiceConfig на двух персонажей с prebuiltVoiceConfig.voiceName',
    duoConfig.speakerVoiceConfigs.length === 2 &&
      duoConfig.speakerVoiceConfigs.every(
        (config) => typeof config.voiceConfig.prebuiltVoiceConfig.voiceName === 'string'
      ) &&
      duoConfig.speakerVoiceConfigs.map((c) => c.speaker).join(',') === 'Narrator,Hikki'
  );
  check(
    '3c. у каждого part есть speech_metadata.speaker (иначе Gemini не знает, кто говорит)',
    duoBody.contents[0].parts.map((part) => part.speech_metadata.speaker).join(',') ===
      'Narrator,Hikki,Narrator,Hikki'
  );
  check(
    '3d. без voiceMap голоса разные: Kore и Puck',
    duoConfig.speakerVoiceConfigs.map((c) => c.voiceConfig.prebuiltVoiceConfig.voiceName).join(',') ===
      DEFAULT_TTS_VOICES.join(',')
  );

  const mapped = planTtsRequests(
    [line('A', 'раз'), line('B', 'два')],
    { A: 'Fenrir', B: 'kore' } // «kore» в другом регистре — приводим к канону
  );
  check(
    '3e. voiceMap уважается и нормализуется по регистру',
    mapped[0].voices.A === 'Fenrir' && mapped[0].voices.B === 'Kore'
  );

  const bogus = planTtsRequests([line('A', 'раз'), line('B', 'два')], { A: 'Fola' });
  check(
    '3f. неизвестный голос из voiceMap → дефолт, а не 400 от Gemini',
    bogus[0].voices.A === 'Kore'
  );

  // ── 4. Три и более персонажей → чанки ────────────────────────────────────
  const trio = [line('A', 'а1'), line('B', 'б1'), line('C', 'в1'), line('A', 'а2')];
  const chunks = planTtsRequests(trio);
  check(
    '4a. три персонажа → два чанка по ≤2 голоса',
    chunks.length === 2 && chunks.every((chunk) => chunk.speakers.length <= TTS_MAX_SPEAKERS_PER_REQUEST),
    chunks.map((chunk) => chunk.speakers.join('+')).join(' | ')
  );
  const chunkParts = chunks.flatMap((chunk) => chunk.body.contents[0].parts);
  check(
    '4b. порядок и текст реплик при разбиении не меняются',
    chunkParts.length === trio.length &&
      chunkParts.map((part) => part.text).join(',') === 'а1,б1,в1,а2' &&
      chunkParts.map((part) => part.speech_metadata.speaker).join(',') === 'A,B,C,A'
  );
  const voiceBySpeaker = Object.assign({}, ...chunks.map((chunk) => chunk.voices));
  check(
    '4c. голос персонажа одинаков во всех чанках (A → Kore, B → Puck, C → Kore)',
    chunks.every((chunk) => chunk.speakers.every((speaker) => chunk.voices[speaker] === voiceBySpeaker[speaker])) &&
      voiceBySpeaker.A === 'Kore' &&
      voiceBySpeaker.B === 'Puck' &&
      voiceBySpeaker.C === 'Kore'
  );
  check(
    '4d. каждый чанк — валидный multi/single-speaker запрос',
    chunks.every((chunk) => {
      const config = chunk.body.generationConfig.speechConfig;
      return chunk.speakers.length === 1
        ? Boolean(config.voiceConfig)
        : config.multiSpeakerVoiceConfig.speakerVoiceConfigs.length === chunk.speakers.length;
    })
  );

  // 16 «персонажей по одной реплике» = ровно 8 чанков по 2 голоса — потолок.
  const wide = planTtsRequests(
    Array.from({ length: TTS_MAX_REQUESTS * TTS_MAX_SPEAKERS_PER_REQUEST }, (_, index) =>
      line(`S${index + 1}`, `реплика ${index + 1}`)
    )
  );
  check(
    '4e. 16 персонажей влезают ровно в лимит запросов',
    wide.length === TTS_MAX_REQUESTS,
    String(wide.length)
  );
  const overflow = await Promise.resolve()
    .then(() => planTtsRequests(Array.from({ length: 40 }, (_, i) => line(`S${i + 1}`, `т${i + 1}`))))
    .then(() => null, (error) => error);
  check(
    '4f. слишком много персонажей → tts_too_many_requests, а не таймаут edge-функции',
    overflow instanceof TtsPlanError &&
      overflow.code === 'tts_too_many_requests' &&
      overflow.message.includes(String(TTS_MAX_REQUESTS))
  );

  // ── 5. Пустые реплики ────────────────────────────────────────────────────
  const empty = await Promise.resolve()
    .then(() => planTtsRequests([line('Narrator', '   ')], {}))
    .then(() => null, (error) => error);
  check(
    '5a. пустые/пробельные реплики → tts_no_lines (не отправляем пустой part в Gemini)',
    empty instanceof TtsPlanError && empty.code === 'tts_no_lines'
  );

  // ── 6. Склейка аудио и форма ответа ──────────────────────────────────────
  const bytes = (arr) => Buffer.from(arr).toString('base64');
  const merged = mergeTtsAudio([bytes([1, 2, 3]), bytes([4, 5])]);
  check(
    '6a. PCM-чанки склеиваются в один base64 без потерь',
    Buffer.from(merged, 'base64').equals(Buffer.from([1, 2, 3, 4, 5])),
    merged
  );
  check(
    '6b. один чанк возвращается как есть (с вырезанными пробелами)',
    mergeTtsAudio(['  ' + bytes([9, 8]) + '\n']) === bytes([9, 8])
  );
  check('6c. пустой список чанков → пустая строка', mergeTtsAudio([]) === '');

  const response = buildTtsResponse(merged);
  check(
    '6d. ответ /tts читается клиентом по старому пути inlineData.data',
    extractTtsAudio(response) === merged &&
      extractTtsAudio({ candidates: [{ content: { parts: [{ inlineData: { data: null } }] } }] }) === null
  );
  check(
    '6e. в ответе нет лишних полей с ключом/ошибкой',
    !JSON.stringify(response).toLowerCase().includes('key') &&
      !('error' in response)
  );
  check(
    '6f. нормализация ошибки Gemini: сообщение из error.message, иначе — статус',
    geminiErrorMessage({ error: { message: 'API key not valid. Please pass a valid API key.' } }, 'fallback') ===
      'API key not valid. Please pass a valid API key.' &&
      geminiErrorMessage({ error: { status: 'RESOURCE_EXHAUSTED' } }, 'Квота') === 'Квота (RESOURCE_EXHAUSTED)'
  );

  // ── 7. Прод и dev не разъезжаются ────────────────────────────────────────
  const proxyFn = read('supabase/functions/gemini-proxy/index.ts');
  const viteConfig = read('vite.config.ts');
  const sharedSource = read('supabase/functions/_shared/gemini-tts.ts');

  check(
    '7a. gemini-proxy использует общий модуль (модели, план, склейка)',
    proxyFn.includes("from \"../_shared/gemini-tts.ts\"") &&
      proxyFn.includes('planTtsRequests') &&
      proxyFn.includes('mergeTtsAudio') &&
      proxyFn.includes('geminiHeaders')
  );
  check(
    '7b. dev-middleware использует тот же модуль (прод = dev)',
    viteConfig.includes("from './supabase/functions/_shared/gemini-tts.ts'") &&
      viteConfig.includes('planTtsRequests') &&
      viteConfig.includes('mergeTtsAudio')
  );
  // Комментарии не считаем: в них `?key=` упоминается как раз с пометкой
  // «так нельзя». Ищем именно использование в коде/URL.
  const stripComments = (source) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  check(
    '7c. `?key=` не остался ни в edge-функции, ни в dev-middleware, ни в общем модуле',
    [proxyFn, viteConfig, sharedSource].every((source) => !stripComments(source).includes('?key='))
  );
  check(
    '7d. старые модели 2.5 в проекте не используются',
    !read('supabase/functions/gemini-proxy/index.ts').includes('gemini-2.5') &&
      !viteConfig.includes('gemini-2.5')
  );
  check(
    '7e. формат ключа в admin-api-keys больше не привязан к AIza',
    !read('supabase/functions/admin-api-keys/index.ts').includes('AIza[')
  );

  // ── 8. Клиент: ошибки edge-функции доходят до админа ─────────────────────
  const clientSource = read('src/data/gemini.ts');
  check(
    '8a. клиент показывает message edge-функции, а не 404 dev-proxy',
    clientSource.includes('edgeErrorFrom') &&
      clientSource.includes('devProxyError') &&
      clientSource.includes('gemini_upstream_error') === false
  );
} finally {
  await vite.close();
}

if (failures.length) {
  console.error(`\nunit-gemini-tts: провалено проверок — ${failures.length}`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exitCode = 1;
} else {
  console.log('\nunit-gemini-tts: все проверки пройдены');
}

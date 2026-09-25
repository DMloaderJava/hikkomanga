/**
 * Unit-тесты dialog-tts: разбор расшифровки, план запросов и склейка WAV.
 *
 *   node scripts/unit-dialog-tts.mjs
 *
 * Проверяем без сети, Deno и браузера:
 *   1. константы контракта (модель, белый список голосов, лимиты);
 *   2. парсинг транскрипта: 1/2 спикера, продолжения без префикса, пустой
 *      ввод, текст без префиксов, >8 спикеров, >40 реплик (только 3+);
 *   3. форма запросов к Gemini по режимам: один голос, два голоса
 *      (`speaker: "Speaker 1"` / `"Speaker 2"`), по запросу на реплику без
 *      префикса в тексте;
 *   4. голоса: неизвестное имя → круг, один голос не повторяется;
 *   5. WAV: заголовок RIFF/WAVE, пауза 10560 байт на 24 kHz mono 16-bit,
 *      разбор RIFF-ответа и mimeType `audio/L16`;
 *   6. контракт edge-функции: audio/wav, последовательные запросы, общий
 *      модуль, ключ заголовком (не `?key=`), и совпадение белых списков
 *      клиента и сервера.
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
/** Комментарии не считаются: в них мы как раз объясняем «так нельзя». */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const base64Of = (bytes) => Buffer.from(bytes).toString('base64');
const ascii = (bytes, offset, length) =>
  String.fromCharCode(...Array.from(bytes.slice(offset, offset + length)));
const catchError = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
};

const vite = await createServer({ ...DEMO_SERVER_OPTIONS, mode: 'test' });

try {
  const {
    DEFAULT_PCM_FORMAT,
    DIALOG_TTS_LIMITS,
    DIALOG_TTS_MODEL,
    DIALOG_TTS_VOICES,
    DialogTtsError,
    buildDialogWav,
    extractInlineAudio,
    parseAudioFormat,
    parseDialogTranscript,
    pcmToWav,
    planDialogTts,
    readRiffAudio,
    resolveDialogVoices,
  } = await vite.ssrLoadModule('/supabase/functions/_shared/gemini-tts.ts');

  // ── 1. Константы контракта ────────────────────────────────────────────────
  check(
    '1a. модель диалогов — gemini-3.1-flash-tts-preview',
    DIALOG_TTS_MODEL === 'gemini-3.1-flash-tts-preview',
    DIALOG_TTS_MODEL
  );
  check(
    '1b. белый список голосов — 8 тембров из ТЗ',
    JSON.stringify([...DIALOG_TTS_VOICES]) ===
      JSON.stringify(['Charon', 'Kore', 'Puck', 'Aoede', 'Fenrir', 'Leda', 'Zephyr', 'Orus'])
  );
  check(
    '1c. лимиты: 6000 символов, 8 спикеров, 40 реплик, пауза 220 мс',
    DIALOG_TTS_LIMITS.maxChars === 6000 &&
      DIALOG_TTS_LIMITS.maxSpeakers === 8 &&
      DIALOG_TTS_LIMITS.maxReplies === 40 &&
      DIALOG_TTS_LIMITS.pauseMs === 220 &&
      DIALOG_TTS_LIMITS.sampleRate === 24000
  );

  // ── 2. Парсинг транскрипта ────────────────────────────────────────────────
  const one = parseDialogTranscript('Speaker 1: Привет');
  check(
    '2a. один спикер, простой текст → одна реплика',
    one.length === 1 && one[0].speaker === 1 && one[0].text === 'Привет'
  );

  const two = parseDialogTranscript(
    'Speaker 1: Ребята, начинаем?\nSpeaker 2: Я сказала тебе прекратить!'
  );
  check(
    '2b. два спикера → две реплики с верными номерами',
    two.length === 2 &&
      two[0].speaker === 1 &&
      two[0].text === 'Ребята, начинаем?' &&
      two[1].speaker === 2 &&
      two[1].text === 'Я сказала тебе прекратить!'
  );

  const continued = parseDialogTranscript(
    'Speaker 1: Первая часть реплики\nпродолжение без префикса\nSpeaker 2: Ответ'
  );
  check(
    '2c. строки без префикса приклеиваются к предыдущей реплике через пробел',
    continued.length === 2 && continued[0].text === 'Первая часть реплики продолжение без префикса'
  );

  const emptyError = catchError(() => parseDialogTranscript('   \n  '));
  check(
    '2d. пустой транскрипт → empty_text «Текст пуст»',
    emptyError instanceof DialogTtsError &&
      emptyError.code === 'empty_text' &&
      emptyError.message === 'Текст пуст'
  );

  const noPrefixError = catchError(() => parseDialogTranscript('просто текст\nбез префиксов'));
  check(
    '2e. нет ни одной реплики → no_lines «Не найдено реплик»',
    noPrefixError instanceof DialogTtsError &&
      noPrefixError.code === 'no_lines' &&
      noPrefixError.message === 'Не найдено реплик'
  );

  const tooManySpeakers = catchError(() =>
    parseDialogTranscript(
      Array.from({ length: 9 }, (_, index) => `Speaker ${index + 1}: реплика`).join('\n')
    )
  );
  check(
    '2f. 9 спикеров → too_many_speakers «Слишком много спикеров (макс. 8)»',
    tooManySpeakers instanceof DialogTtsError &&
      tooManySpeakers.code === 'too_many_speakers' &&
      tooManySpeakers.message === 'Слишком много спикеров (макс. 8)'
  );

  const tooManyReplies = catchError(() =>
    parseDialogTranscript(
      Array.from({ length: 41 }, (_, index) => `Speaker ${(index % 3) + 1}: реплика`).join('\n')
    )
  );
  check(
    '2g. 41 реплика у 3 спикеров → too_many_replies «Слишком много реплик (макс. 40)»',
    tooManyReplies instanceof DialogTtsError &&
      tooManyReplies.code === 'too_many_replies' &&
      tooManyReplies.message === 'Слишком много реплик (макс. 40)'
  );

  const fortyReplies = parseDialogTranscript(
    Array.from({ length: 40 }, (_, index) => `Speaker ${(index % 3) + 1}: реплика`).join('\n')
  );
  check('2h. 40 реплик у 3 спикеров — принимаются', fortyReplies.length === 40);

  const duetLong = parseDialogTranscript(
    Array.from({ length: 45 }, (_, index) => `Speaker ${(index % 2) + 1}: реплика`).join('\n')
  );
  check(
    '2i. лимит 40 реплик не применяется к диалогу на два голоса',
    duetLong.length === 45
  );

  const long = parseDialogTranscript(`Speaker 1: ${'а'.repeat(7000)}`);
  check(
    '2j. транскрипт обрезается до 6000 символов ДО разбора',
    long[0].text.length === 6000 - 'Speaker 1: '.length,
    String(long[0].text.length)
  );

  // ── 3. Форма запросов по режимам ──────────────────────────────────────────
  const single = planDialogTts(parseDialogTranscript('Speaker 1: Привет'));
  const singleBody = single.requests[0]?.body;
  check(
    '3a. 1 спикер → один запрос, singleSpeaker-voiceConfig',
    single.mode === 'single' &&
      single.requests.length === 1 &&
      singleBody?.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName ===
        'Charon' &&
      !singleBody?.generationConfig?.speechConfig?.multiSpeakerVoiceConfig
  );
  check(
    '3a*. текст запроса — транскрипт `## Transcript:` с префиксом Speaker 1',
    singleBody?.contents?.[0]?.parts?.[0]?.text === '## Transcript:\nSpeaker 1: Привет',
    String(singleBody?.contents?.[0]?.parts?.[0]?.text)
  );
  check(
    '3a**. responseModalities = [AUDIO]',
    JSON.stringify(singleBody?.generationConfig?.responseModalities) === '["AUDIO"]'
  );

  const duet = planDialogTts(
    parseDialogTranscript('Speaker 1: Привет\nSpeaker 2: И тебе привет')
  );
  const duetConfig = duet.requests[0]?.body?.generationConfig?.speechConfig?.multiSpeakerVoiceConfig;
  check(
    '3b. 2 спикера → один запрос, ровно две записи speakerVoiceConfigs',
    duet.mode === 'duet' &&
      duet.requests.length === 1 &&
      duetConfig?.speakerVoiceConfigs?.length === 2
  );
  check(
    '3b*. speaker-строки буквально совпадают с префиксами текста',
    duetConfig?.speakerVoiceConfigs?.[0]?.speaker === 'Speaker 1' &&
      duetConfig?.speakerVoiceConfigs?.[1]?.speaker === 'Speaker 2' &&
      duet.requests[0].body.contents[0].parts[0].text.includes('Speaker 1: Привет') &&
      duet.requests[0].body.contents[0].parts[0].text.includes('Speaker 2: И тебе привет')
  );
  check(
    '3b**. голоса в multiSpeakerVoiceConfig не совпадают',
    duetConfig?.speakerVoiceConfigs?.[0]?.voiceConfig?.prebuiltVoiceConfig?.voiceName !==
      duetConfig?.speakerVoiceConfigs?.[1]?.voiceConfig?.prebuiltVoiceConfig?.voiceName
  );

  const trio = planDialogTts(
    parseDialogTranscript('Speaker 1: раз\nSpeaker 2: два\nSpeaker 3: три')
  );
  check(
    '3c. 3+ спикера → отдельный запрос на каждую реплику',
    trio.mode === 'multi' && trio.requests.length === 3
  );
  check(
    '3c*. в запросах режима 3+ только текст реплики, без префикса Speaker N:',
    trio.requests.every((request) => !request.text.startsWith('Speaker')) &&
      trio.requests[0].body.contents[0].parts[0].text === 'раз' &&
      trio.requests[2].body.contents[0].parts[0].text === 'три'
  );
  check(
    '3c**. у каждой реплики одиночный voiceConfig, multiSpeaker нет',
    trio.requests.every(
      (request) =>
        request.body.generationConfig.speechConfig.voiceConfig?.prebuiltVoiceConfig?.voiceName ===
          request.voice && !request.body.generationConfig.speechConfig.multiSpeakerVoiceConfig
    )
  );
  check(
    '3d. голоса 3+ спикеров идут по кругу: Charon → Kore → Puck',
    trio.requests[0].voice === 'Charon' &&
      trio.requests[1].voice === 'Kore' &&
      trio.requests[2].voice === 'Puck'
  );

  // ── 4. Голоса ─────────────────────────────────────────────────────────────
  const unknownVoice = resolveDialogVoices(parseDialogTranscript('Speaker 1: текст'), {
    '1': 'НеизвестныйГолос',
  });
  check('4a. неизвестное имя → голос по кругу (Charon)', unknownVoice[1] === 'Charon');

  const explicit = resolveDialogVoices(
    parseDialogTranscript('Speaker 1: а\nSpeaker 2: б'),
    { '2': 'leda' }
  );
  check(
    '4b. валидное имя из voices уважается (регистр не важен), первому — свободный Charon',
    explicit[1] === 'Charon' && explicit[2] === 'Leda'
  );

  const duplicated = resolveDialogVoices(
    parseDialogTranscript('Speaker 1: а\nSpeaker 2: б'),
    { '1': 'Kore', '2': 'Kore' }
  );
  check(
    '4c. один и тот же голос не достаётся двум спикерам',
    duplicated[1] === 'Kore' && duplicated[2] !== 'Kore',
    String(duplicated[2])
  );

  const eightSpeakers = resolveDialogVoices(
    parseDialogTranscript(Array.from({ length: 8 }, (_, i) => `Speaker ${i + 1}: реплика`).join('\n')),
    {}
  );
  check(
    '4d. восемь спикеров → восемь разных голосов',
    new Set(Object.values(eightSpeakers)).size === 8
  );

  // ── 5. WAV ────────────────────────────────────────────────────────────────
  const pcmChunk = (byte, size) => ({
    data: base64Of(new Uint8Array(size).fill(byte)),
    mimeType: 'audio/L16; rate=24000',
  });

  const wav = buildDialogWav([pcmChunk(1, 8), pcmChunk(2, 8)]);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const silence = 24000 * 0.22 * 2; // 10560

  check(
    '5a. заголовок WAV: RIFF…WAVE, fmt, data',
    ascii(wav, 0, 4) === 'RIFF' &&
      ascii(wav, 8, 4) === 'WAVE' &&
      ascii(wav, 12, 4) === 'fmt ' &&
      ascii(wav, 36, 4) === 'data'
  );
  check(
    '5b. поля fmt: PCM, моно, 24000 Гц, blockAlign 2, 16 бит',
    view.getUint32(16, true) === 16 &&
      view.getUint16(20, true) === 1 &&
      view.getUint16(22, true) === 1 &&
      view.getUint32(24, true) === 24000 &&
      view.getUint32(28, true) === 48000 &&
      view.getUint16(32, true) === 2 &&
      view.getUint16(34, true) === 16
  );
  check(
    '5c. между двумя репликами вставлена пауза 220 мс (10560 байт)',
    view.getUint32(40, true) === 16 + silence &&
      wav.byteLength === 44 + 16 + silence &&
      view.getUint32(4, true) === 36 + 16 + silence
  );
  check(
    '5d. пауза — нулевые байты, реплики на своих местах',
    wav.slice(44, 52).every((byte) => byte === 1) &&
      wav.slice(44 + 8, 44 + 8 + silence).every((byte) => byte === 0) &&
      wav.slice(44 + 8 + silence, 44 + 16 + silence).every((byte) => byte === 2)
  );

  const oneChunk = buildDialogWav([pcmChunk(1, 8)]);
  check(
    '5e. одна реплика → ни одной паузы',
    oneChunk.byteLength === 44 + 8
  );

  const innerFormat = { sampleRate: 22050, channels: 2, bitsPerSample: 16 };
  const innerWav = pcmToWav(new Uint8Array([9, 9, 9, 9]), innerFormat);
  const reWrapped = buildDialogWav([{ data: base64Of(innerWav), mimeType: 'audio/wav' }]);
  check(
    '5f. ответ с RIFF-заголовком разбирается в PCM и частота берётся из него',
    reWrapped.byteLength === 44 + 4 &&
      new DataView(reWrapped.buffer, reWrapped.byteOffset).getUint32(24, true) === 22050 &&
      new DataView(reWrapped.buffer, reWrapped.byteOffset).getUint16(22, true) === 2
  );

  const riff = readRiffAudio(innerWav);
  check(
    '5g. readRiffAudio возвращает PCM и формат',
    Boolean(riff) &&
      riff.pcm.length === 4 &&
      riff.format.sampleRate === 22050 &&
      riff.format.channels === 2 &&
      riff.format.bitsPerSample === 16
  );
  check(
    '5h. сырой PCM не принимается за RIFF',
    readRiffAudio(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])) === null
  );

  check(
    '5i. mimeType audio/L16; rate=24000 → 24000 Гц, 16 бит',
    parseAudioFormat('audio/L16; codec=pcm; rate=24000').sampleRate === 24000 &&
      parseAudioFormat('audio/L16; codec=pcm; rate=24000').bitsPerSample === 16
  );

  const inline = extractInlineAudio({
    candidates: [
      { content: { parts: [{ inlineData: { data: 'QUJD', mimeType: 'audio/L16; rate=24000' } }] } },
    ],
  });
  check(
    '5j. extractInlineAudio достаёт base64 и mimeType',
    inline?.data === 'QUJD' && inline?.mimeType === 'audio/L16; rate=24000'
  );
  check(
    '5k. пустой ответ Gemini → null',
    extractInlineAudio({ candidates: [{ content: { parts: [{}] } }] }) === null
  );

  check(
    '5l. DEFAULT_PCM_FORMAT — 24 kHz mono 16-bit',
    DEFAULT_PCM_FORMAT.sampleRate === 24000 &&
      DEFAULT_PCM_FORMAT.channels === 1 &&
      DEFAULT_PCM_FORMAT.bitsPerSample === 16
  );

  // ── 6. Контракт edge-функции ──────────────────────────────────────────────
  const fn = read('supabase/functions/dialog-tts/index.ts');
  const fnCode = stripComments(fn);
  check(
    '6a. функция отвечает audio/wav (без стрима)',
    fn.includes("'Content-Type': 'audio/wav'") && fn.includes('new Response(wav')
  );
  check(
    '6b. запросы к Gemini последовательные (нет Promise.all)',
    !fnCode.includes('Promise.all')
  );
  check(
    '6c. используется общий модуль _shared/gemini-tts.ts',
    fn.includes('from "../_shared/gemini-tts.ts"') &&
      fn.includes('planDialogTts') &&
      fn.includes('buildDialogWav') &&
      fn.includes('parseDialogTranscript')
  );
  check(
    '6d. ключ уходит заголовком (x-goog-api-key), а не ?key=',
    fnCode.includes('geminiHeaders') && !fnCode.includes('?key=')
  );
  check(
    '6e. ошибки по таблице ТЗ: 401/403/400/429/500',
    fn.includes("{ error: 'unauthorized' }, 401") &&
      fn.includes("{ error: 'forbidden' }, 403") &&
      fn.includes("'Слишком много запросов, попробуйте позже'") &&
      fn.includes("'Не удалось озвучить текст'") &&
      fn.includes("'Озвучка не удалась'")
  );

  // ── 7. Клиент ─────────────────────────────────────────────────────────────
  const client = await vite.ssrLoadModule('/src/data/dialogTts.ts');
  check(
    '7a. белые списки голосов клиента и сервера совпадают',
    JSON.stringify([...client.DIALOG_TTS_VOICES]) === JSON.stringify([...DIALOG_TTS_VOICES])
  );
  check(
    '7b. клиент описывает все коды ошибок DIALOG_TTS_ERROR_MESSAGES',
    ['unauthorized', 'forbidden', 'gemini_key_missing', 'invalid_input', 'rate_limit', 'unknown'].every(
      (code) => typeof client.DIALOG_TTS_ERROR_MESSAGES[code] === 'string' && client.DIALOG_TTS_ERROR_MESSAGES[code]
    )
  );
  check(
    '7c. клиент вызывает функцию по адресу /functions/v1/dialog-tts и берёт blob',
    read('src/data/dialogTts.ts').includes('/functions/v1/dialog-tts') &&
      read('src/data/dialogTts.ts').includes('response.blob()') &&
      typeof client.synthesizeDialog === 'function'
  );
} finally {
  await vite.close();
}

if (failures.length) {
  console.error(`\nunit-dialog-tts: провалено проверок — ${failures.length}`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exitCode = 1;
} else {
  console.log('\nunit-dialog-tts: все проверки пройдены');
}

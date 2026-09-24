/**
 * Gemini: сборка запросов TTS и анализ ответов.
 *
 * Модуль намеренно чистый (никаких Deno/Node API, кроме глобальных
 * `atob`/`btoa`, которые есть и в Deno, и в Node ≥16, и в браузере):
 * его импортируют ОБА исполнителя — edge-функция `gemini-proxy` (прод) и
 * dev-middleware `/api/gemini/*` в `vite.config.ts` (`npm run dev`), — а тесты
 * дергают его напрямую через vite-SSR. Одна копия формы запроса = прод и dev
 * не разъезжаются.
 *
 * ── Что здесь важно знать про Gemini TTS (доки, сентябрь 2026) ──────────────
 *
 * 1. Модель `gemini-3.8-flash-tts` — GA-замена `gemini-2.5-flash-preview-tts`
 *    (тот остался только у тех, кто им уже пользовался; в докáх помечен как
 *    legacy, для новых проектов рекомендуют 3.8).
 * 2. Аудио приходит ровно туда же, куда и раньше:
 *    `candidates[0].content.parts[0].inlineData.data` (base64 PCM 24 kHz mono
 *    16-bit), поэтому клиент (`src/data/gemini.ts`) не меняется.
 * 3. Multi-speaker режим — максимум ДВА голоса на запрос. Каждая реплика идёт
 *    отдельным `part` с `speech_metadata.speaker`, а голоса — в
 *    `generationConfig.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs`
 *    (`voiceConfig.prebuiltVoiceConfig.voiceName`, поле не переименовано).
 *    Больше двух персонажей → несколько запросов и склейка PCM (см.
 *    `planTtsRequests` + `mergeTtsAudio`).
 * 4. Ключ передаётся заголовком `x-goog-api-key`, а НЕ `?key=`: новые
 *    auth-ключи (`AQ.…`) с query-параметром не работают вовсе (Google отдаёт
 *    404). Работает и для старых `AIza…`, поэтому ветки «если ключ старый» нет.
 *
 * Плейнтекст ключа сюда не приходит: модуль получает уже готовый apiKey от
 * вызывающего кода и никогда его не логирует/не возвращает.
 */

/** База REST: `<base>/<model>:generateContent`. */
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Vision-модель для анализа страниц (`/analyze`). */
export const GEMINI_ANALYZE_MODEL = 'gemini-3.8-flash';

/** TTS-модель (`/tts`). GA, без суффикса `-preview`. */
export const GEMINI_TTS_MODEL = 'gemini-3.8-flash-tts';

/** Жёсткий лимит Gemini TTS: в multi-speaker режиме максимум 2 голоса. */
export const TTS_MAX_SPEAKERS_PER_REQUEST = 2;

/**
 * Сколько запросов разрешено на одну озвучку. Каждый запрос — это отдельный
 * вызов Gemini (5–20 с); без потолка глава с десятком персонажей упрётся в
 * wall-clock edge-функции. 8 чанков × 2 голоса = 16 персонажей, дальше честная
 * ошибка вместо таймаута в 150 с.
 */
export const TTS_MAX_REQUESTS = 8;

/** Голоса по умолчанию: разные тембры, чтобы диалог не сливался в один голос. */
export const DEFAULT_TTS_VOICES = ['Kore', 'Puck'] as const;

/** Голос, если персонаж в главе один. */
export const SINGLE_SPEAKER_TTS_VOICE = 'Kore';

/** Имя говорящего по умолчанию — как в analyzer и в UI (`line.speaker`). */
export const DEFAULT_SPEAKER = 'Narrator';

/**
 * 30 prebuilt-голосов Gemini TTS (доки: speech-generation → Voice options).
 * Список нужен, чтобы не отправить в API опечатку из UI: неизвестное имя
 * Gemini отклоняет 400-й ошибкой, а мы тихо откатываемся на дефолт.
 */
export const PREBUILT_TTS_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda',
  'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus',
  'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi',
  'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima',
  'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
] as const;

const VOICE_SET = new Set<string>(PREBUILT_TTS_VOICES);

/** Коды ошибок сборки плана — исполнители мапят их в HTTP-статусы. */
export type TtsPlanErrorCode = 'tts_no_lines' | 'tts_too_many_requests';

export class TtsPlanError extends Error {
  readonly code: TtsPlanErrorCode;

  constructor(code: TtsPlanErrorCode, message: string) {
    super(message);
    this.name = 'TtsPlanError';
    this.code = code;
  }
}

export interface TtsLine {
  speaker?: string | null;
  text?: string | null;
}

export interface TtsRequestPlan {
  /** Уникальные персонажи чанка — 1 или 2 (лимит Gemini). */
  speakers: string[];
  /** speaker → voiceName, по одному на каждого персонажа чанка. */
  voices: Record<string, string>;
  /** Готовое тело POST-запроса (форма generateContent). */
  body: Record<string, unknown>;
}

/** Голос из UI принимаем только если он есть в списке prebuilt; иначе null. */
export function normalizeTtsVoice(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const value = name.trim();
  if (!value) return null;
  // Регистр в API значим, но в UI люди пишут «kore» — приведём к канону.
  const canonical = [...VOICE_SET].find((voice) => voice.toLowerCase() === value.toLowerCase());
  return canonical ?? null;
}

function speakerOf(line: TtsLine): string {
  return (line?.speaker ?? '').toString().trim() || DEFAULT_SPEAKER;
}

function textOf(line: TtsLine): string {
  return (line?.text ?? '').toString().trim();
}

/**
 * План запросов к Gemini TTS.
 *
 * Алгоритм:
 *  1. Пустые реплики выбрасываем (Gemini на пустой `part` спотыкается, а
 *     платить за них нечем).
 *  2. Голоса: `voiceMap[speaker]` (если это валидный prebuilt-голос) → иначе
 *     дефолт по порядку появления персонажа (Kore / Puck / Kore…), так один и
 *     тот же персонаж звучит одинаково во всех чанках.
 *  3. Реплики идут по порядку, чанк набирает максимум 2 персонажа; реплика
 *     третьего персонажа начинает новый чанк. Порядок и текст реплик при этом
 *     не меняются — склейка PCM (mergeTtsAudio) даёт ту же последовательность,
 *     что и однослотовый запрос.
 *
 * @throws {TtsPlanError} `tts_no_lines` — все реплики пустые;
 *                         `tts_too_many_requests` — персонажей больше, чем
 *                         влезает в TTS_MAX_REQUESTS запросов.
 */
export function planTtsRequests(
  lines: readonly TtsLine[] | null | undefined,
  voiceMap: Record<string, string> | null | undefined = {}
): TtsRequestPlan[] {
  const usable = (Array.isArray(lines) ? lines : []).filter((line) => textOf(line).length > 0);

  if (usable.length === 0) {
    throw new TtsPlanError('tts_no_lines', 'Нет непустых реплик для озвучки');
  }

  // Голос персонажа фиксируем глобально: валидный из voiceMap, иначе дефолт по
  // порядку первого появления.
  const voices: Record<string, string> = {};
  let defaults = 0;

  const voiceFor = (speaker: string): string => {
    if (voices[speaker]) return voices[speaker];
    const fromMap = normalizeTtsVoice(voiceMap?.[speaker]);
    const assigned = fromMap
      ?? DEFAULT_TTS_VOICES[defaults++ % DEFAULT_TTS_VOICES.length]
      ?? SINGLE_SPEAKER_TTS_VOICE;
    voices[speaker] = assigned;
    return assigned;
  };

  const groups: { speakers: string[]; lines: TtsLine[] }[] = [];

  for (const line of usable) {
    const speaker = speakerOf(line);
    let group = groups[groups.length - 1];

    if (!group || (!group.speakers.includes(speaker) && group.speakers.length >= TTS_MAX_SPEAKERS_PER_REQUEST)) {
      group = { speakers: [], lines: [] };
      groups.push(group);
    }

    if (!group.speakers.includes(speaker)) group.speakers.push(speaker);
    group.lines.push(line);
  }

  if (groups.length > TTS_MAX_REQUESTS) {
    throw new TtsPlanError(
      'tts_too_many_requests',
      `Слишком много персонажей для одной озвучки: нужно ${groups.length} запросов к Gemini TTS, ` +
        `лимит — ${TTS_MAX_REQUESTS} (по ${TTS_MAX_SPEAKERS_PER_REQUEST} голоса в каждом). ` +
        'Сократите число говорящих или озвучьте главу частями.'
    );
  }

  return groups.map((group) => {
    const groupVoices: Record<string, string> = {};
    for (const speaker of group.speakers) groupVoices[speaker] = voiceFor(speaker);

    const isSingleSpeaker = group.speakers.length === 1;

    // Каждая реплика — отдельный part; в multi-speaker режиме к нему
    // прикладывается speech_metadata.speaker, по которому Gemini выбирает
    // голос. В single-speaker режиме `speaker` не передаём: там атрибуция не
    // нужна, а лишнее поле — повод для 400.
    const parts = group.lines.map((line) =>
      isSingleSpeaker
        ? { text: textOf(line) }
        : { text: textOf(line), speech_metadata: { speaker: speakerOf(line) } }
    );

    return {
      speakers: [...group.speakers],
      voices: groupVoices,
      body: {
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: isSingleSpeaker
            ? {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: groupVoices[group.speakers[0]] },
                },
              }
            : {
                multiSpeakerVoiceConfig: {
                  speakerVoiceConfigs: group.speakers.map((speaker) => ({
                    speaker,
                    voiceConfig: {
                      prebuiltVoiceConfig: { voiceName: groupVoices[speaker] },
                    },
                  })),
                },
              },
        },
      },
    };
  });
}

/** URL конкретной модели: `<base>/<model>:generateContent`. */
export function geminiEndpoint(model: string): string {
  return `${GEMINI_API_BASE}/${model}:generateContent`;
}

/**
 * Заголовки запроса к Gemini. Ключ — только в `x-goog-api-key`: новые
 * auth-ключи (`AQ.…`) с `?key=` отдают 404, и даже для старых `AIza…` так
 * ключ не оседает в URL-логах/прокси.
 */
export function geminiHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey,
  };
}

function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Чанками: String.fromCharCode(...bytes) на мегабайтах переполняет стек.
  const STEP = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

/**
 * Склейка PCM-аудио нескольких ответов Gemini в один base64.
 * Все чанки — 24 kHz mono 16-bit PCM, поэтому «сложить байты» == «сложить
 * звук по времени»: клиент оборачивает результат в один WAV.
 */
export function mergeTtsAudio(chunks: readonly string[]): string {
  const decoded = chunks.filter((chunk) => typeof chunk === 'string' && chunk.length > 0);
  if (decoded.length === 0) return '';
  if (decoded.length === 1) return decoded[0].replace(/\s+/g, '');

  const parts = decoded.map((chunk) => base64ToBytes(chunk));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);

  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }

  return bytesToBase64(merged);
}

/** Достаёт base64-аудио из ответа Gemini (`inlineData.data`). */
export function extractTtsAudio(payload: unknown): string | null {
  const data = (payload as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[] })
    ?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  return typeof data === 'string' && data.length > 0 ? data : null;
}

/**
 * Ответ `/tts` в той же форме, что отдаёт Gemini: клиент читает
 * `candidates[0].content.parts[0].inlineData.data` и не знает, сколько было
 * запросов. `modelVersion` оставляем своим, он не парсится.
 */
export function buildTtsResponse(audioBase64: string, model = GEMINI_TTS_MODEL): Record<string, unknown> {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [
            {
              inlineData: {
                mimeType: 'audio/L16;codec=pcm;rate=24000',
                data: audioBase64,
              },
            },
          ],
        },
        finishReason: 'STOP',
      },
    ],
    modelVersion: model,
  };
}

/**
 * Человекочитаемое сообщение об ошибке Gemini из тела ответа.
 * Ключ никогда не попадает в текст (в телах Google его и нет).
 */
export function geminiErrorMessage(payload: unknown, fallback: string): string {
  const error = (payload as { error?: { message?: string; status?: string } } | null)?.error;
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  if (message) return message;
  const status = typeof error?.status === 'string' ? error.status.trim() : '';
  return status ? `${fallback} (${status})` : fallback;
}

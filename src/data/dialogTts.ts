import { getSupabase, isSupabaseConfigured } from './client';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '@/integrations/supabase/config';
import type { InlineAudio } from '../../supabase/functions/_shared/gemini-tts';

export type { InlineAudio };

/**
 * dialog-tts: озвучка расшифровки диалога (`Speaker N: текст`) в один WAV.
 *
 * Edge-функция отвечает ТЕЛОМ-AUDIO (`Content-Type: audio/wav`), поэтому
 * вызов идёт через `fetch`, а не `supabase.functions.invoke`: обёртка
 * supabase-js разбирает ответ по Content-Type и `audio/wav` для неё —
 * «неизвестный тип», который она декодирует как текст (`response.text()`),
 * то есть байты WAV по дороге теряются. Ошибки (JSON) читаются с того же
 * ответа — формат тел не отличается от других edge-функций проекта.
 *
 * Ключ Gemini живёт на сервере: клиент шлёт только JWT (функция проверяет
 * роль admin и берёт персональный ключ из user_api_keys).
 */

/**
 * Голоса dialog-tts — зеркало белого списка сервера
 * (`DIALOG_TTS_VOICES` в supabase/functions/_shared/gemini-tts.ts).
 * Расхождение ловит scripts/unit-dialog-tts.mjs.
 */
export const DIALOG_TTS_VOICES = [
  'Charon', 'Kore', 'Puck', 'Aoede', 'Fenrir', 'Leda', 'Zephyr', 'Orus',
] as const;

export type DialogTtsErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'gemini_key_missing'
  | 'invalid_input'
  | 'rate_limit'
  | 'unknown';

export class DialogTtsError extends Error {
  readonly code: DialogTtsErrorCode;

  constructor(code: DialogTtsErrorCode, message: string) {
    super(message);
    this.name = 'DialogTtsError';
    this.code = code;
  }
}

export const DIALOG_TTS_ERROR_MESSAGES: Record<DialogTtsErrorCode, string> = {
  unauthorized: 'Сессия истекла — войдите в админку заново.',
  forbidden: 'Озвучка диалогов доступна только админам.',
  gemini_key_missing: 'Gemini API key не задан. Добавьте ключ: /admin/settings.',
  invalid_input: 'Проверьте текст: нужна расшифровка вида «Speaker 1: …».',
  rate_limit: 'Слишком много запросов к Gemini, попробуйте позже.',
  unknown:
    'Озвучка не удалась: edge-функция dialog-tts не ответила. Проверьте деплой (supabase functions deploy dialog-tts) и соединение.',
};

export interface SynthesizeDialogOptions {
  /** Расшифровка с префиксами `Speaker N:` (без них сервер вернёт 400). */
  transcript: string;
  /** speaker → voiceName; неизвестные имена отбрасываются, остальным — круг. */
  voices?: Record<string, string>;
  signal?: AbortSignal;
}

interface ErrorPayload {
  error?: string;
  message?: string;
}

/**
 * Оставляет только валидные голоса: сервер всё равно откатится на дефолт, но
 * незачем гонять по сети мусор (опечатки из UI ловятся здесь же).
 */
function sanitizeVoices(voices: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!voices) return result;

  for (const [speaker, voice] of Object.entries(voices)) {
    if (typeof voice !== 'string') continue;
    const canonical = DIALOG_TTS_VOICES.find(
      (candidate) => candidate.toLowerCase() === voice.trim().toLowerCase()
    );
    if (canonical) result[speaker] = canonical;
  }

  return result;
}

function errorFrom(status: number, payload: ErrorPayload | null): DialogTtsError {
  const serverMessage = (payload?.message ?? '').trim();
  const serverError = (payload?.error ?? '').trim();

  let code: DialogTtsErrorCode = 'unknown';
  if (status === 401) code = 'unauthorized';
  else if (status === 403) code = serverError === 'gemini_key_missing' ? 'gemini_key_missing' : 'forbidden';
  else if (status === 400) code = 'invalid_input';
  else if (status === 429) code = 'rate_limit';

  // Тексты сервера конкретнее общих («Текст пуст», «Добавьте ключ:
  // /admin/settings») — показываем их.
  const message = code === 'invalid_input' || code === 'gemini_key_missing'
    ? serverMessage || serverError || DIALOG_TTS_ERROR_MESSAGES[code]
    : DIALOG_TTS_ERROR_MESSAGES[code];

  return new DialogTtsError(code, message);
}

/**
 * Синтезирует диалог и возвращает готовый WAV-blob.
 *
 * @throws {DialogTtsError} см. `DIALOG_TTS_ERROR_MESSAGES`.
 */
export async function synthesizeDialog({
  transcript,
  voices,
  signal,
}: SynthesizeDialogOptions): Promise<Blob> {
  const text = typeof transcript === 'string' ? transcript.trim() : '';
  if (!text) {
    throw new DialogTtsError('invalid_input', 'Текст пуст');
  }

  if (!isSupabaseConfigured || !SUPABASE_URL) {
    throw new DialogTtsError(
      'unknown',
      'Демо-режим: Supabase не настроен, озвучка недоступна.'
    );
  }

  const supabase = await getSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) {
    throw new DialogTtsError('unauthorized', DIALOG_TTS_ERROR_MESSAGES.unauthorized);
  }

  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/dialog-tts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ transcript: text, voices: sanitizeVoices(voices) }),
      signal,
    });
  } catch {
    if (signal?.aborted) {
      throw new DialogTtsError('unknown', 'Озвучка отменена.');
    }
    throw new DialogTtsError('unknown', DIALOG_TTS_ERROR_MESSAGES.unknown);
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ErrorPayload | null;
    throw errorFrom(response.status, payload);
  }

  const audio = await response.blob();
  return new Blob([audio], { type: 'audio/wav' });
}

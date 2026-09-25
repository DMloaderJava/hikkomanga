import { getSupabase, isSupabaseConfigured } from './client';
import type { ChatMessage } from '../../supabase/functions/_shared/gemini-chat';

export type { ChatMessage };

/**
 * Support-чат: стриминг ответа edge-функции `chat`.
 *
 * Функция проксирует SSE от Gemini как есть (`text/event-stream`), поэтому
 * клиент читает поток построчно (`parseGeminiSSE`) и отдаёт токены по мере
 * поступления — ответ печатается, а не появляется целиком в конце.
 *
 * Почему не `await response.json()` в обёртке supabase-js: `functions.invoke`
 * при `Content-Type: text/event-stream` возвращает саму `Response` (см.
 * @supabase/functions-js, ветка `responseType === 'text/event-stream'`), а не
 * разобранный JSON — из неё и берётся `body`.
 *
 * Ошибки: коды edge-функции (`unauthorized`, `gemini_key_missing`,
 * `rate_limit`) превращаются в `ChatError.code`, тексты — в
 * `CHAT_ERROR_MESSAGES`.
 */

export type ChatErrorCode = 'unauthorized' | 'gemini_key_missing' | 'rate_limit' | 'unknown';

export class ChatError extends Error {
  readonly code: ChatErrorCode;

  constructor(code: ChatErrorCode, message: string) {
    super(message);
    this.name = 'ChatError';
    this.code = code;
  }
}

/**
 * Демо-режим (`npm run dev` без `.env`: нет `VITE_SUPABASE_*`) — обращаться
 * некуда, edge-функции нет ни в каком виде. Отдельный текст, чтобы админ не
 * искал незадеплоенную функцию там, где дело в конфиге окружения: сообщение
 * `unknown` про «проверьте деплой» в этом случае просто врёт.
 */
export const CHAT_DEMO_MESSAGE =
  'Демо-режим: Supabase не настроен, чат недоступен. Задайте VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY (см. SETUP_SUPABASE.md) и перезапустите dev-сервер.';

export const CHAT_ERROR_MESSAGES: Record<ChatErrorCode, string> = {
  unauthorized: 'Сессия истекла — войдите заново, чтобы задать вопрос.',
  gemini_key_missing: 'Для чата нужен ключ Gemini. Обратитесь к администратору.',
  rate_limit: 'Слишком много запросов, попробуйте позже.',
  unknown:
    'Чат недоступен: edge-функция chat не ответила. Проверьте деплой (supabase functions deploy chat) и соединение.',
};

export interface StreamChatOptions {
  messages: ChatMessage[];
  signal?: AbortSignal;
}

interface ErrorPayload {
  error?: string;
  code?: string;
  message?: string;
}

/** Тело не-2xx ответа edge-функции лежит в `error.context` (Response). */
async function readErrorPayload(error: unknown): Promise<ErrorPayload | null> {
  const context = (error as { context?: Response } | null)?.context;
  if (!context || typeof context.json !== 'function') return null;
  try {
    return (await context.clone().json()) as ErrorPayload;
  } catch {
    return null;
  }
}

function toChatError(payload: ErrorPayload | null, thrown: unknown): ChatError {
  const raw = payload?.code ?? payload?.error ?? '';
  const code: ChatErrorCode =
    raw === 'unauthorized' ? 'unauthorized'
      : raw === 'gemini_key_missing' ? 'gemini_key_missing'
        : raw === 'rate_limit' ? 'rate_limit'
          : 'unknown';

  // Готовое сообщение сервера важнее общего текста (например, «Обратитесь к
  // администратору»), но код всё равно ведёт UI.
  const message = (payload?.message ?? '').trim();
  return new ChatError(code, message || CHAT_ERROR_MESSAGES[code]);
}

/** Пустой поток: запрос отменён до первого токена. */
async function* emptyStream(): AsyncGenerator<string, void, void> {
  // Намеренно ничего не отдаём.
}

/** Маркер конца потока (Gemini его не шлёт, но SSE-клиенты обязаны понимать). */
const DONE = Symbol('gemini-sse-done');

/**
 * Одна строка SSE → текст токена.
 *
 *  - пустые строки и комментарии (`:` в начале) — служебные, пропускаем;
 *  - берём только строки `data: `, как в ответе Gemini
 *    (`data: {"candidates":[{"content":{"parts":[{"text":"…"}]}}]}`);
 *  - части с `thought: true` игнорируем: это «размышления» модели, их не
 *    показываем пользователю;
 *  - битый JSON — тоже пропуск, а не падение стрима.
 */
function tokenFromSseLine(line: string): string | null | typeof DONE {
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed || trimmed.startsWith(':')) return null;
  if (!trimmed.startsWith('data:')) return null;

  const payload = trimmed.slice(5).trim();
  if (!payload) return null;
  if (payload === '[DONE]') return DONE;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  const parts = (parsed as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  })?.candidates?.[0]?.content?.parts;

  if (!Array.isArray(parts)) return null;

  const text = parts
    .filter((part) => part && part.thought !== true && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');

  return text || null;
}

/**
 * Разбор SSE-потока Gemini в токены.
 *
 * Декодирует чанки `TextDecoder` в потоковом режиме (`{ stream: true }`) —
 * иначе кириллица на границе чанка превращается в «ромбики» — и буферизует
 * по `\n`: один SSE-фрейм может прийти разрезанным на любом байте.
 */
export async function* parseGeminiSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<string, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);

        const token = tokenFromSseLine(line);
        if (token === DONE) return;
        if (token) yield token;

        index = buffer.indexOf('\n');
      }
    }

    // Хвост без перевода строки: последний чанк Gemini иногда приходит без `\n`.
    const tail = tokenFromSseLine(buffer);
    if (tail && tail !== DONE) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Поток уже закрыт или отменён (abort) — отменять нечего.
    }
  }
}

/**
 * Запускает стрим ответа поддержки.
 *
 * @returns асинхронный поток токенов; если пользователь нажал «Стоп» до
 *          первого токена — пустой поток (не ошибка: это штатная отмена).
 */
export async function streamChat({
  messages,
  signal,
}: StreamChatOptions): Promise<AsyncIterable<string>> {
  if (!isSupabaseConfigured) {
    throw new ChatError('unknown', CHAT_DEMO_MESSAGE);
  }

  const supabase = await getSupabase();

  let data: unknown = null;
  let error: unknown = null;

  try {
    const invocation = await supabase.functions.invoke('chat', { body: { messages }, signal });
    data = invocation.data;
    error = invocation.error;
  } catch (thrown) {
    // Abort на стороне клиента supabase-js отдаёт как FunctionsFetchError —
    // это не ошибка чата, а нажатый «Стоп».
    if (signal?.aborted) return emptyStream();
    throw toChatError(null, thrown);
  }

  if (error) {
    if (signal?.aborted) return emptyStream();
    throw toChatError(await readErrorPayload(error), error);
  }

  // text/event-stream → supabase-js отдаёт саму Response (см. док-блок выше).
  const response = data as Response | null;
  const body = response?.body ?? null;
  if (!body) return emptyStream();

  return parseGeminiSSE(body, signal);
}
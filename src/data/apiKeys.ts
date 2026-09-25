import { getSupabase, isSupabaseConfigured } from './client';
import { SUPABASE_URL } from '@/integrations/supabase/config';

/**
 * Персональный Gemini API key админа: статус, сохранение, удаление.
 *
 * Плейнтекст ключа уходит ТОЛЬКО в POST-запрос к edge-функции
 * `admin-api-keys`, которая шифрует его (AES-256-GCM) и кладёт шифротекст
 * в `public.user_api_keys`. Обратно приходит максимум `last4` — прочитать
 * ключ нельзя ни из UI, ни из консоли браузера.
 *
 * Демо-режим (нет VITE_SUPABASE_*): сохранять некуда — `status()` отдаёт
 * `{ key: null, demo: true }`, а `save()`/`remove()` бросают ApiKeyError
 * с кодом `demo_mode`. В localStorage ключ не пишется ни в каком виде.
 */

/**
 * Gemini API key: опаковая строка, БЕЗ проверки префикса.
 *
 * Раньше здесь стояло `/^AIza[0-9A-Za-z_\-]{35}$/` («AIza + 35 = 39») — это
 * ровно тот случай, когда валидация ломается раньше Google: с 28 мая 2026
 * AI Studio выдаёт auth-ключи нового вида (`AQ.Ab8RN6…`), и старый шаблон
 * начал отклонять заведомо рабочие ключи («Ключ должен начинаться с AIza и
 * содержать 39 символов»). Формат ключа — не контракт: следующий префикс
 * сломал бы проверку снова.
 *
 * Что осталось: страховка от мусора/опечаток — только ASCII-безопасный
 * алфавит и разумные границы длины. 20 символов — короче не бывает ни у
 * `AIza…` (39), ни у `AQ.…` (30+); 512 — с запасом на будущие форматы.
 * Проверка продублирована в edge-функции (admin-api-keys/index.ts), расхождение
 * ловит scripts/unit-api-keys.mjs.
 */
export const GEMINI_API_KEY_RE = /^[A-Za-z0-9_\-\.]{20,100}$/;
export const GEMINI_PROVIDER = 'gemini';

export interface ApiKeyStatus {
  provider: string;
  /** Последние 4 символа — всё, что вообще покидает сервер. */
  last4: string;
  updated_at: string;
}

export interface ApiKeyStatusResult {
  key: ApiKeyStatus | null;
  /** true — Supabase не настроен, ключ сохранить некуда. */
  demo: boolean;
}

export interface ApiKeySaveResult {
  ok: true;
  provider: string;
  last4: string;
}

export type ApiKeyErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_key_format'
  | 'db_error'
  | 'enc_secret_missing'
  | 'enc_secret_invalid'
  | 'fn_not_deployed'
  | 'network'
  | 'demo_mode'
  | 'unknown';

export class ApiKeyError extends Error {
  readonly code: ApiKeyErrorCode;

  constructor(code: ApiKeyErrorCode, message: string) {
    super(message);
    this.name = 'ApiKeyError';
    this.code = code;
  }
}

/**
 * Хост Supabase для текста ошибки. «Supabase недоступен» без адреса — худший
 * вид диагностики: чаще всего сборка смотрит в СТАРЫЙ/удалённый проект
 * (переменные на хостинге не обновили или не сделали redeploy), и по хосту
 * это видно сразу.
 */
function supabaseHostLabel(): string {
  if (!SUPABASE_URL) return 'supabase (VITE_SUPABASE_URL пуст)';
  try {
    return new URL(SUPABASE_URL).host;
  } catch {
    return SUPABASE_URL;
  }
}

/** Человеческие подсказки: код от edge-функции → что делать админу. */
export const API_KEY_ERROR_MESSAGES: Record<string, string> = {
  unauthorized: 'Сессия истекла — войдите в админку заново.',
  forbidden: 'Нужен аккаунт с ролью admin.',
  invalid_key_format:
    'Ключ выглядит некорректно: нужна строка из 20–512 символов без пробелов ' +
    '(новый auth-ключ AQ.… или старый AIza…). Скопируйте ключ целиком из Google AI Studio.',
  db_error: 'База отклонила запись. Проверьте, что применена миграция 00000000000017_user_api_keys.sql.',
  enc_secret_missing: 'На сервере не задан Edge Secret USER_KEY_ENC_SECRET (см. SETUP_SUPABASE.md).',
  enc_secret_invalid: 'USER_KEY_ENC_SECRET задан неверно: нужен base64 от 32 байт (openssl rand -base64 32).',
  fn_not_deployed: 'Edge-функция admin-api-keys не задеплоена: supabase functions deploy admin-api-keys.',
  network:
    `Supabase недоступен: запрос к ${supabaseHostLabel()} не прошёл. ` +
    'Проверьте соединение и переменные VITE_SUPABASE_* на хостинге — после их правки нужен redeploy (см. SETUP_SUPABASE.md).',
  unknown: 'Не удалось выполнить запрос к admin-api-keys.',
  demo_mode: 'Демо-режим: Supabase не настроен, ключ сохранить некуда.',
};

export function apiKeyErrorMessage(code: string, fallback?: string): string {
  return API_KEY_ERROR_MESSAGES[code] ?? fallback ?? API_KEY_ERROR_MESSAGES.unknown;
}

interface FunctionErrorPayload {
  error?: string;
  code?: string;
  message?: string;
}

/**
 * Тело не-2xx ответа edge-функции лежит в `error.context` (Response),
 * а не в `data` — достаём код, чтобы показать точную подсказку.
 */
async function readErrorPayload(error: unknown): Promise<FunctionErrorPayload | null> {
  const context = (error as { context?: Response } | null)?.context;
  if (!context || typeof context.json !== 'function') return null;
  try {
    return (await context.clone().json()) as FunctionErrorPayload;
  } catch {
    return null;
  }
}

function toApiKeyError(payload: FunctionErrorPayload | null, thrown: unknown): ApiKeyError {
  if (payload) {
    const code = (payload.code ?? payload.error ?? 'unknown') as ApiKeyErrorCode;
    return new ApiKeyError(code, apiKeyErrorMessage(code, payload.message));
  }

  // 404 от Supabase Relay = функция не задеплоена (тело при этом часто пустое).
  const context = (thrown as { context?: Response } | null)?.context;
  if (context?.status === 404) {
    return new ApiKeyError('fn_not_deployed', API_KEY_ERROR_MESSAGES.fn_not_deployed);
  }

  const name = (thrown as { name?: string } | null)?.name;
  if (name === 'FunctionsFetchError' || name === 'FunctionsRelayError') {
    return new ApiKeyError('network', API_KEY_ERROR_MESSAGES.network);
  }

  return new ApiKeyError('unknown', API_KEY_ERROR_MESSAGES.unknown);
}

async function invoke<T>(
  method: 'GET' | 'POST' | 'DELETE',
  body?: Record<string, unknown>
): Promise<T> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.functions.invoke('admin-api-keys', {
    method,
    ...(body ? { body } : {}),
  });

  if (error) {
    throw toApiKeyError(await readErrorPayload(error), error);
  }

  // Функция отвечает 200/4xx с телом { error } (например, на OPTIONS-пути) —
  // подстраховка на случай нестандартного статуса.
  const payload = data as FunctionErrorPayload | null;
  if (payload && typeof payload === 'object' && typeof payload.error === 'string') {
    const code = (payload.code ?? payload.error) as ApiKeyErrorCode;
    throw new ApiKeyError(code, apiKeyErrorMessage(code, payload.message));
  }

  return data as T;
}

function assertDemo(): never {
  throw new ApiKeyError('demo_mode', API_KEY_ERROR_MESSAGES.demo_mode);
}

export const apiKeys = {
  /** Статус ключа текущего админа. Плейнтекст сюда не приходит по определению. */
  async status(): Promise<ApiKeyStatusResult> {
    if (!isSupabaseConfigured) {
      return { key: null, demo: true };
    }

    const data = await invoke<{ key: ApiKeyStatus | null }>('GET');
    return { key: data?.key ?? null, demo: false };
  },

  /**
   * Сохраняет (или заменяет) ключ. Валидация формата — до сети, чтобы не
   * гонять заведомо неверный ключ на сервер; edge-функция проверяет тот же
   * формат повторно.
   */
  async save(key: string): Promise<ApiKeySaveResult> {
    const value = key.trim();

    if (!GEMINI_API_KEY_RE.test(value)) {
      throw new ApiKeyError('invalid_key_format', API_KEY_ERROR_MESSAGES.invalid_key_format);
    }

    if (!isSupabaseConfigured) {
      assertDemo();
    }

    return invoke<ApiKeySaveResult>('POST', { key: value });
  },

  async remove(): Promise<void> {
    if (!isSupabaseConfigured) {
      assertDemo();
    }

    await invoke<{ ok: true }>('DELETE');
  },
};

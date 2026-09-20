import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/integrations/supabase/config';
import { isSupabaseConfigured } from './client';
import type { AdminRequest, RequestStatus } from './types';

/**
 * Анонимные заявки на тайтл.
 *
 * Прод: edge-функции submit-title / get-submission (капча + IP rate limit +
 * upload обложки в бакет submissions под service_role). Клиент кладёт в БД
 * ничего не может — RLS «no anon insert».
 *
 * Демо (без Supabase): локальный fallback в том же хранилище, что и
 * adminRequests (manga_admin_requests), чтобы весь флоу — подача → инбокс →
 * approve/reject → статус по токену — работал в dev/превью без бэкенда.
 */

export interface SubmitTitlePayload {
  original_title: string;
  type: 'manga' | 'manhwa' | 'manhua' | 'oel';
  description: string;
  genres: string[];
  title_ru?: string;
  title_en?: string;
  alt_titles?: string[];
  author?: string;
  year?: number;
  country?: string;
  status?: string;
}

export interface SubmitTitleResult {
  ok: boolean;
  token?: string;
  id?: string;
  /** Ошибка верхнего уровня (captcha_failed / rate_limited / ...). */
  error?: string;
  message?: string;
  retryAfter?: number;
  /** Ошибки по полям формы (HTTP 400). */
  fields?: Record<string, string>;
}

export interface SubmissionStatus {
  status: RequestStatus;
  type: string;
  created_at: string;
  resolved_at: string | null;
  reason: string | null;
}

const DEMO_KEY = 'manga_admin_requests';

function demoList(): AdminRequest[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    return raw ? (JSON.parse(raw) as AdminRequest[]) : [];
  } catch {
    return [];
  }
}

function demoSave(list: AdminRequest[]) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

function demoToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Лёгкая клиентская пред-валидация: экономит запрос, но server решает. */
export function prevalidatePayload(payload: SubmitTitlePayload): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!payload.original_title.trim()) errors.original_title = 'Укажите название';
  if (payload.description.trim().length < 10)
    errors.description = 'Минимум 10 символов';
  if (payload.genres.filter((g) => g.trim()).length < 1)
    errors.genres = 'Добавьте хотя бы один жанр';
  return errors;
}

export const submissions = {
  /**
   * Подать заявку. coverFile обязателен (≤5 MB, jpeg/png/webp, 3:4±10%).
   * При настроенном Supabase уходит в edge-функцию multipart-запросом;
   * в демо — в localStorage с той же структурой строки admin_requests.
   */
  async submitTitle(input: {
    payload: SubmitTitlePayload;
    cover: File;
    captchaToken: string;
    email?: string;
  }): Promise<SubmitTitleResult> {
    if (isSupabaseConfigured) {
      const form = new FormData();
      form.append('turnstileToken', input.captchaToken);
      form.append('payload', JSON.stringify(input.payload));
      if (input.email?.trim()) form.append('email', input.email.trim());
      form.append('cover', input.cover);

      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/submit-title`, {
          method: 'POST',
          headers: { apikey: SUPABASE_ANON_KEY },
          body: form,
        });

        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('Retry-After')) || 60;
          const body = await res.json().catch(() => ({}));
          return {
            ok: false,
            error: 'rate_limited',
            retryAfter,
            message:
              (body as { message?: string }).message ??
              `Слишком часто. Попробуйте через ${retryAfter} сек.`,
          };
        }

        const body = (await res.json().catch(() => ({}))) as SubmitTitleResult;
        if (!res.ok) {
          return {
            ok: false,
            error: body.error ?? 'internal',
            fields: body.fields,
            message: body.message,
          };
        }
        return body;
      } catch (e) {
        return {
          ok: false,
          error: 'network',
          message:
            e instanceof Error
              ? `Не удалось связаться с сервером: ${e.message}`
              : 'Не удалось связаться с сервером',
        };
      }
    }

    // ── Демо-режим: капча «пройдена», лимиты не считаются ──
    const token = demoToken();
    const coverUrl = await fileToDemoUrl(input.cover);
    const row: AdminRequest = {
      id: 'anon-' + Date.now(),
      type: 'new_title',
      requester_id: null,
      payload: {
        ...input.payload,
        cover_url: coverUrl,
        cover_name: input.cover.name,
      },
      status: 'pending',
      ip_hash: 'demo-anonymous',
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : 'demo',
      turnstile_ok: true,
      public_token: token,
      submitter_email: input.email?.trim() || null,
      created_at: new Date().toISOString(),
    };
    const list = demoList();
    list.unshift(row);
    demoSave(list);
    console.info('[demo] заявка на тайтл подана (localStorage):', input.payload.original_title);
    return { ok: true, token, id: row.id };
  },

  /** Статус заявки по токену (/s/{token}). null = не найдено. */
  async getSubmission(token: string): Promise<SubmissionStatus | null> {
    const clean = token.trim();
    if (!clean) return null;

    if (isSupabaseConfigured) {
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/get-submission`, {
          method: 'POST',
          headers: {
            apikey: SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ token: clean }),
        });
        if (res.status === 404) return null;
        if (!res.ok) return null;
        const body = (await res.json()) as SubmissionStatus & { ok: boolean };
        return {
          status: body.status,
          type: body.type,
          created_at: body.created_at,
          resolved_at: body.resolved_at,
          reason: body.reason,
        };
      } catch {
        return null;
      }
    }

    const row = demoList().find((r) => r.public_token === clean);
    if (!row) return null;
    return {
      status: row.status,
      type: row.type,
      created_at: row.created_at,
      resolved_at: row.resolved_at ?? null,
      reason: row.reject_reason ?? null,
    };
  },

  /** Отменить свою pending-заявку (первые 5 минут). */
  async withdrawSubmission(token: string): Promise<{ ok: boolean; message?: string }> {
    if (isSupabaseConfigured) {
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/get-submission`, {
          method: 'POST',
          headers: {
            apikey: SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ token: token.trim(), action: 'withdraw' }),
        });
        if (res.ok) return { ok: true };
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        return { ok: false, message: body.message ?? 'Не удалось отменить заявку' };
      } catch {
        return { ok: false, message: 'Не удалось связаться с сервером' };
      }
    }

    const list = demoList();
    const row = list.find((r) => r.public_token === token.trim());
    if (!row) return { ok: false, message: 'Заявка не найдена' };
    const age = Date.now() - new Date(row.created_at).getTime();
    if (row.status !== 'pending' || age > 5 * 60 * 1000) {
      return { ok: false, message: 'Отменить можно только pending-заявку в первые 5 минут' };
    }
    demoSave(list.filter((r) => r.id !== row.id));
    return { ok: true };
  },
};

/** Демо-обложка: маленькие файлы — data-URL (переживают перезагрузку), большие — blob-URL сессии. */
async function fileToDemoUrl(file: File): Promise<string> {
  if (file.size <= 100 * 1024) {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
  console.warn('[demo] обложка >100 kB — будет доступна до перезагрузки страницы (blob-URL)');
  return URL.createObjectURL(file);
}

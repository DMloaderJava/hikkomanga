import { supabase, isSupabaseConfigured } from './client';

export interface LoginNotifyResult {
  ok: boolean;
  emulated?: boolean;
  challengeId?: string;
  /** Только в DEV-эмуляции: ссылки из письма, чтобы подтвердить без Resend. */
  preview?: {
    to?: string;
    from?: string;
    subject?: string;
    html?: string;
    approveUrl?: string;
    denyUrl?: string;
  };
  error?: string;
}

export type LoginChallengeStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'none'
  | 'unauthenticated'
  /** RPC/сеть недоступны — UI не должен путать с «нет challenge». */
  | 'error'
  | string;

/**
 * Запускает обязательное подтверждение входа (Login Guard).
 *
 * Транспорт:
 *  1. Supabase Edge Function `login-notify` — создаёт challenge + Resend;
 *  2. dev-мидлварь Vite `/api/login-notify` (только `npm run dev`).
 *
 * Если письмо/challenge не удалось создать — `ok: false`.
 * Вызывающий код ОБЯЗАН откатить сессию (signOut): без подтверждения входа нет.
 */
export async function notifyAdminLogin(adminEmail: string): Promise<LoginNotifyResult> {
  if (typeof window === 'undefined') {
    return { ok: false, error: 'notify доступен только в браузере' };
  }

  const payload = {
    adminEmail,
    loginAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    siteUrl: window.location.origin,
  };

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase.functions.invoke('login-notify', {
        body: payload,
      });
      if (!error && data?.ok) {
        const result = data as LoginNotifyResult;
        rememberLoginChallenge(result);
        return result;
      }
      // функция не задеплоена / секреты не заданы — пробуем dev-транспорт
      if (error && !import.meta.env.DEV) {
        return {
          ok: false,
          error: error.message || 'не удалось отправить письмо подтверждения',
        };
      }
    } catch (e: any) {
      if (!import.meta.env.DEV) {
        return { ok: false, error: e?.message || 'не удалось отправить письмо подтверждения' };
      }
    }
  }

  // Dev-мидлварь есть только в `npm run dev`. В проде роут отсутствует:
  // SPA-фоллбэк вернул бы index.html с 200 — бессмысленный запрос.
  if (!import.meta.env.DEV) {
    return {
      ok: false,
      error: 'сервис подтверждения входа недоступен (нет login-notify)',
    };
  }

  try {
    const res = await fetch('/api/login-notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const result = (await res.json()) as LoginNotifyResult;
      rememberLoginChallenge(result);
      return result;
    }
    const body = await res.json().catch(() => null);
    return {
      ok: false,
      error: (body as any)?.error || `HTTP ${res.status}`,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'сервис подтверждения входа недоступен' };
  }
}

const CHALLENGE_LS_KEY = 'manga_login_challenge';

/** Запомнить challenge после успешного notify (для polling / hasRole). */
export function rememberLoginChallenge(result: LoginNotifyResult) {
  if (typeof window === 'undefined' || !result.ok) return;
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  let token: string | undefined;
  try {
    if (result.preview?.approveUrl) {
      token = new URL(result.preview.approveUrl).searchParams.get('token') || undefined;
    }
  } catch {
    // ignore
  }
  const payload = {
    id: result.challengeId,
    status: 'pending' as const,
    expiresAt,
    token,
    emulated: Boolean(result.emulated),
  };
  try {
    localStorage.setItem(CHALLENGE_LS_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

/**
 * Статус последнего login-challenge текущего пользователя.
 * Supabase → RPC; dev / эмуляция → /api/login-challenge-status + localStorage.
 */
export async function getLoginChallengeStatus(): Promise<LoginChallengeStatus> {
  if (typeof window === 'undefined') return 'none';

  // Если challenge создан dev-эмуляцией (даже при настроенном Supabase URL) —
  // не ходим в RPC, которого может не быть / он пустой.
  let preferDev = !isSupabaseConfigured;
  try {
    const raw = localStorage.getItem(CHALLENGE_LS_KEY);
    if (raw && JSON.parse(raw)?.emulated) preferDev = true;
  } catch {
    // ignore
  }

  if (isSupabaseConfigured && !preferDev) {
    try {
      const { data, error } = await supabase.rpc('latest_login_challenge_status');
      if (!error && typeof data === 'string') return data;
      // Не глотаем RPC-ошибку как «none» — UI может показать «сервис недоступен».
      if (error) {
        console.warn('[login-challenge] RPC status failed:', error.message);
        return 'error';
      }
    } catch (e) {
      console.warn('[login-challenge] RPC status exception:', e);
      return 'error';
    }
  }

  // Dev API (общий для вкладок на том же origin через server file)
  if (import.meta.env.DEV) {
    try {
      let id = '';
      try {
        const raw = localStorage.getItem(CHALLENGE_LS_KEY);
        if (raw) id = JSON.parse(raw)?.id || '';
      } catch {
        // ignore
      }
      const q = id ? `?id=${encodeURIComponent(id)}` : '';
      const res = await fetch(`/api/login-challenge-status${q}`);
      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        if (body.status) {
          // синхронизируем localStorage
          try {
            const raw = localStorage.getItem(CHALLENGE_LS_KEY);
            const ch = raw ? JSON.parse(raw) : {};
            ch.status = body.status;
            localStorage.setItem(CHALLENGE_LS_KEY, JSON.stringify(ch));
          } catch {
            // ignore
          }
          return body.status as LoginChallengeStatus;
        }
      }
    } catch {
      // fallback ниже
    }
  }

  try {
    const raw = localStorage.getItem(CHALLENGE_LS_KEY);
    if (!raw) return 'none';
    const ch = JSON.parse(raw) as {
      status?: string;
      expiresAt?: string;
    };
    // approved не истекает по expiresAt (как в SQL latest_login_challenge_status).
    // Истекает только pending; denied/expired возвращаем as-is.
    if (
      ch.status !== 'approved' &&
      ch.expiresAt &&
      new Date(ch.expiresAt).getTime() < Date.now()
    ) {
      if (ch.status === 'pending') {
        ch.status = 'expired';
        localStorage.setItem(CHALLENGE_LS_KEY, JSON.stringify(ch));
      }
      return ch.status === 'expired' || !ch.status ? 'expired' : (ch.status as LoginChallengeStatus);
    }
    return (ch.status as LoginChallengeStatus) || 'none';
  } catch {
    return 'none';
  }
}

/**
 * Подтвердить / отклонить challenge по токену из письма.
 * Работает без сессии (токен = секрет).
 */
export async function resolveLoginChallenge(
  token: string,
  action: 'approve' | 'deny'
): Promise<{ ok: boolean; status: string; error?: string }> {
  const cleanToken = token.trim();
  if (!cleanToken) {
    return { ok: false, status: 'invalid', error: 'нет токена' };
  }

  const syncLocal = (status: string) => {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(CHALLENGE_LS_KEY);
      const ch = raw ? JSON.parse(raw) : {};
      // Обновляем, если токен совпал или токена в кэше ещё нет (письмо с другого устройства).
      if (!ch.token || ch.token === cleanToken) {
        ch.token = cleanToken;
        if (status === 'approved' || status === 'already_approved') ch.status = 'approved';
        else if (status === 'denied' || status === 'already_denied') ch.status = 'denied';
        else if (status === 'expired') ch.status = 'expired';
        else ch.status = status;
        ch.resolvedAt = new Date().toISOString();
        localStorage.setItem(CHALLENGE_LS_KEY, JSON.stringify(ch));
      }
    } catch {
      // ignore
    }
  };

  // Dev API первым, если challenge эмулированный или Supabase не настроен.
  let emulated = false;
  try {
    const raw =
      typeof window !== 'undefined' ? localStorage.getItem(CHALLENGE_LS_KEY) : null;
    if (raw && JSON.parse(raw)?.emulated) emulated = true;
  } catch {
    // ignore
  }

  if (import.meta.env.DEV && (emulated || !isSupabaseConfigured)) {
    try {
      const res = await fetch('/api/login-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: cleanToken, action }),
      });
      if (res.ok || res.status === 400) {
        const body = (await res.json()) as { ok: boolean; status: string; error?: string };
        if (body.status) syncLocal(body.status);
        return body;
      }
    } catch {
      // fallback ниже
    }
  }

  if (isSupabaseConfigured && !emulated) {
    try {
      // Edge-функция публичная; fallback — прямой RPC (anon имеет grant).
      const { data: fnData, error: fnError } = await supabase.functions.invoke(
        'login-confirm',
        { body: { token: cleanToken, action } }
      );
      if (!fnError && fnData?.status) {
        syncLocal(String(fnData.status));
        return {
          ok: Boolean(fnData.ok),
          status: String(fnData.status),
          error: fnData.error,
        };
      }

      const { data, error } = await supabase.rpc('resolve_login_challenge', {
        p_token: cleanToken,
        p_action: action,
      });
      if (error) {
        return { ok: false, status: 'error', error: error.message };
      }
      const status = String(data || 'error');
      const ok =
        status === 'approved' ||
        status === 'denied' ||
        status === 'already_approved' ||
        status === 'already_denied';
      syncLocal(status);
      return { ok, status };
    } catch (e: any) {
      return { ok: false, status: 'error', error: e?.message || 'ошибка подтверждения' };
    }
  }

  // Последний fallback: только localStorage (без dev-сервера).
  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(CHALLENGE_LS_KEY);
      if (!raw) return { ok: false, status: 'not_found' };
      const ch = JSON.parse(raw) as {
        token?: string;
        status?: string;
        expiresAt?: string;
      };
      if (ch.token && ch.token !== cleanToken) return { ok: false, status: 'not_found' };
      if (ch.status === 'approved') return { ok: true, status: 'already_approved' };
      if (ch.status === 'denied') return { ok: true, status: 'already_denied' };
      if (ch.expiresAt && new Date(ch.expiresAt).getTime() < Date.now()) {
        ch.status = 'expired';
        localStorage.setItem(CHALLENGE_LS_KEY, JSON.stringify(ch));
        return { ok: false, status: 'expired' };
      }
      if (ch.status && ch.status !== 'pending') {
        return { ok: false, status: ch.status };
      }

      const status = action === 'approve' ? 'approved' : 'denied';
      ch.token = cleanToken;
      ch.status = status;
      (ch as any).resolvedAt = new Date().toISOString();
      localStorage.setItem(CHALLENGE_LS_KEY, JSON.stringify(ch));
      return { ok: true, status };
    } catch (e: any) {
      return { ok: false, status: 'error', error: e?.message };
    }
  }

  return { ok: false, status: 'error', error: 'недоступно' };
}

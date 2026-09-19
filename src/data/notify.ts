import { getSupabase, isSupabaseConfigured } from './client';
import { SUPABASE_URL } from '@/integrations/supabase/config';

/** Почему не ушло письмо подтверждения — для точной подсказки владельцу в UI. */
export type LoginNotifyErrorKind =
  /** Прод-сборка без VITE_SUPABASE_* → сайт в демо-режиме, письмо слать нечем. */
  | 'demo-build'
  /** Edge Function login-notify не задеплоена (404 / "function not found"). */
  | 'fn-not-deployed'
  /** OWNER_NOTIFY_EMAIL / RESEND_API_KEY не заданы в секретах Supabase. */
  | 'secrets-missing'
  /** Resend отклонил запрос (ключ, домен отправителя, лимиты). */
  | 'resend'
  /** Сеть/браузер не достучались до функции. */
  | 'network'
  | 'other';

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
  errorKind?: LoginNotifyErrorKind;
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

/** Ключ localStorage с последним login-challenge (pending/approved/denied/expired). */
export const LOGIN_CHALLENGE_LS_KEY = 'manga_login_challenge';

/**
 * Событие «challenge в localStorage изменился» для ТОГО ЖЕ документа.
 *
 * `storage` прилетает только в другие вкладки, поэтому экран ожидания
 * (`/admin/login`) без этого события узнаёт о смене статуса лишь по polling —
 * а polling может вернуть устаревший серверный статус (см. getLoginChallengeStatus).
 */
export const LOGIN_CHALLENGE_EVENT = 'manga-login-challenge-change';

/** Запись challenge в localStorage. Формат держим в одном месте. */
export interface StoredLoginChallenge {
  id?: string;
  token?: string;
  status?: string;
  expiresAt?: string;
  resolvedAt?: string;
  emulated?: boolean;
}

type LoginChallengeListener = (
  challenge: StoredLoginChallenge | null,
  source: 'local' | 'remote'
) => void;

/** Финальные статусы challenge: ждать больше нечего. */
export function isTerminalChallengeStatus(status?: string | null): boolean {
  return status === 'approved' || status === 'denied' || status === 'expired';
}

/** Читает challenge из localStorage: null — записи нет или JSON битый. */
export function readLoginChallenge(): StoredLoginChallenge | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(LOGIN_CHALLENGE_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredLoginChallenge;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Статус записи из localStorage с учётом `expiresAt` — как в SQL
 * `latest_login_challenge_status()`: approved не истекает, pending по времени
 * становится expired, denied/expired возвращаются как есть.
 */
export function localChallengeStatus(): LoginChallengeStatus {
  const ch = readLoginChallenge();
  if (!ch?.status) return 'none';
  const status = String(ch.status);
  const expiredByTime =
    Boolean(ch.expiresAt) && new Date(String(ch.expiresAt)).getTime() < Date.now();
  if (status === 'pending' && expiredByTime) return 'expired';
  return status as LoginChallengeStatus;
}

/**
 * Финальный статус, уже записанный в localStorage (approved/denied/expired),
 * либо null, если ждать ещё есть смысл. Нужен, чтобы отставший серверный
 * статус (`pending`/`none`) не «затенял» подтверждение, которое уже получено
 * в этом браузере.
 */
export function localTerminalChallengeStatus(): 'approved' | 'denied' | 'expired' | null {
  const status = localChallengeStatus();
  return isTerminalChallengeStatus(status)
    ? (status as 'approved' | 'denied' | 'expired')
    : null;
}

/** Оповещает подписчиков ЭТОГО документа о новой записи challenge. */
function emitLoginChallengeChange(challenge: StoredLoginChallenge | null) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try {
    window.dispatchEvent(
      new CustomEvent(LOGIN_CHALLENGE_EVENT, { detail: { challenge } })
    );
  } catch {
    // CustomEvent может отсутствовать (SSR/старые окружения) — не роняем flow.
  }
}

/**
 * Записать challenge в localStorage и оповестить подписчиков.
 *
 * Событие шлём только при реальном изменении записи: polling вызывает функцию
 * каждые 2.5 с, и «пустые» события заставляли бы экран ожидания перерисовываться
 * без причины.
 *
 * `replace: true` — это НОВЫЙ challenge: старый статус (approved/denied) и
 * resolvedAt наследовать нельзя, иначе новый вход выглядел бы подтверждённым.
 */
export function persistLoginChallenge(
  patch: StoredLoginChallenge,
  opts?: { replace?: boolean }
): StoredLoginChallenge | null {
  if (typeof window === 'undefined') return null;
  const before = readLoginChallenge();
  const base = opts?.replace ? {} : (before ?? {});
  const next: StoredLoginChallenge = { ...base, ...patch };
  if (before && JSON.stringify(before) === JSON.stringify(next)) return before;
  try {
    localStorage.setItem(LOGIN_CHALLENGE_LS_KEY, JSON.stringify(next));
  } catch {
    // Приватный режим/квота: localStorage — не единственный источник статуса.
    return next;
  }
  emitLoginChallengeChange(next);
  return next;
}

/** Удалить challenge (signOut) — «записи больше нет» видят и другие вкладки. */
export function clearLoginChallenge() {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(LOGIN_CHALLENGE_LS_KEY);
  } catch {
    // ignore
  }
  emitLoginChallengeChange(null);
}

/**
 * Подписка на изменения challenge: `storage` (другие вкладки этого origin)
 * + LOGIN_CHALLENGE_EVENT (эта самая вкладка).
 *
 * Благодаря ей экран ожидания переводит `phase` сразу после approve/deny, а не
 * только по таймеру polling — и продолжает работать, когда серверный статус
 * отстаёт от localStorage.
 */
export function subscribeLoginChallenge(listener: LoginChallengeListener): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }
  const onStorage = (event: StorageEvent) => {
    // key === null — storage.clear(), могли стереть и наш ключ.
    if (event.key !== null && event.key !== LOGIN_CHALLENGE_LS_KEY) return;
    listener(readLoginChallenge(), 'remote');
  };
  const onLocal = (event: Event) => {
    const detail = (event as CustomEvent<{ challenge?: StoredLoginChallenge | null }>).detail;
    const challenge =
      detail && 'challenge' in detail ? detail.challenge ?? null : readLoginChallenge();
    listener(challenge, 'local');
  };
  window.addEventListener('storage', onStorage as EventListener);
  window.addEventListener(LOGIN_CHALLENGE_EVENT, onLocal);
  return () => {
    window.removeEventListener('storage', onStorage as EventListener);
    window.removeEventListener(LOGIN_CHALLENGE_EVENT, onLocal);
  };
}

/**
 * Достаёт статус и тело ошибки из FunctionsHttpError (supabase-js кладёт
 * оригинальный Response в `error.context`). Тело нашей функции —
 * `{ ok:false, error: '...' }`;relay/404 могут отдавать просто текст.
 */
async function extractEdgeErrorDetail(
  error: unknown
): Promise<{ status?: number; detail?: string }> {
  try {
    const ctx = (error as { context?: Response })?.context;
    if (ctx && typeof ctx.status === 'number') {
      const text = await ctx.text().catch(() => '');
      if (text) {
        try {
          const j = JSON.parse(text) as { error?: unknown; message?: unknown };
          if (j?.error != null) return { status: ctx.status, detail: String(j.error) };
          if (j?.message != null) return { status: ctx.status, detail: String(j.message) };
        } catch {
          return { status: ctx.status, detail: text.slice(0, 200) };
        }
      }
      return { status: ctx.status };
    }
  } catch {
    // ignore
  }
  return {};
}

/**
 * Классифицирует сбой `login-notify` в понятную строку + вид причины,
 * чтобы владелец сразу видел, ЧТО именно настраивать (деплой/секреты/Resend).
 * Экспортируется для unit-тестов.
 */
export function classifyEdgeFailure(
  error: unknown,
  status?: number,
  detail?: string
): { error: string; errorKind: LoginNotifyErrorKind } {
  const d = (detail || '').toLowerCase();
  const msg = ((error as Error)?.message || '').toLowerCase();

  // 1) Функция не задеплоена: явный 404 от edge-рантайма или текст "not found" в ответе.
  //    ВАЖНО: голый FunctionsFetchError ("Failed to send a request to the Edge Function")
  //    БЕЗ context/status НЕ означает "не задеплоена" — он приходит при DNS/CORS/сетевом
  //    сбое. Настоящий 404 всегда идёт как FunctionsHttpError с context.status === 404.
  if (
    status === 404 ||
    /function not found|not deployed|could not be found/.test(d)
  ) {
    return {
      error:
        'Edge Function login-notify не задеплоена в этом проекте. ' +
        'Владелец: `supabase functions deploy login-notify --project-ref <ref>` ' +
        '(и `login-confirm`), см. SETUP_SUPABASE.md раздел 6 или ' +
        '`node scripts/setup-login-guard.mjs --help`',
      errorKind: 'fn-not-deployed',
    };
  }

  // 1b) FunctionsFetchError без HTTP-ответа — сеть/блокировка/CORS.
  //     (Сюда попадаем когда detail пуст, а сообщение говорит что запрос не ушёл.)
  if (!status && !detail && /failed to send a request|fetch|network|econn/i.test(msg)) {
    // Подставляем реальный хост из SUPABASE_URL, чтобы пользователь видел,
    // куда именно не достучаться; fallback — плейсхолдер на случай если
    // SUPABASE_URL вообще не задан (demo-build отрабатывает раньше, но страхуемся).
    const host = (SUPABASE_URL || 'https://<ref>.supabase.co').replace(/^https?:\/\//, '').replace(/\/$/, '');
    return {
      error:
        `Не удалось достучаться до Edge Function login-notify (${host}) — сетевая ошибка, ` +
        'блокировка запроса или CORS. Проверьте соединение; быстрая самопроверка:\n' +
        `  curl -s -o /dev/null -w '%{http_code}\\n' -X POST https://${host}/functions/v1/login-notify\n` +
        '  401 → жива; 404 → не задеплоена; 000 → сеть/блокировка',
      errorKind: 'network',
    };
  }

  // 2) Секреты не заданы — функция сама возвращает точные 500/503.
  if (d.includes('owner_notify_email')) {
    return {
      error:
        'в секретах Supabase не задан OWNER_NOTIFY_EMAIL. Владелец: ' +
        '`supabase secrets set OWNER_NOTIFY_EMAIL=you@domain.tld --project-ref <ref>`',
      errorKind: 'secrets-missing',
    };
  }
  if (d.includes('resend_api_key')) {
    return {
      error:
        'в секретах Supabase не задан RESEND_API_KEY. Владелец: ' +
        '`supabase secrets set RESEND_API_KEY=re_xxx --project-ref <ref>` ' +
        '(ключ: resend.com → API Keys)',
      errorKind: 'secrets-missing',
    };
  }

  // 3) Resend отклонил письмо (502 от функции с текстом Resend).
  if (
    status === 502 ||
    /resend|api key|unverified|not allowed to send|sender|domain/.test(d)
  ) {
    return {
      error:
        `Resend не принял письмо${detail ? `: ${detail}` : ''}. Владелец: проверьте ` +
        'RESEND_API_KEY; отправитель по умолчанию onboarding@resend.dev доставляет ' +
        'почту ТОЛЬКО на адрес аккаунта Resend — для другого адреса подтвердите ' +
        'домен в Resend и задайте секрет OWNER_NOTIFY_FROM',
      errorKind: 'resend',
    };
  }

  // 4) Всё остальное (ошибка challenge, auth, сеть) — как есть.
  const text = detail || (error as Error)?.message || 'не удалось отправить письмо подтверждения';
  return { error: text, errorKind: /fetch|network|econn|cors/i.test(text) ? 'network' : 'other' };
}

/**
 * Запускает обязательное подтверждение входа (Login Guard).
 *
 * Транспорт:
 *  1. Supabase Edge Function `login-notify` — создаёт challenge + Resend;
 *  2. dev-мидлварь Vite `/api/login-notify` (только `npm run dev`).
 *
 * Если письмо/challenge не удалось создать — `ok: false` + `errorKind`.
 * Вызывающий код ОБЯЗАН откатить сессию (signOut): без подтверждения входа нет.
 */
export async function notifyAdminLogin(adminEmail: string): Promise<LoginNotifyResult> {
  if (typeof window === 'undefined') {
    return { ok: false, error: 'notify доступен только в браузере', errorKind: 'other' };
  }

  const payload = {
    adminEmail,
    loginAt: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'Node.js',
    siteUrl: typeof window !== 'undefined' && window.location ? window.location.origin : '',
  };

  if (isSupabaseConfigured) {
    try {
      const supabase = await getSupabase();
      const { data, error } = await supabase.functions.invoke('login-notify', {
        body: payload,
      });
      if (!error && data?.ok) {
        const result = data as LoginNotifyResult;
        rememberLoginChallenge(result);
        return result;
      }
      // Прод: разбираем, ЧТО именно сломано (деплой / секреты / Resend).
      // DEV при ошибке функции проваливается в эмуляцию ниже.
      if (!import.meta.env.DEV) {
        const { status, detail } = await extractEdgeErrorDetail(error);
        const { error: message, errorKind } = classifyEdgeFailure(error, status, detail);
        return { ok: false, error: message, errorKind };
      }
    } catch (e: any) {
      if (!import.meta.env.DEV) {
        const { error: message, errorKind } = classifyEdgeFailure(e);
        return { ok: false, error: message, errorKind };
      }
    }
  }

  // Dev-мидлварь есть только в `npm run dev`. В проде роут отсутствует:
  // сюда попадают либо демо-сборка (нет VITE_SUPABASE_*), либо сбой выше.
  if (!import.meta.env.DEV) {
    return {
      ok: false,
      error:
        'в этой сборке вообще не настроен Supabase (нет VITE_SUPABASE_URL и ключа) — ' +
        'сайт работает в демо-режиме, письмо подтверждения отправить нечем. ' +
        'Владелец: задайте переменные сборки, затем настройте секреты и задеплойте ' +
        'функции (SETUP_SUPABASE.md раздел 6, `node scripts/setup-login-guard.mjs --help`)',
      errorKind: 'demo-build',
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
  // replace: это новый challenge, а не обновление предыдущего.
  persistLoginChallenge(
    {
      id: result.challengeId,
      status: 'pending',
      expiresAt,
      token,
      emulated: Boolean(result.emulated),
    },
    { replace: true }
  );
}

/**
 * Статус последнего login-challenge текущего пользователя.
 * Supabase → RPC; dev / эмуляция → /api/login-challenge-status + localStorage.
 */
export async function getLoginChallengeStatus(): Promise<LoginChallengeStatus> {
  if (typeof window === 'undefined') return 'none';

  const local = readLoginChallenge();

  // Если challenge создан dev-эмуляцией (даже при настроенном Supabase URL) —
  // не ходим в RPC, которого может не быть / он пустой.
  const preferDev = !isSupabaseConfigured || Boolean(local?.emulated);

  if (isSupabaseConfigured && !preferDev) {
    try {
      const supabase = await getSupabase();
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

  /**
   * Финализация статуса перед возвратом: истечение pending по времени —
   * единственный статус, который вычисляется локально, поэтому его надо
   * зафиксировать в localStorage — событие подхватит экран ожидания.
   */
  const finalize = (status: LoginChallengeStatus): LoginChallengeStatus => {
    if (status === 'expired' && local?.status === 'pending') {
      persistLoginChallenge({ status: 'expired' });
    }
    return status;
  };

  // Dev API (общий для вкладок на том же origin через server file)
  if (import.meta.env.DEV) {
    try {
      const id = local?.id || '';
      const q = id ? `?id=${encodeURIComponent(id)}` : '';
      const res = await fetch(`/api/login-challenge-status${q}`);
      if (res.ok) {
        const body = (await res.json()) as { status?: string; id?: string };
        if (body.status) {
          const remote = String(body.status);
          // Локальный финальный статус не должен «затеняться» отставшим dev-API.
          // Challenge мог быть подтверждён в этом браузере (ссылка из письма в
          // соседней вкладке, approve через localStorage-fallback), а dev-стор
          // знает только старый pending: без этой ветки экран ожидания зависает,
          // хотя в localStorage уже approved/denied/expired.
          const localTerminal = localTerminalChallengeStatus();
          const sameChallenge = !local?.id || !body.id || local.id === body.id;
          if (localTerminal && sameChallenge && !isTerminalChallengeStatus(remote)) {
            return finalize(localTerminal);
          }
          // Синхронизируем localStorage — от этого события узнаёт экран ожидания.
          persistLoginChallenge({ id: body.id ?? local?.id, status: remote });
          return finalize(remote as LoginChallengeStatus);
        }
      }
    } catch {
      // fallback ниже
    }
  }

  return finalize(localChallengeStatus());
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

  /**
   * Зафиксировать результат в localStorage. Именно это (плюс `storage` в
   * других вкладках) мгновенно обновляет экран ожидания — поэтому пишем через
   * persistLoginChallenge, а не напрямую setItem.
   */
  const syncLocal = (status: string) => {
    if (typeof window === 'undefined') return;
    const ch = readLoginChallenge();
    // Обновляем, если токен совпал или токена в кэше ещё нет (письмо с другого устройства).
    if (ch?.token && ch.token !== cleanToken) return;
    let next = status;
    if (status === 'approved' || status === 'already_approved') next = 'approved';
    else if (status === 'denied' || status === 'already_denied') next = 'denied';
    else if (status === 'expired') next = 'expired';
    persistLoginChallenge({
      token: cleanToken,
      status: next,
      resolvedAt: new Date().toISOString(),
    });
  };

  // Dev API первым, если challenge эмулированный или Supabase не настроен.
  const emulated = Boolean(readLoginChallenge()?.emulated);

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
      const supabase = await getSupabase();
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
      const ch = readLoginChallenge();
      if (!ch) return { ok: false, status: 'not_found' };
      if (ch.token && ch.token !== cleanToken) return { ok: false, status: 'not_found' };
      if (ch.status === 'approved') return { ok: true, status: 'already_approved' };
      if (ch.status === 'denied') return { ok: true, status: 'already_denied' };
      if (ch.expiresAt && new Date(ch.expiresAt).getTime() < Date.now()) {
        // persist: экран ожидания в этой же вкладке узнаёт об истечении сразу.
        persistLoginChallenge({ status: 'expired' });
        return { ok: false, status: 'expired' };
      }
      if (ch.status && ch.status !== 'pending') {
        return { ok: false, status: ch.status };
      }

      const status = action === 'approve' ? 'approved' : 'denied';
      persistLoginChallenge({
        token: cleanToken,
        status,
        resolvedAt: new Date().toISOString(),
      });
      return { ok: true, status };
    } catch (e: any) {
      return { ok: false, status: 'error', error: e?.message };
    }
  }

  return { ok: false, status: 'error', error: 'недоступно' };
}

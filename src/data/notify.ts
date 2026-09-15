import { supabase, isSupabaseConfigured } from './client';

export interface LoginNotifyResult {
  ok: boolean;
  emulated?: boolean;
  error?: string;
}

/**
 * Уведомляет владельца сайта о входе администратора.
 *
 * Транспорт (по убыванию приоритета):
 *  1. Supabase Edge Function `login-notify` (Resend, секреты на сервере);
 *  2. dev-мидлварь Vite `/api/login-notify` (читает .env: RESEND_API_KEY,
 *     OWNER_NOTIFY_EMAIL; без ключа Resend — эмулирует письмо в консоль);
 *  3. в проде без Supabase эндпоинта нет → тихо `{ ok: false }`.
 *
 * Ошибки отправки НИКОГДА не прерывают вход: это уведомление, а не 2FA.
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
        return data as LoginNotifyResult;
      }
      // функция не задеплоена или упала — пробуем dev-транспорт ниже
    } catch {
      // fallback
    }
  }

  try {
    const res = await fetch('/api/login-notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      return (await res.json()) as LoginNotifyResult;
    }
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'сервис уведомлений недоступен' };
  }
}

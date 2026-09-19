import { getSupabase, isSupabaseConfigured } from './client';
import { mockStore } from './mockStore';
import {
  notifyAdminLogin,
  getLoginChallengeStatus,
  readLoginChallenge,
  clearLoginChallenge,
  type LoginNotifyResult,
} from './notify';

export type SignInResult = {
  data: { user: any; session: any };
  error: Error | null;
  /** Сессия есть, но ждём подтверждение из письма. */
  pendingConfirmation?: boolean;
  notify?: LoginNotifyResult;
};

type AuthListener = (session: any) => void;
const authListeners = new Set<AuthListener>();

/**
 * Оповещает всех подписчиков (включая useAuth в Header) об изменении
 * состояния авторизации без необходимости перезагрузки страницы.
 */
export function notifyAuthChanged(session?: any) {
  authListeners.forEach((listener) => {
    try {
      listener(session);
    } catch {
      // ignore
    }
  });
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(
        new CustomEvent('manga-auth-change', { detail: { session } })
      );
    } catch {
      // ignore
    }
  }
}

/**
 * Демо-сессия для режима без Supabase. Реальных паролей в коде нет и не было:
 * в демо-режиме форма входа принимает любые непустые email и пароль — это
 * заглушка для локальной разработки, а не аутентификация. При настроенном
 * Supabase (`VITE_SUPABASE_URL` + ключ) работает только Supabase Auth.
 *
 * Login Guard обязателен и в демо: без подтверждения из письма (или dev-ссылки)
 * админ-панель не откроется.
 */
function createMockSession(email: string) {
  // В демо без Supabase считаем единственного пользователя владельцем,
  // чтобы локально можно было и создавать главы, и разбирать заявки.
  const mockUser = {
    id: 'demo-admin-01',
    email,
    user_metadata: { role: 'owner' },
    role: 'owner',
  };
  const mockSession = {
    user: mockUser,
    access_token: 'mock-access-token',
  };
  return { mockUser, mockSession };
}

/**
 * После успешного пароля: отправить письмо с challenge.
 * Если письмо не ушло — сессию откатываем: без подтверждения входа нет.
 */
async function requireLoginConfirmation(
  adminEmail: string
): Promise<{ ok: true; notify: LoginNotifyResult } | { ok: false; error: Error; notify?: LoginNotifyResult }> {
  const notify = await notifyAdminLogin(adminEmail);
  if (!notify.ok) {
    await auth.signOut();
    return {
      ok: false,
      error: new Error(
        notify.error
          ? `Вход отклонён: не удалось отправить письмо подтверждения (${notify.error})`
          : 'Вход отклонён: не удалось отправить письмо подтверждения'
      ),
      notify,
    };
  }
  return { ok: true, notify };
}

export const auth = {
  /**
   * Подписка на локальные изменения auth-состояния (работает без загрузки Supabase SDK).
   */
  subscribe(callback: (session: any) => void): () => void {
    authListeners.add(callback);
    return () => {
      authListeners.delete(callback);
    };
  },

  /**
   * Вход по email/паролю. Даже при верном пароле сессия «висит», пока
   * владелец не подтвердит вход ссылкой из письма на OWNER_NOTIFY_EMAIL.
   * `pendingConfirmation: true` → UI показывает экран ожидания.
   */
  async signIn(email: string, password: string): Promise<SignInResult> {
    const cleanEmail = email.trim().toLowerCase();

    // 1. Supabase Auth — единственный настоящий путь
    if (isSupabaseConfigured) {
      try {
        const supabase = await getSupabase();
        const { data, error } = await supabase.auth.signInWithPassword({
          email: cleanEmail,
          password,
        });
        if (!error && data?.session) {
          // Проверяем роль ДО challenge: иначе любой зарегистрированный
          // юзер мог бы спамить письмами владельцу.
          const isAdmin = await this.hasRole(data.session.user.id, 'admin', {
            skipChallenge: true,
          });
          if (!isAdmin) {
            await this.signOut();
            return {
              data: { user: null, session: null },
              error: new Error('Нет прав администратора'),
            };
          }

          mockStore.setAdminSession(data.session);
          notifyAuthChanged(data.session);
          const conf = await requireLoginConfirmation(cleanEmail);
          if (!conf.ok) {
            return {
              data: { user: null, session: null },
              error: conf.error,
              notify: conf.notify,
            };
          }
          return {
            data: { user: data.user, session: data.session },
            error: null,
            pendingConfirmation: true,
            notify: conf.notify,
          };
        }
        if (error) {
          const message =
            error.message === 'Invalid login credentials'
              ? 'Неверный email или пароль'
              : error.message;
          return { data: { user: null, session: null }, error: new Error(message) };
        }
      } catch (err: any) {
        return {
          data: { user: null, session: null },
          error: new Error(err.message || 'Ошибка входа'),
        };
      }
    }

    // 2. Демо-режим (Supabase не настроен): конкретных учётных данных нет,
    //    достаточно непустых полей — защита от случайной пустой формы.
    if (!cleanEmail || !password) {
      return {
        data: { user: null, session: null },
        error: new Error('Введите email и пароль'),
      };
    }

    const { mockUser, mockSession } = createMockSession(cleanEmail);
    mockStore.setAdminSession(mockSession);
    notifyAuthChanged(mockSession);
    const conf = await requireLoginConfirmation(cleanEmail);
    if (!conf.ok) {
      return {
        data: { user: null, session: null },
        error: conf.error,
        notify: conf.notify,
      };
    }
    return {
      data: { user: mockUser, session: mockSession },
      error: null,
      pendingConfirmation: true,
      notify: conf.notify,
    };
  },

  async signOut() {
    mockStore.setAdminSession(null);
    // Полный сброс LS: approved/pending/denied.
    // Иначе soft-fail keep-alive (error + local approved) открыл бы
    // /admin после signOut без нового письма.
    // clearLoginChallenge (а не localStorage.removeItem): экран ожидания в этой
    // вкладке и подписчики получают событие «challenge исчез».
    clearLoginChallenge();
    notifyAuthChanged(null);
    if (isSupabaseConfigured) {
      try {
        const supabase = await getSupabase();
        await supabase.auth.signOut();
      } catch {
        // Ignore
      }
    }
  },

  async getSession() {
    if (isSupabaseConfigured) {
      try {
        const supabase = await getSupabase();
        const { data } = await supabase.auth.getSession();
        if (data?.session) {
          mockStore.setAdminSession(data.session);
          return data.session;
        }
      } catch {
        // Fallback
      }
    }
    return mockStore.getAdminSession();
  },

  async getUser() {
    const session = await this.getSession();
    return session?.user ?? null;
  },

  async onAuthStateChange(callback: (event: string, session: any) => void) {
    if (isSupabaseConfigured) {
      try {
        const supabase = await getSupabase();
        return supabase.auth.onAuthStateChange((event, newSession) => {
          notifyAuthChanged(newSession);
          callback(event, newSession);
        });
      } catch {
        // Fallback
      }
    }
    return { data: { subscription: { unsubscribe: () => {} } } };
  },

  /**
   * true, только если challenge ТЕКУЩЕЙ session_id = approved.
   * Без этого админ-роуты редиректят на /admin/login.
   *
   * При транзиентной ошибке RPC (`status === 'error'`):
   *  - если в localStorage уже был approved для этой вкладки → keep-alive (null),
   *    чтобы мигающий сбой не выкидывал owner'а;
   *  - иначе false (не улучшаем доступ).
   * Никогда не пишем 'approved' в LS при error.
   */
  async isLoginConfirmed(): Promise<boolean | null> {
    const status = await getLoginChallengeStatus();
    if (status === 'approved') return true;
    if (status === 'error') {
      // Keep-alive только если локально уже подтверждали эту сессию.
      try {
        if (typeof window !== 'undefined') {
          if (readLoginChallenge()?.status === 'approved') return null;
        }
      } catch {
        // ignore
      }
      return false;
    }
    return false;
  },

  async getLoginChallengeStatus() {
    return getLoginChallengeStatus();
  },

  async hasRole(
    userId: string,
    role: string,
    opts?: { skipChallenge?: boolean }
  ): Promise<boolean> {
    const session = await this.getSession();
    if (!session) return false;

    // 1. Явная локальная (демо) сессия
    const localSession = mockStore.getAdminSession();
    let roleOk = false;

    if (localSession && localSession.user?.id === userId) {
      const userRole = localSession.user.user_metadata?.role || localSession.user.role;
      // owner имеет все права admin; admin ≠ owner.
      if (
        userRole === role ||
        (role === 'admin' && (userRole === 'admin' || userRole === 'owner')) ||
        (role === 'owner' && userRole === 'owner')
      ) {
        roleOk = true;
      }
    }

    // 2. Validate userId is a valid UUID before passing to Postgres RPC
    // Канонический формат 8-4-4-4-12 (раньше терялась четвёртая группа → hasRole всегда false).
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);

    // 3. Строго через Supabase RPC, если настроен
    if (!roleOk && isUuid && isSupabaseConfigured) {
      try {
        const supabase = await getSupabase();
        const { data, error } = await supabase.rpc('has_role', {
          uid: userId,
          role_to_check: role,
        });
        if (!error && typeof data === 'boolean') {
          roleOk = data;
        }
      } catch {
        return false;
      }
    }

    if (!roleOk) return false;

    // 4. Login Guard: роль есть, но без подтверждения из письма — не админ.
    //    skipChallenge: signIn до create challenge / login-notify.
    //    confirmed === null → keep-alive (только после local approved).
    //    confirmed === false → отказ (в т.ч. error без prior approved).
    if (!opts?.skipChallenge) {
      const confirmed = await this.isLoginConfirmed();
      if (confirmed === false) return false;
    }

    return true;
  },
};

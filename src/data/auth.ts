import { supabase, isSupabaseConfigured } from './client';
import { mockStore } from './mockStore';
import { notifyAdminLogin } from './notify';

/**
 * Уведомление о входе не должно ни ломать, ни замедлять вход: fire-and-forget.
 * Транспорт и секреты — см. src/data/notify.ts и SETUP_SUPABASE.md.
 */
function fireLoginNotify(adminEmail: string) {
  void notifyAdminLogin(adminEmail).then((r) => {
    if (!r.ok && import.meta.env.DEV) {
      console.warn('[login-notify] письмо не отправлено:', r.error);
    }
  });
}

/**
 * Демо-сессия для режима без Supabase. Реальных паролей в коде нет и не было:
 * в демо-режиме форма входа принимает любые непустые email и пароль — это
 * заглушка для локальной разработки, а не аутентификация. При настроенном
 * Supabase (`VITE_SUPABASE_URL` + ключ) работает только Supabase Auth.
 */
function createMockSession(email: string) {
  const mockUser = {
    id: 'demo-admin-01',
    email,
    user_metadata: { role: 'admin' },
    role: 'admin',
  };
  const mockSession = {
    user: mockUser,
    access_token: 'mock-access-token',
  };
  return { mockUser, mockSession };
}

export const auth = {
  async signIn(email: string, password: string) {
    const cleanEmail = email.trim().toLowerCase();

    // 1. Supabase Auth — единственный настоящий путь
    if (isSupabaseConfigured) {
      try {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: cleanEmail,
          password,
        });
        if (!error && data?.session) {
          mockStore.setAdminSession(data.session);
          fireLoginNotify(cleanEmail);
          return { data, error: null };
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
    fireLoginNotify(cleanEmail);
    return { data: { user: mockUser, session: mockSession }, error: null };
  },

  async signOut() {
    mockStore.setAdminSession(null);
    if (isSupabaseConfigured) {
      try {
        await supabase.auth.signOut();
      } catch {
        // Ignore
      }
    }
  },

  async getSession() {
    if (isSupabaseConfigured) {
      try {
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

  async hasRole(userId: string, role: string) {
    const session = await this.getSession();
    if (!session) return false;

    // 1. Явная локальная (демо) сессия
    const localSession = mockStore.getAdminSession();
    if (localSession && localSession.user?.id === userId) {
      const userRole = localSession.user.user_metadata?.role || localSession.user.role;
      if (userRole === role || userRole === 'admin') {
        return true;
      }
    }

    // 2. Validate userId is a valid UUID before passing to Postgres RPC
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
    if (!isUuid) {
      return false;
    }

    // 3. Строго через Supabase RPC, если настроен
    if (isSupabaseConfigured) {
      try {
        const { data, error } = await supabase.rpc('has_role', {
          uid: userId,
          role_to_check: role,
        });
        if (!error && typeof data === 'boolean') {
          return data;
        }
      } catch {
        return false;
      }
    }

    return false;
  },
};

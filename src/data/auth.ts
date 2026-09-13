import { supabase, isSupabaseConfigured } from './client';
import { mockStore } from './mockStore';

export const auth = {
  async signIn(email: string, password: string) {
    let supabaseError: any = null;
    const cleanEmail = email.trim().toLowerCase();

    // 1. Try real Supabase auth if configured
    if (isSupabaseConfigured) {
      try {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: cleanEmail,
          password,
        });
        if (!error && data?.session) {
          mockStore.setAdminSession(data.session);
          return { data, error: null };
        }
        if (error) {
          supabaseError = error;
        }
      } catch (err: any) {
        supabaseError = err;
      }
    }

    // 2. Strict Demo / Local Auth Fallback (ONLY in DEV mode or when network/fetch to Supabase fails)
    const isNetworkError =
      !isSupabaseConfigured ||
      supabaseError?.message === 'Failed to fetch' ||
      supabaseError?.name === 'FetchError' ||
      supabaseError?.status === 0;

    const isAdminPass = password === 'HikkoAdmin_2026!kM9x' || password === 'admin123';
    const isDemoPass = password === 'demo123';

    const isValidAdminFallback = cleanEmail === 'admin@hikkomanga.local' && isAdminPass;
    const isValidDemoFallback = cleanEmail === 'demo@hikkomanga.local' && isDemoPass;

    if (import.meta.env.DEV || isNetworkError) {
      if (isValidAdminFallback || isValidDemoFallback) {
        const mockUser = {
          id: cleanEmail === 'demo@hikkomanga.local' ? 'user-demo-01' : 'user-admin-01',
          email: cleanEmail,
          user_metadata: { role: 'admin' },
          role: 'admin',
        };
        const mockSession = {
          user: mockUser,
          access_token: 'mock-access-token',
        };
        mockStore.setAdminSession(mockSession);
        return {
          data: { user: mockUser, session: mockSession },
          error: null,
        };
      }
    }

    const errorMessage =
      supabaseError?.message === 'Invalid login credentials'
        ? 'Неверный email или пароль'
        : supabaseError?.message || 'Неверный email или пароль';

    return {
      data: { user: null, session: null },
      error: new Error(errorMessage),
    };
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

    // 1. Explicit mock local session check
    const localSession = mockStore.getAdminSession();
    if (localSession && localSession.user?.id === userId) {
      const userRole = localSession.user.user_metadata?.role || localSession.user.role;
      if (userRole === role || userRole === 'admin') {
        return true;
      }
    }

    if (
      session.user?.email === 'demo@hikkomanga.local' ||
      session.user?.email === 'admin@hikkomanga.local'
    ) {
      return true;
    }

    // 2. Validate userId is a valid UUID before passing to Postgres RPC
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
    if (!isUuid) {
      return false;
    }

    // 3. Check strictly via Supabase RPC if configured
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

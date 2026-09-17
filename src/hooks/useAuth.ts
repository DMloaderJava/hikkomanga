import { useState, useEffect, useCallback } from 'react';
import { auth } from '@/data/auth';

function hasStoredAuth(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const rawChallenge = localStorage.getItem('manga_login_challenge');
    if (rawChallenge) {
      const parsed = JSON.parse(rawChallenge);
      if (parsed?.status === 'approved') return true;
    }
    if (localStorage.getItem('manga_admin_session')) return true;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.startsWith('sb-') && key.endsWith('-auth-token'))) {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * React hook для управления сессией и правами пользователя.
 *
 * @param options.requireAuth — если true (например, на защищённых роутах `/admin/*`),
 *        принудительно инициализирует Supabase клиент и ожидает сессию.
 *        По умолчанию (в Header для гостей) клиент Supabase НЕ загружается
 *        на холодном старте (0 kB initial overhead). При логине через диалог или
 *        изменении сессии хук реактивно обновляет состояние через лёгкую подписку
 *        без необходимости перезагрузки страницы (F5).
 */
export function useAuth(options?: { requireAuth?: boolean }) {
  const requireAuth = Boolean(options?.requireAuth);
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(() => {
    return requireAuth || hasStoredAuth();
  });
  const [isAdmin, setIsAdmin] = useState(false);

  const refreshAuth = useCallback(async (incomingSession?: any) => {
    try {
      const activeSession =
        incomingSession !== undefined
          ? incomingSession
          : await auth.getSession();

      setSession(activeSession);
      if (activeSession?.user) {
        const hasAdminRole = await auth.hasRole(activeSession.user.id, 'admin');
        setIsAdmin(hasAdminRole);
      } else {
        setIsAdmin(false);
      }
    } catch (err) {
      console.error('Error refreshing session:', err);
      setIsAdmin(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    let supabaseUnsubscribe: (() => void) | undefined;

    // 1. Подписываемся на локальные события аутентификации (легковесно, 0 kB Supabase SDK)
    const unsubscribeLocal = auth.subscribe((newSession) => {
      if (!mounted) return;
      void refreshAuth(newSession);
    });

    const handleCustomEvent = (event: Event) => {
      if (!mounted) return;
      const customEvent = event as CustomEvent;
      void refreshAuth(customEvent.detail?.session);
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('manga-auth-change', handleCustomEvent);
    }

    // 2. Если пользователь уже был авторизован или requireAuth=true — инициализируем состояние
    if (requireAuth || hasStoredAuth()) {
      async function init() {
        try {
          await refreshAuth();
          if (!mounted) return;

          const sub = await auth.onAuthStateChange((_event, newSession) => {
            if (!mounted) return;
            void refreshAuth(newSession);
          });
          supabaseUnsubscribe = sub?.data?.subscription?.unsubscribe;
        } catch (err) {
          console.error('Error loading initial session:', err);
        }
      }
      void init();
    } else {
      setLoading(false);
    }

    return () => {
      mounted = false;
      unsubscribeLocal();
      if (typeof window !== 'undefined') {
        window.removeEventListener('manga-auth-change', handleCustomEvent);
      }
      if (supabaseUnsubscribe) {
        supabaseUnsubscribe();
      }
    };
  }, [requireAuth, refreshAuth]);

  return {
    session,
    isAuthenticated: !!session,
    isAdmin,
    loading,
  };
}

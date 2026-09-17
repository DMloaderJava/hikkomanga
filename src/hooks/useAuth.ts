import { useState, useEffect } from 'react';
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

export function useAuth(options?: { requireAuth?: boolean }) {
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(() => {
    return options?.requireAuth || hasStoredAuth();
  });
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | undefined;

    // Guest without stored credentials: do not trigger async auth initialization
    if (!options?.requireAuth && !hasStoredAuth()) {
      setLoading(false);
      return;
    }

    async function init() {
      try {
        const activeSession = await auth.getSession();
        if (!mounted) return;
        setSession(activeSession);
        if (activeSession?.user) {
          const hasAdminRole = await auth.hasRole(activeSession.user.id, 'admin');
          if (mounted) setIsAdmin(hasAdminRole);
        } else {
          setIsAdmin(false);
        }

        const sub = await auth.onAuthStateChange((_event, newSession) => {
          if (!mounted) return;
          setSession(newSession);
          if (newSession?.user) {
            void auth.hasRole(newSession.user.id, 'admin').then((hasRole) => {
              if (mounted) setIsAdmin(hasRole);
            });
          } else {
            setIsAdmin(false);
          }
        });
        unsubscribe = sub?.data?.subscription?.unsubscribe;
      } catch (err) {
        console.error('Error loading session:', err);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    init();

    return () => {
      mounted = false;
      if (unsubscribe) unsubscribe();
    };
  }, [options?.requireAuth]);

  return {
    session,
    isAuthenticated: !!session,
    isAdmin,
    loading,
  };
}

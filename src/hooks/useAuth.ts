import { useState, useEffect } from 'react';
import { auth } from '@/data/auth';
import { supabase } from '@/data/client';

export function useAuth() {
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function loadAuth(currentSession?: any) {
      try {
        const activeSession = currentSession !== undefined ? currentSession : await auth.getSession();
        if (mounted) {
          setSession(activeSession);
          if (activeSession?.user) {
            const hasAdminRole = await auth.hasRole(activeSession.user.id, 'admin');
            if (mounted) setIsAdmin(hasAdminRole);
          } else {
            setIsAdmin(false);
          }
        }
      } catch (err) {
        console.error('Error loading session:', err);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    loadAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setTimeout(() => {
        if (mounted) {
          loadAuth(newSession);
        }
      }, 0);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  return {
    session,
    isAuthenticated: !!session,
    isAdmin,
    loading,
  };
}

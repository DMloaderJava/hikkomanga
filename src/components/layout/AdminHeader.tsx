import { useContext, useEffect, useState, useCallback, useRef } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { Library, Tag, ArrowLeft, LogOut, Inbox, Megaphone, Settings, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { auth } from '@/data/auth';
import { adminRequests } from '@/data/adminRequests';
import { SupportChatContext } from '@/components/support/SupportChatContext';

export function AdminHeader() {
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const ownerKnown = useRef(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Через контекст, а не через useSupportChat(): хедер переиспользуется в
  // тестах/страницах без провайдера, и бросать исключение из-за кнопки чата
  // там не за что — кнопка просто ничего не делает.
  const support = useContext(SupportChatContext);

  const refreshPending = useCallback(async () => {
    try {
      // hasRole(owner) — один раз за mount (не на каждый pathname).
      if (!ownerKnown.current) {
        const s = await auth.getSession();
        const uid = s?.user?.id;
        if (!uid) return;
        const owner = await auth.hasRole(uid, 'owner');
        setIsOwner(owner);
        ownerKnown.current = true;
        if (!owner) {
          setPendingCount(null);
          return;
        }
      } else if (!isOwner) {
        return;
      }
      const list = await adminRequests.listPending();
      setPendingCount(list.length);
    } catch {
      // header не должен ломаться
    }
  }, [isOwner]);

  useEffect(() => {
    void refreshPending();
  }, [pathname, refreshPending]);

  const handleLogout = async () => {
    await auth.signOut();
    window.location.href = '/admin/login';
  };

  return (
    <header className="sticky top-0 z-40 border-b border-neutral-800 bg-neutral-900/90 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-6">
          <Link
            to="/"
            className="flex items-center gap-2 group text-neutral-400 hover:text-white text-xs font-medium border-r border-neutral-800 pr-4"
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">На сайт</span>
          </Link>

          <Link to="/admin" className="flex items-center gap-2">
            <span className="text-lg font-bold text-white tracking-wide">
              Hikko<span className="text-rose-500">Admin</span>
            </span>
          </Link>

          <nav className="hidden md:flex items-center gap-1 text-sm">
            <Link
              to="/admin/titles"
              className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-white transition-colors"
              activeProps={{
                className:
                  'bg-rose-950/50 text-rose-400 font-medium border border-rose-900/50',
              }}
            >
              <Library className="h-4 w-4" />
              Тайтлы
            </Link>
            <Link
              to="/admin/genres"
              className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-white transition-colors"
              activeProps={{
                className:
                  'bg-rose-950/50 text-rose-400 font-medium border border-rose-900/50',
              }}
            >
              <Tag className="h-4 w-4" />
              Жанры
            </Link>
            <Link
              to="/admin/requests"
              className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-white transition-colors relative"
              activeProps={{
                className:
                  'bg-rose-950/50 text-rose-400 font-medium border border-rose-900/50',
              }}
            >
              <Inbox className="h-4 w-4" />
              Заявки
              {pendingCount != null && pendingCount > 0 && (
                <span className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-600 px-1.5 text-[10px] font-bold text-white">
                  {pendingCount > 99 ? '99+' : pendingCount}
                </span>
              )}
            </Link>
            {/* Доступно всем админам: у каждого свой Gemini API key. */}
            <Link
              to="/admin/settings"
              className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-white transition-colors"
              activeProps={{
                className:
                  'bg-rose-950/50 text-rose-400 font-medium border border-rose-900/50',
              }}
            >
              <Settings className="h-4 w-4" />
              Настройки
            </Link>
            {isOwner && (
              <Link
                to="/admin/ads"
                className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-white transition-colors"
                activeProps={{
                  className:
                    'bg-rose-950/50 text-rose-400 font-medium border border-rose-900/50',
                }}
              >
                <Megaphone className="h-4 w-4" />
                Реклама
              </Link>
            )}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => support?.toggle()}
            title="Чат поддержки"
            aria-label="Чат поддержки"
            aria-pressed={support?.open ?? false}
            className="rounded-lg p-2 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white"
          >
            <MessageCircle className="h-4 w-4" />
          </button>

          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            className="text-neutral-400 hover:text-white gap-2"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">Выйти</span>
          </Button>
        </div>
      </div>
    </header>
  );
}

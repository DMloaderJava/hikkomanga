import { Link } from '@tanstack/react-router';
import { BookOpen, Shield, LogOut } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { auth } from '@/data/auth';
import { Button } from '@/components/ui/button';
import { AddMenu } from '@/components/requests/AddMenu';

export function Header() {
  const { session, isAdmin } = useAuth();

  const handleLogout = async () => {
    await auth.signOut();
    window.location.href = '/';
  };

  return (
    <header className="sticky top-0 z-40 border-b border-rose-950/40 bg-[#140e12]/85 backdrop-blur-md shadow-[0_8px_24px_-12px_rgba(0,0,0,0.7)]">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-8">
          <Link to="/" className="flex items-center gap-2.5 group">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-rose-600 font-bold text-white shadow-lg shadow-rose-600/30 group-hover:bg-rose-500 transition-colors">
              <BookOpen className="h-5 w-5" />
            </div>
            <span className="text-xl font-bold tracking-tight text-white group-hover:text-rose-400 transition-colors">
              Hikko<span className="text-rose-500">manga</span>
            </span>
          </Link>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
            <Link
              to="/"
              className="text-neutral-300 hover:text-white transition-colors"
              activeProps={{ className: 'text-rose-500 font-semibold' }}
            >
              Каталог
            </Link>
            <Link
              to="/advertise"
              className="text-neutral-300 hover:text-white transition-colors"
              activeProps={{ className: 'text-rose-500 font-semibold' }}
            >
              Реклама
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-3">
          {/* «+» всем, включая анонимов: заявка на тайтл без регистрации */}
          <AddMenu />
          {session ? (
            <>
              {isAdmin && (
                <Link to="/admin">
                  <Button variant="outline" size="sm" className="gap-2 border-rose-500/30 text-rose-400 hover:bg-rose-950/40">
                    <Shield className="h-4 w-4" />
                    Админка
                  </Button>
                </Link>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLogout}
                className="text-neutral-400 hover:text-white"
                title="Выйти"
              >
                <LogOut className="h-4 w-4" />
                <span className="hidden sm:inline ml-1">Выход</span>
              </Button>
            </>
          ) : (
            <Link to="/admin/login">
              <Button variant="ghost" size="sm" className="gap-2 text-neutral-300 hover:text-white">
                <Shield className="h-4 w-4" />
                Вход для админа
              </Button>
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}

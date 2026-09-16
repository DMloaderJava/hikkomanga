import { createRootRoute, Outlet, useLocation, Link } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Analytics } from '@vercel/analytics/react';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Home } from 'lucide-react';
import '@/styles/globals.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      refetchOnWindowFocus: false,
    },
  },
});

export const Route = createRootRoute({
  component: RootComponent,
  errorComponent: RootErrorComponent,
});

function RootErrorComponent({ error }: { error: any }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-6 text-center bg-neutral-950 text-neutral-100">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-red-950/60 text-red-400 border border-red-800/80 mb-4">
        <AlertTriangle className="h-8 w-8" />
      </div>
      <h1 className="text-2xl font-bold tracking-tight text-white mb-2">Произошла ошибка</h1>
      <p className="text-sm text-neutral-400 max-w-md mb-6">{error?.message || 'Не удалось загрузить данные'}</p>
      <Link to="/">
        <Button className="gap-2">
          <Home className="h-4 w-4" /> На главную
        </Button>
      </Link>
    </div>
  );
}

function RootComponent() {
  const location = useLocation();
  const isAdminRoute = location.pathname.startsWith('/admin');
  const isReaderRoute = location.pathname.includes('/chapter/');

  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col font-sans selection:bg-rose-600 selection:text-white antialiased">
        {!isAdminRoute && !isReaderRoute && <Header />}
        <div className="flex-1">
          <Outlet />
        </div>
        {!isAdminRoute && !isReaderRoute && <Footer />}
        {/* Vercel Web Analytics — pageviews на всех маршрутах (вкл. admin/reader). */}
        <Analytics />
      </div>
    </QueryClientProvider>
  );
}

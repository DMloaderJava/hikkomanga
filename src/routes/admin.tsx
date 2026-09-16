import { createFileRoute, redirect, Outlet, useLocation } from '@tanstack/react-router';
import { auth } from '@/data/auth';
import { AdminHeader } from '@/components/layout/AdminHeader';

export const Route = createFileRoute('/admin')({
  beforeLoad: async ({ location }) => {
    const cleanPath = location.pathname.replace(/\/$/, '');
    // Форма входа и страница подтверждения из письма — без guard.
    if (cleanPath === '/admin/login' || cleanPath.startsWith('/admin/login/')) {
      return;
    }

    const session = await auth.getSession();
    if (!session) {
      throw redirect({ to: '/admin/login' });
    }
    // hasRole: soft-fail на транзиентной ошибке challenge status (не redirect).
    const isAdmin = await auth.hasRole(session.user.id, 'admin');
    if (!isAdmin) {
      // Различаем «нет challenge / denied» vs «роль отсутствует».
      // Если challenge status = error — hasRole уже вернул true при roleOk.
      // Сюда попадаем только при реальном false.
      throw redirect({ to: '/admin/login' });
    }
  },
  component: AdminLayout,
});

function AdminLayout() {
  const location = useLocation();
  const cleanPath = location.pathname.replace(/\/$/, '');
  const isLoginPage =
    cleanPath === '/admin/login' || cleanPath.startsWith('/admin/login/');

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col">
      {!isLoginPage && <AdminHeader />}
      <div className="flex-1">
        <Outlet />
      </div>
    </div>
  );
}

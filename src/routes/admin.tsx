import { createFileRoute, redirect, Outlet, useLocation } from '@tanstack/react-router';
import { auth } from '@/data/auth';
import { AdminHeader } from '@/components/layout/AdminHeader';

export const Route = createFileRoute('/admin')({
  beforeLoad: async ({ location }) => {
    const cleanPath = location.pathname.replace(/\/$/, '');
    if (cleanPath === '/admin/login') return;

    const session = await auth.getSession();
    if (!session) {
      throw redirect({ to: '/admin/login' });
    }
    const isAdmin = await auth.hasRole(session.user.id, 'admin');
    if (!isAdmin) {
      throw redirect({ to: '/admin/login' });
    }
  },
  component: AdminLayout,
});

function AdminLayout() {
  const location = useLocation();
  const cleanPath = location.pathname.replace(/\/$/, '');
  const isLoginPage = cleanPath === '/admin/login';

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col">
      {!isLoginPage && <AdminHeader />}
      <div className="flex-1">
        <Outlet />
      </div>
    </div>
  );
}

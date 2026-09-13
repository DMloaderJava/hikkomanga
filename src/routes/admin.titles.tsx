import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/admin/titles')({
  component: AdminTitlesLayout,
});

function AdminTitlesLayout() {
  return <Outlet />;
}

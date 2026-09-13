import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/admin/titles/$id')({
  component: AdminTitleIdLayout,
});

function AdminTitleIdLayout() {
  return <Outlet />;
}

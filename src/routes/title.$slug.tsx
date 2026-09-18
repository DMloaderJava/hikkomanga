import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/title/$slug')({
  component: TitleLayout,
});

function TitleLayout() {
  return <Outlet />;
}

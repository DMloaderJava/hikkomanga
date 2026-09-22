import { createFileRoute, Outlet } from '@tanstack/react-router';

// Список глав — index-маршрут. Редактор страниц и импорт отображаются
// вместо списка через Outlet, а не скрываются внутри него.
export const Route = createFileRoute('/admin/titles/$id/chapters')({
  component: Outlet,
});

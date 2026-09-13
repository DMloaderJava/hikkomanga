import { createFileRoute } from '@tanstack/react-router';
import { GenreManager } from '@/components/admin/GenreManager';

export const Route = createFileRoute('/admin/genres')({
  component: AdminGenresPage,
});

function AdminGenresPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <GenreManager />
    </main>
  );
}

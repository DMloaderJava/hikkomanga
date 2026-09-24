import { createFileRoute } from '@tanstack/react-router';
import { ApiKeySettings } from '@/components/admin/ApiKeySettings';

export const Route = createFileRoute('/admin/settings')({
  component: AdminSettingsPage,
});

function AdminSettingsPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <ApiKeySettings />
    </main>
  );
}

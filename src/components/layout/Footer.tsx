import { BookOpen } from 'lucide-react';

export function Footer() {
  return (
    <footer className="border-t border-neutral-900 bg-neutral-950 py-8 text-neutral-500">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-rose-500" />
          <span className="text-sm font-medium text-neutral-400">Hikkomanga © {new Date().getFullYear()}</span>
        </div>
        <p className="text-xs text-neutral-600 text-center sm:text-right">
          Удобная онлайн читалка манги. Все права на произведения принадлежат их авторам.
        </p>
      </div>
    </footer>
  );
}

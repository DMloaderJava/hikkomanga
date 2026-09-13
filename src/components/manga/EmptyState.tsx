import { BookX } from 'lucide-react';

interface EmptyStateProps {
  message?: string;
  description?: string;
}

export function EmptyState({
  message = 'Каталог пока пуст',
  description = 'Попробуйте изменить параметры поиска или зайти позже',
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-neutral-800 bg-neutral-900/30 p-12 text-center my-8">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-neutral-900 text-neutral-600 mb-4 border border-neutral-800">
        <BookX className="h-8 w-8 text-neutral-500" />
      </div>
      <h3 className="text-lg font-bold text-white mb-1">{message}</h3>
      <p className="text-sm text-neutral-400 max-w-md">{description}</p>
    </div>
  );
}

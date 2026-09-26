import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { titles as titlesApi } from '@/data/titles';
import { Button } from '@/components/ui/button';
import { AlertCircle, CheckCircle, Globe } from 'lucide-react';
import type { Title } from '@/data/types';

/**
 * Черновик тайтла не попадает в каталог, даже если главы уже опубликованы.
 * Переключатель в таблице легко пропустить — здесь публикация отдельной кнопкой
 * и не зависит от сохранения всей формы (обложка, жанры, slug).
 */
export function PublishTitleBanner({
  title,
  onChange,
}: {
  title: Title;
  onChange?: (title: Title) => void;
}) {
  const [override, setOverride] = useState<Title | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justPublished, setJustPublished] = useState(false);

  useEffect(() => {
    setOverride(null);
    setJustPublished(false);
    setError(null);
  }, [title.id]);

  const current = override && override.id === title.id ? override : title;

  const publish = async () => {
    setPending(true);
    setError(null);
    try {
      const updated = await titlesApi.setPublished(current.id, true);
      setOverride(updated);
      setJustPublished(true);
      onChange?.(updated);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Не удалось опубликовать тайтл');
    } finally {
      setPending(false);
    }
  };

  if (current.published) {
    if (!justPublished) return null;
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-emerald-800/70 bg-emerald-950/40 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2 text-sm text-emerald-200">
          <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
          <p>
            «{current.title || title.title}» опубликован и виден в каталоге.
            Если страница каталога уже была открыта — обновите её.
          </p>
        </div>
        {current.slug ? (
          <Link to="/title/$slug" params={{ slug: current.slug }} target="_blank">
            <Button size="sm" variant="outline" className="gap-1.5 border-emerald-800 text-emerald-200">
              <Globe className="h-3.5 w-3.5" /> Открыть на сайте
            </Button>
          </Link>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-amber-800/80 bg-amber-950/40 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        <p className="text-sm font-semibold text-amber-100">Тайтл не опубликован</p>
        <p className="text-xs leading-relaxed text-amber-100/80">
          «{title.title}» не виден читателям. Опубликованные главы тоже скрыты,
          пока сам тайтл — черновик. Кнопка меняет только статус, форму сохранять не нужно.
        </p>
        {error && (
          <p className="flex items-start gap-1.5 pt-1 text-xs text-red-300">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}
      </div>
      <Button onClick={publish} disabled={pending} className="shrink-0 gap-2">
        <Globe className="h-4 w-4" />
        {pending ? 'Публикация…' : 'Опубликовать тайтл'}
      </Button>
    </div>
  );
}

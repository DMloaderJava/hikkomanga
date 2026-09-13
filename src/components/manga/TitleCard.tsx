import { Link } from '@tanstack/react-router';
import type { Title } from '@/data/types';
import { Badge } from '@/components/ui/badge';
import { BookOpen } from 'lucide-react';

export function TitleCard({ title }: { title: Title }) {
  return (
    <Link
      to="/title/$slug"
      params={{ slug: title.slug }}
      className="group relative flex flex-col overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/60 transition-all duration-300 hover:-translate-y-1 hover:border-neutral-700 hover:shadow-xl hover:shadow-rose-950/20"
    >
      <div className="relative aspect-[3/4] w-full overflow-hidden bg-neutral-950">
        {title.cover_url ? (
          <img
            src={title.cover_url}
            alt={title.title}
            className="h-full w-full object-cover object-center transition-transform duration-500 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-neutral-900 text-neutral-700">
            <BookOpen className="h-12 w-12" />
          </div>
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-neutral-950 via-neutral-950/20 to-transparent opacity-80 group-hover:opacity-60 transition-opacity" />

        <div className="absolute top-2 right-2">
          <Badge
            variant={title.status === 'completed' ? 'success' : 'default'}
            className="text-[10px] px-2 py-0.5 shadow-md"
          >
            {title.status === 'completed' ? 'Завершён' : 'Онгоинг'}
          </Badge>
        </div>
      </div>

      <div className="flex flex-1 flex-col p-4">
        <h3 className="line-clamp-1 text-base font-bold text-white group-hover:text-rose-400 transition-colors">
          {title.title}
        </h3>

        {title.author && (
          <p className="mt-0.5 line-clamp-1 text-xs text-neutral-400 font-medium">
            {title.author}
          </p>
        )}

        <div className="mt-3 flex flex-wrap gap-1">
          {title.genres.slice(0, 3).map((g) => (
            <span
              key={g.id}
              className="rounded bg-neutral-800/80 px-1.5 py-0.5 text-[10px] font-medium text-neutral-300 border border-neutral-700/50"
            >
              {g.name}
            </span>
          ))}
          {title.genres.length > 3 && (
            <span className="rounded bg-neutral-800/50 px-1.5 py-0.5 text-[10px] text-neutral-500">
              +{title.genres.length - 3}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

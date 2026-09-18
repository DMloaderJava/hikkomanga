import { Link } from '@tanstack/react-router';
import type { Title } from '@/data/types';
import { BookOpen } from 'lucide-react';

function CoverArt({ title }: { title: Title }) {
  if (title.cover_url) {
    return (
      <img
        src={title.cover_url}
        alt={title.title}
        className="h-full w-full object-cover object-center transition-transform duration-500 ease-out group-hover:scale-110"
        loading="lazy"
      />
    );
  }

  const hue = title.title.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 360;

  return (
    <div
      className="relative flex h-full w-full items-end overflow-hidden p-3"
      style={{
        background: `linear-gradient(160deg, hsl(${hue} 38% 18%), hsl(${(hue + 40) % 360} 42% 10%))`,
      }}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-35"
        style={{
          backgroundImage:
            'radial-gradient(circle at 30% 20%, rgba(255,255,255,0.12), transparent 40%), repeating-linear-gradient(-20deg, transparent, transparent 12px, rgba(255,255,255,0.05) 13px)',
        }}
      />
      <BookOpen className="absolute right-3 top-3 h-7 w-7 text-white/20" />
      <p className="relative z-10 line-clamp-3 rounded-md bg-black/45 px-2 py-1 text-sm font-bold leading-snug text-white backdrop-blur-sm [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]">
        {title.title}
      </p>
    </div>
  );
}

export function TitleCard({ title }: { title: Title }) {
  const statusCompleted = title.status === 'completed';

  return (
    <Link
      to="/title/$slug"
      params={{ slug: title.slug }}
      title={title.title}
      className="group relative flex flex-col overflow-hidden rounded-2xl bg-[#1c1418] shadow-[0_10px_30px_-18px_rgba(0,0,0,0.8)] ring-1 ring-rose-950/30 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_18px_40px_-16px_rgba(136,19,55,0.45)] hover:ring-rose-800/50"
    >
      <div className="relative aspect-[3/4] w-full overflow-hidden bg-[#120c10]">
        <CoverArt title={title} />

        <div className="absolute inset-0 bg-gradient-to-t from-[#140e12] via-[#140e12]/15 to-transparent opacity-80 group-hover:opacity-50 transition-opacity duration-300" />

        <div className="absolute top-2 right-2">
          <span
            className={
              statusCompleted
                ? 'rounded-full bg-emerald-950 px-2 py-0.5 text-[10px] font-semibold text-emerald-100 ring-1 ring-emerald-800/70'
                : 'rounded-full bg-amber-950 px-2 py-0.5 text-[10px] font-semibold text-amber-100 ring-1 ring-amber-800/70'
            }
          >
            {statusCompleted ? 'Завершён' : 'Онгоинг'}
          </span>
        </div>

        <div className="absolute inset-x-0 bottom-0 flex justify-center pb-3 opacity-0 translate-y-2 transition-all duration-300 group-hover:opacity-100 group-hover:translate-y-0">
          <span className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white shadow-lg shadow-rose-950/50">
            <BookOpen className="h-3.5 w-3.5" />
            Читать
          </span>
        </div>
      </div>

      <div className="flex flex-1 flex-col p-3.5">
        <h3
          className="line-clamp-2 min-h-[2.5rem] text-sm font-bold leading-snug text-white group-hover:text-rose-300 transition-colors duration-200"
          title={title.title}
        >
          {title.title}
        </h3>

        {title.author && (
          <p className="mt-0.5 line-clamp-1 text-xs text-neutral-400 font-medium" title={title.author}>
            {title.author}
          </p>
        )}

        <div className="mt-2.5 flex flex-wrap gap-1">
          {title.genres.slice(0, 3).map((g) => (
            <span
              key={g.id}
              className="rounded-lg bg-[#2a1c22] px-1.5 py-0.5 text-[10px] font-medium text-neutral-300"
            >
              {g.name}
            </span>
          ))}
          {title.genres.length > 3 && (
            <span className="rounded-lg bg-[#2a1c22]/70 px-1.5 py-0.5 text-[10px] text-neutral-500">
              +{title.genres.length - 3}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

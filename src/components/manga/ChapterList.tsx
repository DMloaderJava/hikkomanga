import { Link } from '@tanstack/react-router';
import type { Chapter } from '@/data/types';
import { formatDate, formatChapterNumber } from '@/lib/format';
import { BookOpen, Calendar, ChevronRight } from 'lucide-react';

interface ChapterListProps {
  slug: string;
  chapters: Chapter[];
}

export function ChapterList({ slug, chapters }: ChapterListProps) {
  if (chapters.length === 0) {
    return (
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-8 text-center text-neutral-500">
        У этого тайтла пока нет доступных глав.
      </div>
    );
  }

  return (
    <div className="cv-auto flex flex-col gap-2">
      {chapters.map((ch) => (
        <Link
          key={ch.id}
          to="/title/$slug/chapter/$number"
          params={{ slug, number: `${ch.number}` }}
          className="group flex items-center justify-between rounded-xl border border-neutral-800/80 bg-neutral-900/60 p-4 transition-all hover:border-neutral-700 hover:bg-neutral-800/80"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-neutral-800 text-rose-400 group-hover:bg-rose-600 group-hover:text-white transition-colors">
              <BookOpen className="h-4 w-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-white text-base">
                  Глава {formatChapterNumber(ch.number)}
                </span>
                {ch.name && (
                  <span className="text-sm text-neutral-400 font-medium">
                    — {ch.name}
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-neutral-500">
                <Calendar className="h-3 w-3" />
                <span>{formatDate(ch.created_at)}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 text-neutral-500 group-hover:text-rose-400 transition-colors">
            <span className="text-xs font-medium hidden sm:inline">Читать</span>
            <ChevronRight className="h-5 w-5" />
          </div>
        </Link>
      ))}
    </div>
  );
}

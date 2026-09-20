import { useEffect, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { titles as titlesApi } from '@/data/titles';
import { chapters as chaptersApi } from '@/data/chapters';
import { ChapterList } from '@/components/manga/ChapterList';
import { CoverImage } from '@/components/manga/CoverImage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { updateMetaTags, seoForRoute } from '@/lib/seo';
import type { Title, Chapter } from '@/data/types';
import { BookOpen, User, Play, Bookmark } from 'lucide-react';

export const Route = createFileRoute('/title/$slug/')({
  loader: async ({ params }) => {
    const titleData = await titlesApi.getBySlug(params.slug);
    if (!titleData || !titleData.published) {
      throw new Error('Тайтл не найден');
    }
    const chapterList = await chaptersApi.listByTitle(titleData.id, false);
    return { title: titleData, chapters: chapterList };
  },
  component: TitleDetailsPage,
});

function TitleDetailsPage() {
  const { title, chapters } = Route.useLoaderData() as { title: Title; chapters: Chapter[] };
  const [lastReadProgress, setLastReadProgress] = useState<{
    chapterNumber: number;
    pageIndex?: number;
  } | null>(null);

  useEffect(() => {
    if (title) {
      updateMetaTags(seoForRoute(Route.id, { title }));

      try {
        const saved = localStorage.getItem(`hikkomanga_progress_${title.slug}`);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed && parsed.chapterNumber) {
            setLastReadProgress(parsed);
          }
        }
      } catch {
        // Ignore
      }
    }
  }, [title]);

  const firstChapter = chapters[0];

  return (
    <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      <section className="relative overflow-hidden rounded-3xl border border-neutral-800 bg-neutral-900/60 p-6 sm:p-8 backdrop-blur-xl shadow-2xl">
        <div className="flex flex-col md:flex-row gap-8 items-start">
          <div className="relative aspect-[3/4] w-48 sm:w-56 shrink-0 overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950 shadow-2xl mx-auto md:mx-0">
            <CoverImage
              src={title.cover_url}
              title={title.title}
              className="h-full w-full object-cover"
              loading="eager"
              fallback={
                <div className="flex h-full w-full items-center justify-center text-neutral-700">
                  <BookOpen className="h-16 w-16" />
                </div>
              }
            />
          </div>

          <div className="flex-1 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={title.status === 'completed' ? 'success' : 'default'}>
                {title.status === 'completed' ? 'Завершён' : 'Онгоинг'}
              </Badge>
              {title.genres.map((g) => (
                <span
                  key={g.id}
                  className="rounded-md bg-neutral-800/80 px-2.5 py-1 text-xs font-medium text-neutral-300 border border-neutral-700/50"
                >
                  {g.name}
                </span>
              ))}
            </div>

            <h1 className="text-2xl sm:text-4xl font-extrabold text-white tracking-tight">
              {title.title}
            </h1>

            {title.author && (
              <div className="flex items-center gap-2 text-sm text-neutral-400 font-medium">
                <User className="h-4 w-4 text-rose-500" />
                <span>Автор: {title.author}</span>
              </div>
            )}

            {title.description && (
              <p className="text-sm sm:text-base text-neutral-300 leading-relaxed whitespace-pre-line bg-neutral-950/40 p-4 rounded-xl border border-neutral-800/50">
                {title.description}
              </p>
            )}

            <div className="pt-2 flex flex-wrap items-center gap-3">
              {lastReadProgress ? (
                <>
                  <Link
                    to="/title/$slug/chapter/$number"
                    params={{ slug: title.slug, number: `${lastReadProgress.chapterNumber}` }}
                  >
                    <Button size="lg" className="gap-2.5 shadow-lg shadow-rose-600/30">
                      <Bookmark className="h-5 w-5 text-amber-300" />
                      Продолжить чтение (Глава {lastReadProgress.chapterNumber}
                      {lastReadProgress.pageIndex !== undefined ? `, стр. ${lastReadProgress.pageIndex + 1}` : ''})
                    </Button>
                  </Link>

                  {firstChapter && (
                    <Link
                      to="/title/$slug/chapter/$number"
                      params={{ slug: title.slug, number: `${firstChapter.number}` }}
                    >
                      <Button variant="outline" size="lg" className="gap-2 border-neutral-800">
                        <Play className="h-4 w-4" />
                        С первой главы
                      </Button>
                    </Link>
                  )}
                </>
              ) : firstChapter ? (
                <Link
                  to="/title/$slug/chapter/$number"
                  params={{ slug: title.slug, number: `${firstChapter.number}` }}
                >
                  <Button size="lg" className="gap-2.5 shadow-lg shadow-rose-600/30">
                    <Play className="h-5 w-5 fill-current" />
                    Начать чтение (Глава {firstChapter.number})
                  </Button>
                </Link>
              ) : (
                <Button size="lg" disabled className="gap-2">
                  Нет доступных глав
                </Button>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-rose-500" />
            Список глав ({chapters.length})
          </h2>
        </div>

        <ChapterList slug={title.slug} chapters={chapters} />
      </section>
    </main>
  );
}

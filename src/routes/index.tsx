import { useState, useMemo, useEffect } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { titles as titlesApi } from '@/data/titles';
import { genres as genresApi } from '@/data/genres';
import { TitleGrid, TitleGridSkeleton } from '@/components/manga/TitleGrid';
import { SearchBar } from '@/components/manga/SearchBar';
import { GenreFilter } from '@/components/manga/GenreFilter';
import { EmptyState } from '@/components/manga/EmptyState';
import { useDebounce } from '@/hooks/useDebounce';
import { updateMetaTags, seoForRoute } from '@/lib/seo';
import type { Title, Genre } from '@/data/types';
import { Sparkles, BookOpen } from 'lucide-react';

export const Route = createFileRoute('/')({
  loader: async () => {
    const [publishedTitles, allGenres] = await Promise.all([
      titlesApi.listPublished(),
      genresApi.list(),
    ]);
    return { titles: publishedTitles, genres: allGenres };
  },
  component: HomePage,
  pendingComponent: HomePending,
});

function HomePending() {
  return (
    <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6 space-y-7">
      <div className="h-40 rounded-2xl animate-pulse bg-[#1c1418] ring-1 ring-rose-950/30" />
      <div className="h-11 w-full md:w-96 rounded-xl animate-pulse bg-[#1c1418]" />
      <TitleGridSkeleton />
    </main>
  );
}

function HomePage() {
  const loaderData = Route.useLoaderData() as { titles: Title[]; genres: Genre[] };
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGenreId, setSelectedGenreId] = useState<string | null>(null);

  const debouncedSearch = useDebounce(searchQuery, 300);

  useEffect(() => {
    updateMetaTags(seoForRoute(Route.id));
  }, []);

  const filteredTitles = useMemo(() => {
    return loaderData.titles.filter((t) => {
      if (selectedGenreId && !t.genres.some((g) => g.id === selectedGenreId)) {
        return false;
      }
      if (debouncedSearch.trim()) {
        const query = debouncedSearch.toLowerCase().trim();
        const matchesTitle = t.title.toLowerCase().includes(query);
        const matchesAuthor = t.author?.toLowerCase().includes(query) ?? false;
        return matchesTitle || matchesAuthor;
      }
      return true;
    });
  }, [loaderData.titles, selectedGenreId, debouncedSearch]);

  const suggestions = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    if (q.length < 1) return [];
    return loaderData.titles
      .filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          (t.author?.toLowerCase().includes(q) ?? false)
      )
      .slice(0, 7);
  }, [loaderData.titles, debouncedSearch]);

  const catalogId = 'catalog';

  return (
    <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6 space-y-7">
      <section className="relative overflow-hidden rounded-2xl border border-rose-900/30 bg-gradient-to-br from-[#3a1524] via-[#1a1016] to-[#120c14] px-5 py-6 sm:px-8 sm:py-7 shadow-[0_20px_50px_-20px_rgba(80,20,40,0.55)]">
        <div
          className="pointer-events-none absolute inset-0 opacity-30"
          style={{
            backgroundImage:
              'radial-gradient(ellipse at 80% 20%, rgba(244,63,94,0.28), transparent 50%), radial-gradient(ellipse at 10% 90%, rgba(124,45,18,0.25), transparent 45%)',
          }}
        />
        <div
          className="pointer-events-none absolute inset-y-0 right-0 w-1/2 opacity-[0.12] hidden sm:block"
          style={{
            backgroundImage:
              'repeating-linear-gradient(115deg, transparent, transparent 18px, rgba(255,255,255,0.35) 19px, transparent 20px)',
          }}
        />

        <div className="relative z-10 max-w-2xl space-y-3.5 animate-fade-up">
          <div className="inline-flex items-center gap-2 rounded-full bg-rose-600/20 px-3 py-1 text-xs font-semibold text-rose-300 border border-rose-500/25">
            <Sparkles className="h-3.5 w-3.5" /> Hikkomanga
          </div>
          <h1 className="text-2xl sm:text-4xl font-black text-white tracking-tight leading-[1.25]">
            Читайте мангу онлайн — спокойно и удобно
          </h1>
          <p className="text-sm sm:text-base text-rose-50/70 leading-relaxed max-w-xl">
            Качественные переводы, комфортный режим чтения и главы в день выхода. Реклама ненавязчивая — чтобы ничего не мешало сюжету.
          </p>
          <a
            href={`#${catalogId}`}
            className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-rose-900/40 transition-all duration-200 hover:bg-rose-500 hover:shadow-rose-800/50 hover:-translate-y-0.5"
          >
            <BookOpen className="h-4 w-4" />
            Смотреть каталог
          </a>
        </div>

        <div className="absolute -right-10 -top-10 h-48 w-48 rounded-full bg-rose-600/15 blur-3xl" />
        <div className="absolute -left-8 -bottom-12 h-40 w-40 rounded-full bg-amber-800/10 blur-3xl" />
      </section>

      <section id={catalogId} className="space-y-4 scroll-mt-24">
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4">
          <div className="w-full md:w-96">
            <SearchBar
              value={searchQuery}
              onChange={setSearchQuery}
              suggestions={suggestions}
            />
          </div>
        </div>

        <GenreFilter
          genres={loaderData.genres}
          selectedGenreId={selectedGenreId}
          onSelectGenre={setSelectedGenreId}
        />
      </section>

      <section>
        {filteredTitles.length > 0 ? (
          <TitleGrid titles={filteredTitles} />
        ) : (
          <EmptyState
            message="Ничего не найдено"
            description="Попробуйте изменить поисковый запрос или выбрать другой жанр"
          />
        )}
      </section>
    </main>
  );
}

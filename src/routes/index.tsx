import { useState, useMemo, useEffect } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { titles as titlesApi } from '@/data/titles';
import { genres as genresApi } from '@/data/genres';
import { TitleGrid } from '@/components/manga/TitleGrid';
import { SearchBar } from '@/components/manga/SearchBar';
import { GenreFilter } from '@/components/manga/GenreFilter';
import { EmptyState } from '@/components/manga/EmptyState';
import { useDebounce } from '@/hooks/useDebounce';
import { updateMetaTags } from '@/lib/seo';
import type { Title, Genre } from '@/data/types';
import { Sparkles } from 'lucide-react';

export const Route = createFileRoute('/')({
  loader: async () => {
    const [publishedTitles, allGenres] = await Promise.all([
      titlesApi.listPublished(),
      genresApi.list(),
    ]);
    return { titles: publishedTitles, genres: allGenres };
  },
  component: HomePage,
});

function HomePage() {
  const loaderData = Route.useLoaderData() as { titles: Title[]; genres: Genre[] };
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGenreId, setSelectedGenreId] = useState<string | null>(null);

  const debouncedSearch = useDebounce(searchQuery, 300);

  useEffect(() => {
    updateMetaTags({
      title: 'Каталог манги',
      description: 'Онлайн читалка манги. Читайте популярные произведения онлайн бесплатно.',
    });
  }, []);

  const filteredTitles = useMemo(() => {
    return loaderData.titles.filter((t) => {
      // Genre match
      if (selectedGenreId && !t.genres.some((g) => g.id === selectedGenreId)) {
        return false;
      }
      // Search query match
      if (debouncedSearch.trim()) {
        const query = debouncedSearch.toLowerCase().trim();
        const matchesTitle = t.title.toLowerCase().includes(query);
        const matchesAuthor = t.author?.toLowerCase().includes(query) ?? false;
        return matchesTitle || matchesAuthor;
      }
      return true;
    });
  }, [loaderData.titles, selectedGenreId, debouncedSearch]);

  return (
    <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Hero Banner */}
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-rose-950/60 via-neutral-900 to-neutral-950 p-6 sm:p-10 border border-neutral-800 shadow-2xl">
        <div className="relative z-10 max-w-2xl space-y-4">
          <div className="inline-flex items-center gap-2 rounded-full bg-rose-600/20 px-3 py-1 text-xs font-semibold text-rose-400 border border-rose-500/30">
            <Sparkles className="h-3.5 w-3.5" /> Hikkomanga
          </div>
          <h1 className="text-3xl sm:text-5xl font-black text-white tracking-tight leading-tight">
            Читайте мангу онлайн без рекламы
          </h1>
          <p className="text-sm sm:text-base text-neutral-300">
            Тысячи страниц качественных переводов, удобный режим чтения и обновление глав в день выхода.
          </p>
        </div>

        {/* Decorative blur */}
        <div className="absolute -right-12 -top-12 h-64 w-64 rounded-full bg-rose-600/10 blur-3xl" />
      </section>

      {/* Search & Filters */}
      <section className="space-y-4">
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4">
          <div className="w-full md:w-96">
            <SearchBar value={searchQuery} onChange={setSearchQuery} />
          </div>
        </div>

        <GenreFilter
          genres={loaderData.genres}
          selectedGenreId={selectedGenreId}
          onSelectGenre={setSelectedGenreId}
        />
      </section>

      {/* Manga Grid */}
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

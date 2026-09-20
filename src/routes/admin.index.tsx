import { createFileRoute, Link } from '@tanstack/react-router';
import { titles as titlesApi } from '@/data/titles';
import { genres as genresApi } from '@/data/genres';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CoverImage } from '@/components/manga/CoverImage';
import { Library, BookOpen, Tag, Plus, Eye, ArrowRight } from 'lucide-react';
import type { Title, Genre } from '@/data/types';

export const Route = createFileRoute('/admin/')({
  loader: async () => {
    const [allTitles, allGenres] = await Promise.all([
      titlesApi.listAll(),
      genresApi.list(),
    ]);
    return { titles: allTitles, genres: allGenres };
  },
  component: AdminDashboardPage,
});

function AdminDashboardPage() {
  const { titles, genres } = Route.useLoaderData() as { titles: Title[]; genres: Genre[] };

  const publishedCount = titles.filter((t) => t.published).length;
  const draftCount = titles.length - publishedCount;

  return (
    <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Welcome Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-neutral-800 pb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
            Панель управления
          </h1>
          <p className="text-xs sm:text-sm text-neutral-400 mt-1">
            Управляйте каталогом манги, главами и жанрами
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Link to="/admin/titles/new">
            <Button className="gap-2 shadow-lg shadow-rose-600/20">
              <Plus className="h-4 w-4" /> Добавить тайтл
            </Button>
          </Link>
        </div>
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-neutral-800 bg-neutral-900/60">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold text-neutral-400 uppercase">
              Всего тайтлов
            </CardTitle>
            <Library className="h-5 w-5 text-rose-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-black text-white">{titles.length}</div>
            <p className="text-xs text-neutral-500 mt-1">
              {publishedCount} опубл. / {draftCount} черновик.
            </p>
          </CardContent>
        </Card>

        <Card className="border-neutral-800 bg-neutral-900/60">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold text-neutral-400 uppercase">
              Опубликовано
            </CardTitle>
            <Eye className="h-5 w-5 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-black text-white">{publishedCount}</div>
            <p className="text-xs text-neutral-500 mt-1">Видны на сайте</p>
          </CardContent>
        </Card>

        <Card className="border-neutral-800 bg-neutral-900/60">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold text-neutral-400 uppercase">
              Жанры
            </CardTitle>
            <Tag className="h-5 w-5 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-black text-white">{genres.length}</div>
            <p className="text-xs text-neutral-500 mt-1">Категории каталога</p>
          </CardContent>
        </Card>

        <Card className="border-neutral-800 bg-neutral-900/60">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold text-neutral-400 uppercase">
              Быстрый доступ
            </CardTitle>
            <BookOpen className="h-5 w-5 text-indigo-500" />
          </CardHeader>
          <CardContent className="space-y-1">
            <Link to="/admin/titles" className="text-xs text-rose-400 hover:underline block font-medium">
              Перейти к тайтлам →
            </Link>
            <Link to="/admin/genres" className="text-xs text-rose-400 hover:underline block font-medium">
              Управление жанрами →
            </Link>
          </CardContent>
        </Card>
      </div>

      {/* Recent Titles List */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">Недавние тайтлы</h2>
          <Link to="/admin/titles" className="text-xs font-medium text-rose-400 hover:underline flex items-center gap-1">
            Все тайтлы <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 overflow-hidden">
          <div className="divide-y divide-neutral-800/80">
            {titles.slice(0, 5).map((t) => (
              <div key={t.id} className="flex items-center justify-between p-4 hover:bg-neutral-800/40 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="h-12 w-9 rounded overflow-hidden bg-neutral-950 shrink-0 border border-neutral-800">
                    <CoverImage src={t.cover_url} title={t.title} className="h-full w-full object-cover" />
                  </div>
                  <div>
                    <h3 className="font-bold text-white text-sm">{t.title}</h3>
                    <p className="text-xs text-neutral-400 font-mono">/{t.slug}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <span className={`text-xs px-2 py-0.5 rounded font-medium ${t.published ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/50' : 'bg-neutral-800 text-neutral-400'}`}>
                    {t.published ? 'Опубликован' : 'Черновик'}
                  </span>

                  <Link to="/admin/titles/$id" params={{ id: t.id }}>
                    <Button variant="outline" size="sm" className="h-8 text-xs border-neutral-800">
                      Изменить
                    </Button>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}

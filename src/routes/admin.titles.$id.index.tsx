import { useState } from 'react';
import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { titles as titlesApi } from '@/data/titles';
import { genres as genresApi } from '@/data/genres';
import { TitleForm } from '@/components/admin/TitleForm';
import type { Title, TitleInput, Genre } from '@/data/types';
import { ArrowLeft, Edit, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { assertEntityId } from '@/lib/routeParams';

export const Route = createFileRoute('/admin/titles/$id/')({
  loader: async ({ params }) => {
    const titleId = assertEntityId(params.id, 'тайтл');
    const [titleData, allGenres] = await Promise.all([
      titlesApi.getById(titleId),
      genresApi.list(),
    ]);
    if (!titleData) throw new Error('Тайтл не найден');
    return { title: titleData, genres: allGenres };
  },
  component: EditTitleIndexPage,
});

function EditTitleIndexPage() {
  const { title, genres } = Route.useLoaderData() as { title: Title; genres: Genre[] };
  const [allGenres, setAllGenres] = useState<Genre[]>(genres);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const navigate = useNavigate();

  const handleAddGenre = async (name: string) => {
    const created = await genresApi.create(name);
    setAllGenres((prev) => [...prev, created]);
    return created;
  };

  const handleSubmit = async (input: TitleInput) => {
    setIsSubmitting(true);
    try {
      await titlesApi.update(title.id, input);
      navigate({ to: '/admin/titles' });
    } catch (err: any) {
      setIsSubmitting(false);
      throw err;
    }
  };

  return (
    <main className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-neutral-800 pb-4">
        <div className="flex items-center gap-4">
          <Link to="/admin/titles" className="text-neutral-400 hover:text-white">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight flex items-center gap-2">
              <Edit className="h-6 w-6 text-rose-500" /> Редактирование «{title.title}»
            </h1>
            <p className="text-xs text-neutral-400 mt-0.5 font-mono">
              ID: {title.id} | Slug: {title.slug}
            </p>
          </div>
        </div>

        <Link to="/admin/titles/$id/chapters" params={{ id: title.id }}>
          <Button variant="outline" size="sm" className="gap-2 border-neutral-800">
            <Layers className="h-4 w-4 text-rose-400" /> Управление главами
          </Button>
        </Link>
      </div>

      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-6 shadow-xl backdrop-blur-xl">
        <TitleForm
          initialData={title}
          allGenres={allGenres}
          onSubmit={handleSubmit}
          onAddGenre={handleAddGenre}
          isSubmitting={isSubmitting}
        />
      </div>
    </main>
  );
}

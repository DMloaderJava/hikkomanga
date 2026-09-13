import { useState } from 'react';
import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { titles as titlesApi } from '@/data/titles';
import { genres as genresApi } from '@/data/genres';
import { TitleForm } from '@/components/admin/TitleForm';
import type { TitleInput, Genre } from '@/data/types';
import { ArrowLeft, PlusCircle } from 'lucide-react';

export const Route = createFileRoute('/admin/titles/new')({
  loader: async () => {
    return { genres: await genresApi.list() };
  },
  component: NewTitlePage,
});

function NewTitlePage() {
  const { genres } = Route.useLoaderData() as { genres: Genre[] };
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
      const createdTitle = await titlesApi.create(input);
      navigate({ to: '/admin/titles/$id/chapters', params: { id: createdTitle.id } });
    } catch (err: any) {
      setIsSubmitting(false);
      throw err;
    }
  };

  return (
    <main className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="flex items-center gap-4 border-b border-neutral-800 pb-4">
        <Link to="/admin/titles" className="text-neutral-400 hover:text-white">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight flex items-center gap-2">
            <PlusCircle className="h-6 w-6 text-rose-500" /> Создание нового тайтла
          </h1>
          <p className="text-xs text-neutral-400 mt-0.5">
            Заполните основные сведения о манге
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-6 shadow-xl backdrop-blur-xl">
        <TitleForm
          allGenres={allGenres}
          onSubmit={handleSubmit}
          onAddGenre={handleAddGenre}
          isSubmitting={isSubmitting}
        />
      </div>
    </main>
  );
}

import type { Genre } from '@/data/types';
import { cn } from '@/lib/utils';

interface GenreFilterProps {
  genres: Genre[];
  selectedGenreId: string | null;
  onSelectGenre: (genreId: string | null) => void;
}

export function GenreFilter({ genres, selectedGenreId, onSelectGenre }: GenreFilterProps) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
      <button
        onClick={() => onSelectGenre(null)}
        className={cn(
          'whitespace-nowrap rounded-lg px-3.5 py-1.5 text-xs font-medium transition-all',
          selectedGenreId === null
            ? 'bg-rose-600 text-white shadow-md shadow-rose-600/30'
            : 'bg-neutral-900 text-neutral-400 hover:bg-neutral-800 hover:text-white border border-neutral-800'
        )}
      >
        Все жанры
      </button>

      {genres.map((genre) => {
        const isSelected = selectedGenreId === genre.id;
        return (
          <button
            key={genre.id}
            onClick={() => onSelectGenre(isSelected ? null : genre.id)}
            className={cn(
              'whitespace-nowrap rounded-lg px-3.5 py-1.5 text-xs font-medium transition-all',
              isSelected
                ? 'bg-rose-600 text-white shadow-md shadow-rose-600/30'
                : 'bg-neutral-900 text-neutral-400 hover:bg-neutral-800 hover:text-white border border-neutral-800'
            )}
          >
            {genre.name}
          </button>
        );
      })}
    </div>
  );
}

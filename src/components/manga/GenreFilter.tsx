import type { Genre } from '@/data/types';
import { cn } from '@/lib/utils';
import {
  LayoutGrid,
  Swords,
  Heart,
  Laugh,
  Ghost,
  Sparkles,
  Compass,
  Drama,
  Wand2,
  Skull,
  Rocket,
  BookOpen,
  Users,
  Landmark,
  Music,
  type LucideIcon,
} from 'lucide-react';

interface GenreFilterProps {
  genres: Genre[];
  selectedGenreId: string | null;
  onSelectGenre: (genreId: string | null) => void;
}

const GENRE_ICONS: Record<string, LucideIcon> = {
  экшен: Swords,
  action: Swords,
  романтика: Heart,
  romance: Heart,
  комедия: Laugh,
  comedy: Laugh,
  хоррор: Ghost,
  horror: Ghost,
  фэнтези: Wand2,
  fantasy: Wand2,
  драма: Drama,
  drama: Drama,
  приключения: Compass,
  adventure: Compass,
  мистика: Sparkles,
  mystery: Sparkles,
  триллер: Skull,
  thriller: Skull,
  фантастика: Rocket,
  'sci-fi': Rocket,
  сёнэн: BookOpen,
  shonen: BookOpen,
  сёдзё: Heart,
  shojo: Heart,
  сэйнэн: Users,
  seinen: Users,
  история: Landmark,
  historical: Landmark,
  музыка: Music,
  music: Music,
};

function iconForGenre(name: string): LucideIcon {
  const key = name.trim().toLowerCase();
  return GENRE_ICONS[key] ?? Sparkles;
}

export function GenreFilter({ genres, selectedGenreId, onSelectGenre }: GenreFilterProps) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto px-1 py-1.5 scrollbar-none">
      <button
        onClick={() => onSelectGenre(null)}
        className={cn(
          'inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl px-3.5 py-1.5 text-xs font-medium transition-all duration-200',
          selectedGenreId === null
            ? 'bg-rose-600 text-white shadow-md shadow-rose-600/40 ring-2 ring-rose-400/40'
            : 'bg-[#1c1418] text-neutral-400 hover:bg-[#2a1c22] hover:text-white border border-rose-950/40'
        )}
      >
        <LayoutGrid className="h-3.5 w-3.5" />
        Все жанры
      </button>

      {genres.map((genre) => {
        const isSelected = selectedGenreId === genre.id;
        const Icon = iconForGenre(genre.name);
        return (
          <button
            key={genre.id}
            onClick={() => onSelectGenre(isSelected ? null : genre.id)}
            className={cn(
              'inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl px-3.5 py-1.5 text-xs font-medium transition-all duration-200',
              isSelected
                ? 'bg-rose-600 text-white shadow-md shadow-rose-600/40 ring-2 ring-rose-400/40'
                : 'bg-[#1c1418] text-neutral-400 hover:bg-[#2a1c22] hover:text-white border border-rose-950/40'
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {genre.name}
          </button>
        );
      })}
    </div>
  );
}

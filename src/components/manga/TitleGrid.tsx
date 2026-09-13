import type { Title } from '@/data/types';
import { TitleCard } from './TitleCard';

export function TitleGrid({ titles }: { titles: Title[] }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 sm:gap-6">
      {titles.map((title) => (
        <TitleCard key={title.id} title={title} />
      ))}
    </div>
  );
}

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

export function TitleGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 sm:gap-6">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="overflow-hidden rounded-2xl bg-[#1c1418] ring-1 ring-rose-950/30"
        >
          <div
            className="aspect-[3/4] w-full bg-gradient-to-r from-[#2a1c22] via-[#3a2530] to-[#2a1c22] bg-[length:200%_100%]"
            style={{ animation: 'shimmer 1.4s ease-in-out infinite' }}
          />
          <div className="space-y-2 p-3.5">
            <div className="h-4 w-4/5 animate-pulse rounded bg-[#2a1c22]" />
            <div className="h-3 w-2/5 animate-pulse rounded bg-[#2a1c22]/80" />
            <div className="flex gap-1 pt-1">
              <div className="h-4 w-10 animate-pulse rounded-lg bg-[#2a1c22]" />
              <div className="h-4 w-12 animate-pulse rounded-lg bg-[#2a1c22]" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

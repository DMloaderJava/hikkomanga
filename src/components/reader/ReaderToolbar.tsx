import { Link } from '@tanstack/react-router';
import { ArrowLeft, ChevronLeft, ChevronRight, LayoutList, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Chapter } from '@/data/types';
import type { ReaderMode } from '@/hooks/useReaderMode';

interface ReaderToolbarProps {
  mode: ReaderMode;
  onModeChange: (mode: ReaderMode) => void;
  prevChapter: Chapter | null;
  nextChapter: Chapter | null;
  titleSlug: string;
  titleName: string;
  chapterNumber: number;
  chapterName: string | null;
}

export function ReaderToolbar({
  mode,
  onModeChange,
  prevChapter,
  nextChapter,
  titleSlug,
  titleName,
  chapterNumber,
  chapterName,
}: ReaderToolbarProps) {
  return (
    <header className="sticky top-0 z-50 border-b border-neutral-800/80 bg-neutral-950/90 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-3 sm:px-6">
        <div className="flex items-center gap-2 sm:gap-4 overflow-hidden">
          <Link
            to="/title/$slug"
            params={{ slug: titleSlug }}
            className="flex items-center gap-1 text-neutral-400 hover:text-white text-xs sm:text-sm font-medium shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">К тайтлу</span>
          </Link>

          <div className="h-4 w-px bg-neutral-800 shrink-0 hidden sm:block" />

          <div className="truncate text-xs sm:text-sm font-semibold text-white">
            <span>{titleName}</span>
            <span className="text-neutral-500 mx-1.5">—</span>
            <span className="text-rose-400">Глава {chapterNumber}</span>
            {chapterName && <span className="text-neutral-400 font-normal hidden md:inline"> ({chapterName})</span>}
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {/* Mode Switcher */}
          <div className="flex items-center rounded-lg bg-neutral-900 border border-neutral-800 p-0.5">
            <button
              onClick={() => onModeChange('vertical')}
              className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                mode === 'vertical'
                  ? 'bg-rose-600 text-white shadow-sm'
                  : 'text-neutral-400 hover:text-white'
              }`}
              title="Вертикальная лента"
            >
              <LayoutList className="h-3.5 w-3.5" />
              <span className="hidden md:inline">Лента</span>
            </button>
            <button
              onClick={() => onModeChange('paged')}
              className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                mode === 'paged'
                  ? 'bg-rose-600 text-white shadow-sm'
                  : 'text-neutral-400 hover:text-white'
              }`}
              title="Постраничный режим"
            >
              <Layers className="h-3.5 w-3.5" />
              <span className="hidden md:inline">Постранично</span>
            </button>
          </div>

          {/* Chapter Nav */}
          <div className="flex items-center gap-1">
            {prevChapter ? (
              <Link
                to="/title/$slug/chapter/$number"
                params={{ slug: titleSlug, number: `${prevChapter.number}` }}
              >
                <Button variant="outline" size="sm" className="h-8 px-2 sm:px-3 text-xs gap-1 border-neutral-800">
                  <ChevronLeft className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Пред.</span>
                </Button>
              </Link>
            ) : (
              <Button variant="outline" size="sm" disabled className="h-8 px-2 sm:px-3 text-xs gap-1 border-neutral-900 text-neutral-600">
                <ChevronLeft className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Пред.</span>
              </Button>
            )}

            {nextChapter ? (
              <Link
                to="/title/$slug/chapter/$number"
                params={{ slug: titleSlug, number: `${nextChapter.number}` }}
              >
                <Button variant="default" size="sm" className="h-8 px-2 sm:px-3 text-xs gap-1">
                  <span className="hidden sm:inline">След.</span>
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </Link>
            ) : (
              <Button variant="outline" size="sm" disabled className="h-8 px-2 sm:px-3 text-xs gap-1 border-neutral-900 text-neutral-600">
                <span className="hidden sm:inline">След.</span>
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

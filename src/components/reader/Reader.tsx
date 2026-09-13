import { Link, useNavigate } from '@tanstack/react-router';
import type { Chapter, Page } from '@/data/types';
import { useReaderMode } from '@/hooks/useReaderMode';
import { ReaderToolbar } from './ReaderToolbar';
import { VerticalReader } from './VerticalReader';
import { PagedReader } from './PagedReader';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, BookOpen } from 'lucide-react';

interface ReaderProps {
  chapter: Chapter;
  pages: Page[];
  prevChapter: Chapter | null;
  nextChapter: Chapter | null;
  titleSlug: string;
  titleName: string;
}

export function Reader({
  chapter,
  pages,
  prevChapter,
  nextChapter,
  titleSlug,
  titleName,
}: ReaderProps) {
  const [mode, setMode] = useReaderMode();
  const navigate = useNavigate();

  const handleNextChapter = () => {
    if (nextChapter) {
      navigate({
        to: '/title/$slug/chapter/$number',
        params: { slug: titleSlug, number: `${nextChapter.number}` },
      });
    }
  };

  const altPrefix = `${titleName}, глава ${chapter.number}`;

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col">
      <ReaderToolbar
        mode={mode}
        onModeChange={setMode}
        prevChapter={prevChapter}
        nextChapter={nextChapter}
        titleSlug={titleSlug}
        titleName={titleName}
        chapterNumber={chapter.number}
        chapterName={chapter.name}
      />

      <main className="flex-1 w-full">
        {mode === 'vertical' ? (
          <VerticalReader
            pages={pages}
            altPrefix={altPrefix}
            titleSlug={titleSlug}
            chapterNumber={chapter.number}
          />
        ) : (
          <PagedReader
            pages={pages}
            altPrefix={altPrefix}
            titleSlug={titleSlug}
            chapterNumber={chapter.number}
            onChapterEnd={handleNextChapter}
          />
        )}
      </main>

      {/* Reader Footer Navigation */}
      <footer className="border-t border-neutral-900 bg-neutral-950 py-8 px-4 mt-auto">
        <div className="mx-auto max-w-3xl flex flex-col items-center gap-6">
          <div className="flex items-center gap-4 w-full justify-between">
            {prevChapter ? (
              <Link
                to="/title/$slug/chapter/$number"
                params={{ slug: titleSlug, number: `${prevChapter.number}` }}
              >
                <Button variant="outline" className="gap-2 border-neutral-800 bg-neutral-900">
                  <ChevronLeft className="h-4 w-4" />
                  Глава {prevChapter.number}
                </Button>
              </Link>
            ) : (
              <div />
            )}

            <Link to="/title/$slug" params={{ slug: titleSlug }}>
              <Button variant="ghost" className="gap-2 text-neutral-400 hover:text-white">
                <BookOpen className="h-4 w-4" />
                Все главы
              </Button>
            </Link>

            {nextChapter ? (
              <Link
                to="/title/$slug/chapter/$number"
                params={{ slug: titleSlug, number: `${nextChapter.number}` }}
              >
                <Button variant="default" className="gap-2">
                  Глава {nextChapter.number}
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </Link>
            ) : (
              <div />
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}

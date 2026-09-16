import { useEffect, useRef } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { Chapter, Page } from '@/data/types';
import { useReaderMode } from '@/hooks/useReaderMode';
import { useChapterProgress } from '@/hooks/useChapterProgress';
import { ReaderToolbar } from './ReaderToolbar';
import { VerticalReader } from './VerticalReader';
import { PagedReader } from './PagedReader';
import { AdInterstitial } from '@/components/AdInterstitial';
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
  const { markChapterRead, showAd, dismissAd } = useChapterProgress();
  const markedRef = useRef<string | null>(null);

  // Считаем главу «прочитанной» один раз при открытии (для interstitial каждые N).
  useEffect(() => {
    if (markedRef.current === chapter.id) return;
    markedRef.current = chapter.id;
    markChapterRead(chapter.id);
  }, [chapter.id, markChapterRead]);

  const goNextChapter = () => {
    if (nextChapter) {
      navigate({
        to: '/title/$slug/chapter/$number',
        params: { slug: titleSlug, number: `${nextChapter.number}` },
      });
    } else {
      navigate({ to: '/title/$slug', params: { slug: titleSlug } });
    }
  };

  const handleAdNext = () => {
    dismissAd();
    goNextChapter();
  };

  const handleAdDismiss = () => {
    dismissAd();
  };

  const handleNextChapter = () => {
    // Interstitial виден → «Далее» ведёт себя как кнопка в баннере (не disabled).
    if (showAd) {
      handleAdNext();
      return;
    }
    goNextChapter();
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

      <footer className="border-t border-neutral-900 bg-neutral-950 py-8 px-4 mt-auto">
        <div className="mx-auto max-w-3xl flex flex-col items-center gap-6">
          {/* Interstitial НАД навигацией — prev/все/next всегда доступны. */}
          {showAd && (
            <div className="w-full">
              <AdInterstitial
                onDismiss={handleAdDismiss}
                onNext={handleAdNext}
              />
            </div>
          )}

          <div className="flex items-center gap-4 w-full justify-between">
            {prevChapter ? (
              <Link
                to="/title/$slug/chapter/$number"
                params={{ slug: titleSlug, number: `${prevChapter.number}` }}
              >
                <Button
                  variant="outline"
                  className="gap-2 border-neutral-800 bg-neutral-900"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Глава {prevChapter.number}
                </Button>
              </Link>
            ) : (
              <div />
            )}

            <Link to="/title/$slug" params={{ slug: titleSlug }}>
              <Button
                variant="ghost"
                className="gap-2 text-neutral-400 hover:text-white"
              >
                <BookOpen className="h-4 w-4" />
                Все главы
              </Button>
            </Link>

            {nextChapter ? (
              <Button
                variant="default"
                className="gap-2"
                onClick={handleNextChapter}
                title={
                  showAd
                    ? 'Закроет рекламу и откроет следующую главу'
                    : undefined
                }
              >
                Глава {nextChapter.number}
                <ChevronRight className="h-4 w-4" />
              </Button>
            ) : (
              <div />
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}

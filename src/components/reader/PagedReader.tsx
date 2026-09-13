import { useState, useEffect, useRef } from 'react';
import type { Page } from '@/data/types';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PagedReaderProps {
  pages: Page[];
  altPrefix: string;
  titleSlug: string;
  chapterNumber: number;
  onChapterEnd?: () => void;
}

export function PagedReader({
  pages,
  altPrefix,
  titleSlug,
  chapterNumber,
  onChapterEnd,
}: PagedReaderProps) {
  const progressKey = `hikkomanga_progress_${titleSlug}`;
  const [index, setIndex] = useState(0);
  const touchStartX = useRef<number | null>(null);

  // Restore saved reading progress on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(progressKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (
          parsed &&
          Number(parsed.chapterNumber) === Number(chapterNumber) &&
          typeof parsed.pageIndex === 'number' &&
          parsed.pageIndex >= 0 &&
          parsed.pageIndex < pages.length
        ) {
          setIndex(parsed.pageIndex);
          return;
        }
      }
    } catch {
      // Ignore
    }
    setIndex(0);
  }, [pages, chapterNumber, progressKey]);

  // Save reading progress on page change
  useEffect(() => {
    if (pages.length === 0) return;
    try {
      const progressData = {
        chapterNumber,
        pageIndex: index,
        updatedAt: new Date().toISOString(),
      };
      localStorage.setItem(progressKey, JSON.stringify(progressData));
    } catch {
      // Ignore
    }
  }, [index, chapterNumber, pages.length, progressKey]);

  // Preload next image
  useEffect(() => {
    if (index + 1 < pages.length) {
      const img = new Image();
      img.src = pages[index + 1].image_url;
    }
  }, [index, pages]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'Space') {
        e.preventDefault();
        if (index < pages.length - 1) {
          setIndex((prev) => prev + 1);
        } else if (onChapterEnd) {
          onChapterEnd();
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (index > 0) {
          setIndex((prev) => prev - 1);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [index, pages.length, onChapterEnd]);

  // Touch handlers (sanitized multi-touch & safe reset)
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      touchStartX.current = e.touches[0].clientX;
    } else {
      touchStartX.current = null;
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    if (e.changedTouches.length > 0) {
      const touchEndX = e.changedTouches[0].clientX;
      const diffX = touchStartX.current - touchEndX;

      if (Math.abs(diffX) > 50) {
        if (diffX > 0) {
          if (index < pages.length - 1) {
            setIndex((prev) => prev + 1);
          } else if (onChapterEnd) {
            onChapterEnd();
          }
        } else {
          if (index > 0) {
            setIndex((prev) => prev - 1);
          }
        }
      }
    }
    touchStartX.current = null;
  };

  if (pages.length === 0) {
    return (
      <div className="py-20 text-center text-neutral-500">
        В этой главе пока нет загруженных страниц.
      </div>
    );
  }

  const currentPage = pages[index] || pages[0];

  return (
    <div
      className="relative flex flex-col items-center justify-between min-h-[calc(100vh-3.5rem)] bg-neutral-950 py-4 select-none"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Main Image Display */}
      <div className="relative flex-1 flex items-center justify-center w-full max-w-5xl px-2 my-auto">
        <img
          src={currentPage.image_url}
          alt={`${altPrefix}, страница ${index + 1}`}
          className="max-h-[calc(100vh-8rem)] w-auto object-contain rounded shadow-2xl bg-neutral-900"
          draggable={false}
        />

        {/* Click Overlay Zones */}
        <div
          onClick={() => index > 0 && setIndex((prev) => prev - 1)}
          className={`absolute left-0 top-0 bottom-0 w-1/3 cursor-pointer transition-opacity opacity-0 hover:opacity-100 flex items-center justify-start pl-4 ${
            index === 0 ? 'pointer-events-none' : ''
          }`}
        >
          <div className="rounded-full bg-black/60 p-3 text-white backdrop-blur-sm border border-neutral-700">
            <ChevronLeft className="h-6 w-6" />
          </div>
        </div>

        <div
          onClick={() => {
            if (index < pages.length - 1) {
              setIndex((prev) => prev + 1);
            } else if (onChapterEnd) {
              onChapterEnd();
            }
          }}
          className="absolute right-0 top-0 bottom-0 w-1/3 cursor-pointer transition-opacity opacity-0 hover:opacity-100 flex items-center justify-end pr-4"
        >
          <div className="rounded-full bg-black/60 p-3 text-white backdrop-blur-sm border border-neutral-700">
            <ChevronRight className="h-6 w-6" />
          </div>
        </div>
      </div>

      {/* Page Navigation Controls */}
      <div className="flex items-center gap-4 mt-4 bg-neutral-900/90 border border-neutral-800 rounded-full px-6 py-2 backdrop-blur-md shadow-xl">
        <Button
          variant="ghost"
          size="sm"
          disabled={index === 0}
          onClick={() => setIndex((prev) => prev - 1)}
          className="h-8 w-8 p-0 rounded-full text-neutral-300 hover:text-white"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>

        <span className="text-sm font-semibold text-neutral-200 min-w-[70px] text-center">
          {index + 1} / {pages.length}
        </span>

        <Button
          variant="ghost"
          size="sm"
          disabled={index === pages.length - 1}
          onClick={() => setIndex((prev) => prev + 1)}
          className="h-8 w-8 p-0 rounded-full text-neutral-300 hover:text-white"
        >
          <ChevronRight className="h-5 w-5" />
        </Button>
      </div>
    </div>
  );
}

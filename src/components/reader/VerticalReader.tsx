import { useState, useEffect, useRef } from 'react';
import type { Page } from '@/data/types';
import { prefetchNextChapter } from '@/lib/queryClient';

interface VerticalReaderProps {
  pages: Page[];
  altPrefix: string;
  titleSlug: string;
  chapterNumber: number;
  chapterTitleId?: string;
  nextChapterNumber?: number | null;
}

interface VerticalReaderPageProps {
  page: Page;
  index: number;
  altPrefix: string;
}

function VerticalReaderPage({ page, index, altPrefix }: VerticalReaderPageProps) {
  const [isVisible, setIsVisible] = useState(index === 0);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const itemRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = itemRef.current;
    if (!el) return;

    if (typeof IntersectionObserver === 'undefined') {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsVisible(entry.isIntersecting);
      },
      {
        root: null,
        rootMargin: '100% 0px', // ±100% viewport buffer (1 full screen ahead/behind)
        threshold: 0,
      }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={itemRef}
      className="w-full bg-neutral-900 overflow-hidden"
      style={{
        minHeight: measuredHeight ? `${measuredHeight}px` : undefined,
        aspectRatio: measuredHeight ? undefined : '2 / 3',
      }}
    >
      {isVisible ? (
        <img
          src={page.image_url}
          alt={`${altPrefix}, страница ${index + 1}`}
          fetchPriority={index === 0 ? 'high' : 'auto'}
          decoding={index === 0 ? 'sync' : 'async'}
          loading={index === 0 ? 'eager' : 'lazy'}
          className="w-full h-auto select-none block bg-neutral-900"
          draggable={false}
          onLoad={(e) => {
            const h = e.currentTarget.offsetHeight;
            if (h > 0 && h !== measuredHeight) {
              setMeasuredHeight(h);
            }
          }}
        />
      ) : (
        <div
          className="w-full h-full flex items-center justify-center text-neutral-700 select-none bg-neutral-900/60"
          style={{ height: measuredHeight ? `${measuredHeight}px` : undefined }}
        >
          <span className="text-xs text-neutral-600">Страница {index + 1}</span>
        </div>
      )}
    </div>
  );
}

export function VerticalReader({
  pages,
  altPrefix,
  titleSlug,
  chapterNumber,
  chapterTitleId,
  nextChapterNumber,
}: VerticalReaderProps) {
  const progressKey = `hikkomanga_progress_${titleSlug}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const prefetchedRef = useRef(false);

  // Restore scroll position or bookmark on load
  useEffect(() => {
    try {
      const saved = localStorage.getItem(progressKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && Number(parsed.chapterNumber) === Number(chapterNumber) && parsed.scrollTop) {
          window.scrollTo({ top: parsed.scrollTop, behavior: 'smooth' });
        }
      }
    } catch {
      // Ignore
    }
  }, [chapterNumber, progressKey]);

  // Save scroll position on scroll & prefetch next chapter on reaching lower part of page
  useEffect(() => {
    let timeout: any;
    prefetchedRef.current = false;

    const handleScroll = () => {
      // Prefetch next chapter when scrolled > 65% of the page
      if (!prefetchedRef.current && chapterTitleId && nextChapterNumber != null) {
        const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
        if (scrollHeight > 0 && window.scrollY / scrollHeight > 0.65) {
          prefetchedRef.current = true;
          void prefetchNextChapter(chapterTitleId, nextChapterNumber);
        }
      }

      clearTimeout(timeout);
      timeout = setTimeout(() => {
        try {
          const progressData = {
            chapterNumber,
            scrollTop: window.scrollY,
            updatedAt: new Date().toISOString(),
          };
          localStorage.setItem(progressKey, JSON.stringify(progressData));
        } catch {
          // Ignore
        }
      }, 300);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      clearTimeout(timeout);
      window.removeEventListener('scroll', handleScroll);
    };
  }, [chapterNumber, progressKey, chapterTitleId, nextChapterNumber]);

  if (pages.length === 0) {
    return (
      <div className="py-20 text-center text-neutral-500">
        В этой главе пока нет загруженных страниц.
      </div>
    );
  }

  return (
    <div ref={containerRef} className="mx-auto max-w-3xl flex flex-col items-center shadow-2xl">
      {pages.map((p, i) => (
        <VerticalReaderPage
          key={p.id}
          page={p}
          index={i}
          altPrefix={altPrefix}
        />
      ))}
    </div>
  );
}

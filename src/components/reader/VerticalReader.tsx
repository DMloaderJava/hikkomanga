import { useEffect, useRef } from 'react';
import type { Page } from '@/data/types';

interface VerticalReaderProps {
  pages: Page[];
  altPrefix: string;
  titleSlug: string;
  chapterNumber: number;
}

export function VerticalReader({ pages, altPrefix, titleSlug, chapterNumber }: VerticalReaderProps) {
  const progressKey = `hikkomanga_progress_${titleSlug}`;
  const containerRef = useRef<HTMLDivElement>(null);

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

  // Save scroll position on scroll
  useEffect(() => {
    let timeout: any;
    const handleScroll = () => {
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
  }, [chapterNumber, progressKey]);

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
        <img
          key={p.id}
          src={p.image_url}
          alt={`${altPrefix}, страница ${i + 1}`}
          fetchPriority={i === 0 ? 'high' : 'auto'}
          decoding={i === 0 ? 'sync' : 'async'}
          loading={i === 0 ? 'eager' : 'lazy'}
          className="w-full h-auto select-none block bg-neutral-900"
          draggable={false}
        />
      ))}
    </div>
  );
}

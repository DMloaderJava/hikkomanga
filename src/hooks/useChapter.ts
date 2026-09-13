import { useState, useEffect } from 'react';
import { titles } from '@/data/titles';
import { chapters } from '@/data/chapters';
import { pages } from '@/data/pages';
import type { Title, Chapter, Page } from '@/data/types';

export function useChapter(slug: string, chapterNumber: number) {
  const [data, setData] = useState<{
    title: Title | null;
    chapter: Chapter | null;
    chapterPages: Page[];
    prevChapter: Chapter | null;
    nextChapter: Chapter | null;
  }>({
    title: null,
    chapter: null,
    chapterPages: [],
    prevChapter: null,
    nextChapter: null,
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      try {
        const titleData = await titles.getBySlug(slug);
        if (!titleData) {
          if (mounted) setError(new Error('Тайтл не найден'));
          return;
        }

        const chapterData = await chapters.getByNumber(titleData.id, chapterNumber);
        if (!chapterData) {
          if (mounted) setError(new Error('Глава не найдена'));
          return;
        }

        const [pageList, nav] = await Promise.all([
          pages.listByChapter(chapterData.id),
          chapters.getNextAndPrev(titleData.id, chapterData.number),
        ]);

        if (mounted) {
          setData({
            title: titleData,
            chapter: chapterData,
            chapterPages: pageList,
            prevChapter: nav.prevChapter,
            nextChapter: nav.nextChapter,
          });
          setError(null);
        }
      } catch (err: any) {
        if (mounted) setError(err);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    if (slug && chapterNumber) {
      load();
    }
  }, [slug, chapterNumber]);

  return { ...data, loading, error };
}

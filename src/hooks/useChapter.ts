import { useQuery } from '@tanstack/react-query';
import { titles } from '@/data/titles';
import { chapters } from '@/data/chapters';
import { pages } from '@/data/pages';
import { readerQueryKeys } from '@/lib/queryClient';
import type { Title, Chapter, Page } from '@/data/types';

export function useChapter(slug: string, chapterNumber: number) {
  const {
    data: title,
    isLoading: isTitleLoading,
    error: titleError,
  } = useQuery({
    queryKey: readerQueryKeys.title(slug),
    queryFn: () => titles.getBySlug(slug),
    enabled: Boolean(slug),
    staleTime: 1000 * 60 * 5,
  });

  const titleId = title?.id;

  const {
    data: chapter,
    isLoading: isChapterLoading,
    error: chapterError,
  } = useQuery({
    queryKey: readerQueryKeys.chapter(titleId || '', chapterNumber),
    queryFn: () => (titleId ? chapters.getByNumber(titleId, chapterNumber) : null),
    enabled: Boolean(titleId && chapterNumber),
    staleTime: Infinity,
  });

  const chapterId = chapter?.id;

  const {
    data: chapterPages = [],
    isLoading: isPagesLoading,
    error: pagesError,
  } = useQuery<Page[]>({
    queryKey: readerQueryKeys.pages(chapterId || ''),
    queryFn: () => (chapterId ? pages.listByChapter(chapterId) : Promise.resolve([])),
    enabled: Boolean(chapterId),
    staleTime: Infinity,
  });

  const {
    data: nav = { prevChapter: null, nextChapter: null },
    isLoading: isNavLoading,
    error: navError,
  } = useQuery<{ prevChapter: Chapter | null; nextChapter: Chapter | null }>({
    queryKey: readerQueryKeys.nav(titleId || '', chapterNumber),
    queryFn: () =>
      titleId ? chapters.getNextAndPrev(titleId, chapterNumber) : Promise.resolve({ prevChapter: null, nextChapter: null }),
    enabled: Boolean(titleId && chapterNumber),
    staleTime: Infinity,
  });

  const loading =
    isTitleLoading ||
    (Boolean(titleId) && isChapterLoading) ||
    (Boolean(chapterId) && isPagesLoading) ||
    (Boolean(titleId) && isNavLoading);

  const error = titleError || chapterError || pagesError || navError || null;

  return {
    title: title || null,
    chapter: chapter || null,
    chapterPages,
    prevChapter: nav.prevChapter,
    nextChapter: nav.nextChapter,
    loading,
    error,
  };
}

import { QueryClient } from '@tanstack/react-query';
import { titles as titlesApi } from '@/data/titles';
import { chapters as chaptersApi } from '@/data/chapters';
import { pages as pagesApi } from '@/data/pages';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes default
      gcTime: 1000 * 60 * 30, // 30 minutes
      refetchOnWindowFocus: false,
    },
  },
});

export const readerQueryKeys = {
  title: (slug: string) => ['title', slug] as const,
  chapter: (titleId: string, number: number) => ['chapter', titleId, number] as const,
  pages: (chapterId: string) => ['pages', chapterId] as const,
  nav: (titleId: string, number: number) => ['nav', titleId, number] as const,
};

export async function prefetchNextChapter(titleId: string, nextChapterNumber: number) {
  try {
    const nextChapter = await queryClient.ensureQueryData({
      queryKey: readerQueryKeys.chapter(titleId, nextChapterNumber),
      queryFn: () => chaptersApi.getByNumber(titleId, nextChapterNumber),
      staleTime: Infinity,
    });

    if (nextChapter?.id) {
      void queryClient
        .ensureQueryData({
          queryKey: readerQueryKeys.pages(nextChapter.id),
          queryFn: () => pagesApi.listByChapter(nextChapter.id),
          staleTime: Infinity,
        })
        .catch(() => {});

      void queryClient
        .ensureQueryData({
          queryKey: readerQueryKeys.nav(titleId, nextChapter.number),
          queryFn: () => chaptersApi.getNextAndPrev(titleId, nextChapter.number),
          staleTime: Infinity,
        })
        .catch(() => {});
    }
  } catch {
    // Non-blocking prefetch error
  }
}

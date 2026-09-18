import { useEffect } from 'react';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { titles as titlesApi } from '@/data/titles';
import { chapters as chaptersApi } from '@/data/chapters';
import { pages as pagesApi } from '@/data/pages';
import { Reader } from '@/components/reader/Reader';
import { updateMetaTags, seoForRoute } from '@/lib/seo';
import { queryClient, readerQueryKeys } from '@/lib/queryClient';
import type { Title, Chapter, Page } from '@/data/types';

export const Route = createFileRoute('/title/$slug/chapter/$number')({
  loader: async ({ params }) => {
    const titleData = await queryClient.ensureQueryData({
      queryKey: readerQueryKeys.title(params.slug),
      queryFn: () => titlesApi.getBySlug(params.slug),
      staleTime: 1000 * 60 * 5,
    });
    if (!titleData || !titleData.published) throw notFound();

    const num = parseFloat(params.number);
    const chapterData = await queryClient.ensureQueryData({
      queryKey: readerQueryKeys.chapter(titleData.id, num),
      queryFn: () => chaptersApi.getByNumber(titleData.id, num),
      staleTime: Infinity,
    });
    if (!chapterData || !chapterData.published) throw notFound();

    const [chapterPages, nav] = await Promise.all([
      queryClient.ensureQueryData({
        queryKey: readerQueryKeys.pages(chapterData.id),
        queryFn: () => pagesApi.listByChapter(chapterData.id),
        staleTime: Infinity,
      }),
      queryClient.ensureQueryData({
        queryKey: readerQueryKeys.nav(titleData.id, chapterData.number),
        queryFn: () => chaptersApi.getNextAndPrev(titleData.id, chapterData.number),
        staleTime: Infinity,
      }),
    ]);

    return {
      title: titleData,
      chapter: chapterData,
      pages: chapterPages,
      prevChapter: nav.prevChapter,
      nextChapter: nav.nextChapter,
    };
  },
  component: ReaderPage,
});

function ReaderPage() {
  const initial = Route.useLoaderData() as {
    title: Title;
    chapter: Chapter;
    pages: Page[];
    prevChapter: Chapter | null;
    nextChapter: Chapter | null;
  };

  const { data: title } = useQuery({
    queryKey: readerQueryKeys.title(initial.title.slug),
    queryFn: () => titlesApi.getBySlug(initial.title.slug),
    initialData: initial.title,
    staleTime: 1000 * 60 * 5,
  });

  const { data: chapter } = useQuery({
    queryKey: readerQueryKeys.chapter(initial.title.id, initial.chapter.number),
    queryFn: () => chaptersApi.getByNumber(initial.title.id, initial.chapter.number),
    initialData: initial.chapter,
    staleTime: Infinity,
  });

  const { data: pages } = useQuery({
    queryKey: readerQueryKeys.pages(initial.chapter.id),
    queryFn: () => pagesApi.listByChapter(initial.chapter.id),
    initialData: initial.pages,
    staleTime: Infinity,
  });

  const { data: nav } = useQuery({
    queryKey: readerQueryKeys.nav(initial.title.id, initial.chapter.number),
    queryFn: () => chaptersApi.getNextAndPrev(initial.title.id, initial.chapter.number),
    initialData: { prevChapter: initial.prevChapter, nextChapter: initial.nextChapter },
    staleTime: Infinity,
  });

  const activeTitle = title || initial.title;
  const activeChapter = chapter || initial.chapter;
  const activePages = pages || initial.pages;
  const activePrev = nav ? nav.prevChapter : initial.prevChapter;
  const activeNext = nav ? nav.nextChapter : initial.nextChapter;

  useEffect(() => {
    if (activeTitle && activeChapter) {
      updateMetaTags(seoForRoute(Route.id, { title: activeTitle, chapter: activeChapter }));
    }
  }, [activeTitle, activeChapter]);

  return (
    <Reader
      chapter={activeChapter}
      pages={activePages}
      prevChapter={activePrev}
      nextChapter={activeNext}
      titleSlug={activeTitle.slug}
      titleName={activeTitle.title}
    />
  );
}

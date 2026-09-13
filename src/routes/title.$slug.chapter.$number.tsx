import { useEffect } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { titles as titlesApi } from '@/data/titles';
import { chapters as chaptersApi } from '@/data/chapters';
import { pages as pagesApi } from '@/data/pages';
import { Reader } from '@/components/reader/Reader';
import { updateMetaTags } from '@/lib/seo';
import type { Title, Chapter, Page } from '@/data/types';

export const Route = createFileRoute('/title/$slug/chapter/$number')({
  loader: async ({ params }) => {
    const titleData = await titlesApi.getBySlug(params.slug);
    if (!titleData || !titleData.published) throw new Error('Тайтл не найден');

    const num = parseFloat(params.number);
    const chapterData = await chaptersApi.getByNumber(titleData.id, num);
    if (!chapterData || !chapterData.published) throw new Error('Глава не найдена');

    const [chapterPages, nav] = await Promise.all([
      pagesApi.listByChapter(chapterData.id),
      chaptersApi.getNextAndPrev(titleData.id, chapterData.number),
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
  const { title, chapter, pages, prevChapter, nextChapter } = Route.useLoaderData() as {
    title: Title;
    chapter: Chapter;
    pages: Page[];
    prevChapter: Chapter | null;
    nextChapter: Chapter | null;
  };

  useEffect(() => {
    if (title && chapter) {
      updateMetaTags({
        title: `${title.title} — Глава ${chapter.number}`,
        description: `Читать главу ${chapter.number} манги ${title.title} онлайн`,
      });
    }
  }, [title, chapter]);

  return (
    <Reader
      chapter={chapter}
      pages={pages}
      prevChapter={prevChapter}
      nextChapter={nextChapter}
      titleSlug={title.slug}
      titleName={title.title}
    />
  );
}

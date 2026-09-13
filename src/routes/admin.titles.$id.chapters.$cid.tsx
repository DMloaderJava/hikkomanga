import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { titles as titlesApi } from '@/data/titles';
import { chapters as chaptersApi } from '@/data/chapters';
import { pages as pagesApi } from '@/data/pages';
import { ChapterForm } from '@/components/admin/ChapterForm';
import { PageUploader } from '@/components/admin/PageUploader';
import { PageSortList } from '@/components/admin/PageSortList';
import { VoiceoverPanel } from '@/components/admin/VoiceoverPanel';
import type { Title, Chapter, Page, ChapterInput } from '@/data/types';
import { ArrowLeft, FileImage, Layers } from 'lucide-react';
import { formatChapterNumber } from '@/lib/format';

export const Route = createFileRoute('/admin/titles/$id/chapters/$cid')({
  loader: async ({ params }) => {
    const [titleData, chapterData, pageList] = await Promise.all([
      titlesApi.getById(params.id),
      chaptersApi.getById(params.cid),
      pagesApi.listByChapter(params.cid),
    ]);
    if (!titleData || !chapterData) throw new Error('Глава или тайтл не найдены');
    return { title: titleData, chapter: chapterData, pages: pageList };
  },
  component: AdminChapterPagesPage,
});

function AdminChapterPagesPage() {
  const { title, chapter, pages } = Route.useLoaderData() as {
    title: Title;
    chapter: Chapter;
    pages: Page[];
  };

  const [currentChapter, setCurrentChapter] = useState<Chapter>(chapter);
  const [pageList, setPageList] = useState<Page[]>(pages);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleUpdateChapter = async (input: ChapterInput) => {
    setIsSubmitting(true);
    try {
      const updated = await chaptersApi.update(currentChapter.id, input);
      setCurrentChapter(updated);
    } catch (err: any) {
      alert(err.message || 'Ошибка обновления главы');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReloadPages = async () => {
    const updatedPages = await pagesApi.listByChapter(currentChapter.id);
    setPageList(updatedPages);
  };

  const handleReorderPages = async (reorderedPages: Page[]) => {
    setPageList(reorderedPages);
    try {
      await pagesApi.updateOrder(
        reorderedPages.map((p) => ({ id: p.id, page_order: p.page_order })),
        currentChapter.id
      );
    } catch (err) {
      console.error('Failed to update page orders:', err);
    }
  };

  const handleDeletePage = async (pageId: string) => {
    if (!confirm('Вы уверены, что хотите удалить эту страницу?')) return;
    try {
      await pagesApi.delete(pageId);
      setPageList((prev) => prev.filter((p) => p.id !== pageId));
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <main className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Header */}
      <div className="flex items-center gap-4 border-b border-neutral-800 pb-4">
        <Link
          to="/admin/titles/$id/chapters"
          params={{ id: title.id }}
          className="text-neutral-400 hover:text-white"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight flex items-center gap-2">
            <FileImage className="h-6 w-6 text-rose-500" /> Редактирование главы {formatChapterNumber(currentChapter.number)}
          </h1>
          <p className="text-xs text-neutral-400 mt-0.5">
            Тайтл: «{title.title}»
          </p>
        </div>
      </div>

      {/* Chapter Metadata Form */}
      <section className="space-y-3">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Layers className="h-4 w-4 text-rose-400" /> Настройки главы
        </h3>
        <ChapterForm
          titleId={title.id}
          initialData={currentChapter}
          onSubmit={handleUpdateChapter}
          isSubmitting={isSubmitting}
        />
      </section>

      {/* Page Uploader */}
      <section className="space-y-3 pt-4 border-t border-neutral-800">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <FileImage className="h-4 w-4 text-rose-400" /> Загрузка страниц
        </h3>
        <PageUploader
          chapterId={currentChapter.id}
          currentPagesCount={pageList.length}
          onPagesUploaded={handleReloadPages}
        />
      </section>

      {/* Page List & Sorting */}
      <section className="space-y-3 pt-4 border-t border-neutral-800">
        <h3 className="text-sm font-bold text-white">Список страниц ({pageList.length})</h3>
        <PageSortList
          pages={pageList}
          onReorder={handleReorderPages}
          onDeletePage={handleDeletePage}
        />
      </section>

      {/* AI Voiceover & Screen Recording Section (Admin Only) */}
      <section className="pt-4 border-t border-neutral-800">
        <VoiceoverPanel chapterId={currentChapter.id} pages={pageList} />
      </section>
    </main>
  );
}

import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { titles as titlesApi } from '@/data/titles';
import { chapters as chaptersApi } from '@/data/chapters';
import { pages as pagesApi } from '@/data/pages';
import { ChapterForm } from '@/components/admin/ChapterForm';
import { PageUploader } from '@/components/admin/PageUploader';
import { PageSortList } from '@/components/admin/PageSortList';
import { VoiceoverPanel } from '@/components/admin/VoiceoverPanel';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import type { Title, Chapter, Page, ChapterInput } from '@/data/types';
import { ArrowLeft, FileImage, Layers, AlertCircle } from 'lucide-react';
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
  const [deleteTarget, setDeleteTarget] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleUpdateChapter = async (input: ChapterInput) => {
    setIsSubmitting(true);
    setError(null);
    try {
      const updated = await chaptersApi.update(currentChapter.id, input);
      setCurrentChapter(updated);
    } catch (err) {
      // inline-ошибку покажет форма главы
      throw err;
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
    setError(null);
    try {
      await pagesApi.updateOrder(
        reorderedPages.map((p) => ({ id: p.id, page_order: p.page_order })),
        currentChapter.id
      );
    } catch (err: any) {
      setPageList(pageList); // откат визуального порядка
      setError(err.message || 'Не удалось сохранить порядок страниц');
    }
  };

  const handleDeletePage = async () => {
    if (!deleteTarget) return;
    setError(null);
    const pageId = deleteTarget.id;
    try {
      await pagesApi.delete(pageId);
      setPageList((prev) => prev.filter((p) => p.id !== pageId));
    } catch (err: any) {
      setDeleteTarget(null);
      setError(err.message || 'Не удалось удалить страницу');
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

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-800/80 bg-red-950/40 p-3 text-sm text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

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
          onDeletePage={(pageId) =>
            setDeleteTarget(pageList.find((pg) => pg.id === pageId) || null)
          }
        />
      </section>

      {/* AI Voiceover & Screen Recording Section (Admin Only) */}
      <section className="pt-4 border-t border-neutral-800">
        <VoiceoverPanel chapterId={currentChapter.id} pages={pageList} />
      </section>
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={`Удалить страницу ${deleteTarget?.page_order ?? ''}?`}
        description={
          <>
            Файл страницы и её оригинал будут удалены из хранилища, запись — из базы.
            Действие нельзя отменить.
          </>
        }
        confirmLabel="Удалить страницу"
        onConfirm={handleDeletePage}
      />
    </main>
  );
}

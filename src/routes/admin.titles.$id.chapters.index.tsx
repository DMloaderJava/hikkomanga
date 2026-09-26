import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { titles as titlesApi } from '@/data/titles';
import { chapters as chaptersApi } from '@/data/chapters';
import { ChapterForm } from '@/components/admin/ChapterForm';
import { PublishTitleBanner } from '@/components/admin/PublishTitleBanner';
import { RequestForm } from '@/components/admin/RequestForm';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  ArrowLeft,
  Layers,
  Plus,
  Send,
  BookOpen,
  FileImage,
  AlertCircle,
  FileUp,
} from 'lucide-react';
import type { Title, Chapter, ChapterInput } from '@/data/types';
import { formatChapterNumber, formatDate } from '@/lib/format';
import { auth } from '@/data/auth';
import { assertEntityId } from '@/lib/routeParams';

export const Route = createFileRoute('/admin/titles/$id/chapters/')({
  loader: async ({ params }) => {
    const titleId = assertEntityId(params.id, 'тайтл');
    const [titleData, chapterList] = await Promise.all([
      titlesApi.getById(titleId),
      chaptersApi.listByTitle(titleId, true),
    ]);
    if (!titleData) throw new Error('Тайтл не найден');
    // isOwner в loader — без мерцания UI admin ↔ owner.
    let isOwner = false;
    try {
      const session = await auth.getSession();
      const uid = session?.user?.id;
      if (uid) isOwner = await auth.hasRole(uid, 'owner');
    } catch {
      // ignore
    }
    return { title: titleData, chapters: chapterList, isOwner };
  },
  component: AdminTitleChaptersPage,
});

function AdminTitleChaptersPage() {
  const { title, chapters, isOwner } = Route.useLoaderData() as {
    title: Title;
    chapters: Chapter[];
    isOwner: boolean;
  };
  const [titleState, setTitleState] = useState<Title>(title);
  const [chapterList, setChapterList] = useState<Chapter[]>(chapters);
  const [showAddForm, setShowAddForm] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [requestDeleteTarget, setRequestDeleteTarget] = useState<Chapter | null>(null);
  const [pendingToggleId, setPendingToggleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleCreateChapter = async (input: ChapterInput) => {
    setIsSubmitting(true);
    setError(null);
    try {
      const created = await chaptersApi.create(input);
      setChapterList((prev) =>
        [...prev, created].sort((a, b) => a.number - b.number)
      );
      setShowAddForm(false);
    } catch (err) {
      throw err;
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTogglePublish = async (
    chapterId: string,
    currentPublished: boolean
  ) => {
    setError(null);
    setPendingToggleId(chapterId);
    try {
      const updated = await chaptersApi.update(chapterId, {
        published: !currentPublished,
      });
      setChapterList((prev) =>
        prev.map((c) => (c.id === chapterId ? updated : c))
      );
    } catch (err: any) {
      setError(err.message || 'Не удалось изменить статус главы');
    } finally {
      setPendingToggleId(null);
    }
  };

  return (
    <main className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-neutral-800 pb-4">
        <div className="flex items-center gap-4">
          <Link to="/admin/titles" className="text-neutral-400 hover:text-white">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight flex items-center gap-2">
              <Layers className="h-6 w-6 text-rose-500" /> Главы тайтла «{titleState.title}»
            </h1>
            <p className="text-xs text-neutral-400 mt-0.5">
              Всего глав: {chapterList.length}
              {titleState.published ? ' · тайтл в каталоге' : ' · тайтл ещё черновик'}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {isOwner && (
            <Link to="/admin/titles/$id/chapters/import" params={{ id: title.id }}>
              <Button variant="outline" className="gap-2 border-neutral-700">
                <FileUp className="h-4 w-4" />
                Импорт глав
              </Button>
            </Link>
          )}
          <Button
            onClick={() => {
              setError(null);
              setShowAddForm(!showAddForm);
            }}
            variant={showAddForm ? 'secondary' : 'default'}
            className="gap-2"
          >
            <Plus className="h-4 w-4" />
            {showAddForm ? 'Скрыть форму' : 'Добавить главу'}
          </Button>
        </div>
      </div>

      <PublishTitleBanner title={titleState} onChange={setTitleState} />

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-800/80 bg-red-950/40 p-3 text-sm text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {showAddForm &&
        (isOwner ? (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-neutral-300">Новая глава</h3>
            <ChapterForm
              titleId={title.id}
              onSubmit={handleCreateChapter}
              isSubmitting={isSubmitting}
            />
          </div>
        ) : (
          <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
            <RequestForm
              type="new_chapter"
              target_id={title.id}
              target_name={title.title}
              payload={{ suggested_number: chapterList.length + 1 }}
              title="Запрос на добавление главы"
              description="Владелец создаст главу и вы сможете загрузить страницы."
              submitLabel="Запросить создание главы"
              onSuccess={() => setShowAddForm(false)}
            />
          </div>
        ))}

      <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 overflow-hidden shadow-xl">
        {chapterList.length === 0 ? (
          <div className="p-12 text-center text-sm text-neutral-500">
            У этого тайтла пока нет глав. Нажмите «Добавить главу», чтобы создать первую.
          </div>
        ) : (
          <table className="w-full text-left text-sm text-neutral-200">
            <thead className="bg-neutral-950/80 text-xs uppercase font-semibold text-neutral-400 border-b border-neutral-800">
              <tr>
                <th className="px-6 py-4">Глава</th>
                <th className="px-6 py-4">Дата создания</th>
                <th className="px-6 py-4">Публикация</th>
                <th className="px-6 py-4 text-right">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800/60">
              {chapterList.map((ch) => (
                <tr key={ch.id} className="hover:bg-neutral-800/40 transition-colors">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-neutral-800 text-rose-400">
                        <BookOpen className="h-4 w-4" />
                      </div>
                      <div>
                        <div className="font-bold text-white text-base">
                          Глава {formatChapterNumber(ch.number)}
                        </div>
                        {ch.name && (
                          <div className="text-xs text-neutral-400">{ch.name}</div>
                        )}
                      </div>
                    </div>
                  </td>

                  <td className="px-6 py-4 text-xs text-neutral-400">
                    {formatDate(ch.created_at)}
                  </td>

                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={ch.published}
                        disabled={pendingToggleId === ch.id}
                        onCheckedChange={() =>
                          handleTogglePublish(ch.id, ch.published)
                        }
                      />
                      <span className="text-xs text-neutral-400">
                        {pendingToggleId === ch.id
                          ? 'Сохранение...'
                          : ch.published
                            ? 'Опубликована'
                            : 'Черновик'}
                      </span>
                    </div>
                  </td>

                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Link
                        to="/admin/titles/$id/chapters/$cid"
                        params={{ id: title.id, cid: ch.id }}
                      >
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs gap-1.5 border-neutral-800"
                        >
                          <FileImage className="h-3.5 w-3.5 text-rose-400" />{' '}
                          Страницы и загрузка
                        </Button>
                      </Link>

                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRequestDeleteTarget(ch)}
                        className="h-8 w-8 p-0 text-neutral-400 hover:text-amber-400 hover:bg-amber-950/40"
                        title="Запросить удаление"
                      >
                        <Send className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Dialog
        open={!!requestDeleteTarget}
        onOpenChange={(open) => {
          if (!open) setRequestDeleteTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <RequestForm
            type="delete_chapter"
            target_id={requestDeleteTarget?.id}
            target_name={
              requestDeleteTarget
                ? `Глава ${formatChapterNumber(requestDeleteTarget.number)}`
                : ''
            }
            title="Запрос на удаление главы"
            description="Удаление главы со страницами и озвучкой потребует подтверждения владельца."
            submitLabel="Запросить удаление"
            onSuccess={() => setRequestDeleteTarget(null)}
          />
        </DialogContent>
      </Dialog>
    </main>
  );
}

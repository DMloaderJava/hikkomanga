import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { titles as titlesApi } from '@/data/titles';
import { auth } from '@/data/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { RequestForm } from '@/components/admin/RequestForm';
import {
  Library,
  Plus,
  Search,
  Edit,
  Layers,
  Send,
  Trash2,
  ExternalLink,
  AlertCircle,
} from 'lucide-react';
import type { Title } from '@/data/types';

export const Route = createFileRoute('/admin/titles/')({
  loader: async () => {
    // isOwner резолвится в loader — без мерцания admin-UI → owner-UI.
    let isOwner = false;
    try {
      const session = await auth.getSession();
      const uid = session?.user?.id;
      if (uid) isOwner = await auth.hasRole(uid, 'owner');
    } catch {
      // ignore
    }
    return { titles: await titlesApi.listAll(), isOwner };
  },
  component: AdminTitlesIndexPage,
});

function AdminTitlesIndexPage() {
  const { titles, isOwner } = Route.useLoaderData() as {
    titles: Title[];
    isOwner: boolean;
  };
  const [search, setSearch] = useState('');
  const [titleList, setTitleList] = useState<Title[]>(titles);
  const [requestDeleteTarget, setRequestDeleteTarget] = useState<Title | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Title | null>(null);
  const [pendingToggleId, setPendingToggleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const handleTogglePublish = async (id: string) => {
    setError(null);
    setPendingToggleId(id);
    try {
      const updated = await titlesApi.togglePublish(id);
      setTitleList((prev) => prev.map((t) => (t.id === id ? updated : t)));
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Не удалось изменить статус публикации'
      );
    } finally {
      setPendingToggleId(null);
    }
  };

  const handleOwnerDelete = async () => {
    if (!deleteTarget) return;
    setError(null);
    setDialogError(null);
    try {
      await titlesApi.delete(deleteTarget.id);
      setTitleList((prev) => prev.filter((t) => t.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Не удалось удалить тайтл';
      // Ошибка только в диалоге (модальный — верхний баннер не виден).
      setDialogError(msg);
      throw err; // ConfirmDialog остаётся открытым
    }
  };

  const filteredTitles = titleList.filter((t) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return t.title.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q);
  });

  return (
    <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 border-b border-neutral-800 pb-6">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2">
            <Library className="h-6 w-6 text-rose-500" /> Тайтлы манги
          </h1>
          <p className="text-xs text-neutral-400 mt-1">
            Всего тайтлов: {titleList.length}
            {isOwner ? ' · owner: прямое удаление' : ' · admin: удаление через заявку'}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Link to="/admin/titles/new">
            <Button className="gap-2 shadow-lg shadow-rose-600/20">
              <Plus className="h-4 w-4" /> Добавить тайтл
            </Button>
          </Link>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-800/80 bg-red-950/40 p-3 text-sm text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="relative max-w-md">
        <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
        <Input
          type="text"
          placeholder="Поиск по названию или slug..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10"
        />
      </div>

      <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 overflow-hidden shadow-xl">
        <table className="w-full text-left text-sm text-neutral-200">
          <thead className="bg-neutral-950/80 text-xs uppercase font-semibold text-neutral-400 border-b border-neutral-800">
            <tr>
              <th className="px-6 py-4">Обложка и название</th>
              <th className="px-6 py-4">Жанры</th>
              <th className="px-6 py-4">Статус</th>
              <th className="px-6 py-4">Публикация</th>
              <th className="px-6 py-4 text-right">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800/60">
            {filteredTitles.length === 0 && (
              <tr>
                <td colSpan={5} className="px-6 py-12 text-center text-sm text-neutral-500">
                  {titleList.length === 0
                    ? 'Тайтлов пока нет. Нажмите «Добавить тайтл», чтобы создать первый.'
                    : 'Ничего не найдено по вашему запросу.'}
                </td>
              </tr>
            )}
            {filteredTitles.map((t) => (
              <tr key={t.id} className="hover:bg-neutral-800/40 transition-colors">
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="h-14 w-10 shrink-0 overflow-hidden rounded bg-neutral-950 border border-neutral-800">
                      {t.cover_url && (
                        <img src={t.cover_url} alt={t.title} className="h-full w-full object-cover" />
                      )}
                    </div>
                    <div>
                      <div className="font-bold text-white text-base">{t.title}</div>
                      <div className="text-xs text-neutral-500 font-mono">/{t.slug}</div>
                      {t.author && (
                        <div className="text-xs text-neutral-400 font-medium">Автор: {t.author}</div>
                      )}
                    </div>
                  </div>
                </td>

                <td className="px-6 py-4">
                  <div className="flex flex-wrap gap-1 max-w-xs">
                    {t.genres.map((g) => (
                      <span
                        key={g.id}
                        className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300"
                      >
                        {g.name}
                      </span>
                    ))}
                  </div>
                </td>

                <td className="px-6 py-4">
                  <Badge
                    variant={t.status === 'completed' ? 'success' : 'default'}
                    className="text-[10px]"
                  >
                    {t.status === 'completed' ? 'Завершён' : 'Онгоинг'}
                  </Badge>
                </td>

                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={t.published}
                      disabled={pendingToggleId === t.id}
                      onCheckedChange={() => handleTogglePublish(t.id)}
                    />
                    <span className="text-xs text-neutral-400">
                      {pendingToggleId === t.id
                        ? 'Сохранение...'
                        : t.published
                          ? 'Опубликован'
                          : 'Черновик'}
                    </span>
                  </div>
                </td>

                <td className="px-6 py-4 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    {t.published && (
                      <Link to="/title/$slug" params={{ slug: t.slug }} target="_blank">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-neutral-400 hover:text-white"
                          title="Посмотреть на сайте"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                      </Link>
                    )}

                    <Link to="/admin/titles/$id/chapters" params={{ id: t.id }}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs gap-1 border-neutral-800"
                      >
                        <Layers className="h-3.5 w-3.5" /> Глав
                      </Button>
                    </Link>

                    <Link to="/admin/titles/$id" params={{ id: t.id }}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 text-neutral-400 hover:text-white"
                        title="Редактировать"
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                    </Link>

                    {isOwner ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteTarget(t)}
                        className="h-8 w-8 p-0 text-neutral-400 hover:text-red-400 hover:bg-red-950/40"
                        title="Удалить тайтл"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRequestDeleteTarget(t)}
                        className="h-8 w-8 p-0 text-neutral-400 hover:text-amber-400 hover:bg-amber-950/40"
                        title="Запросить удаление"
                      >
                        <Send className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Admin: заявка на удаление */}
      <Dialog
        open={!!requestDeleteTarget}
        onOpenChange={(open) => {
          if (!open) setRequestDeleteTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <RequestForm
            type="delete_title"
            target_id={requestDeleteTarget?.id}
            target_name={requestDeleteTarget?.title}
            title="Запрос на удаление тайтла"
            description={`Удаление «${requestDeleteTarget?.title ?? ''}» со всеми главами и файлами потребует подтверждения владельца.`}
            submitLabel="Запросить удаление"
            onSuccess={() => setRequestDeleteTarget(null)}
          />
        </DialogContent>
      </Dialog>

      {/* Owner: прямое удаление */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setDialogError(null);
          }
        }}
        title="Удалить тайтл?"
        description={
          <>
            «{deleteTarget?.title}» будет удалён вместе со всеми главами, страницами и
            файлами. Действие необратимо.
            {dialogError && (
              <span className="mt-2 block text-red-400">{dialogError}</span>
            )}
          </>
        }
        confirmLabel="Удалить"
        onConfirm={handleOwnerDelete}
      />
    </main>
  );
}

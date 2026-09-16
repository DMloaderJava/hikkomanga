import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect, useCallback } from 'react';
import { adminRequests } from '@/data/adminRequests';
import { auth } from '@/data/auth';
import type { AdminRequest } from '@/data/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  CheckCircle,
  XCircle,
  Trash2,
  Plus,
  Megaphone,
  Inbox,
} from 'lucide-react';
import { formatDate } from '@/lib/format';

export const Route = createFileRoute('/admin/requests')({
  component: AdminRequestsPage,
});

const TYPE_LABELS: Record<string, string> = {
  delete_title: 'Удалить тайтл',
  delete_chapter: 'Удалить главу',
  new_chapter: 'Новая глава',
  ad_request: 'Реклама',
};

function TypeIcon({ type }: { type: string }) {
  if (type === 'delete_title' || type === 'delete_chapter') {
    return <Trash2 className="h-4 w-4 text-red-400" />;
  }
  if (type === 'new_chapter') {
    return <Plus className="h-4 w-4 text-green-400" />;
  }
  return <Megaphone className="h-4 w-4 text-blue-400" />;
}

function isDestructive(type: string) {
  return type === 'delete_title' || type === 'delete_chapter';
}

function AdminRequestsPage() {
  const navigate = useNavigate();
  const [requests, setRequests] = useState<AdminRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  /** true = можно approve/reject (RLS update только у owner). */
  const [canResolve, setCanResolve] = useState(false);
  /** ConfirmDialog target for destructive approve / any reject. */
  const [confirm, setConfirm] = useState<{
    req: AdminRequest;
    decision: 'approved' | 'rejected';
  } | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  useEffect(() => {
    auth.getSession().then(async (session) => {
      if (!session) {
        navigate({ to: '/admin/login' });
        return;
      }
      const userId = session.user?.id;
      if (!userId) {
        navigate({ to: '/admin' });
        return;
      }
      const isOwner = await auth.hasRole(userId, 'owner');
      const isAdmin = await auth.hasRole(userId, 'admin');
      if (!isOwner && !isAdmin) {
        navigate({ to: '/admin' });
        return;
      }

      setCanResolve(isOwner);

      try {
        if (isOwner) {
          setRequests(await adminRequests.listPending());
        } else {
          setRequests(await adminRequests.listMine({ status: 'pending' }));
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Ошибка загрузки');
      } finally {
        setLoading(false);
      }
    });
  }, [navigate]);

  const applyResolve = useCallback(
    async (
      req: AdminRequest,
      decision: 'approved' | 'rejected',
      /** true = из ConfirmDialog → ошибка только в диалоге. */
      inDialog = false
    ) => {
      setResolving(req.id);
      setError(null);
      setFlash(null);
      setConfirmError(null);
      try {
        await adminRequests.resolve(req.id, decision);
        setRequests((prev) => prev.filter((r) => r.id !== req.id));
        setConfirm(null);

        if (decision === 'approved') {
          if (req.type === 'delete_title') {
            setFlash(`Тайтл «${req.target_name || '—'}» удалён.`);
          } else if (req.type === 'delete_chapter') {
            setFlash(`Глава «${req.target_name || '—'}» удалена.`);
          } else if (req.type === 'new_chapter') {
            const n = req.payload?.suggested_number;
            const name =
              typeof req.payload?.name === 'string' ? req.payload.name : null;
            setFlash(
              `Черновик главы создан${n != null ? ` (№ ${n}` : ''}${
                name ? `${n != null ? ', ' : ' ('}${name}` : ''
              }${n != null || name ? ')' : ''}. ` +
                `Номер мог сдвинуться, если был занят — см. список глав тайтла.`
            );
          } else if (req.type === 'ad_request') {
            setFlash(
              'Заявка на рекламу одобрена. Создайте баннер в разделе «Реклама».'
            );
          } else {
            setFlash('Заявка одобрена.');
          }
        } else {
          setFlash('Заявка отклонена.');
        }
      } catch (e: unknown) {
        const msg =
          e instanceof Error
            ? e.message
            : 'Ошибка при обработке заявки (возможно, объект уже удалён)';
        if (inDialog) setConfirmError(msg);
        else setError(msg);
        throw e;
      } finally {
        setResolving(null);
      }
    },
    []
  );

  /** Клик: для delete_* — ConfirmDialog; иначе сразу resolve. */
  const onApproveClick = (req: AdminRequest) => {
    if (isDestructive(req.type)) {
      setConfirmError(null);
      setConfirm({ req, decision: 'approved' });
      return;
    }
    void applyResolve(req, 'approved', false);
  };

  const onRejectClick = (req: AdminRequest) => {
    setConfirmError(null);
    setConfirm({ req, decision: 'rejected' });
  };

  const confirmTitle =
    confirm?.decision === 'rejected'
      ? 'Отклонить заявку?'
      : confirm?.req.type === 'delete_title'
        ? `Удалить тайтл «${confirm.req.target_name || '—'}»?`
        : confirm?.req.type === 'delete_chapter'
          ? `Удалить главу «${confirm.req.target_name || '—'}»?`
          : 'Подтвердить действие?';

  const confirmBody =
    confirm?.decision === 'rejected' ? (
      <>
        Заявка «{TYPE_LABELS[confirm.req.type] ?? confirm.req.type}»
        {confirm.req.target_name ? ` · ${confirm.req.target_name}` : ''} будет
        отклонена. Действие необратимо.
        {confirmError && (
          <span className="mt-2 block text-red-400">{confirmError}</span>
        )}
      </>
    ) : confirm?.req.type === 'delete_title' ? (
      <>
        Тайтл «{confirm.req.target_name || '—'}» и все главы, страницы, озвучка и
        файлы будут удалены безвозвратно.
        {confirmError && (
          <span className="mt-2 block text-red-400">{confirmError}</span>
        )}
      </>
    ) : (
      <>
        Глава «{confirm?.req.target_name || '—'}» и её страницы будут удалены
        безвозвратно.
        {confirmError && (
          <span className="mt-2 block text-red-400">{confirmError}</span>
        )}
      </>
    );

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">
          {canResolve ? 'Входящие заявки' : 'Мои заявки'}
        </h1>
        {!loading && (
          <span className="text-sm text-neutral-500">
            {requests.length} pending
            {!canResolve ? ' (ваши)' : ''}
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-red-800/60 bg-red-950/30 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {flash && (
        <div className="rounded-xl border border-green-800/50 bg-green-950/25 p-3 text-sm text-green-300">
          {flash}
        </div>
      )}

      {loading && <p className="text-sm text-neutral-500">Загрузка…</p>}

      {!loading && requests.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-900 p-12 text-center">
          <Inbox className="h-10 w-10 text-neutral-700" />
          <p className="text-sm text-neutral-500">Нет новых заявок</p>
        </div>
      )}

      <div className="space-y-3">
        {requests.map((req) => (
          <div
            key={req.id}
            className="rounded-xl border border-neutral-800 bg-neutral-900 p-4 space-y-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 flex-wrap">
                <TypeIcon type={req.type} />
                <span className="text-sm font-semibold text-white">
                  {TYPE_LABELS[req.type] ?? req.type}
                </span>
                {req.target_name && (
                  <Badge variant="secondary" className="text-xs">
                    {req.target_name}
                  </Badge>
                )}
              </div>
              <span className="shrink-0 text-xs text-neutral-500">
                {formatDate(req.created_at)}
              </span>
            </div>

            {req.note && (
              <p className="border-l-2 border-neutral-700 pl-3 text-sm text-neutral-400">
                {req.note}
              </p>
            )}

            {req.type === 'new_chapter' &&
              (req.payload?.suggested_number != null ||
                typeof req.payload?.name === 'string') && (
                <p className="text-xs text-neutral-400">
                  {req.payload?.suggested_number != null && (
                    <span>
                      Предложенный №{' '}
                      <span className="text-neutral-200">
                        {String(req.payload.suggested_number)}
                      </span>
                    </span>
                  )}
                  {typeof req.payload?.name === 'string' && req.payload.name && (
                    <span>
                      {req.payload?.suggested_number != null ? ' · ' : ''}«
                      {req.payload.name}»
                    </span>
                  )}
                </p>
              )}
            {req.type === 'ad_request' && req.payload && (
              <p className="text-xs text-neutral-400 space-x-1">
                {typeof req.payload.title === 'string' && req.payload.title && (
                  <span className="text-neutral-200">{req.payload.title}</span>
                )}
                {typeof req.payload.link_url === 'string' &&
                  req.payload.link_url && (
                    <span className="text-neutral-500 break-all">
                      · {req.payload.link_url}
                    </span>
                  )}
              </p>
            )}
            {typeof req.payload?.created_chapter_id === 'string' && (
              <p className="text-[11px] text-green-500/90">
                Создана глава id={req.payload.created_chapter_id}
                {req.payload.created_number != null
                  ? ` · № ${String(req.payload.created_number)}`
                  : ''}
              </p>
            )}

            {canResolve ? (
              <div className="space-y-2 pt-1">
                {(req.type === 'delete_title' ||
                  req.type === 'delete_chapter' ||
                  req.type === 'new_chapter') && (
                  <p className="text-[11px] text-neutral-500 leading-relaxed">
                    «
                    {isDestructive(req.type)
                      ? req.type === 'delete_title'
                        ? 'Удалить тайтл'
                        : 'Удалить главу'
                      : 'Одобрить'}
                    » сразу применит действие
                    {req.type === 'delete_title'
                      ? ' (каскад: главы/страницы/файлы)'
                      : req.type === 'delete_chapter'
                        ? ' (удалит главу и страницы)'
                        : ' (создаст черновик главы)'}
                    .
                  </p>
                )}
                {req.type === 'ad_request' && (
                  <p className="text-[11px] text-neutral-500 leading-relaxed">
                    Рекламную заявку одобрите здесь, затем создайте баннер в
                    разделе «Реклама».
                  </p>
                )}
                <div className="flex gap-2 flex-wrap">
                  {/* Для delete_* destructive-кнопка справа/яркая; reject — outline. */}
                  {!isDestructive(req.type) && (
                    <Button
                      size="sm"
                      onClick={() => onApproveClick(req)}
                      disabled={resolving === req.id}
                      className="gap-1.5 bg-green-700 text-white hover:bg-green-600"
                    >
                      <CheckCircle className="h-4 w-4" />
                      Одобрить
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onRejectClick(req)}
                    disabled={resolving === req.id}
                    className="gap-1.5 border-neutral-700"
                  >
                    <XCircle className="h-4 w-4" />
                    Отклонить
                  </Button>
                  {isDestructive(req.type) && (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => onApproveClick(req)}
                      disabled={resolving === req.id}
                      className="gap-1.5"
                    >
                      <Trash2 className="h-4 w-4" />
                      {req.type === 'delete_title'
                        ? 'Удалить тайтл'
                        : 'Удалить главу'}
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-xs text-neutral-500 pt-1">
                Ожидает решения владельца. Статус заявки обновится после
                рассмотрения.
              </p>
            )}
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open) {
            setConfirm(null);
            setConfirmError(null);
          }
        }}
        title={confirmTitle}
        description={confirmBody}
        confirmLabel={
          confirm?.decision === 'rejected'
            ? 'Отклонить'
            : confirm?.req.type === 'delete_title'
              ? 'Удалить тайтл'
              : 'Удалить главу'
        }
        destructive
        onConfirm={async () => {
          if (!confirm) return;
          await applyResolve(confirm.req, confirm.decision, true);
        }}
      />
    </main>
  );
}

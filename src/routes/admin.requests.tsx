import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect, useCallback } from 'react';
import { adminRequests } from '@/data/adminRequests';
import { auth } from '@/data/auth';
import type { AdminRequest } from '@/data/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { CoverImage } from '@/components/manga/CoverImage';
import {
  CheckCircle,
  XCircle,
  Trash2,
  Plus,
  Megaphone,
  Inbox,
  BookPlus,
  ShieldAlert,
  Ban,
  Loader2,
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
  new_title: 'Новый тайтл',
};

/** Фильтры типа: только реально приходящие в инбокс типы. */
const TYPE_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'Все типы' },
  { value: 'new_title', label: 'Новые тайтлы' },
  { value: 'new_chapter', label: 'Главы' },
  { value: 'delete_title', label: 'Удаление тайтлов' },
  { value: 'delete_chapter', label: 'Удаление глав' },
  { value: 'ad_request', label: 'Реклама' },
];

function TypeIcon({ type }: { type: string }) {
  if (type === 'delete_title' || type === 'delete_chapter') {
    return <Trash2 className="h-4 w-4 text-red-400" />;
  }
  if (type === 'new_chapter') {
    return <Plus className="h-4 w-4 text-green-400" />;
  }
  if (type === 'new_title') {
    return <BookPlus className="h-4 w-4 text-emerald-400" />;
  }
  return <Megaphone className="h-4 w-4 text-blue-400" />;
}

function isDestructive(type: string) {
  return type === 'delete_title' || type === 'delete_chapter';
}

/** Заголовок заявки для flash/диалогов. */
function requestTitle(req: AdminRequest): string {
  if (req.type === 'new_title') {
    const t = req.payload?.original_title;
    return typeof t === 'string' && t ? t : req.target_name || '—';
  }
  return req.target_name || '—';
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
  /** ConfirmDialog target for destructive approve / any reject without reason (spam). */
  const [confirm, setConfirm] = useState<{
    req: AdminRequest;
    decision: 'approved' | 'rejected' | 'spam';
  } | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  /** Отклонение с причиной (rejected) — отдельный диалог с textarea. */
  const [rejectTarget, setRejectTarget] = useState<AdminRequest | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [bulkTarget, setBulkTarget] = useState<AdminRequest | null>(null);
  /** Фильтры инбокса (owner): статус и тип. */
  const [statusFilter, setStatusFilter] = useState<'pending' | 'resolved'>('pending');
  const [typeFilter, setTypeFilter] = useState('all');

  const loadRequests = useCallback(
    async (opts: { isOwner: boolean; status: 'pending' | 'resolved'; type: string }) => {
      setLoading(true);
      setError(null);
      try {
        if (!opts.isOwner) {
          setRequests(await adminRequests.listMine({ status: 'pending' }));
          return;
        }
        const list = await adminRequests.listForOwner({
          status: opts.status === 'pending' ? 'pending' : undefined,
          type: opts.type === 'all' ? undefined : opts.type,
          limit: 200,
        });
        // resolved-вид: approved/rejected/spam вперемешку, новые сверху.
        setRequests(
          opts.status === 'resolved'
            ? list.filter((r) => r.status !== 'pending')
            : list
        );
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Ошибка загрузки');
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const [sessionInfo, setSessionInfo] = useState<{ isOwner: boolean } | null>(null);

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
      setSessionInfo({ isOwner });
      await loadRequests({ isOwner, status: 'pending', type: 'all' });
    });
  }, [navigate, loadRequests]);

  const applyResolve = useCallback(
    async (
      req: AdminRequest,
      decision: 'approved' | 'rejected' | 'spam',
      opts?: { reason?: string; inDialog?: boolean }
    ) => {
      const inDialog = opts?.inDialog ?? false;
      setResolving(req.id);
      setError(null);
      setFlash(null);
      setConfirmError(null);
      try {
        const result = await adminRequests.resolve(req.id, decision, opts?.reason);
        setRequests((prev) => prev.filter((r) => r.id !== req.id));
        setConfirm(null);
        setRejectTarget(null);

        // Уведомление заявителю, если оставил email (fire-and-forget).
        void adminRequests.notifySubmitter({
          email: req.submitter_email,
          status: decision,
          title: requestTitle(req),
          reason: opts?.reason,
        });

        if (decision === 'approved') {
          if (req.type === 'delete_title') {
            setFlash(`Тайтл «${requestTitle(req)}» удалён.`);
          } else if (req.type === 'delete_chapter') {
            setFlash(`Глава «${requestTitle(req)}» удалена.`);
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
          } else if (req.type === 'new_title') {
            if (result?.conflict) {
              const slug = typeof req.payload?.original_title === 'string'
                ? req.payload.original_title
                : '—';
              setFlash(
                `⚠ Заявка одобрена, но черновик НЕ создан: тайтл «${slug}» уже есть в каталоге ` +
                  `(slug занят). Проверьте каталог и при необходимости дополните существующий тайтл.`
              );
            } else {
              setFlash(
                'Черновик тайтла создан (не опубликован). Заполните жанры/главы и опубликуйте из «Тайтлы».'
              );
            }
          } else if (req.type === 'ad_request') {
            setFlash(
              'Заявка на рекламу одобрена. Создайте баннер в разделе «Реклама».'
            );
          } else {
            setFlash('Заявка одобрена.');
          }
        } else {
          setFlash(
            decision === 'spam'
              ? 'Заявка помечена как спам.'
              : 'Заявка отклонена.'
          );
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
    void applyResolve(req, 'approved', { inDialog: false });
  };

  /** Отклонение: причина обязательна → диалог с textarea. */
  const onRejectClick = (req: AdminRequest) => {
    setRejectReason('');
    setRejectTarget(req);
  };

  /** Спам: причина не обязательна → ConfirmDialog. */
  const onSpamClick = (req: AdminRequest) => {
    setConfirmError(null);
    setConfirm({ req, decision: 'spam' });
  };

  const changeFilter = (patch: { status?: 'pending' | 'resolved'; type?: string }) => {
    const next = {
      status: patch.status ?? statusFilter,
      type: patch.type ?? typeFilter,
    };
    setStatusFilter(next.status);
    setTypeFilter(next.type);
    if (sessionInfo) {
      void loadRequests({ isOwner: sessionInfo.isOwner, ...next });
    }
  };

  const confirmTitle =
    confirm?.decision === 'rejected'
      ? 'Отклонить заявку?'
      : confirm?.decision === 'spam'
        ? 'Пометить как спам?'
        : confirm?.req.type === 'delete_title'
          ? `Удалить тайтл «${requestTitle(confirm.req)}»?`
          : confirm?.req.type === 'delete_chapter'
            ? `Удалить главу «${requestTitle(confirm.req)}»?`
            : 'Подтвердить действие?';

  const confirmBody =
    confirm?.decision === 'spam' ? (
      <>
        Заявка «{TYPE_LABELS[confirm.req.type] ?? confirm.req.type}»
        {requestTitle(confirm.req) !== '—' ? ` · ${requestTitle(confirm.req)}` : ''} будет
        помечена как спам. Она попадёт в автоочистку через 90 дней. Действие
        необратимо.
        {confirmError && (
          <span className="mt-2 block text-red-400">{confirmError}</span>
        )}
      </>
    ) : confirm?.decision === 'rejected' ? (
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
        Тайтл «{requestTitle(confirm.req)}» и все главы, страницы, озвучка и
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

  const pendingCount = requests.filter((r) => r.status === 'pending').length;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">
          {canResolve ? 'Входящие заявки' : 'Мои заявки'}
        </h1>
        {!loading && (
          <span className="text-sm text-neutral-500">
            {canResolve && statusFilter === 'pending'
              ? `${pendingCount} pending`
              : `${requests.length} шт.`}
            {!canResolve ? ' (ваши)' : ''}
          </span>
        )}
      </div>

      {/* Фильтры (owner): статус × тип */}
      {canResolve && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-neutral-800 p-0.5">
            {(['pending', 'resolved'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => changeFilter({ status: s })}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  statusFilter === s
                    ? 'bg-neutral-800 text-white'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                {s === 'pending' ? 'В очереди' : 'Решённые'}
              </button>
            ))}
          </div>
          <select
            value={typeFilter}
            onChange={(e) => changeFilter({ type: e.target.value })}
            className="h-8 rounded-lg border border-neutral-800 bg-neutral-900 px-2 text-xs text-neutral-300"
          >
            {TYPE_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      )}

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
          <p className="text-sm text-neutral-500">
            {statusFilter === 'pending' ? 'Нет новых заявок' : 'Решённых заявок нет'}
          </p>
        </div>
      )}

      <div className="space-y-3">
        {requests.map((req) => (
          <RequestCard
            key={req.id}
            req={req}
            canResolve={canResolve}
            resolving={resolving === req.id}
            onApprove={() => onApproveClick(req)}
            onReject={() => onRejectClick(req)}
            onSpam={() => onSpamClick(req)}
            onBulkIp={() => {
              setBulkTarget(req);
            }}
          />
        ))}
      </div>

      {/* Отклонение с причиной */}
      {rejectTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget && resolving !== rejectTarget.id) {
              setRejectTarget(null);
            }
          }}
        >
          <div className="w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-900 p-5 space-y-4">
            <h2 className="text-base font-semibold text-white">
              Отклонить «{requestTitle(rejectTarget)}»?
            </h2>
            <div>
              <Label htmlFor="reject-reason">
                Причина <span className="text-neutral-500">(увидит заявитель{rejectTarget.submitter_email ? ', уйдёт на его email' : ' на странице статуса'})</span>
              </Label>
              <Textarea
                id="reject-reason"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                rows={3}
                maxLength={1000}
                placeholder="Например: такое произведение уже есть в каталоге"
                className="mt-1.5"
              />
              {!rejectReason.trim() && (
                <p className="mt-1 text-[11px] text-red-400">
                  Опишите причину — без неё заявитель не поймёт, что исправить.
                </p>
              )}
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRejectTarget(null)}
                disabled={resolving === rejectTarget.id}
                className="border-neutral-700"
              >
                Отмена
              </Button>
              <Button
                size="sm"
                disabled={!rejectReason.trim() || resolving === rejectTarget.id}
                onClick={() => {
                  if (!rejectTarget) return;
                  void applyResolve(rejectTarget, 'rejected', {
                    reason: rejectReason.trim(),
                    inDialog: true,
                  });
                }}
                className="gap-1.5 bg-red-700 text-white hover:bg-red-600"
              >
                {resolving === rejectTarget.id && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                Отклонить
              </Button>
            </div>
          </div>
        </div>
      )}

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
          confirm?.decision === 'spam'
            ? 'Спам'
            : confirm?.decision === 'rejected'
              ? 'Отклонить'
              : confirm?.req.type === 'delete_title'
                ? 'Удалить тайтл'
                : 'Удалить главу'
        }
        destructive={confirm?.decision !== 'approved'}
        onConfirm={async () => {
          if (!confirm) return;
          await applyResolve(confirm.req, confirm.decision, { inDialog: true });
        }}
      />

      {/* Bulk reject: все pending с этого IP */}
      <ConfirmDialog
        open={!!bulkTarget}
        onOpenChange={(open) => {
          if (!open) setBulkTarget(null);
        }}
        title="Отклонить все заявки с этого IP?"
        description={
          bulkTarget ? (
            <>
              Все pending-заявки с хэша{' '}
              <code className="break-all rounded bg-neutral-800 px-1 text-[11px]">
                {bulkTarget.ip_hash?.slice(0, 16) || '—'}…
              </code>{' '}
              будут отклонены с причиной «bulk: спам с одного IP». Заявители с
              оставленным email получат уведомление.
            </>
          ) : (
            ''
          )
        }
        confirmLabel="Отклонить все"
        destructive
        onConfirm={async () => {
          if (!bulkTarget?.ip_hash) return;
          const count = await adminRequests.rejectByIp(bulkTarget.ip_hash);
          setBulkTarget(null);
          setFlash(`Отклонено заявок: ${count}.`);
          if (sessionInfo) {
            await loadRequests({ isOwner: sessionInfo.isOwner, status: statusFilter, type: typeFilter });
          }
        }}
      />
    </main>
  );
}

/** Карточка заявки; для new_title — превью обложки, жанры, метаданные аудита. */
function RequestCard({
  req,
  canResolve,
  resolving,
  onApprove,
  onReject,
  onSpam,
  onBulkIp,
}: {
  req: AdminRequest;
  canResolve: boolean;
  resolving: boolean;
  onApprove: () => void;
  onReject: () => void;
  onSpam: () => void;
  onBulkIp: () => void;
}) {
  const isNewTitle = req.type === 'new_title';
  const payload = req.payload as Record<string, unknown>;

  return (
    <div
      className="rounded-xl border border-neutral-800 bg-neutral-900 p-4 space-y-3"
      data-request-type={req.type}
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
          {req.status !== 'pending' && (
            <Badge
              variant="secondary"
              className={`text-xs ${
                req.status === 'approved'
                  ? 'text-green-400'
                  : req.status === 'spam'
                    ? 'text-red-400'
                    : 'text-neutral-400'
              }`}
            >
              {req.status === 'approved'
                ? 'одобрена'
                : req.status === 'spam'
                  ? 'спам'
                  : 'отклонена'}
            </Badge>
          )}
          {req.conflict && (
            <Badge variant="secondary" className="text-xs text-amber-400">
              slug занят
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

      {isNewTitle && (
        <NewTitleDetails req={req} payload={payload} />
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
      {isNewTitle && typeof payload?.created_slug === 'string' && (
        <p className="text-[11px] text-green-500/90">
          Создан черновик: /title/{payload.created_slug} (published=false)
        </p>
      )}

      {canResolve && req.status === 'pending' && (
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
          {isNewTitle && (
            <p className="text-[11px] text-neutral-500 leading-relaxed">
              «Одобрить» создаст черновик тайтла (published=false). Если slug
              «{typeof payload?.original_title === 'string' ? payload.original_title : '—'}»
              занят — черновик не создастся, заявка пометится предупреждением.
            </p>
          )}
          <div className="flex gap-2 flex-wrap">
            {/* Для delete_* destructive-кнопка справа/яркая; reject — outline. */}
            {!isDestructive(req.type) && (
              <Button
                size="sm"
                onClick={onApprove}
                disabled={resolving}
                className="gap-1.5 bg-green-700 text-white hover:bg-green-600"
              >
                <CheckCircle className="h-4 w-4" />
                Одобрить
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={onReject}
              disabled={resolving}
              className="gap-1.5 border-neutral-700"
            >
              <XCircle className="h-4 w-4" />
              Отклонить
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onSpam}
              disabled={resolving}
              className="gap-1.5 border-amber-800/60 text-amber-400 hover:bg-amber-950/30"
            >
              <ShieldAlert className="h-4 w-4" />
              Спам
            </Button>
            {isDestructive(req.type) && (
              <Button
                size="sm"
                variant="destructive"
                onClick={onApprove}
                disabled={resolving}
                className="gap-1.5"
              >
                <Trash2 className="h-4 w-4" />
                {req.type === 'delete_title'
                  ? 'Удалить тайтл'
                  : 'Удалить главу'}
              </Button>
            )}
            {isNewTitle && req.ip_hash && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onBulkIp}
                disabled={resolving}
                className="gap-1.5 text-neutral-500 hover:text-red-400"
                title="Отклонить все pending-заявки с этого IP"
              >
                <Ban className="h-3.5 w-3.5" />
                Спам-волна
              </Button>
            )}
          </div>
        </div>
      )}
      {canResolve && req.status !== 'pending' && (
        <p className="text-xs text-neutral-500 pt-1">
          Решено {req.resolved_at ? formatDate(req.resolved_at) : ''}
          {req.reject_reason ? ` · причина: ${req.reject_reason}` : ''}.
        </p>
      )}
      {!canResolve && req.status === 'pending' && (
        <p className="text-xs text-neutral-500 pt-1">
          Ожидает решения владельца. Статус заявки обновится после
          рассмотрения.
        </p>
      )}
    </div>
  );
}

/** Превью анонимной заявки на тайтл: обложка, названия, жанры, аудит-метаданные. */
function NewTitleDetails({
  req,
  payload,
}: {
  req: AdminRequest;
  payload: Record<string, unknown>;
}) {
  const coverUrl = typeof payload.cover_url === 'string' ? payload.cover_url : null;
  const genres = Array.isArray(payload.genres) ? (payload.genres as unknown[]) : [];
  const TYPE_RU: Record<string, string> = {
    manga: 'Манга',
    manhwa: 'Манхва',
    manhua: 'Маньхуа',
    oel: 'OEL',
  };

  return (
    <div className="flex gap-3">
      {coverUrl && (
        <div className="aspect-[3/4] w-20 shrink-0 overflow-hidden rounded-lg border border-neutral-800">
          {/* Обложка заявки: Supabase-бакет (прод) или data:/blob: (демо).
              CoverImage просто рендерит src, при ошибке — плейсхолдер. */}
          <CoverImage src={coverUrl} title={String(payload.original_title ?? 'заявка')} />
        </div>
      )}
      <div className="min-w-0 space-y-1.5 text-xs">
        <p className="text-sm font-semibold text-white">
          {typeof payload.original_title === 'string' ? payload.original_title : '—'}
        </p>
        {(typeof payload.title_ru === 'string' && payload.title_ru) ||
        (typeof payload.title_en === 'string' && payload.title_en) ? (
          <p className="text-neutral-400">
            {typeof payload.title_ru === 'string' && payload.title_ru
              ? payload.title_ru
              : ''}
            {typeof payload.title_ru === 'string' &&
            payload.title_ru &&
            typeof payload.title_en === 'string' &&
            payload.title_en
              ? ' · '
              : ''}
            {typeof payload.title_en === 'string' && payload.title_en
              ? payload.title_en
              : ''}
          </p>
        ) : null}
        <p className="text-neutral-400">
          <span className="text-neutral-500">Тип:</span>{' '}
          {TYPE_RU[String(payload.type)] ?? String(payload.type ?? '—')}
          {typeof payload.author === 'string' && payload.author && (
            <>
              {' '}
              <span className="text-neutral-500">· Автор:</span> {payload.author}
            </>
          )}
          {payload.year != null && (
            <>
              {' '}
              <span className="text-neutral-500">· Год:</span> {String(payload.year)}
            </>
          )}
          {typeof payload.country === 'string' && payload.country && (
            <>
              {' '}
              <span className="text-neutral-500">·</span> {payload.country}
            </>
          )}
          {typeof payload.status === 'string' && payload.status && (
            <>
              {' '}
              <span className="text-neutral-500">·</span> {payload.status}
            </>
          )}
        </p>
        {genres.length > 0 && (
          <p className="flex flex-wrap gap-1">
            {genres.slice(0, 12).map((g, i) => (
              <Badge key={i} variant="secondary" className="text-[10px]">
                {String(g)}
              </Badge>
            ))}
          </p>
        )}
        {typeof payload.description === 'string' && payload.description && (
          <p className="line-clamp-3 whitespace-pre-line text-neutral-400">
            {payload.description}
          </p>
        )}
        {/* Аудит-метаданные: помогают видеть спам, без сырого IP. */}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-[11px] text-neutral-500">
          {req.turnstile_ok ? (
            <span className="text-green-500/80">✓ капча пройдена</span>
          ) : (
            <span className="text-amber-500/80">капча: нет отметки</span>
          )}
          {req.ip_hash && (
            <span className="font-mono" title={req.user_agent ?? undefined}>
              ip: {req.ip_hash.slice(0, 12)}…
            </span>
          )}
          {req.submitter_email && <span>email: {req.submitter_email}</span>}
        </p>
        {req.user_agent && (
          <p className="break-all text-[10px] text-neutral-600">{req.user_agent}</p>
        )}
      </div>
    </div>
  );
}

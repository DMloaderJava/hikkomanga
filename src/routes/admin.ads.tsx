import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { adsApi, type AdInput } from '@/data/ads';
import { auth } from '@/data/auth';
import type { Ad } from '@/data/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Megaphone,
  Plus,
  Trash2,
  Pencil,
  Loader2,
  AlertCircle,
  ExternalLink,
  X,
} from 'lucide-react';
import { formatDate } from '@/lib/format';
import { toDatetimeLocalValue, fromDatetimeLocalValue } from '@/lib/datetimeLocal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

export const Route = createFileRoute('/admin/ads')({
  component: AdminAdsPage,
});

const emptyForm: AdInput = {
  title: '',
  description: '',
  image_url: '',
  link_url: '',
  link_label: 'Перейти',
  placement: 'between_chapters',
  active: true,
  advertiser_name: '',
  expires_at: '',
};

function AdminAdsPage() {
  const navigate = useNavigate();
  const [ads, setAds] = useState<Ad[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<AdInput>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Ad | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const reload = async () => {
    setAds(await adsApi.listAll());
  };

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
      if (!isOwner) {
        navigate({ to: '/admin' });
        return;
      }
      try {
        await reload();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Ошибка загрузки');
      } finally {
        setLoading(false);
      }
    });
  }, [navigate]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
    setError(null);
  };

  const openEdit = (ad: Ad) => {
    setEditingId(ad.id);
    setForm({
      title: ad.title,
      description: ad.description || '',
      image_url: ad.image_url || '',
      link_url: ad.link_url,
      link_label: ad.link_label || 'Перейти',
      placement: ad.placement || 'between_chapters',
      active: ad.active !== false,
      advertiser_name: ad.advertiser_name || '',
      // datetime-local = local TZ; не slice ISO (UTC), иначе сдвиг на offset.
      expires_at: toDatetimeLocalValue(ad.expires_at),
    });
    setShowForm(true);
    setError(null);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || !form.link_url.trim()) {
      setError('Название и ссылка обязательны');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload: AdInput = {
        ...form,
        expires_at: fromDatetimeLocalValue(form.expires_at),
      };
      if (editingId) {
        await adsApi.update(editingId, payload);
      } else {
        await adsApi.create(payload);
      }
      setShowForm(false);
      setEditingId(null);
      setForm(emptyForm);
      await reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeletingId(deleteTarget.id);
    setError(null);
    setDeleteError(null);
    try {
      await adsApi.remove(deleteTarget.id);
      setDeleteTarget(null);
      await reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Ошибка удаления';
      setError(msg);
      setDeleteError(msg);
      throw err;
    } finally {
      setDeletingId(null);
    }
  };

  const toggleActive = async (ad: Ad) => {
    setError(null);
    try {
      await adsApi.update(ad.id, { active: ad.active === false });
      await reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    }
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Megaphone className="h-5 w-5 text-rose-400" />
            Рекламные баннеры
          </h1>
          <p className="text-xs text-neutral-500 mt-1">
            Показываются между главами (каждые 5 прочитанных). Только owner.
          </p>
        </div>
        <Button onClick={openCreate} className="gap-2 shrink-0">
          <Plus className="h-4 w-4" />
          Добавить
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-800/60 bg-red-950/30 p-3 text-sm text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {showForm && (
        <form
          onSubmit={handleSave}
          className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 space-y-4"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">
              {editingId ? 'Редактировать баннер' : 'Новый баннер'}
            </h2>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="text-neutral-500 hover:text-white"
              aria-label="Закрыть"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2 space-y-1.5">
              <Label htmlFor="ad-title">Название *</Label>
              <Input
                id="ad-title"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                required
                maxLength={120}
              />
            </div>
            <div className="sm:col-span-2 space-y-1.5">
              <Label htmlFor="ad-desc">Описание</Label>
              <Textarea
                id="ad-desc"
                value={form.description || ''}
                onChange={(e) =>
                  setForm((f) => ({ ...f, description: e.target.value }))
                }
                rows={2}
                maxLength={500}
                className="resize-none"
              />
            </div>
            <div className="sm:col-span-2 space-y-1.5">
              <Label htmlFor="ad-link">Ссылка *</Label>
              <Input
                id="ad-link"
                type="url"
                value={form.link_url}
                onChange={(e) =>
                  setForm((f) => ({ ...f, link_url: e.target.value }))
                }
                placeholder="https://…"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ad-label">Текст кнопки</Label>
              <Input
                id="ad-label"
                value={form.link_label || ''}
                onChange={(e) =>
                  setForm((f) => ({ ...f, link_label: e.target.value }))
                }
                placeholder="Перейти"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ad-adv">Рекламодатель</Label>
              <Input
                id="ad-adv"
                value={form.advertiser_name || ''}
                onChange={(e) =>
                  setForm((f) => ({ ...f, advertiser_name: e.target.value }))
                }
              />
            </div>
            <div className="sm:col-span-2 space-y-1.5">
              <Label htmlFor="ad-img">URL изображения</Label>
              {/* type=text: type=url блокирует data: / relative, которые CSP разрешает */}
              <Input
                id="ad-img"
                type="text"
                inputMode="url"
                value={form.image_url || ''}
                onChange={(e) =>
                  setForm((f) => ({ ...f, image_url: e.target.value }))
                }
                placeholder="https://….supabase.co/…/banner.png или data:image/…"
              />
              <p className="text-[11px] text-neutral-500 leading-relaxed">
                CSP в проде:{' '}
                <code className="text-neutral-400">*.supabase.co</code> /{' '}
                <code className="text-neutral-400">data:</code> /{' '}
                <code className="text-neutral-400">blob:</code>. Загрузите в
                Supabase Storage (public) или вставьте data-URL. Внешний CDN не
                отрендерится.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ad-exp">Истекает</Label>
              <Input
                id="ad-exp"
                type="datetime-local"
                value={form.expires_at || ''}
                onChange={(e) =>
                  setForm((f) => ({ ...f, expires_at: e.target.value }))
                }
              />
            </div>
            <div className="flex items-center gap-3 pt-6">
              <Switch
                checked={form.active !== false}
                onCheckedChange={(v) => setForm((f) => ({ ...f, active: v }))}
              />
              <span className="text-sm text-neutral-300">
                {form.active !== false ? 'Активен' : 'Выключен'}
              </span>
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <Button type="submit" disabled={saving} className="gap-2">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {editingId ? 'Сохранить' : 'Создать'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowForm(false)}
              className="border-neutral-700"
            >
              Отмена
            </Button>
          </div>
        </form>
      )}

      {loading && <p className="text-sm text-neutral-500">Загрузка…</p>}

      {!loading && ads.length === 0 && !showForm && (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-12 text-center space-y-2">
          <Megaphone className="mx-auto h-10 w-10 text-neutral-700" />
          <p className="text-sm text-neutral-500">Баннеров пока нет</p>
          <Button onClick={openCreate} variant="outline" size="sm" className="mt-2">
            Создать первый
          </Button>
        </div>
      )}

      <div className="space-y-3">
        {ads.map((ad) => {
          const expired =
            ad.expires_at && new Date(ad.expires_at).getTime() < Date.now();
          const on = ad.active !== false && !expired;
          return (
            <div
              key={ad.id}
              className="rounded-xl border border-neutral-800 bg-neutral-900 p-4 space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-white truncate">
                      {ad.title}
                    </span>
                    <Badge
                      variant={on ? 'success' : 'secondary'}
                      className="text-[10px]"
                    >
                      {expired ? 'Истёк' : ad.active === false ? 'Выкл' : 'Активен'}
                    </Badge>
                  </div>
                  {ad.description && (
                    <p className="text-xs text-neutral-400 line-clamp-2">
                      {ad.description}
                    </p>
                  )}
                  <div className="flex items-center gap-2 text-xs text-neutral-500">
                    <a
                      href={ad.link_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-rose-400 hover:underline truncate max-w-[240px]"
                    >
                      <ExternalLink className="h-3 w-3 shrink-0" />
                      {ad.link_label || ad.link_url}
                    </a>
                    {ad.created_at && <span>· {formatDate(ad.created_at)}</span>}
                  </div>
                </div>
                {ad.image_url && (
                  <img
                    src={ad.image_url}
                    alt=""
                    className="h-14 w-20 rounded object-cover border border-neutral-800 shrink-0"
                    referrerPolicy="no-referrer"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = 'none';
                    }}
                  />
                )}
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-2 mr-auto">
                  <Switch
                    checked={ad.active !== false}
                    onCheckedChange={() => toggleActive(ad)}
                    disabled={Boolean(expired)}
                  />
                  <span className="text-xs text-neutral-500">Вкл</span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => openEdit(ad)}
                  className="gap-1.5 border-neutral-700 h-8"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Изменить
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDeleteError(null);
                    setDeleteTarget(ad);
                  }}
                  disabled={deletingId === ad.id}
                  className="gap-1.5 h-8 text-neutral-400 hover:text-red-400"
                >
                  {deletingId === ad.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
        title="Удалить баннер?"
        description={
          <>
            «{deleteTarget?.title}» будет удалён безвозвратно.
            {deleteError && (
              <span className="mt-2 block text-red-400">{deleteError}</span>
            )}
          </>
        }
        confirmLabel="Удалить"
        onConfirm={handleDeleteConfirm}
      />
    </main>
  );
}

import { useState, useEffect } from 'react';
import type { Title, Genre, TitleInput } from '@/data/types';
import { slugify } from '@/lib/slugify';
import { isMediaUrlCspAllowed, normalizeCoverUrl } from '@/lib/storageUrl';
import { CoverImage } from '@/components/manga/CoverImage';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Plus, Lock, Image as ImageIcon, RotateCcw, Trash2, RefreshCw } from 'lucide-react';

/**
 * Причина отклонения обложки — конкретная, под тип провала. Единое общее
 * сообщение не давало понять, что именно не так со значением: админ видел
 * «нельзя опубликовать тайтл» и не знал, какое поле поправить.
 */
function coverRejectionReason(raw: string, normalized: string | null): string {
  const hint =
    'Положите WebP-файл (≤800 px по ширине) в public/media/covers/ и укажите ' +
    'путь вида /media/covers/{slug}.webp — кнопка под полем подставит его ' +
    'по текущему slug.';
  if (/^http:\/\//i.test(raw)) {
    return (
      'Ссылка http:// не пройдёт: на https-странице браузер блокирует ' +
      'смешанный контент. ' + hint
    );
  }
  if (normalized && /^https?:\/\//i.test(normalized)) {
    return (
      'Внешние ссылки на обложку не поддерживаются: домен может умереть, а ' +
      'хотлинк-защита стороннего хостинга вернёт 403 — и весь каталог ' +
      'превратится в битые картинки. ' + hint
    );
  }
  return `Не похоже на путь к файлу репозитория («${raw}»). ` + hint;
}

interface TitleFormProps {
  initialData?: Title | null;
  allGenres: Genre[];
  onSubmit: (data: TitleInput) => Promise<void>;
  onAddGenre?: (name: string) => Promise<Genre>;
  isSubmitting?: boolean;
}

export function TitleForm({
  initialData,
  allGenres,
  onSubmit,
  onAddGenre,
  isSubmitting = false,
}: TitleFormProps) {
  const isEditing = !!initialData;
  const draftStorageKey = `hikkomanga_title_draft_${initialData?.id || 'new'}`;

  const [title, setTitle] = useState(initialData?.title || '');
  const [slug, setSlug] = useState(initialData?.slug || '');
  const [author, setAuthor] = useState(initialData?.author || '');
  const [description, setDescription] = useState(initialData?.description || '');
  const [coverUrl, setCoverUrl] = useState(initialData?.cover_url || '');
  const [status, setStatus] = useState<'ongoing' | 'completed'>(initialData?.status || 'ongoing');
  const [published, setPublished] = useState(initialData?.published ?? true);
  const [selectedGenreIds, setSelectedGenreIds] = useState<string[]>(
    initialData?.genres.map((g) => g.id) || []
  );

  const [newGenreName, setNewGenreName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [hasDraft, setHasDraft] = useState(false);
  // Живая проверка, что файл обложки реально существует (HEAD-запрос к
  // статике). Это НЕ блок — предупреждение: можно опубликовать и без файла,
  // но тогда CoverImage покажет плейсхолдер.
  const [coverCheck, setCoverCheck] = useState<'idle' | 'checking' | 'ok' | 'missing'>(
    'idle'
  );
  // Счётчик ручной повторной проверки (файл положили — жмём, не перебивая путь).
  const [coverCheckNonce, setCoverCheckNonce] = useState(0);

  // Check for saved draft on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(draftStorageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && (parsed.title || parsed.description || parsed.author)) {
          setHasDraft(true);
        }
      }
    } catch {
      // Ignore
    }
  }, [draftStorageKey]);

  // Auto-save draft on changes
  useEffect(() => {
    if (!title && !author && !description && !coverUrl && selectedGenreIds.length === 0) return;
    try {
      const draft = {
        title,
        slug,
        author,
        description,
        coverUrl,
        status,
        published,
        selectedGenreIds,
        updatedAt: new Date().toISOString(),
      };
      localStorage.setItem(draftStorageKey, JSON.stringify(draft));
    } catch {
      // Ignore
    }
  }, [title, slug, author, description, coverUrl, status, published, selectedGenreIds, draftStorageKey]);

  // Auto-generate slug when creating
  useEffect(() => {
    if (!isEditing && title && !slug) {
      setSlug(slugify(title));
    }
  }, [title, isEditing]);

  // Живая проверка наличия файла обложки. Проверяем только относительные
  // пути ('self') — внешние ссылки уже помечены ошибкой формы. Запрос с
  // дебаунсом, чтобы не ходить в сеть на каждый символ.
  useEffect(() => {
    const path = normalizeCoverUrl(coverUrl);
    if (!path || !path.startsWith('/') || !isMediaUrlCspAllowed(path)) {
      setCoverCheck('idle');
      return;
    }
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') {
      setCoverCheck('idle');
      return;
    }
    let cancelled = false;
    setCoverCheck('checking');
    // Дебаунс нужен при наборе текста; ручная повторная проверка идёт сразу.
    const delay = coverCheckNonce === 0 ? 350 : 0;
    const timer = setTimeout(() => {
      window
        .fetch(path, { method: 'HEAD' })
        .then((r) => {
          if (!cancelled) setCoverCheck(r.ok ? 'ok' : 'missing');
        })
        .catch(() => {
          if (!cancelled) setCoverCheck('missing');
        });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [coverUrl, coverCheckNonce]);

  const handleRestoreDraft = () => {
    try {
      const saved = localStorage.getItem(draftStorageKey);
      if (saved) {
        const draft = JSON.parse(saved);
        if (draft.title !== undefined) setTitle(draft.title);
        if (draft.slug !== undefined && !isEditing) setSlug(draft.slug);
        if (draft.author !== undefined) setAuthor(draft.author);
        if (draft.description !== undefined) setDescription(draft.description);
        if (draft.coverUrl !== undefined) setCoverUrl(draft.coverUrl);
        if (draft.status !== undefined) setStatus(draft.status);
        if (draft.published !== undefined) setPublished(draft.published);
        if (draft.selectedGenreIds !== undefined) setSelectedGenreIds(draft.selectedGenreIds);
      }
    } catch {
      // Ignore
    } finally {
      setHasDraft(false);
    }
  };

  const handleDiscardDraft = () => {
    localStorage.removeItem(draftStorageKey);
    setHasDraft(false);
  };

  // Стандартный путь обложки для текущего slug — одной кнопкой снимает
  // вопрос «какой путь писать».
  const standardCoverPath = slug.trim() ? `/media/covers/${slug.trim()}.webp` : null;

  const handleUseStandardCover = () => {
    if (!standardCoverPath) return;
    setCoverUrl(standardCoverPath);
    setError(null);
  };

  // После того как пользователь закончил вводить — тихо приводим значение
  // к канону: media/covers/x.webp → /media/covers/x.webp и т.п.
  const handleCoverBlur = () => {
    const normalized = normalizeCoverUrl(coverUrl);
    if (normalized && normalized !== coverUrl) {
      setCoverUrl(normalized);
    }
  };

  const handleGenreToggle = (id: string) => {
    setSelectedGenreIds((prev) =>
      prev.includes(id) ? prev.filter((gId) => gId !== id) : [...prev, id]
    );
  };

  const handleCreateGenreInline = async () => {
    if (!newGenreName.trim() || !onAddGenre) return;
    try {
      const created = await onAddGenre(newGenreName.trim());
      setSelectedGenreIds((prev) => [...prev, created.id]);
      setNewGenreName('');
    } catch {
      setError('Не удалось создать жанр');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!title.trim()) {
      setError('Название обязательное поле');
      return;
    }

    if (!slug.trim()) {
      setError('Slug обязательное поле');
      return;
    }

    // Обложка: приводим к канонической форме (/media/covers/{slug}.webp —
    // trim, './', 'public/', ведущий '/' — так что «media/covers/x.webp»
    // больше не блокирует публикацию) и отклоняем то, что политика проекта
    // не пропускает (внешние домены, http://) — иначе админ сохранит тайтл
    // и только потом обнаружит битую картинку.
    const normalizedCover = normalizeCoverUrl(coverUrl);
    if (normalizedCover && !isMediaUrlCspAllowed(normalizedCover)) {
      setError(coverRejectionReason(coverUrl.trim(), normalizedCover));
      return;
    }

    try {
      await onSubmit({
        title: title.trim(),
        slug: slug.trim(),
        author: author.trim() || null,
        description: description.trim() || null,
        cover_url: normalizedCover,
        status,
        published,
        genre_ids: selectedGenreIds,
      });
      localStorage.removeItem(draftStorageKey);
    } catch (err: any) {
      setError(err.message || 'Ошибка сохранения тайтла');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {hasDraft && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-800/80 bg-amber-950/40 p-4 text-xs text-amber-300">
          <span>Обнаружен несохранённый черновик данной формы.</span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRestoreDraft}
              className="h-7 text-xs gap-1 border-amber-700 bg-amber-900/50 text-amber-200 hover:bg-amber-800"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Восстановить
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleDiscardDraft}
              className="h-7 text-xs text-amber-400 hover:text-amber-200"
            >
              <Trash2 className="h-3.5 w-3.5" /> Сбросить
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/40 p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Left Column: Cover — путь к файлу в репозитории (public/media/covers/) */}
        <div className="space-y-4">
          <Label>Обложка тайтла</Label>
          <div className="relative aspect-[3/4] w-full rounded-xl border-2 border-dashed border-neutral-800 bg-neutral-900/50 flex flex-col items-center justify-center overflow-hidden">
            {coverUrl ? (
              <CoverImage
                src={normalizeCoverUrl(coverUrl)}
                title={title || 'Тайтл'}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex flex-col items-center gap-2 p-6 text-center">
                <ImageIcon className="h-10 w-10 text-neutral-600" />
                <span className="text-xs font-medium text-neutral-400">
                  Путь к обложке не указан — будет плейсхолдер
                </span>
              </div>
            )}
          </div>
          <Input
            type="text"
            placeholder="/media/covers/slug.webp"
            value={coverUrl}
            onChange={(e) => setCoverUrl(e.target.value)}
            onBlur={handleCoverBlur}
            className="text-xs"
          />
          {standardCoverPath && normalizeCoverUrl(coverUrl) !== standardCoverPath && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleUseStandardCover}
              className="h-7 gap-1 text-xs border-neutral-800"
            >
              <ImageIcon className="h-3.5 w-3.5" /> Подставить {standardCoverPath}
            </Button>
          )}
          {coverCheck !== 'idle' && (
            <div className="flex items-start gap-2">
              {coverCheck === 'checking' && (
                <p className="text-[11px] leading-snug text-neutral-500">
                  Проверка файла обложки…
                </p>
              )}
              {coverCheck === 'ok' && (
                <p className="text-[11px] leading-snug text-emerald-400">
                  Файл на месте — обложка отобразится на сайте.
                </p>
              )}
              {coverCheck === 'missing' && (
                <p className="text-[11px] leading-snug text-amber-400">
                  Файла не нашлось — обложка покажет плейсхолдер, пока вы не
                  положите WebP в <code>public/media/covers/</code> и не
                  запустите изменение (commit + деплой). Тайтл можно публиковать
                  и без файла.
                </p>
              )}
              <button
                type="button"
                title="Проверить наличие файла ещё раз"
                onClick={() => setCoverCheckNonce((n) => n + 1)}
                className="mt-0.5 shrink-0 text-neutral-500 hover:text-neutral-300"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <p className="text-[11px] leading-snug text-neutral-500">
            Обложки — файлы репозитория: положите WebP (≤800 px по ширине) в{' '}
            <code>public/media/covers/</code> и укажите путь вида{' '}
            <code>/media/covers/{'{slug}'}.webp</code>. Запись без ведущего{' '}
            <code>/</code> (например, <code>media/covers/slug.webp</code>) приводится
            к канону автоматически. Внешние ссылки не поддерживаются.
          </p>
        </div>

        {/* Right Column: Title Info */}
        <div className="md:col-span-2 space-y-4">
          <div>
            <Label htmlFor="title">Название *</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="например, Магическая битва"
              className="mt-1.5"
              required
            />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <Label htmlFor="slug">Slug (URL)</Label>
              {isEditing && (
                <span className="flex items-center gap-1 text-[11px] text-amber-500 font-medium">
                  <Lock className="h-3 w-3" /> Заблокирован после создания
                </span>
              )}
            </div>
            <Input
              id="slug"
              value={slug}
              onChange={(e) => !isEditing && setSlug(e.target.value)}
              disabled={isEditing}
              placeholder="magicheskaya-bitva"
              className="mt-1.5 font-mono text-xs disabled:opacity-60"
              required
            />
          </div>

          <div>
            <Label htmlFor="author">Автор</Label>
            <Input
              id="author"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="например, Гэгэ Акутами"
              className="mt-1.5"
            />
          </div>

          <div>
            <Label htmlFor="description">Описание</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Краткий сюжет манги..."
              rows={4}
              className="mt-1.5"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
            <div>
              <Label>Статус</Label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as any)}
                className="mt-1.5 flex h-10 w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 text-sm text-neutral-100 focus:outline-none focus:ring-2 focus:ring-rose-500"
              >
                <option value="ongoing">Онгоинг</option>
                <option value="completed">Завершён</option>
              </select>
            </div>

            <div className="flex flex-col justify-center">
              <Label className="mb-2">Опубликован</Label>
              <div className="flex items-center gap-3">
                <Switch checked={published} onCheckedChange={setPublished} />
                <span className="text-xs text-neutral-400">
                  {published ? 'Виден читателям' : 'Черновик'}
                </span>
              </div>
            </div>
          </div>

          {/* Genres */}
          <div className="pt-2">
            <Label className="mb-2 block">Жанры</Label>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {allGenres.map((g) => {
                const selected = selectedGenreIds.includes(g.id);
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => handleGenreToggle(g.id)}
                    className={`rounded-lg px-3 py-1 text-xs font-medium border transition-colors ${
                      selected
                        ? 'bg-rose-600 text-white border-rose-500'
                        : 'bg-neutral-900 text-neutral-400 border-neutral-800 hover:border-neutral-700'
                    }`}
                  >
                    {g.name}
                  </button>
                );
              })}
            </div>

            {onAddGenre && (
              <div className="flex items-center gap-2 max-w-xs">
                <Input
                  type="text"
                  placeholder="Новый жанр..."
                  value={newGenreName}
                  onChange={(e) => setNewGenreName(e.target.value)}
                  className="h-8 text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleCreateGenreInline}
                  disabled={!newGenreName.trim()}
                  className="h-8 px-2 text-xs gap-1 border-neutral-800"
                >
                  <Plus className="h-3.5 w-3.5" /> Добавить
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-3 pt-4 border-t border-neutral-800">
        <Button type="submit" disabled={isSubmitting} className="min-w-[140px]">
          {isSubmitting ? 'Сохранение...' : isEditing ? 'Сохранить изменения' : 'Создать тайтл'}
        </Button>
      </div>
    </form>
  );
}

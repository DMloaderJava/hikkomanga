import { useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { submissions, prevalidatePayload, type SubmitTitlePayload } from '@/data/submissions';
import { prepareChaptersForSubmit } from '@/data/chapterSubmissions';
import { ChaptersEditor, type EditorChapter } from './ChaptersEditor';
import { MAX_CHAPTERS_PER_REQUEST, MAX_PAGES_PER_CHAPTER } from '../../../supabase/functions/_shared/chapterSubmissionCore';
import { CaptchaWidget } from './CaptchaWidget';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { CheckCircle, Send, Loader2, AlertCircle, ImageIcon, ChevronDown, ChevronRight, Layers } from 'lucide-react';

/**
 * Форма анонимной заявки на тайтл (по образцу MangaLib): обязательные
 * original_title / type / description / genres / cover, опциональный email
 * для уведомления. Капча + лимиты на сервере, клиент делает пред-валидацию.
 */
export interface SubmitTitleModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SubmitTitleModal({ open, onOpenChange }: SubmitTitleModalProps) {
  const [originalTitle, setOriginalTitle] = useState('');
  const [type, setType] = useState<SubmitTitlePayload['type']>('manga');
  const [titleRu, setTitleRu] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [author, setAuthor] = useState('');
  const [year, setYear] = useState('');
  const [description, setDescription] = useState('');
  const [genresRaw, setGenresRaw] = useState('');
  const [email, setEmail] = useState('');
  const [cover, setCover] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  /** Collapsed-секция «Главы»: заявка на тайтл сразу с главами (ТЗ). */
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const [chapters, setChapters] = useState<EditorChapter[]>([]);

  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [topError, setTopError] = useState<string | null>(null);
  const [successToken, setSuccessToken] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetForm = () => {
    setOriginalTitle('');
    setType('manga');
    setTitleRu('');
    setTitleEn('');
    setAuthor('');
    setYear('');
    setDescription('');
    setGenresRaw('');
    setEmail('');
    setCover(null);
    setCoverPreview(null);
    setCaptchaToken(null);
    setChapters([]);
    setChaptersOpen(false);
    setFieldErrors({});
    setTopError(null);
    setProgress(null);
    setSuccessToken(null);
  };

  const handleClose = (next: boolean) => {
    if (!next && sending) return; // не закрываемся во время отправки
    if (!next) resetForm();
    onOpenChange(next);
  };

  const handleCover = (file: File | null) => {
    setCover(file);
    setFieldErrors((prev) => ({ ...prev, cover: '' }));
    if (coverPreview?.startsWith('blob:')) URL.revokeObjectURL(coverPreview);
    if (!file) {
      setCoverPreview(null);
      return;
    }
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) {
      setFieldErrors((prev) => ({ ...prev, cover: 'Формат: JPEG, PNG или WebP' }));
      setCover(null);
      setCoverPreview(null);
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setFieldErrors((prev) => ({ ...prev, cover: 'Файл больше 5 MB' }));
      setCover(null);
      setCoverPreview(null);
      return;
    }
    // Превью + клиентская проверка 3:4±10% (сервер перепроверит по байтам).
    const url = URL.createObjectURL(file);
    setCoverPreview(url);
    const img = new Image();
    img.onload = () => {
      const deviation = Math.abs(img.width / img.height - 3 / 4) / (3 / 4);
      if (deviation > 0.1) {
        setFieldErrors((prev) => ({
          ...prev,
          cover: `Соотношение должно быть 3:4 (вертикальная), сейчас ${img.width}×${img.height}`,
        }));
        setCover(null);
      }
    };
    img.src = url;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTopError(null);

    const payload: SubmitTitlePayload = {
      original_title: originalTitle.trim(),
      type,
      description: description.trim(),
      genres: genresRaw
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean),
      ...(titleRu.trim() && { title_ru: titleRu.trim() }),
      ...(titleEn.trim() && { title_en: titleEn.trim() }),
      ...(author.trim() && { author: author.trim() }),
      ...(year.trim() && { year: Number(year) }),
    };

    const pre = prevalidatePayload(payload);
    if (Object.keys(pre).length > 0) {
      setFieldErrors(pre);
      return;
    }
    if (!cover) {
      setFieldErrors((prev) => ({ ...prev, cover: 'Обложка обязательна' }));
      return;
    }
    if (!captchaToken) {
      setTopError('Пройдите проверку капчи');
      return;
    }

    setSending(true);
    setFieldErrors({});

    // Главы необязательны: пустой список = заявка как раньше (без файлов глав).
    const activeChapters = chapters.filter(
      (ch) => ch.pages.length > 0 || ch.pdf || ch.name.trim() || ch.number.trim()
    );
    let preparedChapters;
    if (activeChapters.length > 0) {
      setProgress('Обрабатываем страницы…');
      try {
        const prepared = await prepareChaptersForSubmit(activeChapters, (n, done, total) =>
          setProgress(`Глава ${n}: разбор PDF (${done}/${total})`)
        );
        if (!prepared.ok) {
          setTopError(prepared.error);
          setSending(false);
          setProgress(null);
          return;
        }
        preparedChapters = prepared.chapters;
      } catch (err) {
        setTopError(err instanceof Error ? err.message : 'Не удалось подготовить главы');
        setSending(false);
        setProgress(null);
        return;
      }
    }

    setProgress('Загружаем…');
    const result = await submissions.submitTitle({
      payload,
      cover,
      captchaToken,
      email: email.trim() || undefined,
      chapters: preparedChapters,
    });
    setSending(false);
    setProgress(null);

    if (result.ok) {
      setSuccessToken(result.token ?? null);
      return;
    }
    if (result.fields) setFieldErrors(result.fields);
    if (result.error === 'captcha_failed' || result.error === 'captcha_missing') {
      setTopError('Капча не пройдена, обновите страницу и попробуйте снова');
    } else if (result.error === 'rate_limited') {
      setTopError(
        result.message ?? `Слишком часто. Попробуйте через ${result.retryAfter ?? 60} сек.`
      );
    } else if (result.error === 'network') {
      setTopError(result.message ?? 'Что-то сломалось, попробуйте позже');
    } else if (!result.fields) {
      setTopError(result.message ?? 'Что-то сломалось, попробуйте позже');
    }
  };

  const fieldError = (name: string) =>
    fieldErrors[name] ? (
      <p className="mt-1 text-[11px] text-red-400">{fieldErrors[name]}</p>
    ) : null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto bg-neutral-900 border-neutral-800">
        <DialogTitle>Предложить тайтл</DialogTitle>
        <DialogDescription>
          Заполните карточку — заявка уйдёт на модерацию. Если оставите email,
          сообщим о решении.
        </DialogDescription>

        {successToken ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-green-800/60 bg-green-950/30 p-6 text-center">
            <CheckCircle className="h-10 w-10 text-green-400" />
            <p className="text-sm font-semibold text-green-300">Заявка отправлена</p>
            <p className="max-w-md text-xs text-neutral-400">
              Ваш тайтл отправится на модерацию. Сохраните ссылку на статус —
              по ней видно решение (страницу можно открыть и без аккаунта).
            </p>
            <code className="break-all rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300">
              /s/{successToken}
            </code>
            <div className="flex gap-2 pt-1">
              <Link to="/s/$token" params={{ token: successToken }} onClick={() => handleClose(false)}>
                <Button size="sm">Открыть статус</Button>
              </Link>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  resetForm();
                }}
              >
                Предложить ещё
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            {topError && (
              <div className="flex items-start gap-2 rounded-xl border border-red-800/60 bg-red-950/30 p-3 text-sm text-red-400">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{topError}</span>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="st-title">Название (оригинал) *</Label>
                <Input
                  id="st-title"
                  value={originalTitle}
                  onChange={(e) => setOriginalTitle(e.target.value)}
                  placeholder="Sword Art Online"
                  className="mt-1.5"
                  maxLength={200}
                  required
                />
                {fieldError('original_title')}
              </div>
              <div>
                <Label htmlFor="st-type">Тип *</Label>
                <select
                  id="st-type"
                  value={type}
                  onChange={(e) => setType(e.target.value as SubmitTitlePayload['type'])}
                  className="mt-1.5 h-10 w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 text-sm text-neutral-100"
                >
                  <option value="manga">Манга</option>
                  <option value="manhwa">Манхва</option>
                  <option value="manhua">Маньхуа</option>
                  <option value="oel">OEL</option>
                </select>
                {fieldError('type')}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <Label htmlFor="st-title-ru">Название (RU)</Label>
                <Input id="st-title-ru" value={titleRu} onChange={(e) => setTitleRu(e.target.value)} className="mt-1.5" maxLength={200} />
                {fieldError('title_ru')}
              </div>
              <div>
                <Label htmlFor="st-title-en">Название (EN/романдзи)</Label>
                <Input id="st-title-en" value={titleEn} onChange={(e) => setTitleEn(e.target.value)} className="mt-1.5" maxLength={200} />
                {fieldError('title_en')}
              </div>
              <div>
                <Label htmlFor="st-author">Автор</Label>
                <Input id="st-author" value={author} onChange={(e) => setAuthor(e.target.value)} className="mt-1.5" maxLength={200} />
                {fieldError('author')}
              </div>
            </div>

            <div>
              <Label htmlFor="st-genres">Жанры * <span className="text-neutral-500">(через запятую, до 10)</span></Label>
              <Input
                id="st-genres"
                value={genresRaw}
                onChange={(e) => setGenresRaw(e.target.value)}
                placeholder="Экшен, Фэнтези, Романтика"
                className="mt-1.5"
              />
              {fieldError('genres')}
            </div>

            <div>
              <Label htmlFor="st-desc">Описание * <span className="text-neutral-500">(Markdown, 10–10000 символов)</span></Label>
              <Textarea
                id="st-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={5}
                maxLength={10000}
                placeholder="О чём произведение…"
                className="mt-1.5 resize-y"
              />
              <p className="mt-1 text-right text-[11px] text-neutral-600">{description.length}/10000</p>
              {fieldError('description')}
            </div>

            <div>
              <Label>Обложка * <span className="text-neutral-500">(3:4, до 5 MB, JPEG/PNG/WebP)</span></Label>
              <div className="mt-1.5 flex items-start gap-3">
                <div className="flex aspect-[3/4] w-28 shrink-0 items-center justify-center overflow-hidden rounded-lg border-2 border-dashed border-neutral-800 bg-neutral-900/60">
                  {coverPreview ? (
                    <img src={coverPreview} alt="Предпросмотр обложки" className="h-full w-full object-cover" />
                  ) : (
                    <ImageIcon className="h-6 w-6 text-neutral-600" />
                  )}
                </div>
                <div className="space-y-2 text-xs">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    className="border-neutral-700"
                  >
                    Выбрать файл
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={(e) => handleCover(e.target.files?.[0] ?? null)}
                  />
                  <p className="text-neutral-500">
                    {cover ? cover.name : 'Файл не выбран'}
                  </p>
                  {fieldError('cover')}
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-neutral-800 bg-neutral-900/50">
              <button
                type="button"
                aria-expanded={chaptersOpen}
                onClick={() => setChaptersOpen((v) => !v)}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-neutral-200"
              >
                {chaptersOpen ? (
                  <ChevronDown className="h-4 w-4 text-neutral-500" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-neutral-500" />
                )}
                <Layers className="h-4 w-4 text-emerald-400" />
                <span className="flex-1">Главы</span>
                <span className="text-xs text-neutral-500">
                  {chapters.length > 0
                    ? `${chapters.length} шт.`
                    : 'необязательно, до ' + MAX_CHAPTERS_PER_REQUEST}
                </span>
              </button>
              {chaptersOpen && (
                <div className="space-y-2 border-t border-neutral-800 p-3">
                  <p className="text-[11px] text-neutral-500">
                    Приложите главы сразу с тайтлом — модератор создаст их
                    черновиками после одобрения (не больше {MAX_CHAPTERS_PER_REQUEST} глав
                    и {MAX_PAGES_PER_CHAPTER} страниц в главе).
                  </p>
                  <ChaptersEditor
                    maxChapters={MAX_CHAPTERS_PER_REQUEST}
                    maxPagesPerChapter={MAX_PAGES_PER_CHAPTER}
                    value={chapters}
                    onChange={setChapters}
                    disabled={sending}
                  />
                  {fieldError('chapters')}
                </div>
              )}
            </div>

            <div>
              <Label htmlFor="st-email">Email для уведомления <span className="text-neutral-500">(необязательно)</span></Label>
              <Input
                id="st-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="mt-1.5"
              />
            </div>

            <CaptchaWidget onVerify={setCaptchaToken} onExpire={() => setCaptchaToken(null)} />

            <div className="flex items-center justify-between gap-3 border-t border-neutral-800 pt-4">
              <p className="text-xs text-neutral-500">Ваш тайтл отправится на модерацию.</p>
              <Button type="submit" disabled={sending} className="min-w-[140px] gap-2">
                {sending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> {progress ?? 'Отправка…'}
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4" /> Создать
                  </>
                )}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

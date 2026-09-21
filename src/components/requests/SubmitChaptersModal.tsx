import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { titles as titlesApi } from '@/data/titles';
import {
  chapterSubmissions,
  prepareChaptersForSubmit,
  type PreparedChapter,
} from '@/data/chapterSubmissions';
import { CaptchaWidget } from './CaptchaWidget';
import {
  ChaptersEditor,
  emptyChapter,
  type EditorChapter,
} from './ChaptersEditor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { MAX_CHAPTERS_PER_REQUEST, MAX_PAGES_PER_CHAPTER } from '../../../supabase/functions/_shared/chapterSubmissionCore';
import type { Title } from '@/data/types';
import { AlertCircle, CheckCircle, Loader2, Send } from 'lucide-react';

/**
 * «Предложить главу»: аноним выбирает опубликованный тайтл и прикладывает
 * 1–5 глав со страницами. Капча + согласие + rate limit 3/мин на сервере
 * (edge submit-chapters), файлы уходят в бакет submissions до approve.
 */
export interface SubmitChaptersModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SubmitChaptersModal({ open, onOpenChange }: SubmitChaptersModalProps) {
  const [titleList, setTitleList] = useState<Title[]>([]);
  const [titlesLoading, setTitlesLoading] = useState(true);
  const [titleId, setTitleId] = useState('');
  const [chapters, setChapters] = useState<EditorChapter[]>([emptyChapter('1')]);
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);

  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [topError, setTopError] = useState<string | null>(null);
  const [successToken, setSuccessToken] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTitlesLoading(true);
    titlesApi
      .listPublished()
      .then((list) => {
        if (cancelled) return;
        setTitleList(list);
        if (list.length > 0) setTitleId((prev) => prev || list[0].id);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setTitlesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const resetForm = () => {
    setChapters([emptyChapter('1')]);
    setEmail('');
    setConsent(false);
    setCaptchaToken(null);
    setFieldErrors({});
    setTopError(null);
    setProgress(null);
    setSuccessToken(null);
  };

  const handleClose = (next: boolean) => {
    if (!next && sending) return;
    if (!next) resetForm();
    onOpenChange(next);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTopError(null);
    setFieldErrors({});

    if (!titleId) {
      setFieldErrors({ title_id: 'Выберите тайтл' });
      return;
    }
    if (!consent) {
      setTopError('Подтвердите согласие — без него заявка не отправляется');
      return;
    }
    if (!captchaToken) {
      setTopError('Пройдите проверку капчи');
      return;
    }

    setSending(true);
    setProgress('Обрабатываем страницы…');
    // PDF разбивается на страницы здесь, до отправки: на сервере pdf-библиотеки нет.
    let prepared: PreparedChapter[];
    try {
      const result = await prepareChaptersForSubmit(chapters, (n, done, total) =>
        setProgress(`Глава ${n}: разбор PDF (${done}/${total})`)
      );
      if (!result.ok) {
        setTopError(result.error);
        setSending(false);
        setProgress(null);
        return;
      }
      prepared = result.chapters;
    } catch (err) {
      setTopError(err instanceof Error ? err.message : 'Не удалось подготовить файлы');
      setSending(false);
      setProgress(null);
      return;
    }

    const title = titleList.find((t) => t.id === titleId);
    setProgress('Загружаем…');
    const res = await chapterSubmissions.submit({
      titleId,
      titleName: title?.title ?? '',
      chapters: prepared,
      captchaToken,
      consent,
      email: email.trim() || undefined,
    });
    setSending(false);
    setProgress(null);

    if (res.ok) {
      setSuccessToken(res.token ?? null);
      return;
    }
    if (res.fields) setFieldErrors(res.fields);
    if (res.error === 'captcha_failed' || res.error === 'captcha_missing') {
      setTopError('Капча не пройдена, обновите страницу и попробуйте снова');
    } else if (res.error === 'consent_required') {
      setTopError('Подтвердите согласие — без него заявка не отправляется');
    } else if (res.error === 'rate_limited') {
      setTopError(res.message ?? `Слишком часто. Попробуйте через ${res.retryAfter ?? 60} сек.`);
    } else if (!res.fields) {
      setTopError(res.message ?? 'Что-то сломалось, попробуйте позже');
    }
  };

  const selectedTitle = titleList.find((t) => t.id === titleId);
  const fieldError = (name: string) =>
    fieldErrors[name] ? <p className="mt-1 text-[11px] text-red-400">{fieldErrors[name]}</p> : null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto bg-neutral-900 border-neutral-800">
        <DialogTitle>Предложить главу</DialogTitle>
        <DialogDescription>
          Выберите тайтл и приложите главы со страницами. Заявка уйдёт на
          модерацию; главы появятся в каталоге только после одобрения.
        </DialogDescription>

        {successToken ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-green-800/60 bg-green-950/30 p-6 text-center">
            <CheckCircle className="h-10 w-10 text-green-400" />
            <p className="text-sm font-semibold text-green-300">Заявка отправлена</p>
            <p className="max-w-md text-xs text-neutral-400">
              Главы отправлены на модерацию. Сохраните ссылку на статус — по ней
              видно решение (страницу можно открыть и без аккаунта).
            </p>
            <code className="break-all rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300">
              /s/{successToken}
            </code>
            <div className="flex gap-2 pt-1">
              <Link to="/s/$token" params={{ token: successToken }} onClick={() => handleClose(false)}>
                <Button size="sm">Открыть статус</Button>
              </Link>
              <Button size="sm" variant="outline" onClick={resetForm}>
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

            <div>
              <Label htmlFor="sc-title">Тайтл *</Label>
              <select
                id="sc-title"
                value={titleId}
                disabled={titlesLoading || titleList.length === 0}
                onChange={(e) => setTitleId(e.target.value)}
                className="mt-1.5 h-10 w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 text-sm text-neutral-100"
              >
                {titleList.length === 0 && <option value="">— нет опубликованных тайтлов —</option>}
                {titleList.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
              {fieldError('title_id')}
              {titlesLoading && <p className="mt-1 text-[11px] text-neutral-500">Загружаем каталог…</p>}
            </div>

            <div>
              <Label>
                Главы *{' '}
                <span className="text-neutral-500">
                  (до {MAX_CHAPTERS_PER_REQUEST}, не больше {MAX_PAGES_PER_CHAPTER} страниц в главе)
                </span>
              </Label>
              <div className="mt-1.5">
                <ChaptersEditor
                  maxChapters={MAX_CHAPTERS_PER_REQUEST}
                  maxPagesPerChapter={MAX_PAGES_PER_CHAPTER}
                  value={chapters}
                  onChange={setChapters}
                  disabled={sending}
                />
              </div>
              {fieldError('chapters')}
            </div>

            <div>
              <Label htmlFor="sc-email">
                Email для уведомления <span className="text-neutral-500">(необязательно)</span>
              </Label>
              <Input
                id="sc-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="mt-1.5"
              />
            </div>

            <label className="flex items-start gap-2 text-xs text-neutral-400">
              <input
                type="checkbox"
                checked={consent}
                disabled={sending}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-rose-600"
              />
              <span>
                Я согласен на обработку загруженных материалов и понимаю, что
                глава появится в каталоге только после проверки модератором.
              </span>
            </label>

            <CaptchaWidget onVerify={setCaptchaToken} onExpire={() => setCaptchaToken(null)} />

            <div className="flex items-center justify-between gap-3 border-t border-neutral-800 pt-4">
              <p className="text-xs text-neutral-500">
                {selectedTitle ? `Тайтл: ${selectedTitle.title}` : 'Выберите тайтл'}
              </p>
              <Button type="submit" disabled={sending} className="min-w-[150px] gap-2">
                {sending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> {progress ?? 'Отправка…'}
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4" /> Отправить
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

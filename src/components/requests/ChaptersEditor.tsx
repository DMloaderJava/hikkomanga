import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FILE_ACCEPT, formatAllowed, naturalCompare, validateFile } from '@/lib/imageFormats';
import { formatBytes } from '@/lib/chaptersImport';
import {
  MAX_TOTAL_BYTES,
  PAGE_IMAGE_MAX_BYTES,
  PDF_MAX_BYTES,
} from '../../../supabase/functions/_shared/chapterSubmissionCore';
import { FileImage, FileText, Plus, Trash2, UploadCloud, X } from 'lucide-react';

/**
 * Редактор глав — один компонент на три экрана (ТЗ):
 *   • SubmitChaptersModal  — «Предложить главу» (1–5 глав);
 *   • SubmitTitleModal     — collapsed-секция «Главы» к заявке на тайтл;
 *   • /admin/titles/$id/chapters/import — массовый импорт (без лимита 5 глав).
 *
 * Ответственность компонента: поля главы, приём файлов (drag-and-drop),
 * превью, авто-нумерация страниц в каноническое имя ch-{n}-page-{m},
 * валидация и счётчики. Загрузкой занимается вызывающий код.
 *
 * `mode`:
 *   'full'   — поля + файлы (модалки);
 *   'fields' — только поля (шаг «Превью» импорта);
 *   'files'  — поля только на чтение + дропзон (шаг «Файлы» импорта).
 */

export interface EditorPage {
  /** Стабильный id для React-ключей и отзыва blob-URL. */
  id: string;
  file: File;
  /** Номер страницы внутри главы, 1-based (пересчитывается при изменении). */
  index: number;
  /** Каноническое имя: ch-{n}-page-{m}.{ext} */
  name: string;
  error?: string;
}

export interface EditorChapter {
  id: string;
  /** Строка, а не число: поле редактируется и может быть пустым/битым. */
  number: string;
  name: string;
  description: string;
  pages: EditorPage[];
  /** Оригинал PDF главы (разбивается на страницы при отправке). */
  pdf?: File | null;
  pdfError?: string;
}

export interface ChaptersEditorProps {
  /** Лимит глав в заявке; для импорта передают большое число. */
  maxChapters: number;
  maxPagesPerChapter: number;
  value: EditorChapter[];
  onChange: (chapters: EditorChapter[]) => void;
  /** Плоский список всех файлов (страницы + PDF) — нужен для FormData. */
  onFilesChange?: (files: File[]) => void;
  disabled?: boolean;
  mode?: 'full' | 'fields' | 'files';
}

/** Лимиты ТЗ — те же константы, что валидирует edge-функция. */
export const EDITOR_IMAGE_MAX_BYTES = PAGE_IMAGE_MAX_BYTES;
export const EDITOR_PDF_MAX_BYTES = PDF_MAX_BYTES;
export const EDITOR_TOTAL_MAX_BYTES = MAX_TOTAL_BYTES;

export function emptyChapter(number: string): EditorChapter {
  return { id: uid(), number, name: '', description: '', pages: [] };
}

function uid(): string {
  return `ch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Пересчёт индексов и канонических имён страниц главы. */
export function renumberPages(chapter: EditorChapter): EditorChapter {
  const number = Number(chapter.number) > 0 ? Number(chapter.number) : 0;
  const pages = chapter.pages
    .slice()
    .sort((a, b) => naturalCompare(a.file.name, b.file.name))
    .map((page, i) => ({
      ...page,
      index: i + 1,
      name: `ch-${number || 0}-page-${i + 1}.${extOf(page.file.name) || 'bin'}`,
    }));
  return { ...chapter, pages };
}

export function chapterPageErrors(chapter: EditorChapter, maxPages: number): string[] {
  const errors: string[] = [];
  const n = Number(chapter.number);
  if (!chapter.number.trim() || !Number.isFinite(n) || n <= 0) {
    errors.push('Укажите номер главы');
  }
  if (chapter.pages.length === 0 && !chapter.pdf) {
    errors.push('Добавьте хотя бы одну страницу');
  }
  if (chapter.pages.length > maxPages) {
    errors.push(`Страниц больше лимита: ${chapter.pages.length}/${maxPages}`);
  }
  return errors;
}

export function totalBytes(chapters: EditorChapter[]): number {
  return chapters.reduce(
    (sum, ch) =>
      sum + ch.pages.reduce((s, p) => s + p.file.size, 0) + (ch.pdf?.size ?? 0),
    0
  );
}

export function duplicateChapterNumbers(chapters: EditorChapter[]): Set<string> {
  const seen = new Map<string, number>();
  for (const ch of chapters) {
    const key = ch.number.trim();
    if (!key) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k));
}

export function ChaptersEditor({
  maxChapters,
  maxPagesPerChapter,
  value,
  onChange,
  onFilesChange,
  disabled = false,
  mode = 'full',
}: ChaptersEditorProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const previews = useRef<Map<string, string>>(new Map());
  const showFiles = mode !== 'fields';
  const fieldsEditable = mode !== 'files';

  const emitFiles = useCallback(
    (chapters: EditorChapter[]) => {
      onFilesChange?.(
        chapters.flatMap((ch) => [...ch.pages.map((p) => p.file), ...(ch.pdf ? [ch.pdf] : [])])
      );
    },
    [onFilesChange]
  );

  const update = useCallback(
    (next: EditorChapter[]) => {
      onChange(next);
      emitFiles(next);
    },
    [onChange, emitFiles]
  );

  // Превью страниц: blob-URL живёт в ref, освобождается при удалении/размонтировании.
  useEffect(() => {
    const map = previews.current;
    const alive = new Set<string>();
    for (const ch of value) for (const p of ch.pages) alive.add(p.id);
    for (const [id, url] of map) {
      if (!alive.has(id)) {
        URL.revokeObjectURL(url);
        map.delete(id);
      }
    }
  }, [value]);

  useEffect(
    () => () => {
      previews.current.forEach((url) => URL.revokeObjectURL(url));
      previews.current.clear();
    },
    []
  );

  const previewFor = (page: EditorPage): string | undefined => {
    if (previews.current.has(page.id)) return previews.current.get(page.id);
    if (extOf(page.file.name) === 'gif' || page.file.type === 'image/gif') return undefined;
    const url = URL.createObjectURL(page.file);
    previews.current.set(page.id, url);
    return url;
  };

  const patchChapter = (id: string, patch: Partial<EditorChapter>) => {
    update(value.map((ch) => (ch.id === id ? renumberPages({ ...ch, ...patch }) : ch)));
  };

  const addChapter = () => {
    if (disabled || value.length >= maxChapters) return;
    const lastNumber = Number(value[value.length - 1]?.number) || 0;
    update([...value, emptyChapter(String(lastNumber + 1))]);
  };

  const removeChapter = (id: string) => {
    if (disabled) return;
    const target = value.find((ch) => ch.id === id);
    target?.pages.forEach((p) => {
      const url = previews.current.get(p.id);
      if (url) {
        URL.revokeObjectURL(url);
        previews.current.delete(p.id);
      }
    });
    update(value.filter((ch) => ch.id !== id));
  };

  const removePage = (chapterId: string, pageId: string) => {
    if (disabled) return;
    const url = previews.current.get(pageId);
    if (url) {
      URL.revokeObjectURL(url);
      previews.current.delete(pageId);
    }
    patchChapter(
      chapterId,
      (() => {
        const ch = value.find((c) => c.id === chapterId);
        return { pages: (ch?.pages ?? []).filter((p) => p.id !== pageId) };
      })()
    );
  };

  /** Приём файлов главы: валидация по сигнатуре, PDF — отдельно от страниц. */
  const handleFiles = async (chapterId: string, files: File[]) => {
    if (disabled || files.length === 0) return;
    const chapter = value.find((c) => c.id === chapterId);
    if (!chapter) return;

    const pages = chapter.pages.slice();
    let pdf = chapter.pdf ?? null;
    let pdfError: string | undefined;

    for (const file of files) {
      const ext = extOf(file.name);
      if (!formatAllowed(ext)) {
        pages.push({
          id: uid(),
          file,
          index: pages.length + 1,
          name: file.name,
          error: `Формат \`${ext || 'без расширения'}\` не поддерживается`,
        });
        continue;
      }
      let kind: string = 'image';
      try {
        const checked = await validateFile(file);
        if (!checked.ok) {
          pages.push({ id: uid(), file, index: pages.length + 1, name: file.name, error: checked.reason });
          continue;
        }
        kind = checked.kind;
      } catch {
        pages.push({
          id: uid(),
          file,
          index: pages.length + 1,
          name: file.name,
          error: `Не удалось прочитать \`${file.name}\``,
        });
        continue;
      }

      if (kind === 'pdf') {
        if (file.size > EDITOR_PDF_MAX_BYTES) {
          pdfError = `PDF больше ${EDITOR_PDF_MAX_BYTES / 1024 / 1024} MB`;
          continue;
        }
        pdf = file;
        continue;
      }
      if (file.size > EDITOR_IMAGE_MAX_BYTES) {
        pages.push({
          id: uid(),
          file,
          index: pages.length + 1,
          name: file.name,
          error: `Файл больше ${EDITOR_IMAGE_MAX_BYTES / 1024 / 1024} MB`,
        });
        continue;
      }
      pages.push({ id: uid(), file, index: pages.length + 1, name: file.name });
    }

    update(
      value.map((ch) =>
        ch.id === chapterId ? renumberPages({ ...ch, pages, pdf, pdfError }) : ch
      )
    );
  };

  const duplicates = duplicateChapterNumbers(value);
  const bytes = totalBytes(value);
  const overBudget = bytes > EDITOR_TOTAL_MAX_BYTES;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-neutral-500">
          Глав: <span className="text-neutral-300">{value.length}</span>
          {Number.isFinite(maxChapters) && maxChapters < 1000 ? `/${maxChapters}` : ''} ·{' '}
          Страниц: <span className="text-neutral-300">{value.reduce((s, c) => s + c.pages.length, 0)}</span> ·{' '}
          Объём: <span className={overBudget ? 'text-red-400' : 'text-neutral-300'}>{formatBytes(bytes)}</span>
        </p>
        {showFiles && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={addChapter}
            disabled={disabled || value.length >= maxChapters}
            className="gap-1.5 border-neutral-700"
          >
            <Plus className="h-3.5 w-3.5" /> Глава
          </Button>
        )}
      </div>

      {overBudget && (
        <p className="rounded-lg border border-red-800/60 bg-red-950/30 p-2 text-xs text-red-400">
          Суммарный объём больше {EDITOR_TOTAL_MAX_BYTES / 1024 / 1024} MB — удалите часть файлов.
        </p>
      )}

      {value.length === 0 && (
        <p className="rounded-xl border border-dashed border-neutral-800 p-6 text-center text-xs text-neutral-500">
          Глав пока нет. Нажмите «Глава», чтобы добавить первую.
        </p>
      )}

      {value.map((chapter, ci) => {
        const errors = chapterPageErrors(chapter, maxPagesPerChapter);
        const isDuplicate = duplicates.has(chapter.number.trim());
        return (
          <div key={chapter.id} className="space-y-3 rounded-xl border border-neutral-800 bg-neutral-900/60 p-3">
            <div className="flex items-start justify-between gap-2">
              <span className="text-xs font-semibold text-neutral-400">Глава #{ci + 1}</span>
              {fieldsEditable && (
                <button
                  type="button"
                  onClick={() => removeChapter(chapter.id)}
                  disabled={disabled}
                  aria-label={`Удалить главу ${chapter.number || ci + 1}`}
                  className="text-neutral-500 hover:text-red-400 disabled:opacity-40"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[110px_1fr]">
              <div>
                <Label htmlFor={`ce-num-${chapter.id}`}>Номер *</Label>
                <Input
                  id={`ce-num-${chapter.id}`}
                  type="number"
                  min={1}
                  step={1}
                  value={chapter.number}
                  disabled={disabled || !fieldsEditable}
                  onChange={(e) => patchChapter(chapter.id, { number: e.target.value })}
                  className="mt-1.5"
                />
                {isDuplicate && <p className="mt-1 text-[11px] text-red-400">Номер повторяется</p>}
              </div>
              <div>
                <Label htmlFor={`ce-name-${chapter.id}`}>Название</Label>
                <Input
                  id={`ce-name-${chapter.id}`}
                  value={chapter.name}
                  disabled={disabled || !fieldsEditable}
                  maxLength={200}
                  onChange={(e) => patchChapter(chapter.id, { name: e.target.value })}
                  className="mt-1.5"
                  placeholder="Например: Начало пути"
                />
              </div>
            </div>

            <div>
              <Label htmlFor={`ce-desc-${chapter.id}`}>Описание</Label>
              <Textarea
                id={`ce-desc-${chapter.id}`}
                value={chapter.description}
                disabled={disabled || !fieldsEditable}
                rows={2}
                maxLength={5000}
                onChange={(e) => patchChapter(chapter.id, { description: e.target.value })}
                className="mt-1.5 resize-y"
              />
            </div>

            {showFiles && (
              <div className="space-y-2">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => inputs.current[chapter.id]?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDraggingId(chapter.id);
                  }}
                  onDragLeave={() => setDraggingId(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDraggingId(null);
                    void handleFiles(chapter.id, Array.from(e.dataTransfer.files));
                  }}
                  className={`w-full rounded-xl border-2 border-dashed p-4 text-center text-xs disabled:opacity-50 ${
                    draggingId === chapter.id ? 'border-rose-500' : 'border-neutral-700'
                  }`}
                >
                  <UploadCloud className="mx-auto mb-2 h-5 w-5 text-rose-400" />
                  <span className="block">Перетащите страницы главы или нажмите</span>
                  <span className="mt-1 block text-neutral-500">
                    JPG, PNG, WebP, GIF, AVIF, BMP, TIFF, HEIC — до 20 MB; PDF — до 200 MB
                  </span>
                </button>
                <input
                  ref={(el) => {
                    inputs.current[chapter.id] = el;
                  }}
                  type="file"
                  multiple
                  accept={FILE_ACCEPT}
                  disabled={disabled}
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    void handleFiles(chapter.id, files);
                  }}
                />

                {chapter.pdf && (
                  <div className="flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900 p-2 text-xs">
                    <FileText className="h-4 w-4 shrink-0 text-rose-400" />
                    <span className="min-w-0 flex-1 break-all">
                      {chapter.pdf.name} · {formatBytes(chapter.pdf.size)}
                      <span className="ml-1 text-neutral-500">(разобьётся на страницы)</span>
                    </span>
                    <button
                      type="button"
                      disabled={disabled}
                      aria-label="Убрать PDF"
                      onClick={() => patchChapter(chapter.id, { pdf: null, pdfError: undefined })}
                      className="text-neutral-500 hover:text-red-400"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                {chapter.pdfError && <p className="text-[11px] text-red-400">{chapter.pdfError}</p>}

                {chapter.pages.length > 0 && (
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2">
                    {chapter.pages.map((page) => {
                      const src = previewFor(page);
                      return (
                        <li
                          key={page.id}
                          className="group relative overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950"
                        >
                          {src ? (
                            <img
                              src={src}
                              alt={`Страница ${page.index}`}
                              className="h-24 w-full object-cover"
                              onError={(e) => {
                                e.currentTarget.style.visibility = 'hidden';
                              }}
                            />
                          ) : (
                            <div className="flex h-24 w-full items-center justify-center">
                              <FileImage className="h-6 w-6 text-neutral-600" />
                            </div>
                          )}
                          <span className="block truncate px-1 py-0.5 text-[10px] text-neutral-400">
                            {page.index}. {page.file.name}
                          </span>
                          {page.error && (
                            <span className="block px-1 pb-1 text-[10px] text-red-400">{page.error}</span>
                          )}
                          <button
                            type="button"
                            disabled={disabled}
                            aria-label={`Удалить страницу ${page.index}`}
                            onClick={() => removePage(chapter.id, page.id)}
                            className="absolute right-1 top-1 hidden rounded bg-black/70 p-1 text-neutral-300 hover:text-red-400 group-hover:block"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            {errors.length > 0 && (
              <ul className="space-y-0.5">
                {errors.map((e) => (
                  <li key={e} className="text-[11px] text-red-400">
                    {e}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

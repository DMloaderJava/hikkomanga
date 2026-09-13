import { useState, useEffect } from 'react';
import type { Chapter, ChapterInput } from '@/data/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { RotateCcw, Trash2 } from 'lucide-react';

interface ChapterFormProps {
  titleId: string;
  initialData?: Chapter | null;
  onSubmit: (input: ChapterInput) => Promise<void>;
  isSubmitting?: boolean;
}

export function ChapterForm({
  titleId,
  initialData,
  onSubmit,
  isSubmitting = false,
}: ChapterFormProps) {
  const draftStorageKey = `hikkomanga_chapter_draft_${titleId}_${initialData?.id || 'new'}`;

  const [number, setNumber] = useState<string>(initialData ? `${initialData.number}` : '1');
  const [name, setName] = useState<string>(initialData?.name || '');
  const [published, setPublished] = useState<boolean>(initialData?.published ?? true);
  const [error, setError] = useState<string | null>(null);
  const [hasDraft, setHasDraft] = useState(false);

  // Check for saved draft on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(draftStorageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && (parsed.name || parsed.number)) {
          setHasDraft(true);
        }
      }
    } catch {
      // Ignore
    }
  }, [draftStorageKey]);

  // Auto-save draft
  useEffect(() => {
    if (!name && number === '1') return;
    try {
      localStorage.setItem(
        draftStorageKey,
        JSON.stringify({ number, name, published, updatedAt: new Date().toISOString() })
      );
    } catch {
      // Ignore
    }
  }, [number, name, published, draftStorageKey]);

  const handleRestoreDraft = () => {
    try {
      const saved = localStorage.getItem(draftStorageKey);
      if (saved) {
        const draft = JSON.parse(saved);
        if (draft.number !== undefined) setNumber(draft.number);
        if (draft.name !== undefined) setName(draft.name);
        if (draft.published !== undefined) setPublished(draft.published);
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const num = parseFloat(number);
    if (isNaN(num) || num <= 0) {
      setError('Номер главы должен быть положительным числом');
      return;
    }

    try {
      await onSubmit({
        title_id: titleId,
        number: num,
        name: name.trim() || null,
        published,
      });
      localStorage.removeItem(draftStorageKey);
    } catch (err: any) {
      setError(err.message || 'Ошибка сохранения главы');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-neutral-800 bg-neutral-900/60 p-6">
      {hasDraft && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-800/80 bg-amber-950/40 p-3 text-xs text-amber-300">
          <span>Найден сохранённый черновик главы.</span>
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
        <div className="rounded-lg border border-red-800 bg-red-950/40 p-3 text-xs text-red-400">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <Label htmlFor="ch-number">Номер главы *</Label>
          <Input
            id="ch-number"
            type="number"
            step="any"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="1"
            className="mt-1.5"
            required
          />
        </div>

        <div className="sm:col-span-2">
          <Label htmlFor="ch-name">Название главы (опционально)</Label>
          <Input
            id="ch-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="например, Пролог"
            className="mt-1.5"
          />
        </div>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <Switch checked={published} onCheckedChange={setPublished} />
        <span className="text-xs text-neutral-300">
          {published ? 'Опубликована (видна читателям)' : 'Черновик'}
        </span>
      </div>

      <div className="flex justify-end pt-2">
        <Button type="submit" disabled={isSubmitting} size="sm">
          {isSubmitting ? 'Сохранение...' : initialData ? 'Сохранить изменения' : 'Создать главу'}
        </Button>
      </div>
    </form>
  );
}

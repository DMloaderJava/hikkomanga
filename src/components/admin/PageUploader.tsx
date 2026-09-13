import { useState, useRef, useEffect } from 'react';
import { storage } from '@/data/storage';
import { pages as pagesApi } from '@/data/pages';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { UploadCloud, AlertCircle, FileImage, CheckCircle2 } from 'lucide-react';

interface PageUploaderProps {
  chapterId: string;
  currentPagesCount: number;
  onPagesUploaded: () => void;
}

export function PageUploader({ chapterId, currentPagesCount, onPagesUploaded }: PageUploaderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Prevent accidental window close or navigation during upload
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (uploading) {
        e.preventDefault();
        e.returnValue = 'Загрузка изображений еще не завершена. Вы уверены, что хотите выйти?';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [uploading]);

  const handleFiles = async (filesList: FileList | File[]) => {
    setError(null);
    setSuccessMessage(null);
    const files = Array.from(filesList).filter((f) => f.type.startsWith('image/'));

    if (files.length === 0) {
      setError('Пожалуйста, выберите хотя бы одно изображение.');
      return;
    }

    if (currentPagesCount + files.length > 100) {
      setError(`Превышен лимит 100 страниц на главу (сейчас ${currentPagesCount}, пытаетесь добавить ${files.length})`);
      return;
    }

    // Check size <= 10MB
    const oversized = files.filter((f) => f.size > 10 * 1024 * 1024);
    if (oversized.length > 0) {
      setError(`Некоторые файлы превышают 10 МБ: ${oversized.map((f) => f.name).join(', ')}`);
      return;
    }

    // Sort files naturally by name
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    setUploading(true);
    setProgress(0);
    setStatusText(`Обработка 1 из ${files.length}...`);

    let completed = 0;
    let failedCount = 0;
    let startOrder = currentPagesCount + 1;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const order = startOrder + i;
      setStatusText(`Загрузка страницы ${i + 1} из ${files.length} (${file.name})...`);

      try {
        // Compress to 1600px WebP and upload to storage
        const { image_url, original_url } = await storage.uploadPage(chapterId, file, order);

        // Save page metadata
        await pagesApi.create({
          chapter_id: chapterId,
          image_url,
          original_url,
          page_order: order,
        });

        completed++;
      } catch (err: any) {
        console.error(`Error uploading page ${file.name}:`, err);
        failedCount++;
      }

      setProgress(Math.round(((i + 1) / files.length) * 100));
    }

    setUploading(false);
    setProgress(0);
    setStatusText('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }

    if (completed > 0) {
      onPagesUploaded();
      if (failedCount > 0) {
        setError(`Успешно загружено страниц: ${completed}. Ошибок загрузки: ${failedCount}.`);
      } else {
        setSuccessMessage(`Успешно загружено ${completed} страниц!`);
      }
    } else if (failedCount > 0) {
      setError('Не удалось загрузить изображения. Проверьте параметры и попробуйте снова.');
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files) {
      handleFiles(e.dataTransfer.files);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-800/80 bg-red-950/40 p-3.5 text-xs text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {successMessage && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-800/80 bg-emerald-950/40 p-3.5 text-xs text-emerald-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{successMessage}</span>
        </div>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDragging(false);
        }}
        onDrop={handleDrop}
        onClick={(e) => {
          // Trigger file input if clicking container directly
          if (!uploading) {
            fileInputRef.current?.click();
          }
        }}
        className={`relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-8 text-center transition-all cursor-pointer ${
          isDragging
            ? 'border-rose-500 bg-rose-950/20 scale-[0.99]'
            : 'border-neutral-800 bg-neutral-900/40 hover:border-neutral-700 hover:bg-neutral-900/80'
        } ${uploading ? 'pointer-events-none opacity-60' : ''}`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*"
          className="hidden"
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />

        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-neutral-800 text-rose-400 mb-3 border border-neutral-700">
          <UploadCloud className="h-7 w-7" />
        </div>

        <p className="text-sm font-semibold text-white">
          Перетащите файлы сюда или нажмите для выбора
        </p>
        <p className="mt-1 text-xs text-neutral-400">
          Поддерживаются JPG, PNG, WebP (до 10 МБ на файл). Авто-сжатие до 1600px WebP.
        </p>
        <p className="mt-2 text-[11px] font-medium text-rose-400">
          Максимум 100 страниц на главу ({currentPagesCount}/100)
        </p>
      </div>

      {uploading && (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4 space-y-2.5">
          <div className="flex items-center justify-between text-xs font-medium text-neutral-300">
            <span className="flex items-center gap-2">
              <FileImage className="h-4 w-4 text-rose-500 animate-pulse" />
              {statusText || 'Загрузка изображений...'}
            </span>
            <span>{progress}%</span>
          </div>
          <Progress value={progress} />
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Loader2 } from 'lucide-react';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Заголовок диалога, например «Удалить тайтл?» */
  title: string;
  /** Подробное предупреждение. Можно передавать ReactNode со списком последствий. */
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Красная кнопка подтверждения — для необратимых действий. */
  destructive?: boolean;
  /** Вызывается при подтверждении; диалог остаётся открытым, пока Promise не решится. */
  onConfirm: () => Promise<void> | void;
}

/**
 * Нормальная замена window.confirm(): тёмный диалог в стиле приложения,
 * с состоянием «выполняется», блокировкой закрытия и кнопкой отмены.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Удалить',
  cancelLabel = 'Отмена',
  destructive = true,
  onConfirm,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);

  const handleConfirm = async () => {
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
              destructive ? 'bg-red-950/60 text-red-400' : 'bg-neutral-800 text-neutral-300'
            }`}
          >
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="space-y-1.5 pr-6">
            <h2 className="text-base font-bold text-white">{title}</h2>
            <div className="text-sm text-neutral-400 leading-relaxed">{description}</div>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
            className="border-neutral-700 text-neutral-300 hover:bg-neutral-800"
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={pending}
            variant={destructive ? 'destructive' : 'default'}
            className={
              destructive
                ? 'bg-red-600 hover:bg-red-500 text-white gap-2'
                : 'gap-2'
            }
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            {pending ? 'Удаление...' : confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

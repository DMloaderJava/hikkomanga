import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Loader2 } from 'lucide-react';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => Promise<void> | void;
}

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
        // Запрещаем закрытие пока идёт операция
        if (!pending) onOpenChange(next);
      }}
    >
      {/*
        DialogContent создаёт портал, оверлей, фокус-трап и aria-атрибуты.
        onInteractOutside/onEscapeKeyDown дополнительно блокируются
        во время pending, чтобы случайный клик мимо не закрыл диалог
        пока идёт удаление.
      */}
      <DialogContent
        className="max-w-md border-neutral-800 bg-neutral-950 p-6 shadow-2xl"
        onInteractOutside={(e) => {
          if (pending) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (pending) e.preventDefault();
        }}
      >
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                destructive
                  ? 'bg-red-950/60 text-red-400'
                  : 'bg-neutral-800 text-neutral-300'
              }`}
            >
              <AlertTriangle className="h-5 w-5" />
            </div>

            <div className="space-y-1.5 pr-6">
              {/*
                DialogTitle и DialogDescription обязательны для скринридеров:
                панель ссылается на них через aria-labelledby/aria-describedby.
              */}
              <DialogTitle className="text-base font-bold text-white">
                {title}
              </DialogTitle>
              <DialogDescription className="text-sm text-neutral-400 leading-relaxed">
                {description}
              </DialogDescription>
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
              {pending ? 'Удаление…' : confirmLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

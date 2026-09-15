import * as React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { X } from 'lucide-react';

/**
 * Доступный примитив диалога без внешних зависимостей (Radix в проекте нет).
 *
 * `Dialog` — только портал + контекст; визуальную часть, оверлей, фокус-трап,
 * `role="dialog"`, `aria-modal`, закрытие по Escape и клику мимо даёт
 * `DialogContent`. `DialogTitle` / `DialogDescription` связываются с панелью
 * через `aria-labelledby` / `aria-describedby` — без них скринридер не
 * поймёт, о чём диалог.
 */

interface DialogContextValue {
  onOpenChange: (open: boolean) => void;
  titleId: string;
  descriptionId: string;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

function useDialogContext() {
  return React.useContext(DialogContext);
}

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

export function Dialog({ open, onOpenChange, children }: DialogProps) {
  const titleId = React.useId();
  const descriptionId = React.useId();

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <DialogContext.Provider value={{ onOpenChange, titleId, descriptionId }}>
      {children}
    </DialogContext.Provider>,
    document.body
  );
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DialogContentProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Клик по оверлею: вызовите e.preventDefault(), чтобы не закрывать. */
  onInteractOutside?: (e: React.MouseEvent<HTMLDivElement>) => void;
  /** Escape: вызовите e.preventDefault(), чтобы не закрывать. */
  onEscapeKeyDown?: (e: KeyboardEvent) => void;
  hideClose?: boolean;
}

export function DialogContent({
  className,
  children,
  onInteractOutside,
  onEscapeKeyDown,
  hideClose,
  ...rest
}: DialogContentProps) {
  const ctx = useDialogContext();
  const panelRef = React.useRef<HTMLDivElement>(null);

  // Держим обработчик Escape в ref: эффект ниже живёт один раз,
  // а замыкание с актуальным `pending` нужно на каждом рендере.
  const escapeHandlerRef = React.useRef(onEscapeKeyDown);
  React.useEffect(() => {
    escapeHandlerRef.current = onEscapeKeyDown;
  });

  React.useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = () =>
      Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);

    // Фокус внутрь диалога
    (focusables()[0] ?? panel)?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        escapeHandlerRef.current?.(e);
        if (!e.defaultPrevented) ctx?.onOpenChange(false);
        return;
      }
      if (e.key !== 'Tab') return;

      // Фокус-трап: Tab не уходит за пределы панели
      const els = focusables();
      if (els.length === 0) {
        e.preventDefault();
        panel?.focus();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
    // Эффект монтируется/размонтируется вместе с открытым диалогом
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        onInteractOutside?.(e);
        if (!e.defaultPrevented) ctx?.onOpenChange(false);
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ctx?.titleId}
        aria-describedby={ctx?.descriptionId}
        tabIndex={-1}
        className={cn(
          'relative z-50 w-full max-w-lg rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-2xl outline-none',
          className
        )}
        {...rest}
      >
        {!hideClose && (
          <button
            type="button"
            onClick={() => ctx?.onOpenChange(false)}
            aria-label="Закрыть"
            className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 text-neutral-400 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

export function DialogTitle({ className, ...rest }: React.HTMLAttributes<HTMLHeadingElement>) {
  const ctx = useDialogContext();
  return (
    <h2 id={ctx?.titleId} className={cn('text-base font-bold text-white', className)} {...rest} />
  );
}

export function DialogDescription({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  const ctx = useDialogContext();
  return (
    <div
      id={ctx?.descriptionId}
      className={cn('text-sm leading-relaxed text-neutral-400', className)}
      {...rest}
    />
  );
}

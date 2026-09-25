import * as React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Выдвижная панель (Sheet) — мобильный аналог боковой панели.
 *
 * Написана на тех же принципах, что `dialog.tsx` (Radix в проекте нет):
 * портал, фокус-трап, закрытие по Escape и клику мимо, `role="dialog"` +
 * `aria-modal`, возврат фокуса на элемент, который открыл панель, и блокировка
 * прокрутки body, пока шторка открыта.
 *
 * Отличие от диалога — позиция панели (`side`): справа (`right`) или снизу
 * (`bottom`). На мобильных support-чат открывается снизу на 85% высоты, чтобы
 * было видно страницу за ним.
 */

interface SheetContextValue {
  onOpenChange: (open: boolean) => void;
  titleId: string;
  descriptionId: string;
}

const SheetContext = React.createContext<SheetContextValue | null>(null);

function useSheetContext() {
  return React.useContext(SheetContext);
}

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

export function Sheet({ open, onOpenChange, children }: SheetProps) {
  const titleId = React.useId();
  const descriptionId = React.useId();

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <SheetContext.Provider value={{ onOpenChange, titleId, descriptionId }}>
      {children}
    </SheetContext.Provider>,
    document.body
  );
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type SheetSide = 'right' | 'bottom';

interface SheetContentProps extends React.HTMLAttributes<HTMLDivElement> {
  side?: SheetSide;
  hideClose?: boolean;
}

const SIDE_CLASSES: Record<SheetSide, string> = {
  right: 'inset-y-0 right-0 h-full w-full max-w-md border-l',
  bottom: 'inset-x-0 bottom-0 h-[85vh] w-full rounded-t-2xl border-t',
};

export function SheetContent({
  side = 'right',
  hideClose,
  className,
  children,
  ...rest
}: SheetContentProps) {
  const ctx = useSheetContext();
  const panelRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = () => Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);

    (focusables()[0] ?? panel)?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        ctx?.onOpenChange(false);
        return;
      }
      if (e.key !== 'Tab') return;

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
    // Эффект живёт вместе с открытой шторкой; зависимости намеренно пустые.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex bg-black/70 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        ctx?.onOpenChange(false);
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
          'absolute flex flex-col border-neutral-800 bg-neutral-900 shadow-2xl outline-none',
          SIDE_CLASSES[side],
          className
        )}
        {...rest}
      >
        {!hideClose && (
          <button
            type="button"
            onClick={() => ctx?.onOpenChange(false)}
            aria-label="Закрыть"
            className="absolute right-3 top-3 z-10 rounded-sm text-neutral-400 opacity-70 transition-opacity hover:text-white hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

export function SheetTitle({ className, ...rest }: React.HTMLAttributes<HTMLHeadingElement>) {
  const ctx = useSheetContext();
  return <h2 id={ctx?.titleId} className={cn('text-base font-bold text-white', className)} {...rest} />;
}

export function SheetDescription({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  const ctx = useSheetContext();
  return (
    <div
      id={ctx?.descriptionId}
      className={cn('text-sm leading-relaxed text-neutral-400', className)}
      {...rest}
    />
  );
}

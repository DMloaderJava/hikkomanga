import { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Link } from '@tanstack/react-router';
import { Plus, BookPlus, Megaphone, Layers } from 'lucide-react';
import type { SubmitTitleModalProps } from './SubmitTitleModal';

// Модалки + капча-виджет не нужны на первом экране — грузим динамическим
// import() по клику (иначе initial-бюджет сборки растёт, см. check-budgets).
// React.lazy/Suspense не используем: renderToString пререндера падает на
// suspending-компоненте («suspended while responding to synchronous input»).
type ModalComponent = ComponentType<SubmitTitleModalProps>;
type ModalKind = 'title' | 'chapters';

async function loadModal(kind: ModalKind): Promise<ModalComponent> {
  if (kind === 'chapters') {
    const m = await import('./SubmitChaptersModal');
    return m.SubmitChaptersModal as ModalComponent;
  }
  const m = await import('./SubmitTitleModal');
  return m.SubmitTitleModal;
}

/**
 * Кнопка «+» в топбаре — видна ВСЕМ, включая анонимов: подача заявки на
 * тайтл не требует аккаунта (капча + rate limit вместо регистрации).
 */
export function AddMenu() {
  const [open, setOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [modal, setModal] = useState<{ kind: ModalKind; Component: ModalComponent } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  const openModal = async (kind: ModalKind) => {
    setOpen(false);
    setModalOpen(true);
    if (modal?.kind !== kind) {
      try {
        const Component = await loadModal(kind);
        setModal({ kind, Component });
      } catch {
        // чанк не доехал — окно не откроется; повторный клик повторит попытку
        setModalOpen(false);
        return;
      }
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Добавить"
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-9 items-center justify-center rounded-lg bg-rose-600/90 text-white shadow-lg shadow-rose-600/25 transition-colors hover:bg-rose-500"
      >
        <Plus className="h-5 w-5" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-11 z-50 w-56 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 py-1 shadow-2xl"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => void openModal('title')}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-neutral-200 hover:bg-neutral-800 hover:text-white"
          >
            <BookPlus className="h-4 w-4 text-rose-400" />
            Предложить тайтл
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void openModal('chapters')}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-neutral-200 hover:bg-neutral-800 hover:text-white"
          >
            <Layers className="h-4 w-4 text-emerald-400" />
            Предложить главу
          </button>
          <Link
            to="/advertise"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-neutral-200 hover:bg-neutral-800 hover:text-white"
          >
            <Megaphone className="h-4 w-4 text-blue-400" />
            Заявка на рекламу
          </Link>
        </div>
      )}

      {modal && modalOpen && (
        <modal.Component open={modalOpen} onOpenChange={setModalOpen} />
      )}
    </div>
  );
}

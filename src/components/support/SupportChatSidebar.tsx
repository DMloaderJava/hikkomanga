import * as React from 'react';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useSupportChat } from './SupportChatContext';

/**
 * Боковая панель поддержки вокруг контента страницы.
 *
 * Оборачивает `<Outlet />` в корневом layout: закрытый чат — обычный блок на
 * всю ширину, открытый — resizable-раскладка на десктопе и шторка на мобильных.
 *
 * Почему раскладка грузится динамически и по `requestIdleCallback`:
 *
 *  - `react-resizable-panels`, Sheet и сам чат в initial JS не помещаются
 *    (бюджет 155 kB gzip, см. scripts/check-budgets.mjs), а нужны они только
 *    админам и только после клика по кнопке. `React.lazy` здесь не годится:
 *    пререндер (`scripts/prerender.mjs`) его не умеет и build падает;
 *  - смена обёртки (обычный div → PanelGroup) перемонтирует детей, поэтому
 *    грузим модуль заранее, в простой страницы, а не в момент клика: к первому
 *    открытию чата раскладка уже на месте, и дальше открытие/закрытие только
 *    добавляет/убирает соседнюю панель — контент страницы не перемонтируется
 *    и не теряет введённые данные (важно для админских форм);
 *  - в пререндеренном HTML и на первом рендере всегда простой div — разметка
 *    сервера и клиента совпадают, гидратация без рассинхрона.
 */

type SupportPanel = React.ComponentType<{ open: boolean; children: React.ReactNode }>;

export function SupportChatSidebar({ children }: { children: React.ReactNode }) {
  const { open } = useSupportChat();
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [panel, setPanel] = React.useState<{ Desktop: SupportPanel; Mobile: SupportPanel } | null>(
    null
  );
  const [loadFailed, setLoadFailed] = React.useState(false);
  const requested = React.useRef(false);

  const load = React.useCallback((alive: { current: boolean }) => {
    if (requested.current) return;
    requested.current = true;

    void import('./SupportChatPanel')
      .then((module) => {
        if (!alive.current) return;
        setPanel({ Desktop: module.SupportChatDesktopLayout, Mobile: module.SupportChatMobileSheet });
      })
      .catch(() => {
        if (alive.current) setLoadFailed(true);
      });
  }, []);

  React.useEffect(() => {
    const alive = { current: true };

    // Приоритет: если чат уже открыли — грузим немедленно, иначе ждём простоя.
    if (open) {
      load(alive);
    } else if (typeof window.requestIdleCallback === 'function') {
      // Простой страницы: грузим раскладку до того, как её попросят.
      const id = window.requestIdleCallback(() => load(alive), { timeout: 4000 });
      return () => {
        alive.current = false;
        window.cancelIdleCallback(id);
      };
    } else {
      // Safari: requestIdleCallback нет — просто откладываем на пару секунд.
      const id = window.setTimeout(() => load(alive), 2500);
      return () => {
        alive.current = false;
        window.clearTimeout(id);
      };
    }

    return () => {
      alive.current = false;
    };
  }, [open, load]);

  // Пока модуль не загружен — нейтральная обёртка (она же в пререндере).
  if (!panel) {
    return (
      <div className="w-full min-w-0">
        {children}
        {open && (
          <div className="fixed bottom-4 right-4 z-40 rounded-lg border border-neutral-800 bg-neutral-900/95 px-3 py-2 text-xs text-neutral-400 shadow-lg">
            {loadFailed
              ? 'Не удалось загрузить чат поддержки — обновите страницу.'
              : 'Открываю чат поддержки…'}
          </div>
        )}
      </div>
    );
  }

  const Layout = isDesktop ? panel.Desktop : panel.Mobile;
  return <Layout open={open}>{children}</Layout>;
}

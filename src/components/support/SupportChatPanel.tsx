import * as React from 'react';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { SupportChat } from './SupportChat';
import { useSupportChat } from './SupportChatContext';

/**
 * Раскладки support-чата. Обе живут в одном модуле намеренно: он подгружается
 * ТОЛЬКО динамически (см. SupportChatSidebar), поэтому `react-resizable-panels`
 * и код чата не утяжеляют initial JS (бюджет проверяет
 * scripts/check-budgets.mjs).
 *
 * `children` — контент страницы (`<Outlet />`). В обеих раскладках он стоит на
 * одном и том же месте дерева: открытие и закрытие чата лишь добавляет/убирает
 * соседнюю панель, поэтому страница не перемонтируется и не теряет состояние
 * (важно для админских форм с несохранёнными правками).
 *
 * Про `overflow: visible` на группе и панелях: библиотека по умолчанию ставит
 * `overflow: hidden` и на группу, и на панель — это защита «контент не должен
 * диктовать размер». Но overflow создаёт scroll-контейнер, а внутри него
 * `position: sticky` у чата перестаёт работать (липнет к контейнеру, а не к
 * окну), и страница не смогла бы скроллиться как обычный документ. Контент у
 * нас адаптивный (`min-w-0`), поэтому клипать нечего — снимаем оба.
 */

interface PanelProps {
  open: boolean;
  children: React.ReactNode;
}

/** Desktop: контент 70% + чат 30%, границу можно тянуть (40–50% для чата). */
export function SupportChatDesktopLayout({ open, children }: PanelProps) {
  return (
    <ResizablePanelGroup
      direction="horizontal"
      className="w-full"
      style={{ overflow: 'visible' }}
    >
      <ResizablePanel
        defaultSize={open ? 70 : 100}
        minSize={40}
        style={{ overflow: 'visible' }}
      >
        <div className="min-w-0">{children}</div>
      </ResizablePanel>

      {open && (
        <>
          <ResizableHandle withHandle className="mx-1" />

          <ResizablePanel
            defaultSize={30}
            minSize={20}
            maxSize={50}
            style={{ overflow: 'visible' }}
          >
            {/* Панель «липнет» к окну: страница под чатом длинная, и без sticky
                чат уехал бы вместе с ней. top-16 — высота AdminHeader. */}
            <div className="sticky top-16 h-[calc(100vh-4rem)] p-3">
              <SupportChat />
            </div>
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}

/** Мобильные (< 768px): та же панель шторкой снизу — resizable туда не влезает. */
export function SupportChatMobileSheet({ open, children }: PanelProps) {
  const { setOpen } = useSupportChat();

  return (
    <>
      <div className="w-full min-w-0">{children}</div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" hideClose className="p-2">
          <SheetTitle className="sr-only">Чат поддержки</SheetTitle>
          <SheetDescription className="sr-only">
            Вопросы и ответы по работе сайта hikkomanga
          </SheetDescription>
          <div className="min-h-0 flex-1">
            <SupportChat />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

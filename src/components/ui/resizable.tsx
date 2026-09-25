import * as React from 'react';
import { GripVertical } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { cn } from '@/lib/utils';

/**
 * Resizable-панели (обёртка `react-resizable-panels`, имена и API — как в
 * shadcn/ui, чтобы код панели читался привычно).
 *
 * Зависимость добавлена напрямую, а не через `npx shadcn@latest add resizable`:
 * в проекте нет `components.json`, нет Radix (примитивы в `src/components/ui`
 * написаны руками — см. dialog.tsx), и CLI переписывал бы конфиг Tailwind.
 * Версия зафиксирована на v3: в v4 те же компоненты называются `Group` /
 * `Panel` / `Separator`, а `PanelResizeHandle` больше нет.
 *
 * Важно про `Panel`: библиотека ставит ему инлайновый `overflow: hidden`
 * («без этого размер панели ломает её содержимое»), поэтому длинные страницы
 * внутри панели надо либо оборачивать в собственный скролл-контейнер, либо
 * снимать это через `style={{ overflow: 'visible' }}`.
 */

export function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof PanelGroup>) {
  return (
    <PanelGroup
      className={cn('flex w-full data-[panel-group-direction=vertical]:flex-col', className)}
      {...props}
    />
  );
}

export function ResizablePanel({ className, ...props }: React.ComponentProps<typeof Panel>) {
  return <Panel className={cn('min-w-0', className)} {...props} />;
}

interface ResizableHandleProps extends React.ComponentProps<typeof PanelResizeHandle> {
  /** Показать «ручку» с иконкой — так границу видно на тёмном фоне. */
  withHandle?: boolean;
}

export function ResizableHandle({ withHandle, className, ...props }: ResizableHandleProps) {
  return (
    <PanelResizeHandle
      className={cn(
        'relative flex w-px items-center justify-center bg-neutral-800 transition-colors',
        'data-[resize-handle-state=drag]:bg-rose-600 data-[resize-handle-state=hover]:bg-rose-700',
        'data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full',
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-6 w-3 items-center justify-center rounded-sm border border-neutral-700 bg-neutral-800">
          <GripVertical className="h-2.5 w-2.5 text-neutral-400" />
        </div>
      )}
    </PanelResizeHandle>
  );
}

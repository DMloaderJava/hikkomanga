import * as React from 'react';

/**
 * Состояние боковой панели поддержки: открыта/закрыта.
 *
 * Провайдер стоит в корневом layout (`src/routes/__root.tsx`), поэтому кнопку
 * открытия можно повесить в любой шапке (сейчас — `AdminHeader`, иконка
 * MessageCircle), а саму панель — один раз обернуть вокруг `<Outlet />`.
 * Состояние живёт в памяти вкладки: после перезагрузки панель закрыта, и это
 * осознанно — открытый чат не должен достаться следующему пользователю
 * общего компьютера.
 */

export interface SupportChatContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const SupportChatContext = React.createContext<SupportChatContextValue | null>(null);

export function SupportChatProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);

  const value = React.useMemo<SupportChatContextValue>(
    () => ({
      open,
      setOpen: (next: boolean) => setOpen(next),
      toggle: () => setOpen((prev) => !prev),
    }),
    [open]
  );

  return <SupportChatContext.Provider value={value}>{children}</SupportChatContext.Provider>;
}

export function useSupportChat(): SupportChatContextValue {
  const ctx = React.useContext(SupportChatContext);
  if (!ctx) {
    throw new Error('useSupportChat: компонент вне <SupportChatProvider> (см. src/routes/__root.tsx)');
  }
  return ctx;
}

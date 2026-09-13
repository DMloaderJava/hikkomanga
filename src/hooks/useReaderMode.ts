import { useState, useEffect } from 'react';

export type ReaderMode = 'vertical' | 'paged';

export function useReaderMode() {
  const [mode, setMode] = useState<ReaderMode>(() => {
    if (typeof window === 'undefined') return 'vertical';
    const saved = localStorage.getItem('readerMode');
    return saved === 'paged' ? 'paged' : 'vertical';
  });

  const updateMode = (newMode: ReaderMode) => {
    setMode(newMode);
    try {
      localStorage.setItem('readerMode', newMode);
    } catch {
      // Ignore
    }
  };

  return [mode, updateMode] as const;
}

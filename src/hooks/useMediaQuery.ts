import { useEffect, useState } from 'react';

/**
 * `matchMedia` как состояние React.
 *
 * Нужен, чтобы на узких экранах support-чат открывался шторкой (Sheet), а не
 * resizable-панелью. На сервере (пререндер) и в первом рендере всегда `false`:
 * `window` там нет, а расхождение разметки с гидратацией дало бы warning и
 * «прыжок» интерфейса. Для сайдбара это безопасно — он и так открывается
 * только действием пользователя.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);

    update();
    // Safari < 14 умеет только addListener — оставлен фолбэк.
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', update);
      return () => media.removeEventListener('change', update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, [query]);

  return matches;
}

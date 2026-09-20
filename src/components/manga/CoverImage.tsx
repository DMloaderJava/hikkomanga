import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { generatePlaceholderCover } from '@/lib/placeholder-cover';

interface CoverImageProps {
  /** URL обложки. Если пустой или запрос не удался — показывается fallback. */
  src?: string | null;
  /** Название тайтла — для alt и для генерации плейсхолдера по умолчанию. */
  title: string;
  className?: string;
  /**
   * Что рендерить, если обложка не грузится.
   * По умолчанию — сгенерированный SVG-плейсхолдер с инициалами.
   */
  fallback?: ReactNode;
  loading?: 'lazy' | 'eager';
}

/**
 * Обложка тайтла, которая никогда не показывает «сломанное изображение»:
 * если `src` пустой или запрос провалился (файла нет в Storage, мёртвая
 * ссылка на удалённый проект, битый data-URL и т.п.) — рендерится
 * `fallback` (по умолчанию сгенерированный SVG-плейсхолдер).
 *
 * При сбое загрузки URL пишется в консоль — по нему сразу видно,
 * что именно не грузится (404 в Storage, NXDOMAIN и пр.).
 */
export function CoverImage({ src, title, className, fallback, loading = 'lazy' }: CoverImageProps) {
  const [failed, setFailed] = useState(false);
  const placeholder = useMemo(() => generatePlaceholderCover(title), [title]);
  const imgClassName = className ?? 'h-full w-full object-cover';

  if (!src || failed) {
    if (fallback) return <>{fallback}</>;
    return <img src={placeholder} alt={title} loading={loading} className={imgClassName} />;
  }

  return (
    <img
      src={src}
      alt={title}
      loading={loading}
      className={imgClassName}
      // Внешние обложки (по URL) часто лежат на хостингах с хотлинк-защитой —
      // без Referer они отдают картинку, а с ним могут вернуть 403.
      referrerPolicy="no-referrer"
      onError={() => {
        console.warn(`[CoverImage] не загрузилась обложка «${title}»:`, src);
        setFailed(true);
      }}
    />
  );
}

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

interface CoverImageProps {
  /** URL/путь обложки. Если пустой или запрос не удался — показывается fallback. */
  src?: string | null;
  /** Название тайтла — для alt и подсказки при диагностике. */
  title: string;
  /**
   * Alt изображения. По умолчанию `Обложка: {title}` — осмысленный текст
   * для скринридеров, а не имя файла или пустота.
   */
  alt?: string;
  className?: string;
  /**
   * Что рендерить, если обложка не грузится.
   * По умолчанию — кэшируемый SVG-плейсхолдер из /media/placeholder-cover.svg.
   */
  fallback?: ReactNode;
  loading?: 'lazy' | 'eager';
  /**
   * Приоритетная обложка (первый экран) — eager + fetchPriority=high.
   * Для остальных — loading='lazy' + decoding='async' по умолчанию.
   */
  priority?: boolean;
}

const DEV = import.meta.env?.DEV;

/**
 * Сообщить о сбое обложки: в dev — консоль с контекстом, в prod — тихо
 * (диагностика через data-cover-error в DOM) + счётчик в Vercel Analytics.
 * Динамический импорт: в бандл попадает только при реальном сбое.
 */
function reportCoverError(title: string, src: string) {
  if (DEV) {
    console.warn(`[cover] failed «${title}»:`, src);
    return;
  }
  import('@vercel/analytics')
    .then(({ track }) => track('cover_error', { title }))
    .catch(() => {});
}

/**
 * Единая точка рендера обложки тайтла — «никогда не битая картинка»:
 *
 *  1. src — либо файл репозитория (public/media/covers/*.webp, в
 *     titles.cover_url относительный путь /media/covers/{slug}.webp), либо
 *     загруженная из админки обложка (публичный URL бакета Storage `covers`,
 *     см. src/lib/coverUpload.ts);
 *  2. при ошибке загрузки (файла нет, опечатка в пути, объект в Storage
 *     удалён) — плейсхолдер `/media/placeholder-cover.svg` + `data-cover-error`
 *     в DOM.
 *
 * При пустом src сразу плейсхолдер. SSR-safe: на этапе пререндера window не
 * нужен, onError на сервере не срабатывает, атрибуты детерминированы.
 */
export function CoverImage({
  src,
  title,
  alt,
  className,
  fallback,
  loading,
  priority = false,
}: CoverImageProps) {
  const resolvedLoading = loading ?? (priority ? 'eager' : 'lazy');
  const [failed, setFailed] = useState(false);

  // Смена обложки (редактирование тайтла, другой результат поиска) — новая попытка.
  useEffect(() => {
    setFailed(false);
  }, [src]);

  const placeholderSrc = `${import.meta.env?.BASE_URL ?? '/'}media/placeholder-cover.svg`;
  const imgClassName = className ?? 'h-full w-full object-cover';
  const resolvedAlt = alt ?? `Обложка: ${title}`;

  if (!src || failed) {
    if (fallback) return <>{fallback}</>;
    return (
      <img
        src={placeholderSrc}
        alt={resolvedAlt}
        loading={resolvedLoading}
        decoding="async"
        className={imgClassName}
        data-cover-error="true"
        draggable={false}
      />
    );
  }

  return (
    <img
      src={src}
      alt={resolvedAlt}
      loading={priority ? 'eager' : resolvedLoading}
      decoding="async"
      fetchPriority={priority ? 'high' : undefined}
      className={imgClassName}
      draggable={false}
      // Внешние обложки (по URL) часто лежат на хостингах с хотлинк-защитой —
      // без Referer они отдают картинку, а с ним могут вернуть 403.
      referrerPolicy="no-referrer"
      onError={() => {
        reportCoverError(title, src);
        setFailed(true);
      }}
    />
  );
}

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { coverSrcSet } from '@/lib/storageUrl';

interface CoverImageProps {
  /** URL обложки. Если пустой или запрос не удался — показывается fallback. */
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
function reportCoverError(title: string, src: string, stage: string) {
  if (DEV) {
    console.warn(`[cover] failed (${stage}) «${title}»:`, src);
    return;
  }
  import('@vercel/analytics')
    .then(({ track }) => track('cover_error', { title, stage }))
    .catch(() => {});
}

/**
 * Единая точка рендера обложки тайтла — «никогда не битая картинка»:
 *
 *  1. src + srcset (если включены Supabase-трансформации) →
 *  2. повтор чистым src (трансформации недоступны / кандидат битый) →
 *  3. плейсхолдер `/media/placeholder-cover.svg` + `data-cover-error`.
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
  /** first = src(+srcset), retry = чистый src, placeholder = файл-плейсхолдер. */
  const [attempt, setAttempt] = useState<'first' | 'retry' | 'placeholder'>(() =>
    src ? 'first' : 'placeholder'
  );

  // Смена обложки (редактирование тайтла, другой результат поиска) — новая попытка.
  useEffect(() => {
    setAttempt(src ? 'first' : 'placeholder');
  }, [src]);

  const srcSet = useMemo(() => (attempt === 'first' ? coverSrcSet(src) : undefined), [src, attempt]);
  const placeholderSrc = `${import.meta.env?.BASE_URL ?? '/'}media/placeholder-cover.svg`;
  const imgClassName = className ?? 'h-full w-full object-cover';
  const resolvedAlt = alt ?? `Обложка: ${title}`;

  const handleError = () => {
    if (attempt === 'first' && srcSet) {
      // Кандидат трансформации не загрузился — пробуем оригинал, не «хороним» обложку.
      setAttempt('retry');
      return;
    }
    if (src && attempt !== 'placeholder') {
      reportCoverError(title, src, srcSet ? 'retry' : 'first');
    }
    setAttempt('placeholder');
  };

  if (attempt === 'placeholder') {
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
      key={`${attempt}-${src ?? ''}`}
      src={src ?? undefined}
      srcSet={srcSet}
      // sizes: контейнер карточки ≤ 300px, страница тайтла — до 400px.
      sizes={srcSet ? '(max-width: 640px) 50vw, 300px' : undefined}
      alt={resolvedAlt}
      loading={priority ? 'eager' : resolvedLoading}
      decoding="async"
      fetchPriority={priority ? 'high' : undefined}
      className={imgClassName}
      draggable={false}
      onError={handleError}
    />
  );
}

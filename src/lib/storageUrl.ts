import { SUPABASE_URL } from '@/integrations/supabase/config';

/**
 * Единое место работы с URL медиа (обложки, страницы глав, озвучка).
 *
 * Здесь и только здесь:
 *  - чинятся ссылки на удалённые («мёртвые») Supabase-проекты;
 *  - собирается публичный URL Storage из пути бакета;
 *  - нормализуются значения из БД/форм (trim, '' → null, http → https);
 *  - извлекается путь объекта из публичного URL (для удаления из бакета);
 *  - решается, какой URL CSP продакшена считает допустимым.
 *
 * Разброс этой логики по модулям — проверенный способ получить «каталог без
 * картинок» после переезда Supabase-проекта: см. SETUP_SUPABASE.md,
 * раздел «Обложки не грузятся (Covers troubleshooting)».
 */

/** Refs удалённых Supabase-проектов. Их домены уже не резолвятся (NXDOMAIN),
 *  но в строках БД после переноса данных могут остаться storage-URL, указывающие
 *  на них. Если добавите новый мёртвый ref, допишите его сюда. */
const LEGACY_SUPABASE_REFS = new Set(['vokzyxwkhappwnggjxf']);

/** Дедупликация: один и тот же битый URL выводим в консоль один раз. */
const warnedUrls = new Set<string>();

function currentHostname(): string {
  try {
    return new URL(SUPABASE_URL).hostname;
  } catch {
    return '';
  }
}

/**
 * Починить URL Supabase Storage, указывающий на удалённый проект:
 * `<legacy-ref>.supabase.co` → хост проекта, текущего по VITE_SUPABASE_URL.
 *
 * Если URL указывает на ДРУГОЙ (не текущий и не известный мёртвый) проект,
 * молча не трогаем, но один раз пишем в консоль предупреждение —
 * по нему видно, с какого ref берутся медиа.
 *
 * Всё остальное (data:, внешние ссылки, ссылки на текущий проект)
 * возвращается без изменений. Безопасно вызывать на любом string-поле с URL.
 */
export function repairSupabaseUrl(url: string | null | undefined): string | null | undefined {
  if (!url || typeof url !== 'string' || !url.includes('.supabase.co')) return url;
  const current = currentHostname();
  if (!current) return url;

  const match = url.match(/\/\/([a-z0-9-]+)\.supabase\.co\//);
  const ref = match?.[1];
  if (!ref) return url;

  if (LEGACY_SUPABASE_REFS.has(ref)) {
    if (!warnedUrls.has(url)) {
      warnedUrls.add(url);
      console.warn(
        `[storageUrl] URL указывает на удалённый Supabase-проект ${ref} — переадресован на ${current}. ` +
          'Если файл не был перенесён в новый проект, придёт 404 и приложение покажет плейсхолдер.',
        url
      );
    }
    return url.replace(`${ref}.supabase.co`, current);
  }

  const currentRef = current.split('.')[0];
  if (ref !== currentRef && !warnedUrls.has(url)) {
    warnedUrls.add(url);
    console.warn(
      `[storageUrl] URL медиа указывает на другой Supabase-проект (${ref}), ` +
        `чем настроен в приложении (${currentRef}) — проверьте, откуда взялась ссылка.`,
      url
    );
  }

  return url;
}

/**
 * Нормализованное значение медиа-поля из БД/формы:
 *  - пробелы по краям срезаются, пустая строка → null;
 *  - `http://` повышается до `https://` (иначе CSP img-src режет смешанный
 *    контент, а картинка молча не грузится);
 *  - ссылки на мёртвые Supabase-проекты переадресуются на текущий (repairSupabaseUrl);
 *  - data:-URL, локальные `/media/...` и голые пути бакета проходят как есть
 *    (голый путь — это формат `original_url` в pages, он хранится специально).
 */
export function normalizeMediaUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const upgraded = /^http:\/\//i.test(trimmed) ? `https://${trimmed.slice(7)}` : trimmed;

  const repaired = repairSupabaseUrl(upgraded);
  return typeof repaired === 'string' ? repaired : null;
}

/**
 * Публичный URL объекта Supabase Storage — собирается ТОЛЬКО здесь.
 * `supabase.storage.from(bucket).getPublicUrl()` не используется в других
 * модулях, чтобы формат URL не зависел от версии SDK.
 */
export function supabaseStoragePublicUrl(bucket: string, path: string): string {
  const base = (SUPABASE_URL || '').replace(/\/+$/, '');
  return `${base}/storage/v1/object/public/${bucket}/${path.replace(/^\/+/, '')}`;
}

/**
 * Путь объекта внутри бакета из публичного URL — для `.remove([...])`.
 * Принимает и голый путь (возвращается как есть). Не находит бакет в URL —
 * значит URL не из нашего Storage (внешний/data:) → null.
 */
export function storagePathFromUrl(
  url: string | null | undefined,
  bucket: string
): string | null {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('data:')) return null;
  if (!/^https?:\/\//i.test(url)) {
    // Голый путь (`covers/…`) — допустимый формат хранения.
    return url.includes('/') ? url.replace(/^\/+/, '') : null;
  }
  const marker = `/${bucket}/`;
  const idx = url.indexOf(marker);
  if (idx < 0) return null;
  return url.slice(idx + marker.length).split('?')[0];
}

/**
 * Разрешён ли URL CSP продакшена (vercel.json → img-src):
 * 'self' (относительные пути), data:, blob:, *.supabase.co, *.supabase.in.
 * Всё остальное (внешние CDN, чужие хостинги) браузер молча не загрузит —
 * такие URL нужно отклонять в форме, а не находить по битым картинкам.
 */
export function isMediaUrlCspAllowed(
  url: string | null | undefined,
  opts?: { isBlob?: boolean }
): boolean {
  const value = normalizeMediaUrl(url);
  if (!value) return true; // пустое — валидно (будет плейсхолдер)
  if (value.startsWith('data:')) return true;
  if (opts?.isBlob || value.startsWith('blob:')) return true;
  if (value.startsWith('/')) return true; // 'self'
  if (!/^https:\/\//i.test(value)) return false; // http:// — смешанный контент

  try {
    const host = new URL(value).host.toLowerCase();
    return (
      host.endsWith('.supabase.co') ||
      host.endsWith('.supabase.in') ||
      (typeof window !== 'undefined' && host === window.location.host)
    );
  } catch {
    return false;
  }
}

/**
 * Srcset обложки через Supabase Image Transformation (рендер-эндпоинт
 * `/storage/v1/image/public/...`). По умолчанию ВЫКЛЮЧЕН: трансформации
 * нужно включать на проекте Supabase (план Pro), иначе эндпоинт отвечает
 * ошибкой и браузер делал бы лишний запрос на каждую карточку.
 * Включение: VITE_COVER_TRANSFORMS=1 при сборке. CoverImage при ошибке
 * srcset-кандидата сам откатывается на оригинальный src (двухступенчатый
 * фолбэк), так что включение безопасно даже на плане без трансформаций.
 */
export function coverSrcSet(url: string | null | undefined): string | undefined {
  if (!url || typeof url !== 'string' || !url.includes('/storage/v1/object/public/')) {
    return undefined;
  }
  const transformsOn = import.meta.env?.VITE_COVER_TRANSFORMS === '1';
  if (!transformsOn) return undefined;

  const renderUrl = url.replace('/storage/v1/object/public/', '/storage/v1/image/public/');
  if (renderUrl === url) return undefined;

  const sep = renderUrl.includes('?') ? '&' : '?';
  return [
    `${renderUrl}${sep}width=400&quality=70&format=webp 400w`,
    `${renderUrl}${sep}width=800&quality=75&format=webp 800w`,
  ].join(', ');
}

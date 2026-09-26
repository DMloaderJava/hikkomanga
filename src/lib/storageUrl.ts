import { SUPABASE_URL } from '@/integrations/supabase/config';

/**
 * Единое место работы с URL медиа (обложки, страницы глав, озвучка).
 *
 * Здесь и только здесь:
 *  - чинятся ссылки на удалённые («мёртвые») Supabase-проекты (pages/voiceovers);
 *  - собирается публичный URL Supabase Storage из пути бакета (pages/voiceovers);
 *  - нормализуются значения из БД/форм (trim, '' → null, http → https,
 *    относительные пути обложек — без изменений);
 *  - извлекается путь объекта из публичного URL (для удаления из бакета);
 *  - решается, какой URL CSP продакшена считает допустимым.
 *
 * Обложки тайтлов бывают двух видов: файл репозитория (public/media/covers/,
 * в titles.cover_url относительный путь /media/covers/{slug}.webp) и объект
 * публичного бакета Storage `covers` (загрузка из админки — TitleForm).
 * Различает их isSupabaseStorageUrl(); нормализация и CSP-проверка ниже
 * корректны для обоих.
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
 *  - относительные пути (`/media/covers/x.webp`, формат обложек тайтлов)
 *    возвращаются КАК ЕСТЬ: их не чинят, не апгрейдят до https и не прогоняют
 *    через dead-refs — они указывают на файлы этого же репозитория;
 *  - `http://` повышается до `https://` (иначе CSP img-src режет смешанный
 *    контент, а картинка молча не грузится);
 *  - ссылки на мёртвые Supabase-проекты переадресуются на текущий (repairSupabaseUrl)
 *    — актуально для страниц глав и озвучек, которые живут в Supabase Storage;
 *  - data:-URL и голые пути бакета проходят как есть
 *    (голый путь — формат `original_url` в pages, он хранится специально).
 */
export function normalizeMediaUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Обложки — локальные файлы репозитория; любой `/...` не трогаем.
  if (trimmed.startsWith('/')) return trimmed;

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
 * Это публичный URL объекта Supabase Storage (а не файл репозитория и не
 * data-URL)? Именно так отличают «обложку загрузили из админки» (бакет
 * `covers`, URL вида `…/storage/v1/object/public/covers/…`) от «обложка —
 * файл репозитория» (`/media/covers/{имя}.webp`).
 *
 * Нужно, чтобы:
 *  - TitleForm показывал, откуда взялась текущая обложка;
 *  - замена загруженной обложки удаляла старый объект из бакета
 *    (storage.deleteCover), а файл репозитория при этом не трогался;
 *  - check-covers.mjs проверял такие обложки HTTP-запросом, а не поиском
 *    файла в public/.
 */
export function isSupabaseStorageUrl(url: string | null | undefined): boolean {
  const value = normalizeMediaUrl(url);
  if (!value || !/^https:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const isSupabaseHost = host.endsWith('.supabase.co') || host.endsWith('.supabase.in');
    return isSupabaseHost && parsed.pathname.startsWith('/storage/v1/object/public/');
  } catch {
    return false;
  }
}

/**
 * Разрешён ли URL CSP продакшена (vercel.json → img-src):
 * 'self' (относительные пути), data:, blob:, *.supabase.co, *.supabase.in.
 * Всё остальное (внешние CDN, чужие хостинги) браузер молча не загрузит —
 * такие URL нужно отклонять в форме, а не находить по битым картинкам.
 * Обложки теперь 'self' (/media/covers/), поэтому проверка актуальна как
 * защита от опечаток в ручном пути и от случайных внешних ссылок.
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

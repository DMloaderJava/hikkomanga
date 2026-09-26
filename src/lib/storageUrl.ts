import { SUPABASE_URL } from '@/integrations/supabase/config';

/**
 * Единое место работы с URL медиа (обложки, страницы глав, озвучка).
 *
 * Здесь и только здесь:
 *  - чинятся ссылки на удалённые («мёртвые») Supabase-проекты (pages/voiceovers);
 *  - собирается публичный URL Supabase Storage из пути бакета (pages/voiceovers);
 *  - нормализуются значения из БД/форм (trim, '' → null, http → https,
 *    относительные пути обложек — без изменений);
 *  - путь обложки приводится к канонической форме (`normalizeCoverUrl`);
 *  - извлекается путь объекта из публичного URL (для удаления из бакета);
 *  - решается, какой URL CSP продакшена считает допустимым.
 *
 * Обложки тайтлов — НЕ Storage: это файлы репозитория (public/media/covers/),
 * в titles.cover_url лежит относительный путь /media/covers/{slug}.webp.
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
 * Путь обложки тайтла (titles.cover_url) → каноническая форма.
 *
 * Каноническая форма одна: `/media/covers/{slug}.webp` — файл этого
 * репозитория (public/media/covers/). Форма раньше отклоняла любую другую
 * запись того же пути («нельзя опубликовать тайтл»): здесь механически
 * приводим частые записи к канону, чтобы валидная обложка не блокировалась
 * из-за опечатки:
 *  - trim по краям, '' → null;
 *  - срезается ведущий `./` и ведущий `public/` (путь относительно корня репо);
 *  - добавляется отсутствующий ведущий `/`:
 *    `media/covers/x.webp` → `/media/covers/x.webp`;
 *  - уже абсолютные пути (`/…`) — без изменений.
 *
 * Функция НЕ проверяет допустимость: `http(s)://`, `data:`, `blob:` и пути
 * локального диска (`C:\…`) возвращаются как есть (после trim) — их отклоняет
 * `isMediaUrlCspAllowed`, а форма показывает конкретную причину. URL страниц
 * глав и озвучек (Supabase Storage) через эту функцию НЕ гонять — у них своя
 * семантика, см. `normalizeMediaUrl`.
 */
export function normalizeCoverUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // URL (http(s):, data:, blob:, прочие схемы) и пути локального диска —
  // не путь репозитория; не трогаем, чтобы downstream-проверка отклонила
  // со своим сообщением.
  if (/^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(trimmed)) return trimmed;

  let v = trimmed.replace(/^\.\//, '');
  v = v.replace(/^public\//, '');
  if (!v.startsWith('/')) v = `/${v}`;
  return v;
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
 * Разрешён ли URL CSP продакшена (vercel.json → img-src) и политике проекта:
 * 'self' (относительные пути), data:, blob:, *.supabase.co, *.supabase.in.
 *
 * Нюанс: img-src в vercel.json содержит `https:` — браузер охотно загрузит
 * картинку с внешнего https-домена. Но внешние ссылки для обложек
 * НЕ используются ПО ПОЛИТИКЕ ПРОЕКТА: мёртвые домены и хотлинк-защита
 * молча превращают каталог в «стену битых картинок» (см. SETUP_SUPABASE.md,
 * «Covers troubleshooting»), поэтому форма их отклоняет — эта функция и есть
 * источник правды для формы. Для страниц/озвучек (Supabase Storage) хост
 * должен быть *.supabase.co/.in. http:// отклоняется всегда: это смешанный
 * контент, его блокирует сам браузер.
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

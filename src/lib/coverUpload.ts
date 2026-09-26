import { signature } from './imageFormats';

/**
 * Загрузка обложки тайтла из файла (админка → TitleForm).
 *
 * Обложка по-прежнему МОЖЕТ быть файлом репозитория — `public/media/covers/*.webp`
 * и относительный путь в `titles.cover_url`. Это штатный способ для сидов и
 * «вечных» картинок (см. public/media/ATTRIBUTION.md): файл в git, кэш
 * 'self', вес ограничен бюджетом (scripts/check-budgets.mjs).
 *
 * Здесь добавлен второй способ: админ выбирает файл (JPEG/PNG/WebP/GIF),
 * тот приводится к WebP ≤800 px (GIF уходит как есть — с анимацией) и уходит
 * в публичный бакет Storage `title-covers`, а в `titles.cover_url`
 * записывается публичный URL Storage. CSP `img-src` пропускает
 * `*.supabase.co` (vercel.json), а `isMediaUrlCspAllowed` — подтверждает это
 * до сохранения, поэтому форма принимает оба вида путей.
 *
 * Без настроенного Supabase (демо/превью) файл превращается в data-URL:
 * весь флоу «выбрал файл → превью → сохранил → обложка в каталоге» работает
 * без бэкенда — так же, как страницы глав в демо-режиме (src/data/storage.ts).
 *
 * Логика намеренно без React и без DOM-зависимостей, кроме canvas в
 * compressToWebP: её проверяет scripts/unit-covers.mjs в Node.
 */

/**
 * Форматы, которые принимает форма (`accept` у input[type=file]).
 *
 * `image/*` — осознанно широко: фильтр файлового диалога не должен мешать
 * выбрать обложку, а настоящая проверка формата идёт по байтам файла
 * (COVER_SIGNATURES) уже в validateCoverFile. Экзотика (HEIC/TIFF/AVIF/BMP)
 * при этом отклоняется внятной ошибкой, а не битой картинкой в каталоге.
 */
export const COVER_ACCEPT = 'image/*';

/** Рабочие форматы расширениями — для подсказки под полем и для дропзоны. */
export const COVER_ACCEPT_EXT = '.jpg,.jpeg,.png,.webp,.gif';

/**
 * Сигнатуры (magic bytes), которые считаем обложкой: JPEG, PNG, WebP и GIF
 * (в том числе анимированный — он уходит в бакет как есть, см. prepareCoverImage).
 * HEIC/TIFF/AVIF/BMP/PDF отклоняются ДО загрузки: страницы глав их
 * перекодируют (preparePageImage), а для обложки «почти рабочий» экзотический
 * формат дороже понятной ошибки — битая картинка в каталоге видна всем читателям.
 */
const COVER_SIGNATURES: readonly string[] = ['jpg', 'png', 'webp', 'gif'];

/** Форматы обложки в порядке упоминания в текстах формы и ошибок. */
export const COVER_FORMATS_LABEL = 'JPEG, PNG, WebP или GIF';

/** Лимит ИСХОДНИКА. После сжатия обложка занимает ~50–150 kB, но выбирают
 *  обычно телефонные JPEG по 3–4 MB — как в форме заявки (SubmitTitleModal). */
export const COVER_MAX_BYTES = 5 * 1024 * 1024;

/** Ширина, к которой приводится обложка: как у сид-обложек
 *  (scripts/generate-seed-covers.mjs, «WebP 800px») и у карточек каталога. */
export const COVER_MAX_WIDTH = 800;

export type CoverValidation = { ok: true; ext: string } | { ok: false; reason: string };

/**
 * Валидация файла до всякого canvas: пустой / тяжелее лимита / не картинка.
 * Формат определяется по байтам (`signature`), а не по расширению — файл
 * `cover.png`, внутри которого JPEG, проходит: браузеру всё равно, а подпись
 * расходится только предупреждением в консоль (как в imageFormats.validateFile).
 */
export async function validateCoverFile(file: File | null | undefined): Promise<CoverValidation> {
  if (!file) return { ok: false, reason: 'Файл не выбран.' };
  if (file.size === 0) return { ok: false, reason: `Файл \`${file.name}\` пуст.` };
  if (file.size > COVER_MAX_BYTES) {
    return {
      ok: false,
      reason: `Файл \`${file.name}\` больше ${Math.round(COVER_MAX_BYTES / 1024 / 1024)} MB. Выберите файл меньше или сожмите его.`,
    };
  }
  const ext = await signature(file);
  if (!ext || !COVER_SIGNATURES.includes(ext)) {
    return {
      ok: false,
      reason: `Формат файла \`${file.name}\` не поддерживается. Допустимы ${COVER_FORMATS_LABEL}.`,
    };
  }
  const nameExt = (file.name.split('.').pop() || '').toLowerCase();
  const normalizedNameExt = ({ jpeg: 'jpg' } as Record<string, string>)[nameExt] || nameExt;
  if (normalizedNameExt && normalizedNameExt !== ext) {
    console.warn(`[covers] ${file.name}: расширение ${nameExt} не совпадает с сигнатурой ${ext}`);
  }
  return { ok: true, ext };
}

function randomToken(length = 8): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
}

/**
 * Имя объекта в бакете `title-covers`: `{slug}-{time36}-{rand8}.{ext}`.
 *
 * Ключ — slug тайтла, чтобы в Storage было видно, чья это обложка. Он приходит
 * из формы (может быть пустым или с кириллицей до сохранения), поэтому
 * нормализуется до `[a-z0-9-]`; пустой ключ → `cover`. Метка времени + случайный
 * хвост гарантируют уникальность: `upload` идёт с `upsert: false`, и повторная
 * загрузка не должна перезаписывать файл, на который ещё ссылается БД.
 */
export function coverObjectPath(key?: string | null, ext = 'webp'): string {
  const safe = (key || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  const safeExt = (ext || 'webp').toLowerCase().replace(/[^a-z0-9]/g, '') || 'webp';
  return `${safe || 'cover'}-${Date.now().toString(36)}-${randomToken()}.${safeExt}`;
}

export interface PreparedCover {
  /** Что реально полетит в Storage: WebP ≤800 px, GIF как есть либо (без canvas) исходник. */
  blob: Blob;
  /** Удалось ли пережать в WebP. `false` — GIF (анимация) или браузер без WebP-энкодера. */
  compressed: boolean;
  /** Расширение того, что лежит в `blob` — из него строится имя объекта в бакете. */
  ext: string;
}

/**
 * Привести файл к тому, что кладётся в бакет `title-covers`.
 *
 * JPEG/PNG/WebP → WebP шириной ≤800 px. GIF уходит как есть: canvas умеет
 * нарисовать только первый кадр, а обложка-анимация без анимации теряет
 * смысл (та же логика у страниц глав — preparePageImage).
 *
 * Если WebP-энкодер недоступен (нет createImageBitmap/OffscreenCanvas или
 * canvas не умеет 'image/webp'), грузим исходник как есть: обложка всё равно
 * рабочая, просто тяжелее. Это же делает флоу тестируемым вне браузера.
 */
export async function prepareCoverImage(file: File): Promise<PreparedCover> {
  const validation = await validateCoverFile(file);
  if (!validation.ok) throw new Error(validation.reason);
  const mimeByExt: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
  };

  if (validation.ext === 'gif') {
    return { blob: new Blob([file], { type: 'image/gif' }), compressed: false, ext: 'gif' };
  }

  try {
    const { compressToWebP } = await import('./imageCompress');
    const webp = await compressToWebP(file, COVER_MAX_WIDTH);
    if (webp.size > 0 && webp.type === 'image/webp') {
      return { blob: webp, compressed: true, ext: 'webp' };
    }
    console.warn('[covers] WebP-энкодер вернул пустой результат — загружаем исходник.');
  } catch (error) {
    console.warn('[covers] WebP-сжатие недоступно — загружаем исходник как есть:', error);
  }
  return {
    blob: new Blob([file], { type: file.type || mimeByExt[validation.ext] || 'image/png' }),
    compressed: false,
    ext: validation.ext === 'jpeg' ? 'jpg' : validation.ext,
  };
}

/**
 * Ядро заявок на главы — чистый TypeScript без Deno/node зависимостей.
 * Используется ТРЕМЯ модулями:
 *   1. edge-функцией submit-chapters (анонимная заявка «Предложить главу»);
 *   2. edge-функцией finalize-chapter-submission (перенос файлов при approve);
 *   3. юнит-тестами scripts/unit-submit-chapters.mjs через Vite SSR.
 *
 * submit-title тоже импортирует отсюда валидацию: «Предложить тайтл» может
 * приложить главы тем же payload'ом (см. processSubmission).
 *
 * Лимиты (ТЗ): ≤5 глав, ≤100 страниц на главу, ≤500 MB суммарно,
 * ≤20 MB изображение / ≤200 MB PDF. Rate limit 3/мин, 30/час, 100/сутки
 * на sha256(ip + ':chapters' + RATE_LIMIT_SALT) — отдельный от заявок на тайтл
 * счётчик,
 * иначе три поданных тайтла заблокировали бы подачу главы.
 */

// ── Лимиты ───────────────────────────────────────────────────────────────────

export const MAX_CHAPTERS_PER_REQUEST = 5;
export const MAX_PAGES_PER_CHAPTER = 100;
export const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
export const PAGE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const PDF_MAX_BYTES = 200 * 1024 * 1024;
/** Совпадает с MAX_PDF_PAGES в src/lib/pdfToPages.ts (разбивка на клиенте). */
export const MAX_PDF_PAGES = 500;
export const CHAPTER_NUMBER_MAX = 100_000;
export const CHAPTER_NAME_MAX = 200;
export const CHAPTER_DESCRIPTION_MAX = 5_000;
/** Разрешённые расширения страниц: тот же список, что src/lib/imageFormats.ts. */
export const PAGE_EXT = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'avif',
  'bmp',
  'tiff',
  'tif',
  'heic',
  'heif',
] as const;

export const CHAPTER_RATE_LIMITS: Array<{ windowSeconds: number; limit: number }> = [
  { windowSeconds: 60, limit: 3 },
  { windowSeconds: 3600, limit: 30 },
  { windowSeconds: 86_400, limit: 100 },
];

/** Суффикс ключа rate limit: окна глав не пересекаются с окнами тайтлов. */
export const CHAPTER_RATE_SCOPE = ':chapters';

// ── Типы ─────────────────────────────────────────────────────────────────────

export interface ChapterPageDecl {
  /** Имя multipart-части: ch-{n}-page-{m}[.ext]. */
  name: string;
  size: number;
}

export interface ChapterDraftInput {
  number?: unknown;
  name?: unknown;
  description?: unknown;
  pages?: unknown;
  pdf?: unknown;
}

export interface ValidatedChapterPage {
  /** Номер страницы внутри главы, 1-based. */
  index: number;
  /** Имя multipart-части. */
  name: string;
  size: number;
  ext: string;
}

export interface ValidatedChapter {
  number: number;
  name: string | null;
  description: string | null;
  pages: ValidatedChapterPage[];
  /**
   * Оригинал PDF главы, если объявлен. `size` известен только в объектной
   * форме объявления ({ name, size }) — её шлёт наш клиент; по строковой
   * форме размер неизвестен (0) и в суммарный объём не попадает.
   */
  pdf: { name: string; size: number } | null;
}

export interface ChapterFilePart {
  name: string;
  bytes: Uint8Array;
  contentType?: string;
}

export type FieldErrors = Record<string, string>;

export interface ChapterSubmissionPayload {
  title_id: string;
  title_name: string | null;
  chapters: Array<{
    number: number;
    name: string | null;
    description: string | null;
    /** Пути в бакете submissions: ch-{n}/page-{m}.{ext} */
    pages: Array<{ index: number; path: string; size: number }>;
    pdf: string | null;
  }>;
}

export interface ChapterSubmissionRow {
  type: 'new_chapters';
  status: 'pending';
  payload: ChapterSubmissionPayload & Record<string, unknown>;
  ip_hash: string;
  user_agent: string | null;
  turnstile_ok: boolean;
  public_token: string;
  submitter_email: string | null;
  target_id: string;
  target_name: string | null;
}

export type ChapterSubmissionDeps = {
  verifyCaptcha: (token: string, ip: string) => Promise<{ ok: boolean; error?: string }>;
  /** Атомарный инкремент окна; false — лимит превышен. */
  checkLimit: (windowSeconds: number, limit: number) => Promise<boolean>;
  /** Заголовок и признак публикации целевого тайтла; null — тайтла нет. */
  lookupTitle: (id: string) => Promise<{ id: string; title: string; published: boolean } | null>;
  uploadPage: (
    bytes: Uint8Array,
    token: string,
    path: string,
    contentType: string | undefined
  ) => Promise<void>;
  insertRequest: (row: ChapterSubmissionRow) => Promise<{ id: string }>;
  /** sha256(ip + RATE_LIMIT_SALT) для ip_hash строки заявки. */
  hashIp: (ip: string) => Promise<string>;
  randomToken?: () => string;
};

export interface ChapterSubmissionInput {
  captchaToken?: string;
  /** Чекбокс «согласен на обработку» — сервер не доверяет клиенту. */
  consent?: boolean;
  /** Распарсенный JSON поля payload: { title_id, title_name?, chapters[] }. */
  payloadRaw: unknown;
  email?: string;
  files: ChapterFilePart[];
  ip: string;
  userAgent?: string;
}

export type SubmissionResult = {
  status: number;
  body: Record<string, unknown>;
  retryAfter?: number;
};

// ── Утилиты ──────────────────────────────────────────────────────────────────

function asTrimmedString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function containsDangerousScheme(value: string): boolean {
  return /(?:javascript|data|vbscript)\s*:/i.test(value);
}

/** 32 hex-символа; подменяется в тестах. */
export function randomToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function isAllowedPageExt(ext: string): boolean {
  return (PAGE_EXT as readonly string[]).includes(ext);
}

/**
 * Имя страницы в multipart-запросе: `ch-{n}-page-{m}[.ext]`.
 * Возвращает null, если имя не похоже — файл не принадлежит ни одной главе.
 */
export function parseSubmittedPageName(
  name: string
): { chapter: number; page: number } | null {
  const m = /^ch-(\d{1,6})-page-(\d{1,4})(?:\.[A-Za-z0-9]+)?$/.exec(name.trim());
  if (!m) return null;
  return { chapter: Number(m[1]), page: Number(m[2]) };
}

/** Имя оригинала PDF в multipart-запросе: `ch-{n}.pdf`. */
export function parseSubmittedPdfName(name: string): number | null {
  const m = /^ch-(\d{1,6})\.pdf$/i.exec(name.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Путь страницы в бакете submissions до апрува:
 * `submissions/{token}/ch-{n}/page-{m}.{ext}` (ТЗ).
 */
export function submissionPagePath(
  token: string,
  chapterNumber: number,
  pageIndex: number,
  ext: string
): string {
  return `${token}/ch-${chapterNumber}/page-${pageIndex}.${ext}`;
}

/** Путь оригинала PDF заявки: `submissions/{token}/ch-{n}.pdf`. */
export function submissionPdfPath(token: string, chapterNumber: number): string {
  return `${token}/ch-${chapterNumber}.pdf`;
}

/** Публичный URL объекта бакета submissions (бакет публичный, см. миграция 10). */
export function submissionPublicUrl(
  supabaseUrl: string,
  path: string
): string {
  return `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/submissions/${path}`;
}

/**
 * Свободный номер главы: желаемый, если не занят, иначе max(занятые)+1.
 * `taken` мутируется — вызывающий передаёт один набор на всю пачку глав,
 * чтобы две главы из одной заявки не получили один номер.
 */
export function resolveChapterNumber(desired: number, taken: number[]): number {
  if (!taken.includes(desired)) {
    taken.push(desired);
    return desired;
  }
  let next = taken.length > 0 ? Math.max(...taken) + 1 : 1;
  while (taken.includes(next)) next += 1;
  taken.push(next);
  return next;
}

// ── Валидация payload ────────────────────────────────────────────────────────

export type ChaptersPayloadCheck =
  | { ok: true; titleId: string; titleName: string | null; chapters: ValidatedChapter[] }
  | { ok: false; fieldErrors: FieldErrors };

/**
 * Валидация массива глав (без title_id) — используется и submit-chapters,
 * и submit-title. `maxChapters` — лимит заявки (для тайтла тот же).
 */
export function validateChapters(
  raw: unknown,
  maxChapters = MAX_CHAPTERS_PER_REQUEST
): { ok: true; chapters: ValidatedChapter[] } | { ok: false; fieldErrors: FieldErrors } {
  const errors: FieldErrors = {};
  if (!Array.isArray(raw)) {
    return { ok: false, fieldErrors: { chapters: 'Список глав должен быть массивом' } };
  }
  if (raw.length < 1) {
    return { ok: false, fieldErrors: { chapters: 'Добавьте хотя бы одну главу' } };
  }
  if (raw.length > maxChapters) {
    return {
      ok: false,
      fieldErrors: { chapters: `Не больше ${maxChapters} глав за одну заявку` },
    };
  }

  const seen = new Set<number>();
  let totalBytes = 0;
  const chapters: ValidatedChapter[] = [];

  for (let i = 0; i < raw.length; i += 1) {
    const item = (raw[i] ?? {}) as ChapterDraftInput;
    const at = `chapters.${i}`;

    const rawNumber =
      typeof item.number === 'number' ? item.number : Number(asTrimmedString(item.number));
    if (!Number.isFinite(rawNumber) || rawNumber <= 0) {
      errors[`${at}.number`] = 'Номер главы — положительное число';
    } else if (!Number.isInteger(rawNumber)) {
      errors[`${at}.number`] = 'Номер главы должен быть целым';
    } else if (rawNumber > CHAPTER_NUMBER_MAX) {
      errors[`${at}.number`] = `Номер главы не больше ${CHAPTER_NUMBER_MAX}`;
    } else if (seen.has(rawNumber)) {
      errors[`${at}.number`] = `Номер ${rawNumber} повторяется в заявке`;
    } else {
      seen.add(rawNumber);
    }

    const name = asTrimmedString(item.name);
    if (name.length > CHAPTER_NAME_MAX) {
      errors[`${at}.name`] = `Не длиннее ${CHAPTER_NAME_MAX} символов`;
    } else if (name && containsDangerousScheme(name)) {
      errors[`${at}.name`] = 'Ссылки в названии запрещены';
    }

    const description = asTrimmedString(item.description);
    if (description.length > CHAPTER_DESCRIPTION_MAX) {
      errors[`${at}.description`] = `Не длиннее ${CHAPTER_DESCRIPTION_MAX} символов`;
    } else if (description && containsDangerousScheme(description)) {
      errors[`${at}.description`] = 'Ссылки в описании запрещены';
    }

    const rawPages = Array.isArray(item.pages) ? item.pages : [];
    if (rawPages.length < 1) {
      errors[`${at}.pages`] = 'В главе должна быть хотя бы одна страница';
    } else if (rawPages.length > MAX_PAGES_PER_CHAPTER) {
      errors[`${at}.pages`] = `Не больше ${MAX_PAGES_PER_CHAPTER} страниц в главе`;
    }

    const pages: ValidatedChapterPage[] = [];
    const pageIndexes = new Set<number>();
    for (let p = 0; p < rawPages.length; p += 1) {
      const decl = (rawPages[p] ?? {}) as ChapterPageDecl;
      const pageName = asTrimmedString(decl.name);
      const parsed = pageName ? parseSubmittedPageName(pageName) : null;
      const key = `${at}.pages.${p}`;
      if (!parsed) {
        errors[key] = `Имя страницы должно быть вида ch-${'{n}'}-page-${'{m}'}`;
        continue;
      }
      if (Number.isFinite(rawNumber) && parsed.chapter !== rawNumber) {
        errors[key] = `Имя страницы относится к главе ${parsed.chapter}, а не ${rawNumber}`;
        continue;
      }
      if (pageIndexes.has(parsed.page)) {
        errors[key] = `Страница ${parsed.page} повторяется`;
        continue;
      }
      pageIndexes.add(parsed.page);

      const ext = extOf(pageName);
      if (!isAllowedPageExt(ext)) {
        errors[key] = `Формат страницы не поддерживается: ${ext || 'без расширения'}`;
        continue;
      }
      const size = Number(decl.size);
      if (!Number.isFinite(size) || size <= 0) {
        errors[key] = 'Размер страницы неизвестен';
        continue;
      }
      if (size > PAGE_IMAGE_MAX_BYTES) {
        errors[key] = `Страница больше ${PAGE_IMAGE_MAX_BYTES / 1024 / 1024} MB`;
        continue;
      }
      totalBytes += size;
      pages.push({ index: parsed.page, name: pageName, size, ext });
    }

    // pdf: строка (только имя части) или { name, size } — форма нашего клиента.
    // Размер нужен, чтобы суммарный объём заявки считался одинаково на клиенте
    // и на сервере: PDF грузится отдельной частью вдобавок к страницам.
    let pdfName = '';
    let pdfSize = 0;
    if (typeof item.pdf === 'string') {
      pdfName = item.pdf.trim();
    } else if (item.pdf && typeof item.pdf === 'object') {
      const obj = item.pdf as { name?: unknown; size?: unknown };
      pdfName = asTrimmedString(obj.name);
      const declared = Number(obj.size);
      pdfSize = Number.isFinite(declared) && declared > 0 ? declared : 0;
    }
    let pdf: { name: string; size: number } | null = null;
    if (pdfName) {
      if (parseSubmittedPdfName(pdfName) === null) {
        errors[`${at}.pdf`] = 'Имя PDF должно быть вида ch-{n}.pdf';
      } else if (Number.isFinite(rawNumber) && parseSubmittedPdfName(pdfName) !== rawNumber) {
        errors[`${at}.pdf`] = 'PDF относится к другой главе';
      } else {
        pdf = { name: pdfName, size: pdfSize };
        totalBytes += pdfSize;
      }
    }

    pages.sort((a, b) => a.index - b.index);
    chapters.push({
      number: Number.isFinite(rawNumber) ? rawNumber : Number.NaN,
      name: name || null,
      description: description || null,
      pages,
      pdf,
    });
  }

  if (totalBytes > MAX_TOTAL_BYTES) {
    errors.total = `Суммарный размер больше ${MAX_TOTAL_BYTES / 1024 / 1024} MB`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  return { ok: true, chapters };
}

/** Полная валидация payload заявки на главы (title_id + chapters). */
export function validateChaptersPayload(
  raw: unknown,
  maxChapters = MAX_CHAPTERS_PER_REQUEST
): ChaptersPayloadCheck {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, fieldErrors: { payload: 'Некорректный payload' } };
  }
  const p = raw as Record<string, unknown>;
  const errors: FieldErrors = {};

  const titleId = asTrimmedString(p.title_id);
  if (!titleId) errors.title_id = 'Выберите тайтл';
  else if (!/^[0-9a-fA-F-]{8,64}$|^t-\d+$/.test(titleId)) errors.title_id = 'Некорректный id тайтла';

  const titleName = asTrimmedString(p.title_name);
  if (titleName.length > CHAPTER_NAME_MAX) errors.title_name = 'Слишком длинное название';

  const checked = validateChapters(p.chapters, maxChapters);
  if (!checked.ok) Object.assign(errors, checked.fieldErrors);
  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };

  return {
    ok: true,
    titleId,
    titleName: titleName || null,
    chapters: (checked as { chapters: ValidatedChapter[] }).chapters,
  };
}

// ── Сверка файлов с payload ──────────────────────────────────────────────────

export type FileCheckResult =
  | {
      ok: true;
      pages: Array<{ chapter: number; index: number; file: ChapterFilePart; ext: string }>;
      pdfs: Array<{ chapter: number; file: ChapterFilePart }>;
      /** Суммарный размер присланных файлов (страницы + PDF). */
      actualBytes: number;
    }
  | { ok: false; fieldErrors: FieldErrors };

/**
 * Каждая declared-страница обязана приехать файлом, лишний файл — ошибка
 * (иначе в submissions остаётся мусор, который никто не удалит).
 * PDF проверяется только на размер и имя: разбивка на страницы делается
 * на клиенте (pdfjs), на сервере pdf-библиотеки нет.
 */
export function checkChapterFiles(
  files: ChapterFilePart[],
  chapters: ValidatedChapter[]
): FileCheckResult {
  const errors: FieldErrors = {};
  const declared = new Map<string, { chapter: number; index: number; ext: string }>();
  for (const ch of chapters) {
    for (const page of ch.pages) {
      declared.set(`${ch.number}:${page.index}`, {
        chapter: ch.number,
        index: page.index,
        ext: page.ext,
      });
      if (!files.some((f) => f.name === page.name)) {
        errors[`chapters.${ch.number}.pages.${page.index}`] =
          `Нет файла для страницы ${page.index} (${page.name})`;
      }
    }
  }

  const chapterNumbers = new Set(chapters.map((c) => c.number));
  const declaredPdfs = new Map<number, { name: string; size: number }>();
  for (const ch of chapters) {
    if (!ch.pdf) continue;
    declaredPdfs.set(ch.number, ch.pdf);
    if (!files.some((f) => f.name === ch.pdf!.name)) {
      errors[`chapters.${ch.number}.pdf`] = `Нет файла для PDF (${ch.pdf.name})`;
    }
  }

  const pages: Array<{ chapter: number; index: number; file: ChapterFilePart; ext: string }> = [];
  const pdfs: Array<{ chapter: number; file: ChapterFilePart }> = [];
  const seenPages = new Set<string>();
  /** Фактический объём принятых частей — сверяется с MAX_TOTAL_BYTES. */
  let actualBytes = 0;

  for (const file of files) {
    if (file.bytes.length <= 0) {
      errors[file.name] = 'Пустой файл';
      continue;
    }
    const pdfChapter = parseSubmittedPdfName(file.name);
    if (pdfChapter !== null) {
      if (!chapterNumbers.has(pdfChapter)) {
        errors[file.name] = `PDF относится к главе ${pdfChapter}, которой нет в заявке`;
        continue;
      }
      const declaredPdf = declaredPdfs.get(pdfChapter);
      if (!declaredPdf) {
        errors[file.name] = 'PDF не объявлен в payload главы';
        continue;
      }
      if (declaredPdf.name !== file.name) {
        errors[file.name] = `В payload объявлен ${declaredPdf.name}, прислан ${file.name}`;
        continue;
      }
      if (file.bytes.length > PDF_MAX_BYTES) {
        errors[file.name] = `PDF больше ${PDF_MAX_BYTES / 1024 / 1024} MB`;
        continue;
      }
      actualBytes += file.bytes.length;
      pdfs.push({ chapter: pdfChapter, file });
      continue;
    }

    const parsed = parseSubmittedPageName(file.name);
    if (!parsed) {
      errors[file.name] = 'Неизвестное имя файла (ожидалось ch-{n}-page-{m} или ch-{n}.pdf)';
      continue;
    }
    const key = `${parsed.chapter}:${parsed.page}`;
    const decl = declared.get(key);
    if (!decl) {
      errors[file.name] = `Файл не объявлен в payload (глава ${parsed.chapter}, страница ${parsed.page})`;
      continue;
    }
    if (seenPages.has(key)) {
      errors[file.name] = 'Два файла для одной страницы';
      continue;
    }
    seenPages.add(key);
    if (extOf(file.name) !== decl.ext) {
      errors[file.name] = 'Расширение файла не совпадает с объявленным';
      continue;
    }
    if (file.bytes.length > PAGE_IMAGE_MAX_BYTES) {
      errors[file.name] = `Страница больше ${PAGE_IMAGE_MAX_BYTES / 1024 / 1024} MB`;
      continue;
    }
    actualBytes += file.bytes.length;
    pages.push({ chapter: parsed.chapter, index: parsed.page, file, ext: decl.ext });
  }

  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  pages.sort((a, b) => a.chapter - b.chapter || a.index - b.index);
  return { ok: true, pages, pdfs, actualBytes };
}

// ── Оркестрация подачи заявки ────────────────────────────────────────────────

/**
 * Полный флоу submit-chapters с подставляемыми зависимостями.
 * Порядок — как в processSubmission (submit-title): rate limit ДО капчи,
 * затем согласие, капча, payload, целевой тайтл, файлы, upload, INSERT.
 */
export async function processChapterSubmission(
  deps: ChapterSubmissionDeps,
  input: ChapterSubmissionInput
): Promise<SubmissionResult> {
  const token = (deps.randomToken ?? randomToken)();

  for (const { windowSeconds, limit } of CHAPTER_RATE_LIMITS) {
    const allowed = await deps.checkLimit(windowSeconds, limit);
    if (!allowed) {
      return {
        status: 429,
        body: {
          ok: false,
          error: 'rate_limited',
          message: 'Слишком много заявок на главы с одного адреса. Попробуйте позже.',
        },
        retryAfter: windowSeconds <= 60 ? 60 : Math.min(windowSeconds, 3600),
      };
    }
  }

  if (input.consent !== true) {
    return { status: 400, body: { ok: false, error: 'consent_required' } };
  }

  if (!input.captchaToken) {
    return { status: 400, body: { ok: false, error: 'captcha_missing' } };
  }
  const captcha = await deps.verifyCaptcha(input.captchaToken, input.ip);
  if (!captcha.ok) {
    return { status: 400, body: { ok: false, error: 'captcha_failed', detail: captcha.error } };
  }

  const checked = validateChaptersPayload(input.payloadRaw);
  if (!checked.ok) {
    return { status: 400, body: { ok: false, error: 'validation_failed', fields: checked.fieldErrors } };
  }
  const { titleId, chapters } = checked;

  // Главы принимаются только к опубликованному тайтлу: иначе заявка указывала
  // бы на черновик/несуществующий id, и approve создал бы главы «в никуда».
  const title = await deps.lookupTitle(titleId);
  if (!title) {
    return {
      status: 400,
      body: { ok: false, error: 'validation_failed', fields: { title_id: 'Тайтл не найден' } },
    };
  }
  if (!title.published) {
    return {
      status: 400,
      body: {
        ok: false,
        error: 'validation_failed',
        fields: { title_id: 'Тайтл ещё не опубликован — главы предложить нельзя' },
      },
    };
  }

  const files = checkChapterFiles(input.files, chapters);
  if (!files.ok) {
    return { status: 400, body: { ok: false, error: 'validation_failed', fields: files.fieldErrors } };
  }
  // Объявленные размеры могут не совпадать с присланными — проверяем факт.
  if (files.actualBytes > MAX_TOTAL_BYTES) {
    return {
      status: 400,
      body: {
        ok: false,
        error: 'validation_failed',
        fields: { total: `Суммарный размер больше ${MAX_TOTAL_BYTES / 1024 / 1024} MB` },
      },
    };
  }

  const payload: ChapterSubmissionPayload = {
    title_id: titleId,
    title_name: checked.titleName ?? title.title,
    chapters: chapters.map((ch) => ({
      number: ch.number,
      name: ch.name,
      description: ch.description,
      pages: ch.pages.map((p) => ({
        index: p.index,
        path: submissionPagePath(token, ch.number, p.index, p.ext),
        size: p.size,
      })),
      pdf: ch.pdf ? submissionPdfPath(token, ch.number) : null,
    })),
  };

  try {
    for (const page of files.pages) {
      await deps.uploadPage(
        page.file.bytes,
        token,
        submissionPagePath(token, page.chapter, page.index, page.ext),
        page.file.contentType
      );
    }
    for (const pdf of files.pdfs) {
      await deps.uploadPage(
        pdf.file.bytes,
        token,
        submissionPdfPath(token, pdf.chapter),
        pdf.file.contentType ?? 'application/pdf'
      );
    }
  } catch (e) {
    return {
      status: 500,
      body: {
        ok: false,
        error: 'page_upload_failed',
        detail: e instanceof Error ? e.message : String(e),
      },
    };
  }

  let inserted: { id: string };
  try {
    inserted = await deps.insertRequest({
      type: 'new_chapters',
      status: 'pending',
      payload: { ...payload, consent: true },
      ip_hash: await deps.hashIp(input.ip),
      user_agent: input.userAgent ?? null,
      turnstile_ok: true,
      public_token: token,
      submitter_email: asTrimmedString(input.email) || null,
      target_id: titleId,
      target_name: payload.title_name,
    });
  } catch (e) {
    return {
      status: 500,
      body: { ok: false, error: 'insert_failed', detail: e instanceof Error ? e.message : String(e) },
    };
  }

  return { status: 200, body: { ok: true, token, id: inserted.id } };
}

// ── Финализация (approve) ────────────────────────────────────────────────────

export interface FinalizeRow {
  id: string;
  type: string;
  status: string;
  target_id: string | null;
  payload: Record<string, unknown>;
  finalized_at: string | null;
}

export interface FinalizedChapterMark {
  finalized_chapter_id?: string;
  finalized_number?: number;
  finalized_pages?: number;
  /**
   * false = глава создана, но страницы перенесены не все (сбой посреди главы).
   * undefined при наличии finalized_chapter_id = старый формат payload,
   * считаем главу завершённой.
   */
  finalized_done?: boolean;
  /** Пути уже перенесённых страниц — при повторе не копируем их дважды. */
  finalized_source_paths?: string[];
}

export type FinalizeDeps = {
  getRequest: (id: string) => Promise<FinalizeRow | null>;
  /** Сохранить прогресс по главам (payload) — для возобновления после сбоя. */
  checkpoint: (id: string, payload: Record<string, unknown>) => Promise<void>;
  /** Проставить finalized_at и финальный payload. */
  finish: (id: string, payload: Record<string, unknown>) => Promise<void>;
  /** Записать finalized_error (заявка остаётся approved, импорт можно повторить). */
  fail: (id: string, message: string) => Promise<void>;
  /** Уже занятые номера глав тайтла. */
  takenNumbers: (titleId: string) => Promise<number[]>;
  createChapter: (input: {
    title_id: string;
    number: number;
    name: string | null;
    description: string | null;
  }) => Promise<{ id: string }>;
  /** Скопировать объект submissions → manga; возвращает публичный image_url. */
  copyPage: (
    sourcePath: string,
    target: { chapterId: string; order: number; ext: string }
  ) => Promise<string>;
  insertPage: (input: {
    chapter_id: string;
    image_url: string;
    original_url: string | null;
    page_order: number;
  }) => Promise<void>;
  /** Удалить исходники из submissions (best effort). */
  removeSources: (paths: string[]) => Promise<void>;
  now?: () => string;
};

export interface FinalizeResult {
  status: number;
  body: Record<string, unknown>;
}

type PayloadChapter = {
  number?: unknown;
  name?: unknown;
  description?: unknown;
  pages?: unknown;
  pdf?: unknown;
} & FinalizedChapterMark;

/**
 * Перенос файлов одобренной заявки в manga/.
 *
 * Идемпотентность: главы с payload.finalized_chapter_id пропускаются, а после
 * финала ставится finalized_at — повторный вызов возвращает skipped=true и
 * ничего не создаёт. Промежуточный сбой оставляет заявку approved с
 * finalized_error и кнопкой «Завершить импорт» в /admin/requests.
 */
// TODO(бэклог, см. SETUP_SUPABASE.md §10.5): (A) два параллельных вызова на
// одной заявке не сериализуются — UNIQUE (title_id, number) не даёт двух глав с
// одним номером, но resolveChapterNumber может выдать сдвинутый номер; лечится
// статусом `finalizing` + условным UPDATE или advisory lock. (B) сбой UPDATE
// payload сразу после INSERT главы оставляет главу без отметки → повтор
// создаст её заново.
export async function finalizeChapterSubmission(
  deps: FinalizeDeps,
  input: { requestId: string }
): Promise<FinalizeResult> {
  const id = (input.requestId ?? '').trim();
  if (!id) return { status: 400, body: { ok: false, error: 'request_id_required' } };

  let row: FinalizeRow | null;
  try {
    row = await deps.getRequest(id);
  } catch (e) {
    return { status: 500, body: { ok: false, error: 'lookup_failed', detail: String(e) } };
  }
  if (!row) return { status: 404, body: { ok: false, error: 'not_found' } };

  // Идемпотентность: уже завершённый импорт не повторяем.
  if (row.finalized_at) {
    return { status: 200, body: { ok: true, skipped: true, finalized_at: row.finalized_at } };
  }
  if (row.status !== 'approved') {
    return { status: 409, body: { ok: false, error: 'not_approved' } };
  }
  if (row.type !== 'new_chapters' && row.type !== 'new_title') {
    return { status: 400, body: { ok: false, error: 'unsupported_type' } };
  }

  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const rawChapters = Array.isArray(payload.chapters) ? (payload.chapters as PayloadChapter[]) : [];

  // Заявка на тайтл без глав (или тайтл создан без них) — нечего переносить.
  if (rawChapters.length === 0) {
    await deps.finish(id, { ...payload, finalized: { chapters_imported: 0, pages_imported: 0 } });
    return { status: 200, body: { ok: true, skipped: true, reason: 'no_chapters' } };
  }

  // Для new_title тайтл создаёт SQL-триггер apply_admin_request (миграция 14)
  // и кладёт id в payload.created_title_id; для new_chapters — target_id.
  const createdTitleId =
    typeof payload.created_title_id === 'string' ? payload.created_title_id : null;
  const titleId = createdTitleId ?? row.target_id;
  if (!titleId) {
    const message =
      row.type === 'new_title'
        ? 'Черновик тайтла не создан (slug занят) — главы не импортированы'
        : 'В заявке нет тайтла';
    await deps.fail(id, message);
    return { status: 409, body: { ok: false, error: 'target_title_missing', message } };
  }

  let taken: number[];
  try {
    taken = await deps.takenNumbers(titleId);
  } catch (e) {
    await deps.fail(id, `Не удалось прочитать главы тайтла: ${String(e)}`);
    return { status: 500, body: { ok: false, error: 'chapters_lookup_failed' } };
  }

  const chapters = rawChapters.slice();
  const renumbered: Array<{ requested: number; created: number }> = [];
  let pagesImported = 0;
  let chaptersImported = 0;

  try {
    for (let i = 0; i < chapters.length; i += 1) {
      const ch = chapters[i];
      const resumedId =
        typeof ch.finalized_chapter_id === 'string' && ch.finalized_chapter_id
          ? ch.finalized_chapter_id
          : null;

      // Полностью перенесённая предыдущим запуском глава — пропускаем целиком.
      // finalized_done === undefined при существующем id = payload старого
      // формата (до чекпоинта после createChapter) → тоже считаем готовой.
      if (resumedId && ch.finalized_done !== false) {
        chaptersImported += 1;
        pagesImported += typeof ch.finalized_pages === 'number' ? ch.finalized_pages : 0;
        continue;
      }

      const requested = Number(ch.number);
      if (!Number.isFinite(requested) || requested <= 0) {
        throw new Error(`Глава #${i + 1}: некорректный номер`);
      }
      const pages = Array.isArray(ch.pages) ? (ch.pages as Array<Record<string, unknown>>) : [];
      const sorted = pages
        .map((p, idx) => ({
          path: typeof p.path === 'string' ? p.path : '',
          index: Number(p.index) || idx + 1,
        }))
        .filter((p) => p.path)
        .sort((a, b) => a.index - b.index);

      let chapterId = resumedId;
      let chapterNumber = Number(ch.finalized_number) || 0;

      if (!chapterId) {
        chapterNumber = resolveChapterNumber(requested, taken);
        if (chapterNumber !== requested) {
          renumbered.push({ requested, created: chapterNumber });
        }
        const created = await deps.createChapter({
          title_id: titleId,
          number: chapterNumber,
          name: typeof ch.name === 'string' && ch.name ? ch.name : null,
          description: typeof ch.description === 'string' && ch.description ? ch.description : null,
        });
        chapterId = created.id;

        // ЧЕКПОИНТ СРАЗУ после INSERT главы, до загрузки страниц. Без него
        // сбой на copyPage/insertPage оставил бы главу в БД без отметки, и
        // повторный вызов создал бы вторую (первая — сирота без страниц).
        chapters[i] = {
          ...ch,
          finalized_chapter_id: chapterId,
          finalized_number: chapterNumber,
          finalized_pages: 0,
          finalized_source_paths: [],
          finalized_done: false,
        };
        await deps.checkpoint(id, { ...payload, chapters: chapters.slice() });
      } else if (chapterNumber > 0 && !taken.includes(chapterNumber)) {
        // Номер возобновляемой главы не должен достаться следующей главе заявки.
        taken.push(chapterNumber);
      }

      // Страницы, перенесённые до сбоя, не копируем повторно; order продолжаем
      // с конца — порядок страниц в главе всегда плотный 1..N.
      const copied = new Set<string>(
        Array.isArray(ch.finalized_source_paths) ? (ch.finalized_source_paths as string[]) : []
      );
      // В sources сразу кладём и уже перенесённые страницы: при повторе их
      // исходники всё ещё лежат в submissions (прошлый запуск до removeSources
      // не дошёл), иначе файл остался бы сиротой до ручной чистки бакета.
      const sources: string[] = [...copied];
      let order = copied.size + 1;
      for (const page of sorted) {
        if (copied.has(page.path)) continue;
        const ext = extOf(page.path) || 'webp';
        const imageUrl = await deps.copyPage(page.path, {
          chapterId,
          order,
          ext,
        });
        await deps.insertPage({
          chapter_id: chapterId,
          image_url: imageUrl,
          original_url: null,
          page_order: order,
        });
        copied.add(page.path);
        order += 1;
        // Прогресс держим в памяти и пишем в payload в catch: чекпоинт на
        // каждую страницу — лишний UPDATE на 100 страниц главы.
        chapters[i] = { ...chapters[i], finalized_source_paths: [...copied] };
      }

      // Оригинал PDF — не страница: строка в pages указывала бы ридеру на PDF.
      // Он нужен был только модератору, поэтому вместе с остальными исходниками
      // уходит в корзину (cron добьёт, если удаление не сработало).
      const pdfName =
        typeof ch.pdf === 'string'
          ? ch.pdf
          : ((ch.pdf as { name?: string } | null)?.name ?? '');
      if (pdfName) sources.push(pdfName);
      // Важно: sources стартовал со снапшотом copied ДО цикла, поэтому сюда
      // дописываются страницы, перенесённые в ЭТОМ проходе (включая случай
      // возобновления). Без этой строки повтор не удалит их из submissions.
      sources.push(...[...copied].filter((path) => !sources.includes(path)));

      // Исходники удаляем ПОСЛЕ успешного переноса главы: при сбое следующей
      // главы уже перенесённые файлы не теряются и не копируются дважды.
      try {
        await deps.removeSources(sources);
      } catch {
        // cleanup не критичен: бакет submissions чистит cron через 90 дней
      }

      chapters[i] = {
        ...chapters[i],
        finalized_chapter_id: chapterId,
        finalized_number: chapterNumber,
        finalized_pages: copied.size,
        finalized_done: true,
      };
      chaptersImported += 1;
      pagesImported += copied.size;
      // checkpoint: повторный вызов продолжит со следующей главы
      await deps.checkpoint(id, { ...payload, chapters: chapters.slice() });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await deps.checkpoint(id, { ...payload, chapters: chapters.slice() }).catch(() => undefined);
    await deps.fail(id, message);
    return { status: 500, body: { ok: false, error: 'finalize_failed', detail: message } };
  }

  const finalPayload = {
    ...payload,
    chapters: chapters.slice(),
    finalized: { chapters_imported: chaptersImported, pages_imported: pagesImported, renumbered },
  };
  await deps.finish(id, finalPayload);

  return {
    status: 200,
    body: {
      ok: true,
      chapters_imported: chaptersImported,
      pages_imported: pagesImported,
      renumbered,
    },
  };
}

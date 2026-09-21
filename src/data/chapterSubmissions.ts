import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/integrations/supabase/config';
import { getSupabase, isSupabaseConfigured } from './client';
import type { AdminRequest } from './types';
import type { EditorChapter } from '@/components/requests/ChaptersEditor';
// Лимиты — из ядра edge-функций: клиент и сервер не должны разъезжаться.
import {
  MAX_CHAPTERS_PER_REQUEST,
  MAX_PAGES_PER_CHAPTER,
  MAX_TOTAL_BYTES,
  PDF_MAX_BYTES,
} from '../../supabase/functions/_shared/chapterSubmissionCore';

/**
 * Клиентский слой заявок на главы.
 *
 * Прод: edge-функции submit-chapters (подача) и finalize-chapter-submission
 * (перенос файлов при approve) — клиент не пишет в admin_requests напрямую,
 * RLS запрещает анонимный INSERT, а перенос между бакетами доступен только
 * service_role.
 *
 * Демо (без Supabase): тот же localStorage-инбокс, что у submissions.ts
 * (manga_admin_requests), чтобы модерация работала в dev/превью.
 */

const DEMO_KEY = 'manga_admin_requests';

export interface ChapterSubmitResult {
  ok: boolean;
  token?: string;
  id?: string;
  error?: string;
  message?: string;
  retryAfter?: number;
  fields?: Record<string, string>;
}

export interface PreparedChapter {
  number: number;
  name: string | null;
  description: string | null;
  pages: Array<{ name: string; size: number; file: File }>;
  pdf: { name: string; size: number; file: File } | null;
}

export type PrepareResult =
  | { ok: true; chapters: PreparedChapter[]; totalBytes: number }
  | { ok: false; error: string };

function demoList(): AdminRequest[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    return raw ? (JSON.parse(raw) as AdminRequest[]) : [];
  } catch {
    return [];
  }
}

function demoSave(list: AdminRequest[]) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

function demoToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : 'webp';
}

/**
 * PDF главы → страницы WebP на клиенте (pdfjs грузится dynamic import,
 * в initial-бандл не попадает). Лимит страниц — MAX_PDF_PAGES из pdfToPages.
 */
async function expandPdf(file: File, onProgress?: (done: number, total: number) => void): Promise<File[]> {
  const { iteratePdfPages } = await import('@/lib/pdfToPages');
  const out: File[] = [];
  let total = 0;
  for await (const page of iteratePdfPages(file, {
    onProgress: (done, n) => {
      total = n;
      onProgress?.(done, n);
    },
  })) {
    out.push(
      new File([page.blob], `${file.name.replace(/\.pdf$/i, '')}-${page.index}.webp`, {
        type: 'image/webp',
      })
    );
  }
  if (out.length === 0) throw new Error(`PDF \`${file.name}\` не содержит страниц`);
  void total;
  return out;
}

/**
 * Главы из редактора → готовый к отправке набор частей multipart.
 * PDF разбивается, страницы сортируются и получают канонические имена
 * ch-{n}-page-{m}.{ext}; лимиты ТЗ проверяются ДО отправки.
 */
export async function prepareChaptersForSubmit(
  chapters: EditorChapter[],
  onProgress?: (chapterNumber: number, done: number, total: number) => void
): Promise<PrepareResult> {
  if (chapters.length === 0) return { ok: false, error: 'Добавьте хотя бы одну главу' };
  if (chapters.length > MAX_CHAPTERS_PER_REQUEST) {
    return { ok: false, error: `Не больше ${MAX_CHAPTERS_PER_REQUEST} глав за одну заявку` };
  }

  const seen = new Set<number>();
  const prepared: PreparedChapter[] = [];
  let totalBytes = 0;

  for (const chapter of chapters) {
    const number = Number(chapter.number);
    if (!Number.isFinite(number) || number <= 0) return { ok: false, error: 'Укажите номер каждой главы' };
    if (seen.has(number)) return { ok: false, error: `Номер главы ${number} повторяется` };
    seen.add(number);

    let files = chapter.pages.filter((p) => !p.error).map((p) => p.file);
    if (chapter.pdf) {
      if (chapter.pdf.size > PDF_MAX_BYTES) {
        return { ok: false, error: `PDF главы ${number} больше ${PDF_MAX_BYTES / 1024 / 1024} MB` };
      }
      try {
        const fromPdf = await expandPdf(chapter.pdf, (done, n) => onProgress?.(number, done, n));
        files = [...files, ...fromPdf];
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'Не удалось разобрать PDF' };
      }
    }
    if (files.length === 0) return { ok: false, error: `В главе ${number} нет страниц` };
    if (files.length > MAX_PAGES_PER_CHAPTER) {
      return {
        ok: false,
        error: `Глава ${number}: ${files.length} страниц, лимит ${MAX_PAGES_PER_CHAPTER}`,
      };
    }

    const pages = files.map((file, i) => {
      const name = `ch-${number}-page-${i + 1}.${extOf(file.name)}`;
      totalBytes += file.size;
      return { name, size: file.size, file: new File([file], name, { type: file.type }) };
    });

    const pdf = chapter.pdf
      ? {
          name: `ch-${number}.pdf`,
          size: chapter.pdf.size,
          file: new File([chapter.pdf], `ch-${number}.pdf`, { type: 'application/pdf' }),
        }
      : null;
    if (pdf) totalBytes += pdf.size;

    prepared.push({
      number,
      name: chapter.name.trim() || null,
      description: chapter.description.trim() || null,
      pages,
      pdf,
    });
  }

  if (totalBytes > MAX_TOTAL_BYTES) {
    return { ok: false, error: `Суммарный объём больше ${MAX_TOTAL_BYTES / 1024 / 1024} MB` };
  }
  return { ok: true, chapters: prepared, totalBytes };
}

/**
 * Демо-превью первой страницы: мелкие файлы — data-URL (переживут
 * перезагрузку), крупные — blob-URL сессии. Вне браузера (SSR/тесты слоя
 * данных) превью нет — возвращаем имя файла, заявка при этом полноценна.
 */
async function demoPreviewUrl(file: File): Promise<string> {
  if (typeof FileReader === 'undefined') return file.name;
  if (file.size > 150 * 1024) {
    return typeof URL?.createObjectURL === 'function' ? URL.createObjectURL(file) : file.name;
  }
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export const chapterSubmissions = {
  /** Подать заявку «Предложить главу». */
  async submit(input: {
    titleId: string;
    titleName: string;
    chapters: PreparedChapter[];
    captchaToken: string;
    consent: boolean;
    email?: string;
  }): Promise<ChapterSubmitResult> {
    if (isSupabaseConfigured) {
      const form = new FormData();
      form.append('turnstileToken', input.captchaToken);
      form.append('consent', input.consent ? 'on' : '');
      if (input.email?.trim()) form.append('email', input.email.trim());
      form.append(
        'payload',
        JSON.stringify({
          title_id: input.titleId,
          title_name: input.titleName,
          chapters: input.chapters.map((ch) => ({
            number: ch.number,
            name: ch.name,
            description: ch.description,
            pages: ch.pages.map((p) => ({ name: p.name, size: p.size })),
            // { name, size } — по размеру сервер считает суммарный объём заявки
            pdf: ch.pdf ? { name: ch.pdf.name, size: ch.pdf.size } : null,
          })),
        })
      );
      for (const ch of input.chapters) {
        for (const page of ch.pages) form.append(page.name, page.file);
        if (ch.pdf) form.append(ch.pdf.name, ch.pdf.file);
      }

      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/submit-chapters`, {
          method: 'POST',
          headers: { apikey: SUPABASE_ANON_KEY },
          body: form,
        });
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('Retry-After')) || 60;
          const body = await res.json().catch(() => ({}));
          return {
            ok: false,
            error: 'rate_limited',
            retryAfter,
            message:
              (body as { message?: string }).message ??
              `Слишком часто. Попробуйте через ${retryAfter} сек.`,
          };
        }
        const body = (await res.json().catch(() => ({}))) as ChapterSubmitResult;
        if (!res.ok) {
          return {
            ok: false,
            error: body.error ?? 'internal',
            fields: body.fields,
            message: body.message,
          };
        }
        return body;
      } catch (e) {
        return {
          ok: false,
          error: 'network',
          message:
            e instanceof Error
              ? `Не удалось связаться с сервером: ${e.message}`
              : 'Не удалось связаться с сервером',
        };
      }
    }

    // ── Демо: заявка в тот же localStorage-инбокс, что у adminRequests ──
    const token = demoToken();
    const payloadChapters = [] as Array<Record<string, unknown>>;
    for (const ch of input.chapters) {
      const pages: Array<Record<string, unknown>> = [];
      for (let i = 0; i < ch.pages.length; i += 1) {
        const page = ch.pages[i];
        pages.push({
          index: i + 1,
          path: i === 0 ? await demoPreviewUrl(page.file) : page.name,
          size: page.size,
        });
      }
      payloadChapters.push({
        number: ch.number,
        name: ch.name,
        description: ch.description,
        pages,
        pdf: ch.pdf ? { name: ch.pdf.name, size: ch.pdf.size } : null,
      });
    }
    const row: AdminRequest = {
      id: 'anon-ch-' + Date.now(),
      type: 'new_chapters',
      requester_id: null,
      target_id: input.titleId,
      target_name: input.titleName,
      payload: {
        title_id: input.titleId,
        title_name: input.titleName,
        chapters: payloadChapters,
        consent: input.consent,
      },
      status: 'pending',
      ip_hash: 'demo-anonymous',
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : 'demo',
      turnstile_ok: true,
      public_token: token,
      submitter_email: input.email?.trim() || null,
      created_at: new Date().toISOString(),
    };
    const list = demoList();
    list.unshift(row);
    demoSave(list);
    console.info('[demo] заявка на главы подана (localStorage):', input.titleName);
    return { ok: true, token, id: row.id };
  },

  /**
   * Завершить импорт одобренной заявки: создать главы, перенести страницы
   * из submissions в manga, проставить finalized_at. Идемпотентна.
   */
  async finalize(requestId: string): Promise<{
    ok: boolean;
    skipped?: boolean;
    chapters_imported?: number;
    pages_imported?: number;
    renumbered?: Array<{ requested: number; created: number }>;
    error?: string;
    message?: string;
  }> {
    if (!isSupabaseConfigured) {
      const list = demoList();
      const idx = list.findIndex((r) => r.id === requestId);
      if (idx < 0) return { ok: false, error: 'not_found' };
      const row = list[idx];
      if (row.finalized_at) return { ok: true, skipped: true };
      if (row.status !== 'approved') return { ok: false, error: 'not_approved' };

      const { chapters: chaptersApi } = await import('./chapters');
      const { pages: pagesApi } = await import('./pages');
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const rawChapters = Array.isArray(payload.chapters)
        ? (payload.chapters as Array<Record<string, unknown>>)
        : [];
      const titleId = row.target_id ?? String(payload.created_title_id ?? '');
      if (!titleId) return { ok: false, error: 'target_title_missing' };

      const existing = await chaptersApi.listByTitle(titleId, true);
      const taken = existing.map((c) => Number(c.number));
      let pagesImported = 0;
      const updated = rawChapters.slice();

      for (let i = 0; i < updated.length; i += 1) {
        const ch = updated[i];
        if (typeof ch.finalized_chapter_id === 'string') continue;
        let number = Number(ch.number);
        while (taken.includes(number)) number += 1;
        taken.push(number);
        const created = await chaptersApi.create({
          title_id: titleId,
          number,
          name: typeof ch.name === 'string' && ch.name ? ch.name : null,
          description: typeof ch.description === 'string' && ch.description ? ch.description : null,
          published: false,
        });
        const pages = Array.isArray(ch.pages) ? (ch.pages as Array<Record<string, unknown>>) : [];
        let order = 1;
        for (const page of pages) {
          await pagesApi.create({
            chapter_id: created.id,
            image_url: String(page.path ?? ''),
            original_url: null,
            page_order: order,
          });
          order += 1;
          pagesImported += 1;
        }
        updated[i] = { ...ch, finalized_chapter_id: created.id, finalized_number: number };
      }

      list[idx] = {
        ...row,
        payload: { ...payload, chapters: updated },
        finalized_at: new Date().toISOString(),
        finalized_error: undefined,
      };
      demoSave(list);
      return { ok: true, chapters_imported: updated.length, pages_imported: pagesImported };
    }

    try {
      const supabase = await getSupabase();
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return { ok: false, error: 'unauthorized', message: 'Нет сессии администратора' };

      const res = await fetch(`${SUPABASE_URL}/functions/v1/finalize-chapter-submission`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ request_id: requestId }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        return {
          ok: false,
          error: String(body.error ?? 'internal'),
          message: typeof body.message === 'string' ? body.message : undefined,
        };
      }
      return body as { ok: boolean };
    } catch (e) {
      return {
        ok: false,
        error: 'network',
        message: e instanceof Error ? e.message : 'Не удалось связаться с сервером',
      };
    }
  },
};

/**
 * Публичный URL страницы заявки (бакет submissions публичный).
 * В демо path — уже готовый data:/blob:-URL, его возвращаем как есть.
 */
export function submissionObjectUrl(path: unknown): string | null {
  if (typeof path !== 'string' || !path) return null;
  if (/^(https?:|data:|blob:)/.test(path)) return path;
  return `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/submissions/${path}`;
}

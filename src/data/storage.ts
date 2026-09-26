import { getSupabase, isSupabaseConfigured } from './client';
import { isSupabaseStorageUrl, supabaseStoragePublicUrl, storagePathFromUrl } from '@/lib/storageUrl';

function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * data-URL без FileReader (его нет ни в Node, ни в части тестовых окружений):
 * тот же результат через arrayBuffer + base64.
 */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

export function uploadErrorMessage(error: unknown, name: string, bucket?: string): string {
  const e = error as {message?: string; statusCode?: string | number; name?: string};
  if (e?.name === 'AbortError') return 'Загрузка отменена. Уже загруженные страницы сохранены.';
  const message = e?.message || '';
  // Бакета нет (проект пересоздавали, миграцию не накатили) — самая частая
  // причина «загрузка падает, а всё остальное работает».
  if (/bucket not found|nosuchbucket|bucket_id/i.test(message)) {
    return bucket === 'covers'
      ? 'Бакет `covers` не создан — накатите supabase/migrations/00000000000018_title_covers.sql. Альтернатива: положите WebP в public/media/covers/ и укажите путь.'
      : `Бакет \`${bucket || 'storage'}\` не создан — см. SETUP_SUPABASE.md §2.`;
  }
  if (/row.level|policy|permission|unauthorized|forbidden|нет прав/i.test(message) || ['401','403'].includes(String(e?.statusCode))) {
    return bucket === 'covers'
      ? 'Нет прав на загрузку обложек: нужен вход под ролью admin и политика «admin write covers» (миграция 00000000000018).'
      : 'Нет прав на загрузку в этот тайтл.';
  }
  if (/quota|storage.*full|insufficient.*storage|capacity/i.test(message) || String(e?.statusCode) === '507') return 'Не хватает места в Storage. Освободите или обратитесь к администратору.';
  if (/^(Файл|PDF|Не удалось обработать|Ожидался|Не хватает места|Нет прав)/.test(message)) return message;
  return `Не удалось загрузить \`${name}\`: проверьте соединение.`;
}
/**
 * Публичные бакеты: из них возвращается полный URL (картинку/обложку читает
 * анонимный посетитель), из приватных — голый путь объекта (его открывает
 * только владелец через подписанный URL).
 */
const PUBLIC_BUCKETS = new Set(['manga', 'covers']);

async function uploadBlob(bucket: string, path: string, blob: Blob, name: string): Promise<string> {
  if (!isSupabaseConfigured) return blobToDataUrl(blob);
  try {
    const supabase = await getSupabase();
    const {error} = await supabase.storage.from(bucket).upload(path,blob,{cacheControl:'31536000', upsert:false, contentType:blob.type || undefined});
    if (error) throw error;
    return PUBLIC_BUCKETS.has(bucket) ? supabaseStoragePublicUrl(bucket,path) : path;
  } catch (error) { throw new Error(uploadErrorMessage(error,name,bucket)); }
}

/**
 * Storage для пользовательского контента: страницы глав (бакеты manga +
 * hikko-originals), озвучки (voiceovers) и загруженные из админки обложки
 * тайтлов (бакет covers).
 *
 * Обложка тайтла живёт в двух видах, форма (TitleForm) принимает оба:
 *  1. ФАЙЛ РЕПОЗИТОРИЯ — public/media/covers/{имя}.webp, в titles.cover_url
 *     относительный путь `/media/covers/{имя}.webp`. Штатно для сидов и
 *     «вечных» картинок: файл в git, кэш 'self', вес ограничен бюджетом
 *     (scripts/check-budgets.mjs), Storage не нужен вовсе.
 *  2. ЗАГРУЗКА ИЗ АДМИНКИ — storage.uploadCover() жмёт файл в WebP ≤800 px
 *     и кладёт в публичный бакет `covers` (миграция
 *     00000000000018_title_covers.sql), в titles.cover_url — публичный URL
 *     `…/storage/v1/object/public/covers/…`. Без Supabase (демо) — data-URL.
 *
 * Оба вида рендерит CoverImage, оба проходят CSP (`'self'` и `*.supabase.co`)
 * и проверку isMediaUrlCspAllowed; различает их isSupabaseStorageUrl().
 */
export const storage = {
  async uploadPage(chapterId: string, file: File, order: number) {
    return this.uploadPageFromBlob(chapterId, file, order, { originalName: file.name, originalFile: file });
  },

  async uploadPageFromBlob(chapterId: string, blob: Blob, order: number,
    opts?: { originalName?: string; originalFile?: File }
  ): Promise<{ image_url: string; original_url: string | null }> {
    const name = opts?.originalName || 'page.webp';
    const { preparePageImage } = await import('@/lib/preparePageImage');
    const prepared = await preparePageImage(new File([blob], name, {type:blob.type}));
    const stamp = `${Date.now()}-${crypto.randomUUID()}`;
    const ext = prepared.type === 'image/gif' ? 'gif' : 'webp';
    const path = `${chapterId}/${order}-${stamp}.${ext}`;
    let original: string | null = null;
    if (opts?.originalFile) {
      const originalExt = (await import('@/lib/imageFormats')).signature;
      const suffix = await originalExt(opts.originalFile);
      original = `${chapterId}/${order}-${stamp}-original.${suffix}`;
      original = await uploadBlob('hikko-originals', original, opts.originalFile, name);
    }
    const image_url = await uploadBlob('manga', path, prepared, name);
    return { image_url, original_url: original };
  },

  // Streaming entry point lets the UI persist each row before rendering the next page.
  async *iteratePdfUploads(chapterId: string, file: File, startOrder: number,
    onProgress?: (stage: 'parsing' | 'uploading', done: number, total: number) => void,
    signal?: AbortSignal
  ): AsyncGenerator<{image_url: string; original_url: string; order: number}> {
    const { validateFile } = await import('@/lib/imageFormats');
    const { iteratePdfPages, checkAbort } = await import('@/lib/pdfToPages');
    const validation = await validateFile(file);
    if (!validation.ok) throw new Error(validation.reason);
    if (validation.kind !== 'pdf') throw new Error('Ожидался PDF.');
    checkAbort(signal);
    const safeName = file.name.replace(/\.pdf$/i,'').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,100) || 'document';
    let original_url = `${chapterId}/${Date.now()}-${crypto.randomUUID()}-${safeName}.pdf`;
    original_url = await uploadBlob('hikko-originals', original_url, new Blob([file], {type:'application/pdf'}), file.name);
    checkAbort(signal);
    let total = 0;
    for await (const page of iteratePdfPages(file, {signal, onProgress: (done,n) => {
      total = n; onProgress?.('parsing',done,n);
    }})) {
      checkAbort(signal);
      const order = startOrder + page.index - 1;
      onProgress?.('uploading',page.index - 1,total);
      const path = `${chapterId}/${order}-${Date.now()}-${crypto.randomUUID()}.webp`;
      const image_url = await uploadBlob('manga',path,page.blob,file.name);
      // Even if cancelled while uploading, persist this completed page before stopping.
      yield {image_url,original_url,order};
      onProgress?.('uploading',page.index,total);
      checkAbort(signal);
    }
  },

  async uploadPdfAsPages(chapterId: string, file: File, startOrder: number,
    onProgress?: (stage: 'parsing' | 'uploading', done: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<Array<{image_url: string; original_url: string; order: number}>> {
    const uploaded: Array<{image_url:string; original_url:string; order:number}> = [];
    try {
      for await (const page of this.iteratePdfUploads(chapterId,file,startOrder,onProgress,signal)) uploaded.push(page);
      return uploaded;
    } catch (error) {
      // Callers of the collecting API can retain successfully uploaded pages on failure.
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {uploaded});
    }
  },

  /**
   * Загрузить обложку тайтла (TitleForm → «Загрузить файл»).
   *
   * Файл приводится к WebP ≤800 px (src/lib/coverUpload.ts) и кладётся в
   * публичный бакет `covers` под именем `{slug}-{time}-{rand}.webp`.
   * Возвращается то, что пишется в titles.cover_url: публичный URL Storage
   * или data-URL в демо-режиме.
   *
   * `key` — slug тайтла (только для читаемого имени объекта; до сохранения
   * нового тайтла slug может быть пустым — тогда будет `cover-…`).
   */
  async uploadCover(file: File, opts?: { key?: string | null }): Promise<{ url: string; compressed: boolean; bytes: number }> {
    const { prepareCoverImage, coverObjectPath } = await import('@/lib/coverUpload');
    const { blob, compressed } = await prepareCoverImage(file);
    const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/jpeg' ? 'jpg' : 'webp';
    const path = coverObjectPath(opts?.key, ext);
    const url = await uploadBlob('covers', path, blob, file.name);
    return { url, compressed, bytes: blob.size };
  },

  /**
   * Удалить загруженную обложку из бакета `covers`.
   *
   * Безопасный no-op для всего, что бакету не принадлежит: относительный путь
   * файла репозитория, data-URL демо-режима, чужой домен. Вызывается из
   * TitleForm после УСПЕШНОГО сохранения — только для файлов, которые больше
   * не указаны ни в одном тайтле (см. cleanupStaleCovers в TitleForm).
   */
  async deleteCover(url: string | null | undefined) {
    if (!isSupabaseConfigured || !isSupabaseStorageUrl(url)) return;
    try {
      const supabase = await getSupabase();
      const path = storagePathFromUrl(url, 'covers');
      if (!path) return;
      const { error } = await supabase.storage.from('covers').remove([path]);
      if (error) throw error;
    } catch (e) {
      // Не роняем сохранение тайтла из-за мусора в Storage: файл останется,
      // это ~100 kB, удалить можно руками в Storage → covers.
      console.error('[covers] не удалось удалить старую обложку из Storage:', e);
    }
  },

  async uploadVoiceover(chapterId: string, audioBlob: Blob): Promise<string> {
    const path = `${chapterId}/${Date.now()}-voiceover.wav`;
    if (isSupabaseConfigured) {
      try {
        const supabase = await getSupabase();
        const { error } = await supabase.storage.from('voiceovers').upload(path, audioBlob, {
          contentType: 'audio/wav',
          upsert: true,
        });

        if (!error) {
          return supabaseStoragePublicUrl('voiceovers', path);
        }
      } catch {
        // Fallback
      }
    }
    return await fileToDataUrl(audioBlob);
  },

  async deletePage(imageUrl: string | null, originalPath: string | null) {
    await this.deletePages([{image_url:imageUrl, original_url:originalPath}]);
  },

  async deletePages(pages: Array<{image_url: string | null; original_url: string | null}>) {
    if (!isSupabaseConfigured) return;
    const supabase = await getSupabase();
    for (const bucket of ['manga','hikko-originals'] as const) {
      const paths = [...new Set(pages.map(page => storagePathFromUrl(bucket === 'manga' ? page.image_url : page.original_url,bucket))
        .filter((path): path is string => !!path && !(bucket === 'hikko-originals' && /\.pdf$/i.test(path))))];
      for (let i = 0; i < paths.length; i += 100) {
        const {error} = await supabase.storage.from(bucket).remove(paths.slice(i,i+100));
        if (error) throw error;
      }
    }
  },

  async deleteVoiceover(audioUrl: string | null) {
    if (!isSupabaseConfigured) return;
    try {
      const supabase = await getSupabase();
      const path = storagePathFromUrl(audioUrl, 'voiceovers');
      if (path) {
        await supabase.storage.from('voiceovers').remove([path]);
      }
    } catch (e) {
      console.error('Error deleting voiceover audio from storage:', e);
    }
  },
};

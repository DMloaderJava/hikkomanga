import { getSupabase, isSupabaseConfigured } from './client';
import { supabaseStoragePublicUrl, storagePathFromUrl } from '@/lib/storageUrl';

function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function uploadErrorMessage(error: unknown, name: string): string {
  const e = error as {message?: string; statusCode?: string | number; name?: string};
  if (e?.name === 'AbortError') return 'Загрузка отменена. Уже загруженные страницы сохранены.';
  const message = e?.message || '';
  if (/row.level|policy|permission|unauthorized|forbidden|нет прав/i.test(message) || ['401','403'].includes(String(e?.statusCode))) return 'Нет прав на загрузку в этот тайтл.';
  if (/quota|storage.*full|insufficient.*storage|capacity/i.test(message) || String(e?.statusCode) === '507') return 'Не хватает места в Storage. Освободите или обратитесь к администратору.';
  if (/^(Файл|PDF|Не удалось обработать|Ожидался|Не хватает места|Нет прав)/.test(message)) return message;
  return `Не удалось загрузить \`${name}\`: проверьте соединение.`;
}
async function uploadBlob(bucket: 'manga' | 'hikko-originals', path: string, blob: Blob, name: string): Promise<string> {
  if (!isSupabaseConfigured) return fileToDataUrl(blob);
  try {
    const supabase = await getSupabase();
    const {error} = await supabase.storage.from(bucket).upload(path,blob,{cacheControl:'31536000', upsert:false, contentType:blob.type || undefined});
    if (error) throw error;
    return bucket === 'manga' ? supabaseStoragePublicUrl(bucket,path) : path;
  } catch (error) { throw new Error(uploadErrorMessage(error,name)); }
}

/**
 * Storage используется ТОЛЬКО для пользовательского контента: страницы глав
 * (бакеты manga + hikko-originals) и озвучки (voiceovers).
 *
 * Обложки тайтлов здесь НЕ хранятся: это файлы репозитория
 * (public/media/covers/, относительные пути в titles.cover_url) — см. ТЗ
 * «отказаться от Supabase Storage для обложек». Поэтому uploadCover /
 * deleteCover удалены; вернуться к ним имеет смысл только при обратном
 * переезде обложек в Storage.
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

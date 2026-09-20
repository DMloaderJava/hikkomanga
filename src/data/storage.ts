import { getSupabase, isSupabaseConfigured } from './client';
import { compressToWebP } from '@/lib/imageCompress';
import { supabaseStoragePublicUrl, storagePathFromUrl } from '@/lib/storageUrl';

function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Демо-режим без Supabase: data-URL складываются в localStorage, квота которого
 * ~5 MB. Обложка-мульти unpredictable размером в пару сотен килобайт выбивает
 * хранилище на 15–20 тайтлах (сдохнет ВЕСЬ каталог, а не одна обложка).
 * Компромисс: большие файлы живут в blob-URL до конца сессии, при перезагрузке
 * страницы CoverImage сам покажет плейсхолдер — данные при этом не теряются.
 */
const DEMO_DATA_URL_LIMIT = 100 * 1024; // 100 kB

async function demoCoverUrl(blob: Blob): Promise<string> {
  const dataUrl = await fileToDataUrl(blob);
  if (dataUrl.length <= DEMO_DATA_URL_LIMIT) return dataUrl;
  console.warn(
    `[storage] обложка ${(dataUrl.length / 1024).toFixed(0)} kB не помещается в localStorage демо-режима ` +
      '(лимит 100 kB) — файл доступен только до перезагрузки страницы. ' +
      'Настройте Supabase, чтобы обложки сохранялись в Storage.'
  );
  return URL.createObjectURL(blob);
}

export const storage = {
  async uploadPage(chapterId: string, file: File, order: number) {
    const ext = file.name.split('.').pop() || 'jpg';
    const originalPath = `${chapterId}/${order}-${Date.now()}-original.${ext}`;
    const publicPath = `${chapterId}/${order}-${Date.now()}.webp`;

    let compressedBlob: Blob;
    try {
      compressedBlob = await compressToWebP(file, 1600);
    } catch {
      compressedBlob = file;
    }

    if (isSupabaseConfigured) {
      try {
        const supabase = await getSupabase();
        // 1. Upload original
        await supabase.storage.from('hikko-originals').upload(originalPath, file, { upsert: true });

        // 2. Upload compressed
        const { error } = await supabase.storage.from('manga').upload(publicPath, compressedBlob, {
          cacheControl: '31536000',
          upsert: true,
        });

        if (!error) {
          return {
            // Публичный URL собирается в storageUrl.ts — едином месте.
            image_url: supabaseStoragePublicUrl('manga', publicPath),
            original_url: originalPath,
          };
        }
      } catch {
        // Fallback
      }
    }

    const imageUrl = await fileToDataUrl(compressedBlob);
    const originalDataUrl = await fileToDataUrl(file);
    return {
      image_url: imageUrl,
      original_url: originalDataUrl,
    };
  },

  async uploadCover(file: File) {
    const ext = file.name.split('.').pop() || 'jpg';
    // Timestamp + случайный суффикс в пути = новая обложка получает новый URL:
    // CDN Supabase не отдаст старый файл из кэша (cache-busting без ?v=).
    const filename = `covers/${Date.now()}-${Math.random().toString(36).substring(2, 7)}.${ext}`;

    let compressedBlob: Blob;
    try {
      compressedBlob = await compressToWebP(file, 800);
    } catch {
      compressedBlob = file;
    }

    if (isSupabaseConfigured) {
      try {
        const supabase = await getSupabase();
        const { error } = await supabase.storage.from('manga').upload(filename, compressedBlob, {
          cacheControl: '31536000',
          upsert: true,
        });

        if (!error) {
          return supabaseStoragePublicUrl('manga', filename);
        }
      } catch {
        // Fallback
      }
    }

    return await demoCoverUrl(compressedBlob);
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
    if (!isSupabaseConfigured) return;
    try {
      const supabase = await getSupabase();
      const original = storagePathFromUrl(originalPath, 'hikko-originals');
      if (original) {
        await supabase.storage.from('hikko-originals').remove([original]);
      }
      const publicPath = storagePathFromUrl(imageUrl, 'manga');
      if (publicPath) {
        await supabase.storage.from('manga').remove([publicPath]);
      }
    } catch (e) {
      console.error('Error deleting page from storage:', e);
    }
  },

  async deleteCover(coverUrl: string | null) {
    if (!isSupabaseConfigured) return;
    try {
      const supabase = await getSupabase();
      const path = storagePathFromUrl(coverUrl, 'manga');
      if (path) {
        await supabase.storage.from('manga').remove([path]);
      }
    } catch (e) {
      console.error('Error deleting cover from storage:', e);
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

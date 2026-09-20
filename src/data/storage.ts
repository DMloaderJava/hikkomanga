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

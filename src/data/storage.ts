import { supabase, isSupabaseConfigured } from './client';
import { compressToWebP } from '@/lib/imageCompress';

function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
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
        // 1. Upload original
        await supabase.storage.from('manga-originals').upload(originalPath, file, { upsert: true });

        // 2. Upload compressed
        const { error } = await supabase.storage.from('manga').upload(publicPath, compressedBlob, {
          cacheControl: '31536000',
          upsert: true,
        });

        if (!error) {
          const { data } = supabase.storage.from('manga').getPublicUrl(publicPath);
          return {
            image_url: data.publicUrl,
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
    const filename = `covers/${Date.now()}-${Math.random().toString(36).substring(2, 7)}.${ext}`;

    let compressedBlob: Blob;
    try {
      compressedBlob = await compressToWebP(file, 800);
    } catch {
      compressedBlob = file;
    }

    if (isSupabaseConfigured) {
      try {
        const { error } = await supabase.storage.from('manga').upload(filename, compressedBlob, {
          cacheControl: '31536000',
          upsert: true,
        });

        if (!error) {
          const { data } = supabase.storage.from('manga').getPublicUrl(filename);
          return data.publicUrl;
        }
      } catch {
        // Fallback
      }
    }

    return await fileToDataUrl(compressedBlob);
  },

  async uploadVoiceover(chapterId: string, audioBlob: Blob): Promise<string> {
    const path = `${chapterId}/${Date.now()}-voiceover.wav`;
    if (isSupabaseConfigured) {
      try {
        const { error } = await supabase.storage.from('voiceovers').upload(path, audioBlob, {
          contentType: 'audio/wav',
          upsert: true,
        });

        if (!error) {
          const { data } = supabase.storage.from('voiceovers').getPublicUrl(path);
          return data.publicUrl;
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
      if (originalPath && !originalPath.startsWith('data:')) {
        await supabase.storage.from('manga-originals').remove([originalPath]);
      }
      if (imageUrl && !imageUrl.startsWith('data:')) {
        const urlParts = imageUrl.split('/manga/');
        if (urlParts.length > 1) {
          await supabase.storage.from('manga').remove([urlParts[1]]);
        }
      }
    } catch (e) {
      console.error('Error deleting page from storage:', e);
    }
  },

  async deleteCover(coverUrl: string | null) {
    if (!isSupabaseConfigured || !coverUrl || coverUrl.startsWith('data:')) return;
    try {
      const urlParts = coverUrl.split('/manga/');
      if (urlParts.length > 1) {
        await supabase.storage.from('manga').remove([urlParts[1]]);
      }
    } catch (e) {
      console.error('Error deleting cover from storage:', e);
    }
  },

  async deleteVoiceover(audioUrl: string | null) {
    if (!isSupabaseConfigured || !audioUrl || audioUrl.startsWith('data:')) return;
    try {
      const urlParts = audioUrl.split('/voiceovers/');
      if (urlParts.length > 1) {
        await supabase.storage.from('voiceovers').remove([urlParts[1]]);
      }
    } catch (e) {
      console.error('Error deleting voiceover audio from storage:', e);
    }
  },
};

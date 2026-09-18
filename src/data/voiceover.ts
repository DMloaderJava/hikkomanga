import { getSupabase, isSupabaseConfigured } from './client';
import { storage } from './storage';
import type { DialogueLine, ChapterVoiceover } from './types';
export type { ChapterVoiceover };

const VOICEOVER_STORAGE_KEY = 'manga_chapter_voiceovers';

function loadLocalVoiceovers(): ChapterVoiceover[] {
  if (typeof window === 'undefined') return [];
  try {
    const saved = localStorage.getItem(VOICEOVER_STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

function saveLocalVoiceovers(items: ChapterVoiceover[]) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(VOICEOVER_STORAGE_KEY, JSON.stringify(items));
  } catch (e) {
    console.warn('Voiceovers local save limit reached', e);
  }
}

export const voiceoverApi = {
  async getByChapter(chapterId: string): Promise<ChapterVoiceover | null> {
    if (isSupabaseConfigured) {
      try {
        const supabase = await getSupabase();
        const { data, error } = await supabase
          .from('chapter_voiceovers')
          .select('*')
          .eq('chapter_id', chapterId)
          .maybeSingle();

        if (!error && data) {
          return data as ChapterVoiceover;
        }
      } catch {
        // Fallback
      }
    }

    const localList = loadLocalVoiceovers();
    return localList.find((v) => v.chapter_id === chapterId) || null;
  },

  async saveVoiceover(
    chapterId: string,
    audioUrl: string,
    lines: DialogueLine[],
    durationMs: number
  ): Promise<ChapterVoiceover> {
    const record: Partial<ChapterVoiceover> = {
      chapter_id: chapterId,
      audio_url: audioUrl,
      lines: lines,
      duration_ms: durationMs,
    };

    if (isSupabaseConfigured) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('chapter_voiceovers')
        .upsert(record, { onConflict: 'chapter_id' })
        .select()
        .single();

      if (error) {
        throw new Error(`Не удалось сохранить озвучку: ${error.message}`);
      }
      return data as ChapterVoiceover;
    }

    const localRecord: ChapterVoiceover = {
      id: 'vo-' + Date.now(),
      chapter_id: chapterId,
      audio_url: audioUrl,
      lines,
      duration_ms: durationMs,
      created_at: new Date().toISOString(),
    };

    const local = loadLocalVoiceovers().filter((v) => v.chapter_id !== chapterId);
    local.push(localRecord);
    saveLocalVoiceovers(local);
    return localRecord;
  },

  async deleteVoiceover(chapterId: string, audioUrl?: string | null): Promise<void> {
    const targetUrl = audioUrl !== undefined ? audioUrl : (await this.getByChapter(chapterId))?.audio_url;
    if (targetUrl) {
      await storage.deleteVoiceover(targetUrl);
    }

    if (isSupabaseConfigured) {
      const supabase = await getSupabase();
      const { error } = await supabase
        .from('chapter_voiceovers')
        .delete()
        .eq('chapter_id', chapterId);
      if (error) {
        throw new Error(`Не удалось удалить озвучку: ${error.message}`);
      }
      return;
    }

    const local = loadLocalVoiceovers().filter((v) => v.chapter_id !== chapterId);
    saveLocalVoiceovers(local);
  },
};

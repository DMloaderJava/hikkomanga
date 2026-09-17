import { getSupabase, isSupabaseConfigured } from './client';
import { mockStore } from './mockStore';
import { pages as pagesApi } from './pages';
import { storage } from './storage';
import { voiceoverApi } from './voiceover';
import { DuplicateChapterError, type Chapter, type ChapterInput } from './types';

export const chapters = {
  async listByTitle(titleId: string, includeDrafts = false): Promise<Chapter[]> {
    if (isSupabaseConfigured) {
      try {
        const supabase = await getSupabase();
        let query = supabase.from('chapters').select('*').eq('title_id', titleId);
        if (!includeDrafts) {
          query = query.eq('published', true);
        }
        const { data, error } = await query.order('number', { ascending: true });

        if (!error && data) {
          return data;
        }
      } catch {
        // Fallback
      }
    }
    return mockStore.getChaptersByTitle(titleId, includeDrafts);
  },

  async getByNumber(titleId: string, number: number): Promise<Chapter | null> {
    if (isSupabaseConfigured) {
      try {
        const supabase = await getSupabase();
        const { data, error } = await supabase
          .from('chapters')
          .select('*')
          .eq('title_id', titleId)
          .eq('number', number)
          .maybeSingle();

        if (!error && data) {
          return data;
        }
      } catch {
        // Fallback
      }
    }
    return mockStore.getChapterByNumber(titleId, number);
  },

  async getById(id: string): Promise<Chapter | null> {
    if (isSupabaseConfigured) {
      try {
        const supabase = await getSupabase();
        const { data, error } = await supabase
          .from('chapters')
          .select('*')
          .eq('id', id)
          .maybeSingle();

        if (!error && data) {
          return data;
        }
      } catch {
        // Fallback
      }
    }
    return mockStore.getChapterById(id);
  },

  async create(input: ChapterInput): Promise<Chapter> {
    if (isSupabaseConfigured) {
      const supabase = await getSupabase();
      // Supabase сам поймает дубликат через UNIQUE (title_id, number) — код 23505.
      // Предварительный SELECT не нужен: лишний RTT и race condition.
      const { data, error } = await supabase
        .from('chapters')
        .insert({
          title_id: input.title_id,
          number: Number(input.number),
          name: input.name || null,
          published: input.published ?? false,
        })
        .select()
        .single();

      if (error) {
        if (error.code === '23505') {
          throw new DuplicateChapterError(Number(input.number));
        }
        throw new Error(`Не удалось создать главу: ${error.message}`);
      }
      return data;
    }

    // mockStore не имеет constraint — проверяет дубликат сам
    return mockStore.createChapter(input);
  },

  async update(id: string, input: Partial<ChapterInput>): Promise<Chapter> {
    if (isSupabaseConfigured) {
      const supabase = await getSupabase();
      const updateData: any = {};
      if (input.number !== undefined) updateData.number = Number(input.number);
      if (input.name !== undefined) updateData.name = input.name;
      if (input.published !== undefined) updateData.published = input.published;

      if (Object.keys(updateData).length === 0) {
        const current = await this.getById(id);
        if (!current) throw new Error('Глава не найдена');
        return current;
      }

      const { data, error } = await supabase
        .from('chapters')
        .update(updateData)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        if (error.code === '23505') {
          throw new DuplicateChapterError(updateData.number);
        }
        throw new Error(`Не удалось сохранить главу: ${error.message}`);
      }
      return data;
    }

    return mockStore.updateChapter(id, input);
  },

  async delete(id: string): Promise<void> {
    const existingVo = await voiceoverApi.getByChapter(id);
    try {
      await voiceoverApi.deleteVoiceover(id, existingVo?.audio_url);
    } catch (e) {
      console.warn('[chapters] не удалось удалить озвучку главы:', e);
    }

    const chapterPages = await pagesApi.listByChapter(id);
    await Promise.allSettled(
      chapterPages.map((page) => storage.deletePage(page.image_url, page.original_url))
    );

    if (isSupabaseConfigured) {
      const supabase = await getSupabase();
      const { error } = await supabase.from('chapters').delete().eq('id', id);
      if (error) {
        throw new Error(`Не удалось удалить главу: ${error.message}`);
      }
      return;
    }

    mockStore.deleteChapter(id);
  },

  async getNextAndPrev(titleId: string, currentNumber: number) {
    const all = await this.listByTitle(titleId, false);
    const currentIndex = all.findIndex((c) => Number(c.number) === Number(currentNumber));

    const prevChapter = currentIndex > 0 ? all[currentIndex - 1] : null;
    const nextChapter = currentIndex >= 0 && currentIndex < all.length - 1 ? all[currentIndex + 1] : null;

    return { prevChapter, nextChapter };
  },
};

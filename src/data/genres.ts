import { supabase, isSupabaseConfigured } from './client';
import { mockStore } from './mockStore';
import type { Genre } from './types';

export const genres = {
  async list(): Promise<Genre[]> {
    if (isSupabaseConfigured) {
      try {
        const { data, error } = await supabase
          .from('genres')
          .select('*')
          .order('name', { ascending: true });

        if (!error && data) {
          return data;
        }
      } catch {
        // Fallback
      }
    }
    return mockStore.getGenres();
  },

  async create(name: string): Promise<Genre> {
    if (isSupabaseConfigured) {
      const { data, error } = await supabase
        .from('genres')
        .insert({ name: name.trim() })
        .select()
        .single();

      if (error) {
        if (error.code === '23505') {
          throw new Error(`Жанр «${name.trim()}» уже существует.`);
        }
        throw new Error(`Не удалось создать жанр: ${error.message}`);
      }
      return data;
    }
    return mockStore.createGenre(name);
  },

  async update(id: string, name: string): Promise<Genre> {
    if (isSupabaseConfigured) {
      const { data, error } = await supabase
        .from('genres')
        .update({ name: name.trim() })
        .eq('id', id)
        .select()
        .single();

      if (error) {
        if (error.code === '23505') {
          throw new Error(`Жанр «${name.trim()}» уже существует.`);
        }
        throw new Error(`Не удалось переименовать жанр: ${error.message}`);
      }
      return data;
    }
    return mockStore.updateGenre(id, name);
  },

  async delete(id: string): Promise<void> {
    if (isSupabaseConfigured) {
      const { error } = await supabase.from('genres').delete().eq('id', id);
      if (error) {
        throw new Error(`Не удалось удалить жанр: ${error.message}`);
      }
      return;
    }
    mockStore.deleteGenre(id);
  },

  async getUsageCount(id: string): Promise<number> {
    if (isSupabaseConfigured) {
      try {
        const { count, error } = await supabase
          .from('title_genres')
          .select('*', { count: 'exact', head: true })
          .eq('genre_id', id);

        if (!error && typeof count === 'number') {
          return count;
        }
      } catch {
        // Fallback
      }
    }
    return mockStore.getGenreUsageCount(id);
  },
};

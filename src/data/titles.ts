import { supabase, isSupabaseConfigured } from './client';
import { mockStore } from './mockStore';
import { chapters as chaptersApi } from './chapters';
import { storage } from './storage';
import { type Title, type TitleInput, type Genre, SlugConflictError } from './types';

function normalizeTitleRow(row: any): Title {
  const genresList: Genre[] = row.title_genres
    ? row.title_genres.map((tg: any) => (tg.genres ? tg.genres : tg)).filter(Boolean)
    : row.genres || [];

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    author: row.author ?? null,
    description: row.description ?? null,
    cover_url: row.cover_url ?? null,
    status: row.status ?? 'ongoing',
    published: row.published ?? false,
    created_at: row.created_at || new Date().toISOString(),
    genres: genresList,
  };
}

export const titles = {
  async listPublished(): Promise<Title[]> {
    if (isSupabaseConfigured) {
      try {
        const { data, error } = await supabase
          .from('titles')
          .select('*, title_genres(genres(id, name))')
          .eq('published', true)
          .order('created_at', { ascending: false });

        if (!error && data) {
          return data.map(normalizeTitleRow);
        }
      } catch {
        // Fallback
      }
    }
    return mockStore.getTitles(true);
  },

  async listAll(): Promise<Title[]> {
    if (isSupabaseConfigured) {
      try {
        const { data, error } = await supabase
          .from('titles')
          .select('*, title_genres(genres(id, name))')
          .order('created_at', { ascending: false });

        if (!error && data) {
          return data.map(normalizeTitleRow);
        }
      } catch {
        // Fallback
      }
    }
    return mockStore.getTitles(false);
  },

  async getBySlug(slug: string): Promise<Title | null> {
    if (isSupabaseConfigured) {
      try {
        const { data, error } = await supabase
          .from('titles')
          .select('*, title_genres(genres(id, name))')
          .eq('slug', slug)
          .maybeSingle();

        if (!error && data) {
          return normalizeTitleRow(data);
        }
      } catch {
        // Fallback
      }
    }
    return mockStore.getTitleBySlug(slug);
  },

  async getById(id: string): Promise<Title | null> {
    if (isSupabaseConfigured) {
      try {
        const { data, error } = await supabase
          .from('titles')
          .select('*, title_genres(genres(id, name))')
          .eq('id', id)
          .maybeSingle();

        if (!error && data) {
          return normalizeTitleRow(data);
        }
      } catch {
        // Fallback
      }
    }
    return mockStore.getTitleById(id);
  },

  async create(input: TitleInput): Promise<Title> {
    // Check slug uniqueness
    const existing = await this.getBySlug(input.slug);
    if (existing) {
      throw new SlugConflictError(input.slug);
    }

    if (isSupabaseConfigured) {
      try {
        const { genre_ids, ...titleData } = input;
        const { data, error } = await supabase
          .from('titles')
          .insert(titleData)
          .select()
          .single();

        if (error) {
          if (error.code === '23505') {
            throw new SlugConflictError(input.slug);
          }
          throw error;
        }

        if (data) {
          if (genre_ids && genre_ids.length > 0) {
            const links = genre_ids.map((gid) => ({
              title_id: data.id,
              genre_id: gid,
            }));
            await supabase.from('title_genres').insert(links);
          }
          mockStore.createTitle(input);
          return (await this.getById(data.id)) || data;
        }
      } catch (err: any) {
        if (err instanceof SlugConflictError) {
          throw err;
        }
        // Fallback
      }
    }
    return mockStore.createTitle(input);
  },

  async update(id: string, input: Partial<TitleInput>): Promise<Title> {
    if (input.slug) {
      const existing = await this.getBySlug(input.slug);
      if (existing && existing.id !== id) {
        throw new SlugConflictError(input.slug);
      }
    }

    if (isSupabaseConfigured) {
      try {
        const { genre_ids, ...titleData } = input;
        const { data, error } = await supabase
          .from('titles')
          .update(titleData)
          .eq('id', id)
          .select()
          .single();

        if (error) {
          if (error.code === '23505') {
            throw new SlugConflictError(input.slug || '');
          }
          throw error;
        }

        if (data) {
          if (genre_ids !== undefined) {
            await supabase.from('title_genres').delete().eq('title_id', id);
            if (genre_ids.length > 0) {
              const links = genre_ids.map((gid) => ({
                title_id: id,
                genre_id: gid,
              }));
              await supabase.from('title_genres').insert(links);
            }
          }
          mockStore.updateTitle(id, input);
          return (await this.getById(id)) || data;
        }
      } catch (err: any) {
        if (err instanceof SlugConflictError) {
          throw err;
        }
        // Fallback
      }
    }
    return mockStore.updateTitle(id, input);
  },

  async delete(id: string): Promise<void> {
    const titleToDelete = await this.getById(id);

    if (titleToDelete?.cover_url) {
      await storage.deleteCover(titleToDelete.cover_url);
    }

    const titleChapters = await chaptersApi.listByTitle(id, true);
    await Promise.allSettled(titleChapters.map((ch) => chaptersApi.delete(ch.id)));

    if (isSupabaseConfigured) {
      try {
        const { error } = await supabase.from('titles').delete().eq('id', id);
        if (!error) {
          mockStore.deleteTitle(id);
          return;
        }
      } catch {
        // Fallback
      }
    }
    mockStore.deleteTitle(id);
  },

  async togglePublish(id: string): Promise<Title> {
    const current = await this.getById(id);
    if (!current) throw new Error('Тайтл не найден');
    return this.update(id, { published: !current.published });
  },
};

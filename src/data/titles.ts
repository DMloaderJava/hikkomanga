import { getSupabase, isSupabaseConfigured } from './client';
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
        const supabase = await getSupabase();
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
        const supabase = await getSupabase();
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
        const supabase = await getSupabase();
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
        const supabase = await getSupabase();
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
      const supabase = await getSupabase();
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
        throw new Error(`Не удалось создать тайтл: ${error.message}`);
      }

      if (genre_ids && genre_ids.length > 0) {
        const { error: linkError } = await supabase
          .from('title_genres')
          .insert(genre_ids.map((genre_id) => ({ title_id: data.id, genre_id })));
        if (linkError) {
          console.warn('[titles] не удалось привязать жанры:', linkError.message);
        }
      }

      return (await this.getById(data.id)) || normalizeTitleRow(data);
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
      const supabase = await getSupabase();
      const { genre_ids, ...titleData } = input;

      if (Object.keys(titleData).length > 0) {
        const { error } = await supabase
          .from('titles')
          .update(titleData)
          .eq('id', id)
          .select()
          .single();

        if (error) {
          if (error.code === '23505') {
            throw new SlugConflictError(input.slug || '');
          }
          throw new Error(`Не удалось сохранить тайтл: ${error.message}`);
        }
      }

      if (genre_ids !== undefined) {
        if (genre_ids.length > 0) {
          // 1. Сначала вставляем новые связи: если INSERT упадёт, старые жанры
          //    останутся на месте — состояние деградирует к предыдущему, а не к пустому.
          const { error: insertError } = await supabase
            .from('title_genres')
            .upsert(
              genre_ids.map((genre_id) => ({ title_id: id, genre_id })),
              { onConflict: 'title_id,genre_id', ignoreDuplicates: true }
            );

          if (insertError) {
            console.warn('[titles] не удалось привязать жанры:', insertError.message);
          } else {
            // 2. Только после успешного INSERT убираем жанры, которых нет в новом списке
            const { error: deleteError } = await supabase
              .from('title_genres')
              .delete()
              .eq('title_id', id)
              .not('genre_id', 'in', `(${genre_ids.join(',')})`);

            if (deleteError) {
              console.warn('[titles] не удалось убрать старые жанры:', deleteError.message);
            }
          }
        } else {
          // Пустой список → убираем все жанры
          const { error } = await supabase.from('title_genres').delete().eq('title_id', id);
          if (error) {
            console.warn('[titles] не удалось сбросить жанры:', error.message);
          }
        }
      }

      const fresh = await this.getById(id);
      if (!fresh) throw new Error('Тайтл не найден после сохранения');
      return fresh;
    }
    return mockStore.updateTitle(id, input);
  },

  async delete(id: string): Promise<void> {
    const titleToDelete = await this.getById(id);
    if (!titleToDelete) throw new Error('Тайтл не найден');

    // Строки глав/страниц в БД удалятся каскадно по внешним ключам, а вот
    // файлы в Storage и озвучки — нет, поэтому чистим их явно до удаления тайтла.
    const titleChapters = await chaptersApi.listByTitle(id, true);
    for (const chapter of titleChapters) {
      try {
        await chaptersApi.delete(chapter.id);
      } catch (e) {
        console.warn(`[titles] глава ${chapter.id} очищена не полностью:`, e);
      }
    }

    try {
      await storage.deleteCover(titleToDelete.cover_url);
    } catch (e) {
      console.warn('[titles] не удалось удалить файл обложки:', e);
    }

    if (isSupabaseConfigured) {
      const supabase = await getSupabase();
      const { error } = await supabase.from('titles').delete().eq('id', id);
      if (error) {
        throw new Error(`Не удалось удалить тайтл: ${error.message}`);
      }
      return;
    }

    mockStore.deleteTitle(id);
  },

  async togglePublish(id: string): Promise<Title> {
    const current = await this.getById(id);
    if (!current) throw new Error('Тайтл не найден');
    return this.update(id, { published: !current.published });
  },
};

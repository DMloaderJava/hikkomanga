import { getSupabase, isSupabaseConfigured } from './client';
import { mockStore } from './mockStore';
import { chapters as chaptersApi } from './chapters';
import { normalizeMediaUrl } from '@/lib/storageUrl';
import { type Title, type TitleInput, type Genre, SlugConflictError } from './types';

function isMissingRpc(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const msg = `${error.code ?? ''} ${error.message ?? ''}`;
  return (
    error.code === 'PGRST202' ||
    error.code === '42883' ||
    /could not find the function|schema cache|function .* does not exist|404/i.test(msg)
  );
}

function publishFailureMessage(
  error: { message?: string; hint?: string; code?: string },
  published: boolean
): string {
  const raw = [error.message, error.hint].filter(Boolean).join(' — ');
  if (/forbidden|permission|policy|row-level|42501/i.test(raw)) {
    return (
      'Нет прав менять публикацию тайтла. Нужна роль admin или owner в public.user_roles. ' +
      'Если роль есть, выполните миграцию supabase/migrations/00000000000018_publish_title.sql в SQL Editor.'
    );
  }
  if (/not_found|0 rows|PGRST116/i.test(raw)) {
    return 'Тайтл не найден — возможно, его уже удалили.';
  }
  const action = published ? 'опубликовать тайтл' : 'снять тайтл с публикации';
  return `Не удалось ${action}: ${raw || 'неизвестная ошибка'}`;
}

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
    // Нормализация обложки: trim, '' → null, http→https, мёртвые refs → текущий
    // проект (см. storageUrl.ts). Единая точка — normalizeMediaUrl.
    cover_url: normalizeMediaUrl(row.cover_url),
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

        // null — тайтла с таким slug нет. Нельзя падать в mockStore: сид с тем
        // же slug дал бы ложный SlugConflictError и форма «Сохранить» не
        // опубликовала бы настоящий тайтл.
        if (!error) {
          return data ? normalizeTitleRow(data) : null;
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

        if (!error) {
          return data ? normalizeTitleRow(data) : null;
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
      const { genre_ids, ...rawTitleData } = input;
      // Обложку нормализуем ДО записи: в БД не должно попадать « HTTP://… »,
      // пустых строк и внешних доменов, которые потом молча режет CSP.
      const titleData = { ...rawTitleData, cover_url: normalizeMediaUrl(rawTitleData.cover_url) };
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
      const { genre_ids, ...rawTitleData } = input;
      const titleData =
        'cover_url' in rawTitleData
          ? { ...rawTitleData, cover_url: normalizeMediaUrl(rawTitleData.cover_url) }
          : rawTitleData;

      let updatedRow: any = null;
      if (Object.keys(titleData).length > 0) {
        const { data, error } = await supabase
          .from('titles')
          .update(titleData)
          .eq('id', id)
          .select()
          .maybeSingle();

        if (error) {
          if (error.code === '23505') {
            throw new SlugConflictError(input.slug || '');
          }
          throw new Error(`Не удалось сохранить тайтл: ${error.message}`);
        }
        if (!data) {
          throw new Error(
            'Не удалось сохранить тайтл: база не изменила строку (нет прав на UPDATE или тайтл удалён). ' +
              'Для публикации выполните миграцию supabase/migrations/00000000000018_publish_title.sql.'
          );
        }
        updatedRow = data;
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
      // Запись уже прошла. Если перечитать карточку не вышло, не делаем вид,
      // что сохранения не было — иначе повторный тогл снимет тайтл с публикации.
      if (fresh) return fresh;
      if (updatedRow) return normalizeTitleRow(updatedRow);
      throw new Error('Тайтл не найден после сохранения');
    }
    return mockStore.updateTitle(id, input);
  },

  async delete(id: string): Promise<void> {
    const titleToDelete = await this.getById(id);
    if (!titleToDelete) throw new Error('Тайтл не найден');

    // Строки глав/страниц в БД удалятся каскадно по внешним ключам, а вот
    // файлы в Storage и озвучки — нет, поэтому чистим их явно до удаления тайтла.
    // Обложка — файл в репозитории (public/media/covers/), её удалять не нужно.
    const titleChapters = await chaptersApi.listByTitle(id, true);
    for (const chapter of titleChapters) {
      try {
        await chaptersApi.delete(chapter.id);
      } catch (e) {
        console.warn(`[titles] глава ${chapter.id} очищена не полностью:`, e);
      }
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

  /**
   * Поставить статус публикации явно (не «переключить»).
   * Сначала обычный UPDATE — его достаточно, если политика и GRANT в порядке.
   * Если строка не изменилась (RLS вернул 0 строк), зовём set_title_published
   * из миграции 18: она пишет флаг после проверки роли и не зависит от политики.
   */
  async setPublished(id: string, published: boolean): Promise<Title> {
    if (!isSupabaseConfigured) {
      return mockStore.updateTitle(id, { published });
    }

    const before = await this.getById(id);
    const supabase = await getSupabase();
    const direct = await supabase
      .from('titles')
      .update({ published })
      .eq('id', id)
      .select('id, published')
      .maybeSingle();

    const directOk = !direct.error && !!direct.data && direct.data.published === published;

    if (!directOk) {
      const rpc = await supabase.rpc('set_title_published', {
        p_id: id,
        p_published: published,
      });
      if (rpc.error) {
        if (isMissingRpc(rpc.error)) {
          if (direct.error) throw new Error(publishFailureMessage(direct.error, published));
          throw new Error(
            (published
              ? 'Не удалось опубликовать тайтл: база не изменила строку. '
              : 'Не удалось снять тайтл с публикации: база не изменила строку. ') +
              'Выполните миграцию supabase/migrations/00000000000018_publish_title.sql в SQL Editor Supabase и повторите.'
          );
        }
        throw new Error(publishFailureMessage(rpc.error, published));
      }
    }

    const fresh = await this.getById(id);
    if (fresh) {
      if (fresh.published !== published) {
        throw new Error(
          'База не сохранила статус публикации. Проверьте триггеры на public.titles и роль admin/owner.'
        );
      }
      return fresh;
    }
    if (before) return { ...before, published };
    throw new Error('Статус публикации сохранён, но карточку не удалось перечитать. Обновите страницу.');
  },

  async togglePublish(id: string): Promise<Title> {
    const current = await this.getById(id);
    if (!current) throw new Error('Тайтл не найден');
    return this.setPublished(id, !current.published);
  },
};

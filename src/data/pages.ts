import { getSupabase, isSupabaseConfigured } from './client';
import { mockStore } from './mockStore';
import { storage } from './storage';
import { repairSupabaseUrl } from '@/lib/storageUrl';
import type { Page, PageInput } from './types';

/** Чиним ссылки на storage удалённых Supabase-проектов (см. storageUrl.ts). */
function repairPageRow(row: Page): Page {
  return { ...row, image_url: repairSupabaseUrl(row.image_url) ?? row.image_url };
}

export const pages = {
  async listByChapter(chapterId: string): Promise<Page[]> {
    if (isSupabaseConfigured) {
      try {
        const supabase = await getSupabase();
        const { data, error } = await supabase
          .from('pages')
          .select('*')
          .eq('chapter_id', chapterId)
          .order('page_order', { ascending: true });

        if (!error && data) {
          return data.map(repairPageRow);
        }
      } catch {
        // Fallback
      }
    }
    return mockStore.getPagesByChapter(chapterId);
  },

  async getById(id: string): Promise<Page | null> {
    if (isSupabaseConfigured) {
      try {
        const supabase = await getSupabase();
        const { data, error } = await supabase
          .from('pages')
          .select('*')
          .eq('id', id)
          .maybeSingle();

        if (!error && data) {
          return repairPageRow(data);
        }
      } catch {
        // Fallback
      }
    }
    return mockStore.getPageById(id);
  },

  async create(input: PageInput): Promise<Page> {
    if (isSupabaseConfigured) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('pages')
        .insert({
          chapter_id: input.chapter_id,
          image_url: input.image_url,
          original_url: input.original_url || null,
          page_order: input.page_order,
        })
        .select()
        .single();

      if (error) {
        throw new Error(`Не удалось добавить страницу: ${error.message}`);
      }
      return data;
    }
    return mockStore.createPage(input);
  },

  async updateOrder(pageOrders: { id: string; page_order: number }[], chapterId: string): Promise<void> {
    if (isSupabaseConfigured) {
      const supabase = await getSupabase();
      const updates = pageOrders.map((item) => ({
        id: item.id,
        chapter_id: chapterId,
        page_order: item.page_order,
      }));

      const { error } = await supabase.from('pages').upsert(updates, { onConflict: 'id' });
      if (error) {
        throw new Error(`Не удалось сохранить порядок страниц: ${error.message}`);
      }
      return;
    }
    mockStore.updatePageOrders(chapterId, pageOrders);
  },

  async delete(id: string): Promise<void> {
    const targetPage = (await this.getById(id)) || mockStore.getPageById(id);
    if (targetPage) {
      try {
        await storage.deletePage(targetPage.image_url, targetPage.original_url);
      } catch (e) {
        console.warn('[pages] не удалось удалить файлы страницы:', e);
      }
    }

    if (isSupabaseConfigured) {
      const supabase = await getSupabase();
      const { error } = await supabase.from('pages').delete().eq('id', id);
      if (error) {
        throw new Error(`Не удалось удалить страницу: ${error.message}`);
      }
      return;
    }
    mockStore.deletePage(id);
  },
};

import { supabase, isSupabaseConfigured } from './client';
import { mockStore } from './mockStore';
import { storage } from './storage';
import type { Page, PageInput } from './types';

export const pages = {
  async listByChapter(chapterId: string): Promise<Page[]> {
    if (isSupabaseConfigured) {
      try {
        const { data, error } = await supabase
          .from('pages')
          .select('*')
          .eq('chapter_id', chapterId)
          .order('page_order', { ascending: true });

        if (!error && data) {
          return data;
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
        const { data, error } = await supabase
          .from('pages')
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
    return mockStore.getPageById(id);
  },

  async create(input: PageInput): Promise<Page> {
    if (isSupabaseConfigured) {
      try {
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

        if (!error && data) {
          mockStore.createPage(input);
          return data;
        }
      } catch {
        // Fallback
      }
    }
    return mockStore.createPage(input);
  },

  async updateOrder(pageOrders: { id: string; page_order: number }[], chapterId: string): Promise<void> {
    if (isSupabaseConfigured) {
      try {
        const updates = pageOrders.map((item) => ({
          id: item.id,
          chapter_id: chapterId,
          page_order: item.page_order,
        }));

        const { error } = await supabase.from('pages').upsert(updates, { onConflict: 'id' });
        if (!error) {
          mockStore.updatePageOrders(chapterId, pageOrders);
          return;
        }
      } catch {
        // Fallback
      }
    }
    mockStore.updatePageOrders(chapterId, pageOrders);
  },

  async delete(id: string): Promise<void> {
    const targetPage = (await this.getById(id)) || mockStore.getPageById(id);
    if (targetPage) {
      await storage.deletePage(targetPage.image_url, targetPage.original_url);
    }

    if (isSupabaseConfigured) {
      try {
        const { error } = await supabase.from('pages').delete().eq('id', id);
        if (!error) {
          mockStore.deletePage(id);
          return;
        }
      } catch {
        // Fallback
      }
    }
    mockStore.deletePage(id);
  },
};

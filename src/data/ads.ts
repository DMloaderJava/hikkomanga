import { getSupabase, isSupabaseConfigured } from './client';
import type { Ad } from './types';

const DEMO_KEY = 'manga_ads';

export type AdInput = {
  title: string;
  description?: string | null;
  image_url?: string | null;
  link_url: string;
  link_label?: string;
  placement?: string;
  active?: boolean;
  advertiser_name?: string | null;
  expires_at?: string | null;
};

function loadDemo(): Ad[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    if (!raw) return [];
    // Старые записи без active считаем активными (active !== false).
    return (JSON.parse(raw) as Ad[]).map((a) => ({
      ...a,
      active: a.active !== false,
      link_label: a.link_label || 'Перейти',
      placement: a.placement || 'between_chapters',
    }));
  } catch {
    return [];
  }
}

function saveDemo(list: Ad[]) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

function isActiveNow(ad: Ad): boolean {
  if (ad.active === false) return false;
  if (ad.expires_at && new Date(ad.expires_at).getTime() < Date.now()) return false;
  return true;
}

export const adsApi = {
  async getActive(placement = 'between_chapters'): Promise<Ad | null> {
    if (!isSupabaseConfigured) {
      const list = loadDemo().filter(
        (a) => (a.placement || 'between_chapters') === placement && isActiveNow(a)
      );
      if (list.length === 0) return null;
      return list[Math.floor(Math.random() * list.length)];
    }

    const supabase = await getSupabase();
    const { data, error } = await supabase
      .from('ads')
      .select('*')
      .eq('placement', placement)
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(5);

    if (error || !data || data.length === 0) return null;

    // RLS уже фильтрует expires_at; на клиенте — ротация
    const alive = (data as Ad[]).filter(isActiveNow);
    if (alive.length === 0) return null;
    return alive[Math.floor(Math.random() * alive.length)];
  },

  /** Все баннеры (owner). Включая inactive / expired. */
  async listAll(): Promise<Ad[]> {
    if (!isSupabaseConfigured) {
      return loadDemo().slice().sort((a, b) =>
        (b.created_at || '').localeCompare(a.created_at || '')
      );
    }

    const supabase = await getSupabase();
    const { data, error } = await supabase
      .from('ads')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return (data ?? []) as Ad[];
  },

  async create(input: AdInput): Promise<Ad> {
    const row: Ad = {
      id: 'ad-' + Date.now(),
      title: input.title.trim(),
      description: input.description?.trim() || undefined,
      image_url: input.image_url?.trim() || undefined,
      link_url: input.link_url.trim(),
      link_label: (input.link_label || 'Перейти').trim() || 'Перейти',
      placement: input.placement || 'between_chapters',
      active: input.active ?? true,
      advertiser_name: input.advertiser_name?.trim() || undefined,
      expires_at: input.expires_at || undefined,
      created_at: new Date().toISOString(),
    };

    if (!isSupabaseConfigured) {
      const list = loadDemo();
      list.unshift(row);
      saveDemo(list);
      return row;
    }

    const supabase = await getSupabase();
    const { data, error } = await supabase
      .from('ads')
      .insert({
        title: row.title,
        description: row.description ?? null,
        image_url: row.image_url ?? null,
        link_url: row.link_url,
        link_label: row.link_label,
        placement: row.placement,
        active: row.active,
        advertiser_name: row.advertiser_name ?? null,
        expires_at: row.expires_at ?? null,
      })
      .select()
      .single();

    if (error) throw new Error(`Не удалось создать баннер: ${error.message}`);
    return data as Ad;
  },

  async update(id: string, input: Partial<AdInput>): Promise<Ad> {
    if (!isSupabaseConfigured) {
      const list = loadDemo();
      const idx = list.findIndex((a) => a.id === id);
      if (idx < 0) throw new Error('Баннер не найден');
      const cur = list[idx];
      // cur.active уже нормализован loadDemo() → boolean (default true).
      const next: Ad = {
        ...cur,
        title: input.title !== undefined ? input.title.trim() : cur.title,
        description:
          input.description !== undefined
            ? input.description?.trim() || undefined
            : cur.description,
        image_url:
          input.image_url !== undefined
            ? input.image_url?.trim() || undefined
            : cur.image_url,
        link_url: input.link_url !== undefined ? input.link_url.trim() : cur.link_url,
        link_label:
          input.link_label !== undefined
            ? input.link_label.trim() || 'Перейти'
            : cur.link_label || 'Перейти',
        placement:
          input.placement !== undefined
            ? input.placement
            : cur.placement || 'between_chapters',
        active: input.active !== undefined ? Boolean(input.active) : cur.active !== false,
        advertiser_name:
          input.advertiser_name !== undefined
            ? input.advertiser_name?.trim() || undefined
            : cur.advertiser_name,
        expires_at:
          input.expires_at !== undefined
            ? input.expires_at || undefined
            : cur.expires_at,
      };
      list[idx] = next;
      saveDemo(list);
      return next;
    }

    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) patch.title = input.title.trim();
    if (input.description !== undefined) patch.description = input.description?.trim() || null;
    if (input.image_url !== undefined) patch.image_url = input.image_url?.trim() || null;
    if (input.link_url !== undefined) patch.link_url = input.link_url.trim();
    if (input.link_label !== undefined) patch.link_label = input.link_label.trim() || 'Перейти';
    if (input.placement !== undefined) patch.placement = input.placement;
    if (input.active !== undefined) patch.active = input.active;
    if (input.advertiser_name !== undefined) {
      patch.advertiser_name = input.advertiser_name?.trim() || null;
    }
    if (input.expires_at !== undefined) patch.expires_at = input.expires_at || null;

    const supabase = await getSupabase();
    const { data, error } = await supabase
      .from('ads')
      .update(patch)
      .eq('id', id)
      .select()
      .single();

    if (error) throw new Error(`Не удалось обновить баннер: ${error.message}`);
    return data as Ad;
  },

  async remove(id: string): Promise<void> {
    if (!isSupabaseConfigured) {
      saveDemo(loadDemo().filter((a) => a.id !== id));
      return;
    }
    const supabase = await getSupabase();
    const { error } = await supabase.from('ads').delete().eq('id', id);
    if (error) throw new Error(`Не удалось удалить баннер: ${error.message}`);
  },
};

import { supabase, isSupabaseConfigured } from './client';
import type { AdminRequest, RequestType } from './types';
import { RateLimitError } from './types';

const DEMO_KEY = 'manga_admin_requests';

function loadDemo(): AdminRequest[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    return raw ? (JSON.parse(raw) as AdminRequest[]) : [];
  } catch {
    return [];
  }
}

function saveDemo(list: AdminRequest[]) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

export const adminRequests = {
  async submit(params: {
    type: RequestType;
    target_id?: string;
    target_name?: string;
    payload?: Record<string, unknown>;
    note?: string;
  }): Promise<AdminRequest> {
    if (!isSupabaseConfigured) {
      const row: AdminRequest = {
        id: 'demo-' + Date.now(),
        type: params.type,
        requester_id: 'demo-admin-01',
        target_id: params.target_id,
        target_name: params.target_name,
        payload: params.payload ?? {},
        status: 'pending',
        note: params.note,
        created_at: new Date().toISOString(),
      };
      const list = loadDemo();
      list.unshift(row);
      saveDemo(list);
      console.info('[demo] заявка подана (mockStore):', params);
      return row;
    }

    // requester_id обязателен для admin-заявок (RLS); для ad_request — опционален
    let requesterId: string | null = null;
    try {
      const { data } = await supabase.auth.getUser();
      requesterId = data.user?.id ?? null;
    } catch {
      requesterId = null;
    }

    if (params.type !== 'ad_request' && !requesterId) {
      throw new Error('Нужна авторизация, чтобы подать заявку');
    }

    const { data, error } = await supabase
      .from('admin_requests')
      .insert({
        type: params.type,
        requester_id: requesterId,
        target_id: params.target_id ?? null,
        target_name: params.target_name ?? null,
        payload: params.payload ?? {},
        note: params.note ?? null,
      })
      .select()
      .single();

    if (error) {
      const errAny = error as { code?: string; message?: string; hint?: string };
      const isRate =
        errAny.message?.includes('rate_limit_exceeded') ||
        errAny.code === 'P0001' ||
        errAny.hint?.toLowerCase().includes('заявок');
      if (isRate) {
        // HINT из RAISE EXCEPTION ... USING HINT=... попадает в error.hint, не в message.
        throw new RateLimitError(errAny.hint || errAny.message);
      }
      throw new Error(`Не удалось подать заявку: ${error.message}`);
    }

    return data as AdminRequest;
  },

  async listPending(): Promise<AdminRequest[]> {
    if (!isSupabaseConfigured) {
      return loadDemo().filter((r) => r.status === 'pending');
    }

    const { data, error } = await supabase
      .from('admin_requests')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return (data ?? []) as AdminRequest[];
  },

  async listMine(opts?: { status?: string; limit?: number }): Promise<AdminRequest[]> {
    const limit = opts?.limit ?? 50;
    if (!isSupabaseConfigured) {
      let list = loadDemo();
      if (opts?.status) list = list.filter((r) => r.status === opts.status);
      return list.slice(0, limit);
    }

    // Фильтр status в SQL — иначе при 50+ resolved admin не увидит свои pending.
    let q = supabase
      .from('admin_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (opts?.status) q = q.eq('status', opts.status);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data ?? []) as AdminRequest[];
  },

  async resolve(
    id: string,
    decision: 'approved' | 'rejected',
    rejectReason?: string
  ): Promise<void> {
    if (!isSupabaseConfigured) {
      const list = loadDemo();
      const idx = list.findIndex((r) => r.id === id);
      if (idx < 0) throw new Error('Заявка не найдена');
      const prev = list[idx];

      // Demo: применяем side-effect локально (в проде — триггер apply_admin_request).
      if (decision === 'approved' && prev.status === 'pending') {
        await applyDemoRequest(prev);
      }

      // resolved_by — из текущей demo-сессии (mockStore), как auth.uid() в SQL.
      let demoResolver: string | undefined;
      try {
        const { mockStore } = await import('./mockStore');
        demoResolver = mockStore.getAdminSession()?.user?.id || 'demo-admin-01';
      } catch {
        demoResolver = 'demo-admin-01';
      }

      list[idx] = {
        ...prev,
        status: decision,
        resolved_at: new Date().toISOString(),
        resolved_by: demoResolver,
        reject_reason: rejectReason,
      };
      saveDemo(list);
      return;
    }

    let resolvedBy: string | null = null;
    try {
      const { data } = await supabase.auth.getUser();
      resolvedBy = data.user?.id ?? null;
    } catch {
      // ignore
    }

    // UPDATE → BEFORE trigger apply_admin_request (delete/create chapter).
    const { error } = await supabase
      .from('admin_requests')
      .update({
        status: decision,
        resolved_at: new Date().toISOString(),
        resolved_by: resolvedBy,
        reject_reason: rejectReason ?? null,
      })
      .eq('id', id);

    if (error) throw new Error(`Не удалось обновить заявку: ${error.message}`);
  },
};

/** Локальное применение approved-заявки без Supabase. */
async function applyDemoRequest(req: AdminRequest): Promise<void> {
  // Динамический импорт, чтобы не плодить циклы titles ↔ adminRequests.
  if (req.type === 'delete_title' && req.target_id) {
    const { titles } = await import('./titles');
    try {
      await titles.delete(req.target_id);
    } catch (e) {
      console.warn('[demo] delete_title apply:', e);
      throw e;
    }
    return;
  }
  if (req.type === 'delete_chapter' && req.target_id) {
    const { chapters } = await import('./chapters');
    try {
      await chapters.delete(req.target_id);
    } catch (e) {
      console.warn('[demo] delete_chapter apply:', e);
      throw e;
    }
    return;
  }
  if (req.type === 'new_chapter' && req.target_id) {
    const { chapters } = await import('./chapters');
    const suggested = Number(req.payload?.suggested_number);
    const number = Number.isFinite(suggested) && suggested > 0 ? suggested : 1;
    const name =
      typeof req.payload?.name === 'string' ? req.payload.name : null;
    try {
      await chapters.create({
        title_id: req.target_id,
        number,
        name,
        published: false,
      });
    } catch (e) {
      // Номер занят — пробуем number+1 … +20
      let created = false;
      for (let n = number + 1; n <= number + 20; n++) {
        try {
          await chapters.create({
            title_id: req.target_id,
            number: n,
            name,
            published: false,
          });
          created = true;
          break;
        } catch {
          // try next
        }
      }
      if (!created) {
        console.warn('[demo] new_chapter apply failed:', e);
        throw e;
      }
    }
  }
  // ad_request — без авто-применения
}

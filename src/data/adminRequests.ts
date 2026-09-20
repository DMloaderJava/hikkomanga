import { getSupabase, isSupabaseConfigured } from './client';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/integrations/supabase/config';
import type { AdminRequest, RequestType } from './types';
import { RateLimitError, SlugConflictError } from './types';

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

    const supabase = await getSupabase();
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

    const supabase = await getSupabase();
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

    const supabase = await getSupabase();
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

  /**
   * Решение owner'а. 'spam' — как rejected, но помечает нарушителя
   * (попадает в автоочистку через 90 дней и в фильтр bulk-reject по IP).
   */
  async resolve(
    id: string,
    decision: 'approved' | 'rejected' | 'spam',
    rejectReason?: string
  ): Promise<{ conflict?: boolean }> {
    if (!isSupabaseConfigured) {
      const list = loadDemo();
      const idx = list.findIndex((r) => r.id === id);
      if (idx < 0) throw new Error('Заявка не найдена');
      const prev = list[idx];

      // Demo: применяем side-effect локально (в проде — триггер apply_admin_request).
      // new_title: конфликт slug НЕ срывает approve — заявка одобряется с
      // payload.conflict=true (как on conflict do nothing в триггере).
      let conflictPayload: Record<string, unknown> | null = null;
      if (decision === 'approved' && prev.status === 'pending') {
        try {
          await applyDemoRequest(prev);
        } catch (e) {
          if (e instanceof SlugConflictError && prev.type === 'new_title') {
            conflictPayload = { conflict: true };
          } else {
            throw e;
          }
        }
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
        payload: conflictPayload ? { ...prev.payload, ...conflictPayload } : prev.payload,
        conflict: conflictPayload ? true : false,
      };
      saveDemo(list);
      return conflictPayload ? { conflict: true } : {};
    }

    const supabase = await getSupabase();
    let resolvedBy: string | null = null;
    try {
      const { data } = await supabase.auth.getUser();
      resolvedBy = data.user?.id ?? null;
    } catch {
      // ignore
    }

    // UPDATE → BEFORE trigger apply_admin_request (delete/create chapter,
    // черновик new_title + payload.conflict при занятом slug).
    const { data, error } = await supabase
      .from('admin_requests')
      .update({
        status: decision,
        resolved_at: new Date().toISOString(),
        resolved_by: resolvedBy,
        reject_reason: rejectReason ?? null,
      })
      .eq('id', id)
      .select('payload')
      .single();

    if (error) throw new Error(`Не удалось обновить заявку: ${error.message}`);
    return data?.payload?.conflict === true ? { conflict: true } : {};
  },

  /**
   * Полный список для owner-инбокса с фильтрами (тип/статус на стороне SQL,
   * поиск по ip_hash — клиентом). Нужно для разбора анонимных заявок:
   * pending по умолчанию, но resolved тоже видны.
   */
  async listForOwner(opts?: { status?: string; type?: string; limit?: number }): Promise<AdminRequest[]> {
    const limit = opts?.limit ?? 200;
    if (!isSupabaseConfigured) {
      let list = loadDemo();
      if (opts?.status) list = list.filter((r) => r.status === opts.status);
      if (opts?.type) list = list.filter((r) => r.type === opts.type);
      return list.slice(0, limit);
    }

    const supabase = await getSupabase();
    let q = supabase
      .from('admin_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (opts?.status) q = q.eq('status', opts.status);
    if (opts?.type) q = q.eq('type', opts.type);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data ?? []) as AdminRequest[];
  },

  /**
   * Bulk reject: все pending-заявки с этого ip_hash → rejected. Против
   * спам-волн: одна кнопка вместо ручного перещёлкивания.
   */
  async rejectByIp(ipHash: string, rejectReason?: string): Promise<number> {
    if (!ipHash?.trim()) throw new Error('ip_hash обязателен');

    if (!isSupabaseConfigured) {
      const list = loadDemo();
      let count = 0;
      const now = new Date().toISOString();
      const updated = list.map((r) => {
        if (r.status === 'pending' && r.ip_hash === ipHash) {
          count += 1;
          return {
            ...r,
            status: 'rejected' as const,
            resolved_at: now,
            resolved_by: 'demo-admin-01',
            reject_reason: rejectReason ?? 'bulk: спам с одного IP',
          };
        }
        return r;
      });
      saveDemo(updated);
      return count;
    }

    const supabase = await getSupabase();
    let resolvedBy: string | null = null;
    try {
      const { data } = await supabase.auth.getUser();
      resolvedBy = data.user?.id ?? null;
    } catch {
      // ignore
    }
    const { data, error } = await supabase
      .from('admin_requests')
      .update({
        status: 'rejected',
        resolved_at: new Date().toISOString(),
        resolved_by: resolvedBy,
        reject_reason: rejectReason ?? 'bulk: спам с одного IP',
      })
      .eq('ip_hash', ipHash)
      .eq('status', 'pending')
      .select('id');

    if (error) throw new Error(`Не удалось отклонить заявки: ${error.message}`);
    return data?.length ?? 0;
  },

  /**
   * Уведомить заявителя о решении (если он оставил email).
   * Fire-and-forget: ошибка почты НЕ срывает модерацию. В демо — console.info.
   */
  async notifySubmitter(info: {
    email?: string | null;
    status: 'approved' | 'rejected' | 'spam';
    title?: string;
    reason?: string;
  }): Promise<void> {
    if (!info.email) return;
    if (!isSupabaseConfigured) {
      console.info(`[demo] уведомили бы ${info.email}: заявка «${info.title}» → ${info.status}`);
      return;
    }
    try {
      const supabase = await getSupabase();
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      await fetch(`${SUPABASE_URL}/functions/v1/notify-submitter`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: info.email,
          status: info.status,
          title: info.title,
          reason: info.reason,
          siteUrl: window.location.origin,
        }),
      });
    } catch (e) {
      console.warn('[adminRequests] notify-submitter недоступен:', e);
    }
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
  if (req.type === 'new_title') {
    // Анонимная заявка на тайтл → черновик (published=false), как триггер 14.
    // Занятый slug → SlugConflictError: resolve() ловит и ставит payload.conflict.
    const { titles } = await import('./titles');
    const { slugify } = await import('@/lib/slugify');
    const p = req.payload as Record<string, unknown>;
    const original = typeof p.original_title === 'string' ? p.original_title : '';
    if (!original.trim()) throw new Error('В заявке нет original_title');

    const status =
      p.status === 'completed' || p.status === 'ongoing' ? p.status : 'ongoing';
    await titles.create({
      slug: slugify(original),
      title: original,
      author: typeof p.author === 'string' && p.author ? p.author : null,
      description: typeof p.description === 'string' && p.description ? p.description : null,
      cover_url: typeof p.cover_url === 'string' && p.cover_url ? p.cover_url : null,
      status,
      published: false,
      genre_ids: [],
    });
    return;
  }
  // ad_request — без авто-применения
}

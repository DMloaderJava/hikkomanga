// Edge-функция: завершение одобренной заявки с главами (approve в /admin/requests).
//
// POST { request_id }
// Auth: только owner (approve заявки тоже доступен только owner — RLS
// «owner can update status»).
//
// Что делает (см. finalizeChapterSubmission в _shared/chapterSubmissionCore.ts):
//   1. SELECT заявки, проверка type ∈ {new_chapters, new_title} и status='approved';
//   2. для каждой главы — INSERT chapters (published=false), свободный номер
//      при конфликте (запрошенный номер фиксируется в payload.finalized.renumbered);
//   3. страницы: download из submissions → upload в manga/{chapterId}/… → INSERT pages;
//   4. исходники главы удаляются из submissions;
//   5. finalized_at + payload.finalized = { chapters_imported, pages_imported }.
//
// Идемпотентность: finalized_at != null → skipped=true, ничего не создаётся;
// сбой на k-й главе оставляет payload.finalized_chapter_id у предыдущих,
// повторный вызов продолжает с k-й (кнопка «Завершить импорт» в карточке).
//
// Секреты: SUPABASE_SERVICE_ROLE_KEY (автоматически), SUPABASE_URL, SUPABASE_ANON_KEY.
// Деплой: supabase functions deploy finalize-chapter-submission

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { finalizeChapterSubmission, type FinalizeDeps } from '../_shared/chapterSubmissionCore.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json(401, { ok: false, error: 'Unauthorized' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json(500, { ok: false, error: 'config_missing' });
  }

  // Проверка роли — клиентом заявителя (anon key + JWT), всё остальное —
  // service_role: RLS на admin_requests/chapters/pages/storage не для анонима.
  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const {
    data: { user },
    error: userError,
  } = await client.auth.getUser();
  if (userError || !user) return json(401, { ok: false, error: 'Unauthorized' });

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // has_role(uid UUID, role_to_check TEXT) — сигнатура из миграций 00/04,
  // та же, что в login-notify / notify-submitter / gemini-proxy.
  const { data: isOwner, error: roleError } = await admin.rpc('has_role', {
    uid: user.id,
    role_to_check: 'owner',
  });
  // Ошибка RPC — это 500, а не «не owner»: иначе owner получил бы 403 без
  // внятной причины (например, при неприменённой миграции с has_role).
  if (roleError) {
    return json(500, { ok: false, error: 'role_check_failed', detail: roleError.message });
  }
  if (!isOwner) return json(403, { ok: false, error: 'Forbidden' });

  let body: { request_id?: string } = {};
  try {
    body = (await req.json()) as { request_id?: string };
  } catch {
    return json(400, { ok: false, error: 'invalid_json' });
  }

  const deps: FinalizeDeps = {
    getRequest: async (id) => {
      const { data, error } = await admin
        .from('admin_requests')
        .select('id, type, status, target_id, payload, finalized_at')
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as never) ?? null;
    },
    checkpoint: async (id, payload) => {
      const { error } = await admin.from('admin_requests').update({ payload }).eq('id', id);
      if (error) throw new Error(error.message);
    },
    finish: async (id, payload) => {
      const { error } = await admin
        .from('admin_requests')
        .update({ payload, finalized_at: new Date().toISOString(), finalized_error: null })
        .eq('id', id);
      if (error) throw new Error(error.message);
    },
    fail: async (id, message) => {
      // Ошибка импорта не откатывает approve: заявка остаётся approved,
      // owner жмёт «Завершить импорт» после исправления причины.
      const { error } = await admin
        .from('admin_requests')
        .update({ finalized_error: message.slice(0, 2000) })
        .eq('id', id);
      if (error) throw new Error(error.message);
    },
    takenNumbers: async (titleId) => {
      const { data, error } = await admin
        .from('chapters')
        .select('number')
        .eq('title_id', titleId);
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => Number((r as { number: number }).number));
    },
    createChapter: async (input) => {
      const { data, error } = await admin
        .from('chapters')
        .insert({
          title_id: input.title_id,
          number: input.number,
          name: input.name,
          description: input.description,
          // Глава из заявки NEVER публикуется автоматически (ТЗ).
          published: false,
        })
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      return { id: (data as { id: string }).id };
    },
    copyPage: async (sourcePath, target) => {
      const { data: blob, error: dlError } = await admin.storage
        .from('submissions')
        .download(sourcePath);
      if (dlError || !blob) throw new Error(`download ${sourcePath}: ${dlError?.message ?? 'нет файла'}`);

      const bytes = new Uint8Array(await blob.arrayBuffer());
      const stamp = `${Date.now()}-${crypto.randomUUID()}`;
      const path = `${target.chapterId}/${target.order}-${stamp}.${target.ext}`;
      const { error: upError } = await admin.storage
        .from('manga')
        .upload(path, bytes, {
          contentType: CONTENT_TYPES[target.ext] ?? 'application/octet-stream',
          cacheControl: '31536000',
          upsert: false,
        });
      if (upError) throw new Error(`upload ${path}: ${upError.message}`);
      return `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/manga/${path}`;
    },
    insertPage: async (input) => {
      const { error } = await admin.from('pages').insert(input);
      if (error) throw new Error(error.message);
    },
    removeSources: async (paths) => {
      for (let i = 0; i < paths.length; i += 100) {
        const { error } = await admin.storage
          .from('submissions')
          .remove(paths.slice(i, i + 100));
        if (error) throw new Error(error.message);
      }
    },
  };

  try {
    const result = await finalizeChapterSubmission(deps, {
      requestId: String(body.request_id ?? ''),
    });
    return json(result.status, result.body);
  } catch (e) {
    return json(500, {
      ok: false,
      error: 'internal',
      detail: e instanceof Error ? e.message : String(e),
    });
  }
});

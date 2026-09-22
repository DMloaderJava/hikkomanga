// Edge-функция: анонимная заявка «Предложить главу» (1–5 глав со страницами).
//
// POST multipart/form-data:
//   turnstileToken — токен капчи (Turnstile/hCaptcha, см. _shared/captcha.ts)
//   consent        — «on»/«true»: согласие на обработку заявки
//   payload        — JSON { title_id, title_name?, chapters: [{ number, name?,
//                    description?, pages: [{ name, size }], pdf? }] }
//   email?         — опционально: уведомление о решении
//   ch-{n}-page-{m}[.ext] — страницы глав (≤20 MB, форматы из PAGE_EXT)
//   ch-{n}.pdf?    — оригинал PDF главы (≤200 MB; разбивка на страницы
//                    делается на клиенте, сервер хранит файл как есть)
//
// Порядок: rate limit (3/мин, 30/час, 100/сутки по
// sha256(ip + ':chapters' + RATE_LIMIT_SALT))
// → согласие → капча → payload → тайтл опубликован → файлы → upload в бакет
// submissions (service_role) → INSERT в admin_requests type='new_chapters'.
// Вся логика — в _shared/chapterSubmissionCore.ts (покрывается
// scripts/unit-submit-chapters.mjs).
//
// Файлы лежат в submissions/{token}/ch-{n}/page-{m}.{ext} до approve;
// перенос в manga/ делает finalize-chapter-submission.
//
// Секреты: CAPTCHA_PROVIDER, TURNSTILE_SECRET_KEY | HCAPTCHA_SECRET_KEY | RECAPTCHA_SECRET_KEY,
// RATE_LIMIT_SALT. SUPABASE_SERVICE_ROLE_KEY доступен автоматически.
//
// Деплой: supabase functions deploy submit-chapters

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyCaptcha } from '../_shared/captcha.ts';
import { hashIp, pickClientIp } from '../_shared/submissionCore.ts';
import {
  CHAPTER_RATE_SCOPE,
  processChapterSubmission,
  type ChapterFilePart,
  type ChapterSubmissionDeps,
} from '../_shared/chapterSubmissionCore.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extraHeaders },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const salt = Deno.env.get('RATE_LIMIT_SALT') ?? '';
  if (!supabaseUrl || !serviceKey || !salt) {
    return json(500, { ok: false, error: 'config_missing' });
  }

  // service_role: RLS запрещает анонимный INSERT в admin_requests, а бакет
  // submissions пишется только сервером (см. миграцию 10).
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { ok: false, error: 'invalid_form' });
  }

  const captchaToken = String(form.get('turnstileToken') ?? form.get('captchaToken') ?? '');
  const consentRaw = String(form.get('consent') ?? '').toLowerCase();
  const consent = consentRaw === 'on' || consentRaw === 'true' || consentRaw === '1';
  const email = String(form.get('email') ?? '');
  const payloadRaw = (() => {
    try {
      return JSON.parse(String(form.get('payload') ?? 'null'));
    } catch {
      return null;
    }
  })();

  // Все файловые части — страницы/PDF; имена проверяет checkChapterFiles.
  const files: ChapterFilePart[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') continue;
    if (!value || typeof value !== 'object' || !('arrayBuffer' in value)) continue;
    const file = value as File;
    files.push({
      name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      contentType: file.type || undefined,
    });
  }

  const ip = pickClientIp(
    req.headers.get('cf-connecting-ip'),
    req.headers.get('x-forwarded-for')
  );

  const deps: ChapterSubmissionDeps = {
    verifyCaptcha,
    // Отдельный от заявок на тайтл счётчик окон: иначе 3 поданных тайтла
    // закрыли бы подачу главы (окна в ip_rate_limit общие на ip_hash).
    checkLimit: async (windowSeconds, limit) => {
      const scoped = await hashIp(`${ip}${CHAPTER_RATE_SCOPE}`, salt);
      const { data, error } = await admin.rpc('check_ip_rate_limit', {
        p_ip_hash: scoped,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      });
      if (error) throw new Error(`rate_limit_rpc: ${error.message}`);
      return data === true;
    },
    lookupTitle: async (id) => {
      const { data, error } = await admin
        .from('titles')
        .select('id, title, published')
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { id: string; title: string; published: boolean } | null) ?? null;
    },
    uploadPage: async (bytes, token, path, contentType) => {
      const { error } = await admin.storage
        .from('submissions')
        .upload(path, bytes, { contentType, upsert: true });
      if (error) throw new Error(error.message);
    },
    insertRequest: async (row) => {
      const { data, error } = await admin
        .from('admin_requests')
        .insert(row)
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      return { id: data.id as string };
    },
    // ip_hash строки — БЕЗ суффикса: bulk-reject по IP в /admin/requests
    // должен ловить и заявки на тайтлы, и заявки на главы.
    hashIp: (clientIp) => hashIp(clientIp, salt),
  };

  try {
    const result = await processChapterSubmission(deps, {
      captchaToken,
      consent,
      payloadRaw,
      email,
      files,
      ip,
      userAgent: req.headers.get('user-agent') ?? undefined,
    });
    return json(
      result.status,
      result.body,
      result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : {}
    );
  } catch (e) {
    // Fail-closed: любая ошибка инфраструктуры — 500, заявки нет.
    return json(500, {
      ok: false,
      error: 'internal',
      detail: e instanceof Error ? e.message : String(e),
    });
  }
});

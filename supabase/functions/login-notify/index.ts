// Supabase Edge Function: уведомление владельца о входе администратора.
//
// Вызывается клиентом сразу после успешного signIn (src/data/notify.ts).
// Требует валидную сессию с ролью admin — иначе 401/403, чтобы эндпоинт
// не использовали для спама.
//
// Секреты (Supabase → Edge Functions → Secrets, или `supabase secrets set`):
//   RESEND_API_KEY    — ключ Resend
//   OWNER_NOTIFY_EMAIL— куда слать (babaevafarida8@gmail.com)
//   OWNER_NOTIFY_FROM — опционально, по умолчанию onboarding@resend.dev
//
// Деплой: supabase functions deploy login-notify --project-ref <ref>

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildLoginMailHtml,
  buildLoginMailSubject,
  type LoginMailPayload,
} from "../../src/lib/loginMailTemplate.ts";

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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed' });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return json(401, { ok: false, error: 'Unauthorized' });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return json(401, { ok: false, error: 'Unauthorized' });
  }

  const { data: isAdmin } = await supabase.rpc('has_role', {
    uid: user.id,
    role_to_check: 'admin',
  });
  if (!isAdmin) {
    return json(403, { ok: false, error: 'Forbidden' });
  }

  let payload: LoginMailPayload = {};
  try {
    payload = (await req.json()) as LoginMailPayload;
  } catch {
    // пустое тело допустимо — письмо уйдёт с тем, что известно серверу
  }

  const to = Deno.env.get('OWNER_NOTIFY_EMAIL');
  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!to) {
    return json(500, { ok: false, error: 'OWNER_NOTIFY_EMAIL secret is not set' });
  }
  if (!apiKey) {
    return json(503, { ok: false, error: 'RESEND_API_KEY secret is not set' });
  }
  const from =
    Deno.env.get('OWNER_NOTIFY_FROM') || 'Hikkomanga Login Guard <onboarding@resend.dev>';

  const enriched: LoginMailPayload = {
    ...payload,
    ip: payload.ip || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
  };

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: buildLoginMailSubject(enriched),
        html: buildLoginMailHtml(enriched),
      }),
    });
    const data = await resendRes.json().catch(() => null);
    if (!resendRes.ok) {
      return json(502, {
        ok: false,
        error: (data as { message?: string })?.message || `Resend HTTP ${resendRes.status}`,
      });
    }
    return json(200, { ok: true, id: (data as { id?: string })?.id });
  } catch (e) {
    return json(502, { ok: false, error: (e as Error).message });
  }
});

// Supabase Edge Function: approve/deny входа по токену из письма.
// Публичный эндпоинт (токен = секрет). Вызывается со страницы
// /admin/login/confirm?token=...&action=approve|deny
//
// Деплой: supabase functions deploy login-confirm --project-ref <ref>

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

  let body: { token?: string; action?: string } = {};
  try {
    body = (await req.json()) as { token?: string; action?: string };
  } catch {
    return json(400, { ok: false, error: 'invalid json' });
  }

  const token = (body.token || '').trim();
  const action = (body.action || '').trim().toLowerCase();
  if (!token || (action !== 'approve' && action !== 'deny')) {
    return json(400, { ok: false, error: 'token and action=approve|deny required' });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  );

  const { data, error } = await supabase.rpc('resolve_login_challenge', {
    p_token: token,
    p_action: action,
  });

  if (error) {
    return json(500, { ok: false, error: error.message });
  }

  const status = String(data || 'error');
  const ok = status === 'approved' || status === 'denied' ||
    status === 'already_approved' || status === 'already_denied';

  return json(ok ? 200 : 400, { ok, status });
});

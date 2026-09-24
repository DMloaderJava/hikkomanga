import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CryptoError, decryptSecret, secretAad } from "../_shared/crypto.ts";

/**
 * gemini-proxy — AI-анализ страниц (/analyze) и озвучка (/tts).
 *
 * Ключ Gemini берётся у пользователя, который вызвал функцию
 * (`public.user_api_keys`, шифротекст AES-256-GCM), и расшифровывается
 * внутри функции секретом USER_KEY_ENC_SECRET.
 *
 * Общего секрета GEMINI_API_KEY здесь НЕТ намеренно: фолбэк на один ключ
 * на всех означал бы, что заявленный «свой ключ админа» ни на что не влияет,
 * а лимиты и биллинг Gemini размазываются по всем аккаунтам сразу. Нет
 * ключа — 403 с кодом `gemini_key_missing`, UI отправляет в /admin/settings.
 *
 * ENV GEMINI_API_KEY осталась только у dev-middleware в vite.config.ts
 * (`npm run dev` без Supabase) — прод-путь её не читает.
 *
 * Запросы:
 *   POST /analyze  { imageBase64, mimeType }
 *   POST /tts      { lines, voiceMap }
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

type KeyResult = { ok: true; key: string } | { ok: false; response: Response };

/** Читает и расшифровывает ключ вызывающего. Чужие строки недоступны (RLS). */
async function resolveGeminiKey(
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<KeyResult> {
  const { data, error } = await supabase
    .from('user_api_keys')
    .select('provider, ciphertext, iv')
    .eq('user_id', userId)
    .eq('provider', 'gemini')
    .maybeSingle();

  if (error) {
    // 42P01 = relation does not exist: миграция с user_api_keys не применена.
    const message = error.code === '42P01'
      ? 'Таблица public.user_api_keys не найдена — примените миграцию 00000000000017_user_api_keys.sql.'
      : error.message;

    return {
      ok: false,
      response: json({ error: 'db_error', code: 'db_error', message }, 500),
    };
  }

  if (!data) {
    return {
      ok: false,
      response: json(
        {
          error: 'gemini_key_missing',
          code: 'gemini_key_missing',
          message: 'Gemini API key не задан. Добавьте свой ключ: /admin/settings',
        },
        403
      ),
    };
  }

  try {
    const key = await decryptSecret(
      { ciphertext: data.ciphertext as string, iv: data.iv as string },
      { aad: secretAad(userId, data.provider as string) }
    );

    if (!key.trim()) {
      throw new CryptoError('decrypt_failed', 'Расшифрованный ключ пуст');
    }

    return { ok: true, key };
  } catch (error) {
    const code = error instanceof CryptoError ? error.code : 'decrypt_failed';
    // ciphertext/plaintext в ответе нет — только код и подсказка.
    return {
      ok: false,
      response: json(
        {
          error: 'gemini_key_unreadable',
          code: 'gemini_key_unreadable',
          reason: code,
          message:
            code === 'enc_secret_missing' || code === 'enc_secret_invalid'
              ? 'Проверьте Edge Secret USER_KEY_ENC_SECRET в проекте Supabase.'
              : 'Ключ не расшифровывается (сменён USER_KEY_ENC_SECRET?). Сохраните ключ заново: /admin/settings',
        },
        500
      ),
    };
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return json({ error: 'unauthorized' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return json({ error: 'unauthorized' }, 401);
  }

  const { data: isAdmin } = await supabase.rpc('has_role', {
    uid: user.id,
    role_to_check: 'admin',
  });

  if (!isAdmin) {
    return json({ error: 'forbidden' }, 403);
  }

  const url = new URL(req.url);
  const pathname = url.pathname;
  const isAnalyze = pathname === '/analyze' || pathname === '/functions/v1/gemini-proxy/analyze';
  const isTts = pathname === '/tts' || pathname === '/functions/v1/gemini-proxy/tts';

  // 1. Analyze Endpoint (Vision)
  if (req.method === 'POST' && isAnalyze) {
    const key = await resolveGeminiKey(supabase, user.id);
    if (!key.ok) return key.response;

    const { imageBase64, mimeType } = await req.json();
    const promptText = `Ты — анализатор манги. Извлеки все диалоговые облака и закадровый текст со страницы.
Верни СТРОГО чистый JSON массив без разметки: [{"speaker":"Speaker1","text":"..."}]`;

    const response = await fetch(
      `${GEMINI_API}/gemini-2.5-flash:generateContent?key=${key.key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: promptText },
                { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } },
              ],
            },
          ],
        }),
      }
    );

    const data = await response.json();
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 2. TTS Endpoint (Speech Synthesis)
  if (req.method === 'POST' && isTts) {
    const key = await resolveGeminiKey(supabase, user.id);
    if (!key.ok) return key.response;

    const { lines, voiceMap } = await req.json();
    const textInput = (lines || [])
      .map((l: any) => `${l.speaker || 'Narrator'}: ${l.text || ''}`)
      .join('\n');

    const speechConfig = Object.entries(voiceMap || {}).map(([speaker, voice]) => ({
      speaker,
      voiceConfig: { prebuiltVoiceConfig: { voiceName: (voice as string) || 'Kore' } },
    }));

    const response = await fetch(
      `${GEMINI_API}/gemini-2.5-flash-preview-tts:generateContent?key=${key.key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: textInput }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig:
              speechConfig.length > 0
                ? { multiSpeakerVoiceConfig: { speakerVoiceConfigs: speechConfig } }
                : undefined,
          },
        }),
      }
    );

    const data = await response.json();
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response('Not Found', { status: 404, headers: corsHeaders });
});

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CryptoError, decryptSecret, secretAad } from "../_shared/crypto.ts";
import {
  DIALOG_TTS_MODEL,
  DialogTtsError,
  buildDialogWav,
  extractInlineAudio,
  geminiEndpoint,
  geminiHeaders,
  parseDialogTranscript,
  planDialogTts,
} from "../_shared/gemini-tts.ts";

/**
 * dialog-tts — озвучка расшифровки диалога одной кнопкой.
 *
 *   POST { transcript: "Speaker 1: …\nSpeaker 2: …", voices: { "1": "Kore" } }
 *   → 200 audio/wav (один файл, реплики разделены паузами 220 мс)
 *
 * Отличие от `gemini-proxy`/`tts`: туда идут уже разобранные реплики страницы
 * главы, а сюда — сырая расшифровка с префиксами `Speaker N:`. Разбор, план
 * запросов и склейка WAV живут в `_shared/gemini-tts.ts` (одна копия логики,
 * её же дергают unit-тесты) — здесь только HTTP и авторизация.
 *
 * Режимы (подробности — в секции dialog-tts общего модуля):
 *   1 спикер  — один запрос, один голос;
 *   2 спикера — один запрос, multiSpeakerVoiceConfig с именами `Speaker 1`/`Speaker 2`;
 *   3+        — по запросу на реплику, СТРОГО последовательно (один ключ на
 *               аккаунт, параллельные вызовы упираются в 429).
 *
 * Ключ Gemini — персональный ключ админа из `public.user_api_keys`
 * (AES-256-GCM, Edge Secret USER_KEY_ENC_SECRET), общий GEMINI_API_KEY не
 * используется и в клиент не попадает. Нет ключа → 403 `gemini_key_missing`,
 * UI ведёт в /admin/settings.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/** Ошибки запроса уровня пользователя: 400 + текст, который показываем как есть. */
function dialogErrorResponse(error: unknown): Response | null {
  if (error instanceof DialogTtsError) {
    // Текст совпадает с формулировкой ТЗ: «Текст пуст», «Не найдено реплик»,
    // «Слишком много спикеров (макс. 8)», «Слишком много реплик (макс. 40)».
    return json({ error: error.message, code: error.code }, 400);
  }
  return null;
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
    return { ok: false, response: json({ error: 'db_error', message: error.message }, 500) };
  }

  if (!data) {
    return {
      ok: false,
      response: json(
        { error: 'gemini_key_missing', message: 'Добавьте ключ: /admin/settings' },
        403
      ),
    };
  }

  try {
    const key = await decryptSecret(
      { ciphertext: data.ciphertext as string, iv: data.iv as string },
      { aad: secretAad(userId, data.provider as string) }
    );

    if (!key.trim()) throw new CryptoError('decrypt_failed', 'Расшифрованный ключ пуст');
    return { ok: true, key };
  } catch {
    // Ни ciphertext, ни текст ошибки наружу: только код для UI.
    return { ok: false, response: json({ error: 'gemini_key_unreadable' }, 500) };
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

  const body = await req.json().catch(() => ({})) as { transcript?: unknown; voices?: unknown };
  const voices = (body.voices && typeof body.voices === 'object' ? body.voices : {}) as Record<
    string,
    unknown
  >;

  // Валидация входа идёт ДО чтения ключа: пустой транскрипт — ошибка
  // пользователя, и незачем ходить в базу за ключом, чтобы это выяснить.
  let plan: ReturnType<typeof planDialogTts>;
  try {
    plan = planDialogTts(parseDialogTranscript(body.transcript), voices);
  } catch (error) {
    const response = dialogErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const key = await resolveGeminiKey(supabase, user.id);
  if (!key.ok) return key.response;

  const chunks: { data: string; mimeType: string }[] = [];

  // «Прочее» из таблицы ошибок (сеть до Google, битый ответ) — всегда 500 с
  // одним и тем же текстом: детали уходят в логи edge-функции, а не в UI.
  try {
    for (let index = 0; index < plan.requests.length; index += 1) {
      const request = plan.requests[index];

      // Последовательно, без Promise.all: ключ персональный, и параллельные
      // запросы к Gemini TTS на одном ключе регулярно возвращают 429.
      const response = await fetch(geminiEndpoint(DIALOG_TTS_MODEL), {
        method: 'POST',
        // Ключ уходит заголовком: новые auth-ключи `AQ.…` с `?key=` отдают 404.
        headers: geminiHeaders(key.key),
        body: JSON.stringify(request.body),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        if (response.status === 429) {
          return json({ error: 'Слишком много запросов, попробуйте позже' }, 429);
        }
        if (response.status >= 400 && response.status < 500) {
          return json({ error: 'Не удалось озвучить текст' }, 400);
        }
        return json({ error: 'Озвучка не удалась' }, 500);
      }

      const audio = extractInlineAudio(data);
      if (!audio) {
        return json({ error: 'Озвучка не удалась' }, 500);
      }

      chunks.push(audio);
    }

    const wav = buildDialogWav(chunks);

    // Тело — WAV-байты целиком (не стрим): клиент играет файл из blob:,
    // поэтому ему нужен `Content-Length`, а не поток.
    return new Response(wav, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'audio/wav',
        'Content-Length': String(wav.byteLength),
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return json({ error: 'Озвучка не удалась' }, 500);
  }
});

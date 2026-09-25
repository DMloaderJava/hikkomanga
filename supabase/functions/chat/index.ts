import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CryptoError, decryptSecret, secretAad } from "../_shared/crypto.ts";
import { toGeminiContents } from "../_shared/gemini-chat.ts";
// Адрес API и заголовки общие с TTS-модулем: ключ уходит в `x-goog-api-key`,
// а не в `?key=` (новые auth-ключи `AQ.…` с query-параметром не работают —
// Google отдаёт 404), а база API не дублируется в двух файлах.
import { GEMINI_API_BASE, geminiHeaders } from "../_shared/gemini-tts.ts";

/**
 * chat — support-чат в боковой панели сайта.
 *
 *   POST { messages: [{ role: 'user'|'assistant', content }] }
 *   → 200 text/event-stream (SSE от Gemini, проксируется как есть)
 *
 * Роль admin здесь НЕ требуется: это поддержка для любого авторизованного
 * пользователя. Но ключ Gemini — персональный, из `public.user_api_keys`
 * (шифротекст AES-256-GCM, Edge Secret USER_KEY_ENC_SECRET): у админа берётся
 * его ключ, у обычного читателя ключа нет — тогда используется ключ владельца
 * проекта (owner), а если и его нет — первого админа с сохранённым ключом.
 * Фолбэк нужен, чтобы чат работал «из коробки»: читатель не ходит в
 * /admin/settings и свой ключ завести не может.
 *
 * Модель одна и задана константой MODEL_ID — никаких селекторов и маппингов
 * UI-имён (см. unit-тест scripts/unit-chat.mjs: модель в файле должна быть
 * ровно одна). `thinkingBudget: 0` выключает «размышления» 2.5-flash: для
 * поддержки важна скорость ответа, а не глубина; если Google не примет 0,
 * функция один раз повторяет запрос с минимальным бюджетом 1.
 */

const MODEL_ID = 'gemini-2.5-flash';

const SYSTEM_PROMPT = `Ты — ассистент поддержки сайта hikkomanga (онлайн-читалка манги). 
Отвечай кратко, вежливо, на русском языке. Если пользователь описывает проблему — 
предложи конкретные шаги решения. Если вопрос про функционал (загрузка глав, 
озвучка, AI-анализ страниц, роли, настройки) — объясни как это работает. 
Если не знаешь ответа — честно скажи и предложи обратиться к администратору. 
Не выдумывай функции, которых нет.`;

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

interface KeyRow {
  userId: string;
  provider: string;
  ciphertext: string;
  iv: string;
}

/**
 * Ключ для чата: свой → owner → первый админ с ключом.
 *
 * Читаем сервисной ролью, потому что RLS `user_api_keys` пускает только
 * собственную строку админа: чужой (owner'ский) ключ иначе не достать.
 * Плейнтекст никуда не пишется и не возвращается — наружу уходит только
 * результат расшифровки внутри функции.
 */
async function resolveChatKey(
  service: ReturnType<typeof createClient>,
  userId: string
): Promise<{ ok: true; key: string } | { ok: false; response: Response }> {
  const readRow = async (ownerId: string): Promise<KeyRow | null> => {
    const { data, error } = await service
      .from('user_api_keys')
      .select('user_id, provider, ciphertext, iv')
      .eq('user_id', ownerId)
      .eq('provider', 'gemini')
      .maybeSingle();

    if (error || !data) return null;
    return {
      userId: data.user_id as string,
      provider: data.provider as string,
      ciphertext: data.ciphertext as string,
      iv: data.iv as string,
    };
  };

  let row = await readRow(userId);

  if (!row) {
    // Кандидаты: owner вперёд, затем админы (порядок user_id — стабильный,
    // чтобы «первый админ» не менялся от запуска к запуску).
    const { data: roles } = await service
      .from('user_roles')
      .select('user_id, role')
      .in('role', ['owner', 'admin'])
      .order('user_id', { ascending: true });

    const candidates = (roles ?? [])
      .map((role) => ({ id: role.user_id as string, role: role.role as string }))
      .sort((a, b) => (a.role === b.role ? 0 : a.role === 'owner' ? -1 : 1));

    for (const candidate of candidates) {
      row = await readRow(candidate.id);
      if (row) break;
    }
  }

  if (!row) {
    return {
      ok: false,
      response: json({ error: 'gemini_key_missing', message: 'Обратитесь к администратору' }, 403),
    };
  }

  try {
    const key = await decryptSecret(
      { ciphertext: row.ciphertext, iv: row.iv },
      { aad: secretAad(row.userId, row.provider) }
    );

    if (!key.trim()) throw new CryptoError('decrypt_failed', 'Расшифрованный ключ пуст');
    return { ok: true, key };
  } catch {
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
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

  // Пользовательский клиент — только для проверки JWT: дальше всё читается
  // сервисной ролью (чужой ключ owner'а), роль admin не нужна.
  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) {
    return json({ error: 'unauthorized' }, 401);
  }

  const body = await req.json().catch(() => ({})) as { messages?: unknown };
  const contents = toGeminiContents(
    Array.isArray(body.messages) ? body.messages : []
  );

  if (contents.length === 0) {
    return json({ error: 'empty_messages', message: 'Пустой запрос' }, 400);
  }

  const service = createClient(supabaseUrl, serviceRoleKey);
  const key = await resolveChatKey(service, user.id);
  if (!key.ok) return key.response;

  const callGemini = (thinkingBudget: number) =>
    fetch(`${GEMINI_API_BASE}/${MODEL_ID}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: geminiHeaders(key.key),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { thinkingConfig: { thinkingBudget } },
      }),
    });

  let upstream = await callGemini(0);

  // thinkingBudget: 0 — не для всех версий модели. Если Google вернул 400
  // именно из-за него, повторяем один раз с минимумом (ТЗ: «заменить на 1»).
  if (upstream.status === 400) {
    const detail = await upstream.text().catch(() => '');
    if (/thinking/i.test(detail) || !detail) {
      upstream = await callGemini(1);
    } else {
      return json({ error: 'Ошибка AI сервиса' }, 500);
    }
  }

  if (!upstream.ok) {
    if (upstream.status === 429) {
      return json({ error: 'rate_limit', message: 'Слишком много запросов' }, 429);
    }
    return json({ error: 'Ошибка AI сервиса' }, 500);
  }

  if (!upstream.body) {
    return json({ error: 'Ошибка AI сервиса' }, 500);
  }

  // Тело Gemini отдаём как есть: клиент (`parseGeminiSSE` в src/data/chat.ts)
  // сам разбирает `data: {...}` чанки и не зависит от формы ответа модели.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

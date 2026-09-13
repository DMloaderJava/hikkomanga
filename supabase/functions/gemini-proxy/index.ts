import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders });
  }

  const { data: isAdmin } = await supabase.rpc('has_role', {
    uid: user.id,
    role_to_check: 'admin',
  });

  if (!isAdmin) {
    return new Response('Forbidden', { status: 403, headers: corsHeaders });
  }

  const geminiKey = Deno.env.get('GEMINI_API_KEY');
  if (!geminiKey) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY is not configured' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(req.url);
  const pathname = url.pathname;
  const isAnalyze = pathname === '/analyze' || pathname === '/functions/v1/gemini-proxy/analyze';
  const isTts = pathname === '/tts' || pathname === '/functions/v1/gemini-proxy/tts';

  // 1. Analyze Endpoint (Vision)
  if (req.method === 'POST' && isAnalyze) {
    const { imageBase64, mimeType } = await req.json();
    const promptText = `Ты — анализатор манги. Извлеки все диалоговые облака и закадровый текст со страницы.
Верни СТРОГО чистый JSON массив без разметки: [{"speaker":"Speaker1","text":"..."}]`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
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
    const { lines, voiceMap } = await req.json();
    const textInput = (lines || [])
      .map((l: any) => `${l.speaker || 'Narrator'}: ${l.text || ''}`)
      .join('\n');

    const speechConfig = Object.entries(voiceMap || {}).map(([speaker, voice]) => ({
      speaker,
      voiceConfig: { prebuiltVoiceConfig: { voiceName: (voice as string) || 'Kore' } },
    }));

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${geminiKey}`,
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

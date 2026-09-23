import { getSupabase, isSupabaseConfigured } from './client';
import type { DialogueLine } from './types';
export type { DialogueLine };

/** Тело не-2xx ответа edge-функции: supabase-js кладёт Response в `error.context`. */
type EdgeErrorBody = { error?: string; code?: string; message?: string };

async function readEdgeError(error: unknown): Promise<EdgeErrorBody | null> {
  const context = (error as { context?: Response } | null)?.context;
  if (!context || typeof context.json !== 'function') return null;
  try {
    return (await context.clone().json()) as EdgeErrorBody;
  } catch {
    return null;
  }
}

/**
 * Проблемы с персональным ключом админа (см. /admin/settings).
 *
 * Раньше функция молча уходила на dev-proxy `/api/gemini/*` — в проде его нет,
 * и админ видел «ошибку сервиса» вместо «добавьте ключ». Теперь такой ответ
 * edge-функции превращается в actionable-ошибку без бесполезного fallback'а.
 */
const KEY_ERROR_CODES = new Set(['gemini_key_missing', 'gemini_key_unreadable']);

function keyErrorMessage(body: EdgeErrorBody): Error {
  if (body.code === 'gemini_key_missing') {
    return new Error('Gemini API key не задан. Добавьте свой ключ в админке: /admin/settings.');
  }
  return new Error(
    body.message ??
      'Gemini API key не читается (сменён USER_KEY_ENC_SECRET?). Сохраните ключ заново: /admin/settings.'
  );
}

function pcmToWav(
  pcm: Uint8Array,
  sampleRate = 24000,
  channels = 1,
  bitsPerSample = 16
): Blob {
  const dataSize = pcm.byteLength;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) =>
    s.split('').forEach((c, i) => view.setUint8(off + i, c.charCodeAt(0)));

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, (sampleRate * channels * bitsPerSample) / 8, true);
  view.setUint16(32, (channels * bitsPerSample) / 8, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  new Uint8Array(buffer, 44).set(pcm);

  return new Blob([buffer], { type: 'audio/wav' });
}

async function fetchImageAsBase64(url: string): Promise<{ mimeType: string; data: string }> {
  if (url.startsWith('data:')) {
    const commaIdx = url.indexOf(',');
    const header = url.substring(0, commaIdx);
    const data = url.substring(commaIdx + 1);
    const mimeMatch = header.match(/data:([^;]+)/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    return { mimeType, data };
  }

  const response = await fetch(url);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const commaIdx = result.indexOf(',');
      const data = result.substring(commaIdx + 1);
      resolve({ mimeType: blob.type || 'image/jpeg', data });
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function parseGeminiResponse(data: any, pageIndex: number): DialogueLine[] {
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
  const cleanedJson = rawText
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  try {
    const parsedLines: { speaker: string; text: string }[] = JSON.parse(cleanedJson);
    return parsedLines.map((line, idx) => ({
      id: `line-${pageIndex}-${idx}-${Date.now()}`,
      speaker: line.speaker || 'Narrator',
      text: line.text || '',
      pageIndex,
    }));
  } catch {
    throw new Error(`Не удалось распарсить ответ анализа: "${rawText.substring(0, 100)}..."`);
  }
}

export const gemini = {
  async analyzeImage(imageUrl: string, pageIndex = 0): Promise<DialogueLine[]> {
    const { mimeType, data: imageBase64 } = await fetchImageAsBase64(imageUrl);

    // 1. Primary: Try Supabase Edge Function invocation
    if (isSupabaseConfigured) {
      let keyError: EdgeErrorBody | null = null;
      try {
        const supabase = await getSupabase();
        const { data, error } = await supabase.functions.invoke('gemini-proxy/analyze', {
          body: { imageBase64, mimeType },
        });

        if (!error && data) {
          return parseGeminiResponse(data, pageIndex);
        }

        const body = error ? await readEdgeError(error) : null;
        if (body?.code && KEY_ERROR_CODES.has(body.code)) keyError = body;
      } catch {
        // Fallback to local dev middleware proxy
      }

      if (keyError) throw keyErrorMessage(keyError);
    }

    // 2. Dev proxy fallback (/api/gemini/analyze)
    const res = await fetch('/api/gemini/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64, mimeType }),
    });

    if (!res.ok) {
      throw new Error(`Ошибка сервиса анализа Gemini (${res.status} ${res.statusText})`);
    }

    const data = await res.json();
    if (data.error) {
      throw new Error(`Ошибка Gemini API: ${data.error.message || data.error}`);
    }

    return parseGeminiResponse(data, pageIndex);
  },

  async generateAudio(
    lines: DialogueLine[],
    voiceMap: Record<string, string> = {}
  ): Promise<{ blob: Blob; durationMs: number }> {
    if (lines.length === 0) {
      throw new Error('Нет реплик для озвучки');
    }

    let responseAudioBase64: string | null = null;

    // 1. Primary: Try Supabase Edge Function invocation for Gemini TTS
    if (isSupabaseConfigured) {
      let keyError: EdgeErrorBody | null = null;
      try {
        const supabase = await getSupabase();
        const { data, error } = await supabase.functions.invoke('gemini-proxy/tts', {
          body: { lines, voiceMap },
        });

        if (!error && data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data) {
          responseAudioBase64 = data.candidates[0].content.parts[0].inlineData.data;
        }

        const body = error ? await readEdgeError(error) : null;
        if (body?.code && KEY_ERROR_CODES.has(body.code)) keyError = body;
      } catch {
        // Fallback to dev proxy
      }

      if (keyError) throw keyErrorMessage(keyError);
    }

    // 2. Dev proxy fallback (/api/gemini/tts)
    if (!responseAudioBase64) {
      const res = await fetch('/api/gemini/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines, voiceMap }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data) {
          responseAudioBase64 = data.candidates[0].content.parts[0].inlineData.data;
        } else if (data.error) {
          throw new Error(`Ошибка Gemini TTS: ${data.error.message || data.error}`);
        }
      } else {
        throw new Error(`Ошибка сервиса Gemini TTS (${res.status} ${res.statusText})`);
      }
    }

    if (responseAudioBase64) {
      const byteCharacters = atob(responseAudioBase64);
      const byteArray = new Uint8Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteArray[i] = byteCharacters.charCodeAt(i);
      }
      const wavBlob = pcmToWav(byteArray, 24000, 1, 16);

      const totalWords = lines.reduce((acc, l) => acc + (l.text ? l.text.split(' ').length : 0), 0);
      const estimatedMs = Math.max(3000, Math.ceil(totalWords * 450));

      return { blob: wavBlob, durationMs: estimatedMs };
    }

    throw new Error('Gemini TTS недоступен. Проверьте подключение к Edge Function и настройки секретов.');
  },
};

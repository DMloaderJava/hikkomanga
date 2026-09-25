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

/**
 * Структурированный ответ edge-функции → ошибка для UI.
 *
 * `gemini-proxy` теперь отдаёт ошибки в одном формате (`error`/`code`/`message`)
 * и для озвучки, и для анализа: текст Gemini («API key not valid», «model not
 * found», лимиты) доходит до админа как есть, а не превращается в «404 от
 * /api/gemini/tts» после бесполезного dev-fallback'а.
 *
 * `null` — ответа нашей функции нет (сеть, 404 «функция не задеплоена»,
 * не-JSON тело): только в этом случае имеет смысл пробовать dev-proxy.
 */
function edgeErrorFrom(body: EdgeErrorBody | null): Error | null {
  if (!body) return null;

  const code = typeof body.code === 'string' ? body.code : '';
  if (code && KEY_ERROR_CODES.has(code)) return keyErrorMessage(body);

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (message) return new Error(message);

  const error = typeof body.error === 'string' ? body.error : '';
  if (error) return new Error(`Gemini недоступен: ${error}. Подробности — в логах edge-функции gemini-proxy.`);

  return null;
}

/**
 * Ошибка вызова в проде, когда edge-функция не ответила разобранным телом
 * (`edgeErrorFrom` вернул null): сеть, 404 «функция не задеплоена», не-JSON.
 *
 * В проде пробрасывать дальше `devProxyError` нельзя — dev-middleware
 * `/api/gemini/*` есть только в `npm run dev`, и админ получал «ошибка
 * сервиса» вместо реальной причины. Здесь собираем текст из того, что есть:
 * тело ответа Supabase, статус, сообщение сети.
 */
async function productionEdgeError(thrown: unknown, scope: string): Promise<Error> {
  const body = await readEdgeError(thrown);
  const message = (body?.message ?? body?.error ?? '').trim();
  if (message) return new Error(message);

  const context = (thrown as { context?: Response } | null)?.context;
  if (context) {
    return new Error(
      `${scope}: edge-функция gemini-proxy ответила HTTP ${context.status}. ` +
        'Подробности — в логах функции (Supabase → Edge Functions).'
    );
  }

  const fallback = thrown instanceof Error ? thrown.message.trim() : '';
  return new Error(
    fallback
      ? `${scope}: ${fallback}`
      : `${scope}: edge-функция gemini-proxy недоступна. Проверьте, что она задеплоена: supabase functions deploy gemini-proxy.`
  );
}

/** Ошибка dev-proxy `/api/gemini/*`: читаем { message } из тела, если оно есть. */
async function devProxyError(scope: string, res: Response): Promise<Error> {
  const body = await res.json().catch(() => null);
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (message) return new Error(message);

  if (isSupabaseConfigured && res.status === 404) {
    return new Error(
      `${scope}: 404 от /api/gemini/* (dev-middleware есть только в npm run dev). ` +
        'Проверьте, что edge-функция задеплоена: supabase functions deploy gemini-proxy.'
    );
  }

  return new Error(`${scope} (${res.status} ${res.statusText})`);
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
      let edgeError: Error | null = null;
      let thrown: unknown = null;
      try {
        const supabase = await getSupabase();
        // Действие — полем в теле: сабпас в имени функции
        // (`gemini-proxy/analyze`) превращается в URL
        // /functions/v1/gemini-proxy/analyze, и шлюз Supabase отдаёт 404.
        const { data, error } = await supabase.functions.invoke('gemini-proxy', {
          body: { action: 'analyze', imageBase64, mimeType },
        });

        if (!error && data) {
          return parseGeminiResponse(data, pageIndex);
        }

        thrown = error;
        edgeError = edgeErrorFrom(error ? await readEdgeError(error) : null);
      } catch (error) {
        thrown = error;
      }

      if (import.meta.env.PROD) {
        // Прод: dev-middleware `/api/gemini/*` здесь не существует, поэтому
        // наружу идёт реальный текст от Supabase (или причина сети/деплоя).
        throw edgeError ?? (await productionEdgeError(thrown, 'Ошибка сервиса анализа Gemini'));
      }

      if (edgeError) throw edgeError;
    }

    // 2. Dev proxy fallback (/api/gemini/analyze) — есть только в npm run dev.
    const res = await fetch('/api/gemini/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64, mimeType }),
    });

    if (!res.ok) {
      throw await devProxyError('Ошибка сервиса анализа Gemini', res);
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

    // 1. Primary: Try Supabase Edge Function invocation for Gemini TTS.
    //    Модель gemini-3.8-flash-tts держит максимум 2 голоса на запрос,
    //    поэтому глава с большим числом персонажей режется на чанки и
    //    склеивается в один PCM уже внутри gemini-proxy — форма ответа та же.
    if (isSupabaseConfigured) {
      let edgeError: Error | null = null;
      let thrown: unknown = null;
      try {
        const supabase = await getSupabase();
        // Как и в анализе: действие — в теле, без сабпаса в URL.
        const { data, error } = await supabase.functions.invoke('gemini-proxy', {
          body: { action: 'tts', lines, voiceMap },
        });

        if (!error && data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data) {
          responseAudioBase64 = data.candidates[0].content.parts[0].inlineData.data;
        }

        thrown = error;
        edgeError = edgeErrorFrom(error ? await readEdgeError(error) : null);
      } catch (error) {
        thrown = error;
      }

      if (import.meta.env.PROD) {
        throw edgeError ?? (await productionEdgeError(thrown, 'Ошибка сервиса Gemini TTS'));
      }

      if (edgeError) throw edgeError;
    }

    // 2. Dev proxy fallback (/api/gemini/tts) — есть только в npm run dev.
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
        throw await devProxyError('Ошибка сервиса Gemini TTS', res);
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

/**
 * Чат поддержки: приведение сообщений к формату Gemini.
 *
 * Клиент (`src/data/chat.ts`, боковая панель `SupportChat`) отправляет
 * OpenAI-подобную историю: `role: 'user' | 'assistant'` и `content`, который
 * бывает строкой или массивом частей (`text`, `inlineData`, `image_url`).
 * Gemini ждёт другое: `role: 'user' | 'model'` и `parts[]` с `text` или
 * `inlineData`. Конвертация живёт здесь, а не в edge-функции, чтобы её можно
 * было прогнать unit-тестом (`scripts/unit-chat.mjs`) без Deno и без сети.
 *
 * Модуль чистый: никаких Deno/Node API, только строки и объекты.
 */

/** Часть сообщения в формате клиента (совместимо с OpenAI-подобным API). */
export interface ChatContentPart {
  type?: string;
  text?: string;
  mimeType?: string;
  data?: string;
  image_url?: { url?: string };
}

export type ChatContent = string | ChatContentPart[] | null | undefined;

export interface ChatMessage {
  role?: string;
  content?: ChatContent;
}

export interface GeminiInlineData {
  mimeType: string;
  data: string;
}

export interface GeminiPart {
  text?: string;
  inlineData?: GeminiInlineData;
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/**
 * Разбор data-URL (`data:image/jpeg;base64,xxx`).
 *
 * Только base64: urlencoded-вариант (`data:image/png,%89PNG…`) в API не
 * принимается, а внешние http(s)-ссылки сознательно НЕ скачиваются —
 * edge-функция, дергающая произвольный URL из пользовательского запроса,
 * это SSRF. Клиент всегда шлёт base64 (файл читается через FileReader),
 * так что терять нечего.
 */
export function parseDataUrl(url: unknown): GeminiInlineData | null {
  if (typeof url !== 'string') return null;

  const match = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match || !match[2]) return null;

  const data = match[3].replace(/\s+/g, '');
  if (!data) return null;

  return { mimeType: match[1] || 'image/jpeg', data };
}

/** Одна часть клиента → одна часть Gemini; null — часть не поддержана. */
function toGeminiPart(part: ChatContentPart | null | undefined): GeminiPart | null {
  if (!part || typeof part !== 'object') return null;

  if (part.type === 'text' || (part.text !== undefined && part.type === undefined)) {
    const text = typeof part.text === 'string' ? part.text : '';
    return text ? { text } : null;
  }

  if (part.type === 'inlineData' || part.type === 'inline_data') {
    if (typeof part.data !== 'string' || !part.data) return null;
    return { inlineData: { mimeType: part.mimeType || 'image/jpeg', data: part.data } };
  }

  if (part.type === 'image_url') {
    const inline = parseDataUrl(part.image_url?.url);
    return inline ? { inlineData: inline } : null;
  }

  return null;
}

/**
 * История клиента → `contents` Gemini.
 *
 *  - `assistant` → `model` (у Gemini нет роли assistant), всё остальное — `user`;
 *  - строка → `parts: [{ text }]`;
 *  - массив → `parts` по частям (text / inlineData / image_url);
 *  - пустые сообщения и неподдержанные части выбрасываются: Gemini отвечает
 *    400 на `parts: []`, а пустая строка в истории — обычное дело после
 *    обрыва стрима кнопкой «Стоп».
 */
export function toGeminiContents(messages: readonly ChatMessage[] | null | undefined): GeminiContent[] {
  const contents: GeminiContent[] = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;

    const role: GeminiContent['role'] = message.role === 'assistant' ? 'model' : 'user';
    const content = message.content;

    let parts: GeminiPart[];
    if (typeof content === 'string') {
      parts = content.trim() ? [{ text: content }] : [];
    } else if (Array.isArray(content)) {
      parts = content
        .map((part) => toGeminiPart(part))
        .filter((part): part is GeminiPart => part !== null);
    } else {
      parts = [];
    }

    if (parts.length === 0) continue;
    contents.push({ role, parts });
  }

  return contents;
}

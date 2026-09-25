import * as React from 'react';
import { AlertTriangle, Loader2, MessageCircle, Paperclip, Send, Square, Volume2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { isSupabaseConfigured } from '@/data/client';
import { CHAT_ERROR_MESSAGES, streamChat, ChatError, type ChatMessage } from '@/data/chat';
import { DialogTtsError, DIALOG_TTS_ERROR_MESSAGES, synthesizeDialog } from '@/data/dialogTts';
import { useSupportChat } from './SupportChatContext';

/**
 * Support-чат: текстовые вопросы + картинка + озвучка ответа.
 *
 * Ответ приходит стримом (SSE от edge-функции `chat`): пустое сообщение
 * ассистента создаётся заранее, токены дописываются в него по мере чтения
 * потока. Кнопка «Стоп» отменяет запрос через AbortController — уже
 * полученные токены остаются в сообщении (модель не откатывается назад).
 *
 * Озвучка ответа идёт через `dialog-tts`: созданные `blob:`-ссылки
 * складываются в `objectUrls` и отзываются при размонтировании панели, иначе
 * аудио осталось бы в памяти вкладки (и Safari не отдаёт его сборщику).
 */

interface AttachedImage {
  name: string;
  mimeType: string;
  /** base64 без префикса `data:…;base64,` — формат `inlineData` Gemini. */
  data: string;
  /** data-URL для превью: его не надо revoke, в отличие от blob: из TTS. */
  previewUrl: string;
}

interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  image?: AttachedImage;
}

/** Озвучка ответа: один Speaker (реплики поддержки — монолог). */
const SUPPORT_TTS_VOICE = 'Charon';

function readImageFile(file: File): Promise<AttachedImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      const comma = dataUrl.indexOf(',');
      resolve({
        name: file.name,
        mimeType: file.type || 'image/jpeg',
        data: comma >= 0 ? dataUrl.slice(comma + 1) : '',
        previewUrl: dataUrl,
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });
}

/** История UI → сообщения для edge-функции (OpenAI-подобный формат). */
function toApiMessage(message: UiMessage): ChatMessage | null {
  const text = message.text.trim();
  const parts: { type: 'text' | 'inlineData'; text?: string; mimeType?: string; data?: string }[] = [];

  if (text) parts.push({ type: 'text', text });
  if (message.image?.data) {
    parts.push({ type: 'inlineData', mimeType: message.image.mimeType, data: message.image.data });
  }

  if (parts.length === 0) return null;
  if (parts.length === 1 && parts[0].type === 'text') return { role: message.role, content: text };
  return { role: message.role, content: parts };
}

export function SupportChat() {
  const { setOpen } = useSupportChat();

  const [messages, setMessages] = React.useState<UiMessage[]>([]);
  const [input, setInput] = React.useState('');
  const [attached, setAttached] = React.useState<AttachedImage | null>(null);
  const [isStreaming, setIsStreaming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [speakingId, setSpeakingId] = React.useState<string | null>(null);
  const [audioUrl, setAudioUrl] = React.useState<string | null>(null);

  const abortRef = React.useRef<AbortController | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const audioRef = React.useRef<HTMLAudioElement>(null);
  const objectUrls = React.useRef<Set<string>>(new Set());

  // Скролл к последней реплике: и на новый вопрос, и на каждый токен ответа.
  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  // Размонтирование панели: глушим стрим, звук и освобождаем blob:-ссылки.
  React.useEffect(
    () => () => {
      abortRef.current?.abort();
      audioRef.current?.pause();
      for (const url of objectUrls.current) URL.revokeObjectURL(url);
      objectUrls.current.clear();
    },
    []
  );

  React.useEffect(() => {
    if (!audioUrl || !audioRef.current) return;
    // Автоплей может быть запрещён политикой браузера — тогда пользователь
    // нажмёт play в появившемся плеере.
    void audioRef.current.play().catch(() => undefined);
  }, [audioUrl]);

  const canSend = !isStreaming && (input.trim().length > 0 || Boolean(attached?.data));

  const stop = () => abortRef.current?.abort();

  const handleFile = async (file: File | null) => {
    if (!file) return;
    try {
      setAttached(await readImageFile(file));
      setError(null);
    } catch {
      setError('Не удалось прочитать изображение.');
    }
  };

  const handleSubmit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;

    const userMessage: UiMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: input.trim(),
      image: attached ?? undefined,
    };
    const history = [...messages, userMessage];
    const assistantId = `assistant-${Date.now()}`;

    setMessages([...history, { id: assistantId, role: 'assistant', text: '' }]);
    setInput('');
    setAttached(null);
    setError(null);
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;
    let received = '';

    try {
      const apiMessages = history
        .map(toApiMessage)
        .filter((message): message is ChatMessage => message !== null);

      const stream = await streamChat({ messages: apiMessages, signal: controller.signal });

      for await (const token of stream) {
        received += token;
        setMessages((prev) =>
          prev.map((message) => (message.id === assistantId ? { ...message, text: received } : message))
        );
      }
    } catch (thrown) {
      // Отмена пользователем — не ошибка: то, что успело прийти, остаётся.
      if (!controller.signal.aborted) {
        setError(thrown instanceof ChatError ? thrown.message : CHAT_ERROR_MESSAGES.unknown);
      }
    } finally {
      if (controller.signal.aborted && !received) {
        setMessages((prev) =>
          prev.map((message) => (message.id === assistantId ? { ...message, text: '(ответ остановлен)' } : message))
        );
      }
      setIsStreaming(false);
      abortRef.current = null;
    }
  };

  const speak = async (message: UiMessage) => {
    const text = message.text.trim();
    if (!text) return;

    setSpeakingId(message.id);
    setError(null);

    try {
      const blob = await synthesizeDialog({
        transcript: `Speaker 1: ${text}`,
        voices: { '1': SUPPORT_TTS_VOICE },
      });
      const url = URL.createObjectURL(blob);

      // Держим только текущую озвучку: прошлую освобождаем сразу.
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
        objectUrls.current.delete(audioUrl);
      }
      objectUrls.current.add(url);
      setAudioUrl(url);
    } catch (thrown) {
      setError(thrown instanceof DialogTtsError ? thrown.message : DIALOG_TTS_ERROR_MESSAGES.unknown);
    } finally {
      setSpeakingId(null);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void handleSubmit();
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/70">
      <div className="flex items-center justify-between gap-2 border-b border-neutral-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-rose-400" />
          <span className="text-sm font-semibold text-white">Чат поддержки</span>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Свернуть чат"
          className="rounded-md p-1 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {/* Демо-режим: отправлять некуда. Предупреждаем сразу, а не после
            первого вопроса — иначе ошибка выглядит как «функция не
            задеплоена», хотя дело в окружении. */}
        {!isSupabaseConfigured && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
            <span>
              Демо-режим: Supabase не настроен, ассистент отвечать не будет. Задайте{' '}
              <code className="text-amber-100">VITE_SUPABASE_URL</code> и{' '}
              <code className="text-amber-100">VITE_SUPABASE_ANON_KEY</code> и перезапустите
              dev-сервер — см. SETUP_SUPABASE.md.
            </span>
          </div>
        )}

        {messages.length === 0 && (
          <p className="text-xs leading-relaxed text-neutral-500">
            Задайте вопрос про загрузку глав, озвучку, AI-анализ страниц или роли — ассистент ответит
            по шагам. Можно приложить скриншот проблемы.
          </p>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={cn('flex flex-col gap-1', message.role === 'user' ? 'items-end' : 'items-start')}
          >
            <div
              className={cn(
                'max-w-[92%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm',
                message.role === 'user'
                  ? 'bg-rose-600/90 text-white'
                  : 'bg-neutral-800/80 text-neutral-100'
              )}
            >
              {message.image && (
                <img
                  src={message.image.previewUrl}
                  alt={message.image.name}
                  className="mb-2 max-h-40 rounded-md border border-black/20"
                />
              )}
              {message.text || (message.role === 'assistant' ? '…' : '')}
            </div>

            {message.role === 'assistant' && message.text.trim().length > 0 && (
              <button
                type="button"
                onClick={() => void speak(message)}
                disabled={speakingId !== null}
                className="flex items-center gap-1 text-[11px] text-neutral-500 transition-colors hover:text-rose-400 disabled:opacity-50"
              >
                {speakingId === message.id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Volume2 className="h-3 w-3" />
                )}
                Озвучить
              </button>
            )}
          </div>
        ))}

        {error && (
          <div className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {audioUrl && (
        <div className="border-t border-neutral-800 px-3 py-2">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio ref={audioRef} src={audioUrl} controls className="h-8 w-full" />
        </div>
      )}

      <form onSubmit={handleSubmit} className="border-t border-neutral-800 p-3">
        {attached && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-950/60 p-2">
            <img src={attached.previewUrl} alt={attached.name} className="h-10 w-10 rounded object-cover" />
            <span className="flex-1 truncate text-xs text-neutral-400">{attached.name}</span>
            <button
              type="button"
              onClick={() => setAttached(null)}
              aria-label="Убрать изображение"
              className="rounded p-1 text-neutral-500 hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <div className="flex items-end gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              void handleFile(event.target.files?.[0] ?? null);
              event.target.value = '';
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="Прикрепить изображение"
            aria-label="Прикрепить изображение"
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip className="h-4 w-4" />
          </Button>

          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder="Опишите проблему… (Enter — отправить, Shift+Enter — новая строка)"
            className="min-h-[44px] flex-1 resize-none py-2 text-sm"
          />

          {isStreaming ? (
            <Button type="button" variant="secondary" size="icon" title="Стоп" aria-label="Стоп" onClick={stop}>
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button type="submit" size="icon" title="Отправить" aria-label="Отправить" disabled={!canSend}>
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, KeyRound, Loader2, Trash2 } from 'lucide-react';
import { API_KEY_ERROR_MESSAGES, ApiKeyError, apiKeys } from '@/data/apiKeys';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatDate } from '@/lib/format';

/**
 * Настройки → Gemini API key.
 *
 * Ключ свой у каждого админа: озвучка и AI-анализ страниц (edge-функция
 * gemini-proxy) работают от ключа того, кто нажал кнопку. Общего
 * GEMINI_API_KEY в проде нет — если ключа нет, функции возвращают
 * `gemini_key_missing`, а здесь висит баннер с объяснением.
 *
 * В UI показываем ровно то, что отдаёт сервер: `last4` и дату обновления.
 * Показать или скачать сам ключ нельзя ни отсюда, ни из консоли — в базе
 * только шифротекст (см. supabase/migrations/00000000000017_user_api_keys.sql).
 */

/** Один ключ на запрос: используется и страницей, и инвалидацией после save/delete. */
export const API_KEY_QUERY_KEY = ['admin', 'api-keys'] as const;

function errorText(error: unknown): string {
  if (error instanceof ApiKeyError) return error.message;
  if (error instanceof Error) return error.message;
  return API_KEY_ERROR_MESSAGES.unknown;
}

type Notice = { kind: 'ok' | 'error'; text: string };

export function ApiKeySettings() {
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const status = useQuery({
    queryKey: API_KEY_QUERY_KEY,
    queryFn: () => apiKeys.status(),
  });

  const save = useMutation({
    mutationFn: (key: string) => apiKeys.save(key),
    onSuccess: (result) => {
      setInput('');
      setNotice({ kind: 'ok', text: `Ключ сохранён (…${result.last4})` });
      void queryClient.invalidateQueries({ queryKey: API_KEY_QUERY_KEY });
    },
    onError: (error) => setNotice({ kind: 'error', text: errorText(error) }),
  });

  const remove = useMutation({
    mutationFn: () => apiKeys.remove(),
    onSuccess: () => {
      setNotice({ kind: 'ok', text: 'Ключ удалён' });
      void queryClient.invalidateQueries({ queryKey: API_KEY_QUERY_KEY });
    },
    onError: (error) => setNotice({ kind: 'error', text: errorText(error) }),
  });

  const demo = status.data?.demo ?? false;
  const connected = Boolean(status.data?.key);
  const isBusy = save.isPending || remove.isPending;
  const showLoading = status.isPending && !status.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-start gap-3 border-b border-neutral-800 pb-6">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-rose-900/50 bg-rose-950/50 text-rose-400">
          <KeyRound className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Настройки · Gemini API key</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Персональный ключ для озвучки и AI-анализа страниц. Хранится зашифрованным
            (AES-256-GCM), обратно не показывается — только последние 4 символа.
          </p>
        </div>
      </div>

      {demo && (
        <div className="flex items-start gap-3 rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 text-sm text-neutral-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400" />
          <div>
            <p className="font-medium text-neutral-200">Демо-режим: Supabase не настроен</p>
            <p className="mt-1 text-xs text-neutral-400">
              {API_KEY_ERROR_MESSAGES.demo_mode} Задайте <code>VITE_SUPABASE_URL</code> и{' '}
              <code>VITE_SUPABASE_ANON_KEY</code>, задеплойте <code>admin-api-keys</code> — см.
              SETUP_SUPABASE.md.
            </p>
          </div>
        </div>
      )}

      {!demo && !connected && !showLoading && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-900/60 bg-amber-950/30 p-4 text-sm text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div>
            <p className="font-medium">Ключ не задан — озвучка недоступна</p>
            <p className="mt-1 text-xs text-amber-200/80">
              Общего серверного ключа больше нет: каждый админ добавляет свой. Пока ключа нет,
              gemini-proxy отвечает <code>gemini_key_missing</code>, и генерация озвучки падает
              с подсказкой вернуться на эту страницу.
            </p>
          </div>
        </div>
      )}

      {status.isError && (
        <div className="rounded-lg border border-red-900/60 bg-red-950/30 p-4 text-sm text-red-200">
          Не удалось получить статус ключа: {errorText(status.error)}
        </div>
      )}

      <Card className="border-neutral-800 bg-neutral-900/60">
        <CardHeader>
          <CardTitle className="text-base text-white">Ключ Gemini API</CardTitle>
          <CardDescription className="text-xs text-neutral-400">
            Создать ключ: Google AI Studio → API keys. Формат — <code>AIza…</code>, 39 символов.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-neutral-400">Статус:</span>
            {showLoading ? (
              <span className="flex items-center gap-2 text-sm text-neutral-400">
                <Loader2 className="h-4 w-4 animate-spin" /> Проверка…
              </span>
            ) : connected ? (
              <Badge variant="success" className="gap-1">
                <CheckCircle2 className="h-3 w-3" /> подключён
              </Badge>
            ) : (
              <Badge variant="secondary">не задан</Badge>
            )}
          </div>

          {connected && status.data?.key && (
            <div className="space-y-1">
              {/* Маска собирается одной строкой: React не вставляет между
                  текстовыми узлами комментарии, и её видно в SSR-разметке. */}
              <div className="font-mono text-sm text-neutral-200">
                {`AIza…••••${status.data.key.last4}`}
              </div>
              <div className="text-xs text-neutral-500">
                провайдер: {status.data.key.provider}, обновлён{' '}
                {formatDate(status.data.key.updated_at)}
              </div>
            </div>
          )}

          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              const value = input.trim();
              if (!value || isBusy || demo) return;
              setNotice(null);
              save.mutate(value);
            }}
          >
            <Label htmlFor="gemini-api-key" className="text-xs text-neutral-400">
              {connected ? 'Новый ключ (заменит текущий)' : 'Gemini API key'}
            </Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="gemini-api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={demo || isBusy}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={connected ? 'AIza… (замена)' : 'AIza…'}
                className="flex-1 font-mono"
              />
              <Button type="submit" disabled={demo || isBusy || !input.trim()} className="gap-2">
                {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {save.isPending ? 'Сохраняю…' : connected ? 'Заменить' : 'Сохранить'}
              </Button>
            </div>
            <p className="text-xs text-neutral-500">
              Ключ уходит только в edge-функцию <code>admin-api-keys</code> и сохраняется
              шифротекстом: прочитать его из базы или из UI нельзя.
            </p>
          </form>

          {connected && (
            <Button
              type="button"
              variant="outline"
              disabled={isBusy || demo}
              onClick={() => setConfirmOpen(true)}
              className="gap-2 border-red-900/60 text-red-300 hover:bg-red-950/40 hover:text-red-200"
            >
              <Trash2 className="h-4 w-4" /> Удалить ключ
            </Button>
          )}

          {notice && (
            <div
              className={
                notice.kind === 'ok'
                  ? 'text-sm text-emerald-400'
                  : 'rounded-lg border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-200'
              }
            >
              {notice.text}
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-neutral-500">
        Ротация Edge Secret <code>USER_KEY_ENC_SECRET</code> ломает расшифровку уже сохранённых
        ключей — порядок действий в SETUP_SUPABASE.md, раздел «Gemini API key на пользователя».
      </p>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Удалить Gemini API key?"
        description="Озвучка и AI-анализ страниц перестанут работать, пока не добавите ключ заново. Записи озвучек и страницы это не затрагивает."
        confirmLabel="Удалить ключ"
        onConfirm={async () => {
          setNotice(null);
          try {
            await remove.mutateAsync();
          } catch (error) {
            // Ошибку показываем в inline-баннере: диалог ConfirmDialog остаётся открытым.
            setNotice({ kind: 'error', text: errorText(error) });
            throw error;
          }
        }}
      />
    </div>
  );
}

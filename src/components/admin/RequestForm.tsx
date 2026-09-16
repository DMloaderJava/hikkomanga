import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { adminRequests } from '@/data/adminRequests';
import type { RequestType } from '@/data/types';
import { RateLimitError } from '@/data/types';
import { Send, Loader2, CheckCircle, AlertCircle } from 'lucide-react';

interface RequestFormProps {
  type: RequestType;
  target_id?: string;
  target_name?: string;
  payload?: Record<string, unknown>;
  title: string;
  description: string;
  submitLabel?: string;
  onSuccess?: () => void;
}

type FormState = 'idle' | 'sending' | 'sent' | 'error';

export function RequestForm({
  type,
  target_id,
  target_name,
  payload,
  title,
  description,
  submitLabel = 'Подать заявку',
  onSuccess,
}: RequestFormProps) {
  const [note, setNote] = useState('');
  const [state, setState] = useState<FormState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState('sending');
    setErrorMsg(null);

    try {
      await adminRequests.submit({
        type,
        target_id,
        target_name,
        payload,
        note: note.trim() || undefined,
      });
      setState('sent');
      onSuccess?.();
    } catch (err: unknown) {
      setState('error');
      if (err instanceof RateLimitError) {
        setErrorMsg(
          err.hint ||
            err.message ||
            'Слишком много заявок. Подождите час и попробуйте снова.'
        );
      } else if (err instanceof Error) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Неизвестная ошибка');
      }
    }
  };

  if (state === 'sent') {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-green-800/60 bg-green-950/30 p-6 text-center">
        <CheckCircle className="h-8 w-8 text-green-400" />
        <p className="text-sm font-semibold text-green-300">Заявка отправлена</p>
        <p className="text-xs text-neutral-400">
          Владелец получит уведомление и рассмотрит её.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-neutral-700"
            onClick={() => {
              setState('idle');
              setNote('');
              setErrorMsg(null);
            }}
          >
            Отправить ещё
          </Button>
          {type === 'ad_request' && (
            <a
              href="/"
              className="inline-flex h-8 items-center rounded-md px-3 text-xs text-neutral-400 hover:text-white"
            >
              В каталог
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <h3 className="text-sm font-bold text-white">{title}</h3>
        <p className="text-xs text-neutral-400 leading-relaxed">{description}</p>
      </div>

      {target_name && (
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm">
          <span className="text-neutral-500">Объект: </span>
          <span className="font-medium text-neutral-100">{target_name}</span>
        </div>
      )}

      <div className="space-y-1.5">
        <label className="text-xs text-neutral-400">
          Комментарий <span className="text-neutral-600">(необязательно)</span>
        </label>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Объясните причину или добавьте детали…"
          rows={3}
          maxLength={500}
          disabled={state === 'sending'}
          className="resize-none text-sm"
        />
        <p className="text-right text-xs text-neutral-600">{note.length}/500</p>
      </div>

      {state === 'error' && errorMsg && (
        <div className="flex items-start gap-2 rounded-xl border border-red-800/60 bg-red-950/30 p-3 text-sm text-red-400">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      <Button type="submit" disabled={state === 'sending'} className="w-full gap-2">
        {state === 'sending' ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Отправка…
          </>
        ) : (
          <>
            <Send className="h-4 w-4" />
            {submitLabel}
          </>
        )}
      </Button>
    </form>
  );
}

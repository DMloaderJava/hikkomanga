import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { submissions, type SubmissionStatus } from '@/data/submissions';
import { updateMetaTags, seoForRoute } from '@/lib/seo';
import { Header } from '@/components/layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CheckCircle, XCircle, Clock, Loader2, ExternalLink } from 'lucide-react';

/**
 * Публичная страница статуса заявки: /s/{token}.
 * Токен — единственный ключ доступа: payload заявки здесь не показывается
 * (edge get-submission его и не отдаёт), только статус и причина отказа.
 */

const STATUS_META: Record<
  string,
  { label: string; icon: typeof Clock; className: string; hint: string }
> = {
  pending: {
    label: 'На модерации',
    icon: Clock,
    className: 'text-amber-400',
    hint: 'Заявка в очереди у модератора. Обычно решение занимает несколько дней.',
  },
  approved: {
    label: 'Одобрена',
    icon: CheckCircle,
    className: 'text-green-400',
    hint: 'Тайтл создан как черновик и скоро появится в каталоге после наполнения главами.',
  },
  rejected: {
    label: 'Отклонена',
    icon: XCircle,
    className: 'text-red-400',
    hint: 'Заявка отклонена. Можно подать новую с исправлениями.',
  },
  spam: {
    label: 'Помечена как спам',
    icon: XCircle,
    className: 'text-red-400',
    hint: 'Заявка отклонена как спам.',
  },
};

function SubmissionPage() {
  const { token } = Route.useParams();

  const [status, setStatus] = useState<SubmissionStatus | null | 'loading'>('loading');
  const [withdrawState, setWithdrawState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [withdrawMessage, setWithdrawMessage] = useState('');

  const load = async () => {
    setStatus('loading');
    const result = await submissions.getSubmission(token);
    setStatus(result);
  };

  useEffect(() => {
    updateMetaTags(seoForRoute(Route.id));
  }, []);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Авто-вывод из 5-минутного окна withdraw, пока заявка pending
  const statusValue = status && status !== 'loading' ? status.status : null;
  useEffect(() => {
    if (statusValue !== 'pending') return;
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusValue]);

  const withinWindow = (s: SubmissionStatus) => {
    if (s.status !== 'pending' || !s.created_at) return false;
    return Date.now() - new Date(s.created_at).getTime() <= 5 * 60 * 1000;
  };

  const handleWithdraw = async () => {
    setWithdrawState('sending');
    const res = await submissions.withdrawSubmission(token);
    if (res.ok) {
      setWithdrawState('done');
      void load();
    } else {
      setWithdrawState('error');
      setWithdrawMessage(res.message ?? 'Не удалось отменить');
    }
  };

  return (
    <div className="min-h-screen bg-[#0f0a0c] text-neutral-100">
      <Header />
      <main className="mx-auto max-w-2xl px-4 py-12">
        {status === 'loading' ? (
          <div className="flex items-center justify-center gap-3 py-16 text-neutral-400">
            <Loader2 className="h-6 w-6 animate-spin" /> Проверяем…
          </div>
        ) : !status || typeof status === 'string' ? (
          <Card className="border-neutral-800 bg-neutral-900/60">
            <CardContent className="py-12 text-center">
              <p className="text-2xl mb-2">🔍</p>
              <h1 className="mb-2 text-lg font-semibold">Заявка не найдена</h1>
              <p className="text-sm text-neutral-400">
                Проверьте ссылку из подтверждения. Заявка также может быть отменена
                заявителем или удалена по истечении срока хранения.
              </p>
            </CardContent>
          </Card>
        ) : (
          (() => {
            const meta = STATUS_META[status.status] ?? STATUS_META.pending;
            const Icon = meta.icon;
            return (
              <Card className="border-neutral-800 bg-neutral-900/60">
                <CardHeader className="border-b border-neutral-800/70">
                  <CardTitle className="flex items-center gap-3 text-lg">
                    <Icon className={`h-6 w-6 ${meta.className}`} />
                    Статус заявки: <span className={meta.className}>{meta.label}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 pt-6">
                  <p className="text-sm text-neutral-300">{meta.hint}</p>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                    <dt className="text-neutral-500">Подана</dt>
                    <dd>{new Date(status.created_at).toLocaleString('ru-RU')}</dd>
                    {status.resolved_at && (
                      <>
                        <dt className="text-neutral-500">Решение</dt>
                        <dd>{new Date(status.resolved_at).toLocaleString('ru-RU')}</dd>
                      </>
                    )}
                    {status.reason && (
                      <>
                        <dt className="text-neutral-500">Причина</dt>
                        <dd className="text-neutral-300">{status.reason}</dd>
                      </>
                    )}
                  </dl>

                  {status.status === 'pending' && (
                    <div className="border-t border-neutral-800 pt-4">
                      {withinWindow(status) && withdrawState !== 'done' ? (
                        <div className="space-y-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleWithdraw}
                            disabled={withdrawState === 'sending'}
                          >
                            {withdrawState === 'sending' && (
                              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                            )}
                            Отменить заявку
                          </Button>
                          <p className="text-xs text-neutral-500">
                            Отменить можно в первые 5 минут после подачи.
                          </p>
                          {withdrawState === 'error' && (
                            <p className="text-xs text-red-400">{withdrawMessage}</p>
                          )}
                        </div>
                      ) : withdrawState === 'done' ? (
                        <p className="text-sm text-green-400">Заявка отменена.</p>
                      ) : null}
                    </div>
                  )}

                  {status.status === 'approved' && (
                    <a
                      href="/"
                      className="inline-flex items-center gap-1.5 text-sm text-rose-400 hover:text-rose-300"
                    >
                      В каталог <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </CardContent>
              </Card>
            );
          })()
        )}
      </main>
    </div>
  );
}

export const Route = createFileRoute('/s/$token')({
  component: SubmissionPage,
});

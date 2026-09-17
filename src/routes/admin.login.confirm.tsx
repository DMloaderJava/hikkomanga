import { useEffect, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { resolveLoginChallenge } from '@/data/notify';
import { auth } from '@/data/auth';
import { Button } from '@/components/ui/button';
import {
  CheckCircle2,
  XCircle,
  Loader2,
  AlertCircle,
  Shield,
} from 'lucide-react';
import { updateMetaTags } from '@/lib/seo';

export const Route = createFileRoute('/admin/login/confirm')({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' ? search.token : '',
    action:
      search.action === 'approve' || search.action === 'deny'
        ? (search.action as 'approve' | 'deny')
        : ('approve' as const),
  }),
  component: AdminLoginConfirmPage,
});

type View =
  | { kind: 'loading' }
  | { kind: 'ok'; status: string; action: 'approve' | 'deny' }
  | { kind: 'err'; message: string };

function statusMessage(status: string, action: 'approve' | 'deny'): {
  title: string;
  body: string;
  ok: boolean;
} {
  switch (status) {
    case 'approved':
      return {
        title: 'Вход подтверждён',
        body: 'Можно вернуться на устройство, с которого входили — админ-панель откроется сама.',
        ok: true,
      };
    case 'already_approved':
      return {
        title: 'Уже подтверждено',
        body: 'Этот вход уже был подтверждён ранее.',
        ok: true,
      };
    case 'denied':
      return {
        title: 'Вход отклонён',
        body: 'Сессия на том устройстве закроется в течение нескольких секунд (polling). Если это были не вы — смените пароль администратора.',
        ok: false,
      };
    case 'already_denied':
      return {
        title: 'Уже отклонено',
        body: 'Этот вход уже был отклонён ранее.',
        ok: false,
      };
    case 'expired':
      return {
        title: 'Ссылка устарела',
        body: 'Срок действия подтверждения — 15 минут. Нужно войти заново и подтвердить новое письмо.',
        ok: false,
      };
    case 'not_found':
      return {
        title: 'Ссылка недействительна',
        body: 'Challenge не найден. Возможно, письмо устарело или токен повреждён.',
        ok: false,
      };
    default:
      return {
        title: action === 'approve' ? 'Не удалось подтвердить' : 'Не удалось отклонить',
        body: `Статус: ${status}`,
        ok: false,
      };
  }
}

function AdminLoginConfirmPage() {
  const { token, action } = Route.useSearch();
  const [view, setView] = useState<View>({ kind: 'loading' });

  useEffect(() => {
    updateMetaTags({ title: 'Подтверждение входа', noindex: true });

    let cancelled = false;
    (async () => {
      if (!token) {
        if (!cancelled) {
          setView({ kind: 'err', message: 'В ссылке нет токена подтверждения.' });
        }
        return;
      }
      const result = await resolveLoginChallenge(token, action);
      if (cancelled) return;
      if (!result.ok && result.status === 'error') {
        setView({
          kind: 'err',
          message: result.error || 'Ошибка при обработке подтверждения',
        });
        return;
      }
      // Если deny — на этом же устройстве (если сессия есть) сразу выходим.
      if (result.status === 'denied' || result.status === 'already_denied') {
        try {
          await auth.signOut();
        } catch {
          // ignore
        }
      }
      setView({ kind: 'ok', status: result.status, action });
    })();

    return () => {
      cancelled = true;
    };
  }, [token, action]);

  if (view.kind === 'loading') {
    return (
      <Shell>
        <Loader2 className="h-8 w-8 animate-spin text-rose-500 mx-auto" />
        <p className="text-sm text-neutral-400 text-center mt-4">
          Обрабатываем подтверждение…
        </p>
      </Shell>
    );
  }

  if (view.kind === 'err') {
    return (
      <Shell>
        <IconBox tone="bad">
          <AlertCircle className="h-6 w-6" />
        </IconBox>
        <h1 className="text-xl font-bold text-white text-center">Ошибка</h1>
        <p className="text-sm text-neutral-400 text-center">{view.message}</p>
        <div className="pt-2">
          <Link to="/admin/login">
            <Button className="w-full">К форме входа</Button>
          </Link>
        </div>
      </Shell>
    );
  }

  const msg = statusMessage(view.status, view.action);
  return (
    <Shell>
      <IconBox tone={msg.ok ? 'good' : 'bad'}>
        {msg.ok ? (
          <CheckCircle2 className="h-6 w-6" />
        ) : (
          <XCircle className="h-6 w-6" />
        )}
      </IconBox>
      <h1 className="text-xl font-bold text-white text-center">{msg.title}</h1>
      <p className="text-sm text-neutral-400 text-center leading-relaxed">{msg.body}</p>
      <div className="pt-2 flex flex-col gap-2">
        {msg.ok ? (
          <Link to="/admin">
            <Button className="w-full gap-2">
              <Shield className="h-4 w-4" />
              Открыть админ-панель
            </Button>
          </Link>
        ) : null}
        <Link to="/admin/login">
          <Button
            variant="outline"
            className="w-full border-neutral-700 text-neutral-300"
          >
            К форме входа
          </Button>
        </Link>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-neutral-800 bg-neutral-900/80 p-8 shadow-2xl backdrop-blur-xl">
        {children}
      </div>
    </div>
  );
}

function IconBox({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: 'good' | 'bad';
}) {
  return (
    <div
      className={`mx-auto flex h-12 w-12 items-center justify-center rounded-2xl text-white shadow-lg ${
        tone === 'good'
          ? 'bg-emerald-600 shadow-emerald-600/30'
          : 'bg-red-600 shadow-red-600/30'
      }`}
    >
      {children}
    </div>
  );
}

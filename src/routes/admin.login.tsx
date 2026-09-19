import { useState, useEffect, useCallback } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { auth } from '@/data/auth';
import { subscribeLoginChallenge, type LoginChallengeStatus } from '@/data/notify';
import {
  loginChallengeUx,
  WAIT_HINT,
  type LoginPhase,
} from '@/lib/loginChallenge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Shield,
  KeyRound,
  AlertCircle,
  Mail,
  Loader2,
  CheckCircle2,
  ExternalLink,
} from 'lucide-react';
import { updateMetaTags } from '@/lib/seo';
import type { LoginNotifyResult } from '@/data/notify';

export const Route = createFileRoute('/admin/login')({
  component: AdminLoginPage,
});

type Phase = LoginPhase;

/** Подсказка владельцу по виду сбоя письма (см. LoginNotifyErrorKind). */
const OWNER_HINTS: Record<string, string> = {
  'demo-build':
    '1) Задайте переменные сборки VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY (или ' +
    'VITE_SUPABASE_PUBLISHABLE_KEY) и пересоберите сайт. ' +
    '2) Затем секреты + деплой функций: `node scripts/setup-login-guard.mjs --help` ' +
    '(SETUP_SUPABASE.md, раздел 6).',
  'fn-not-deployed':
    'Задеплойте функции (нужны обе):\n' +
    '  supabase functions deploy login-notify --project-ref <ref>\n' +
    '  supabase functions deploy login-confirm --project-ref <ref>\n' +
    'или выполните `node scripts/setup-login-guard.mjs ...` (SETUP_SUPABASE.md, раздел 6).',
  'secrets-missing':
    'Задайте секреты проекта:\n' +
    '  supabase secrets set OWNER_NOTIFY_EMAIL=you@domain.tld RESEND_API_KEY=re_xxx --project-ref <ref>\n' +
    'Ключ Resend: resend.com → API Keys. Или `node scripts/setup-login-guard.mjs ...`',
  resend:
    'Проверьте ключ и отправителя в секретах. Важно: отправитель по умолчанию ' +
    'onboarding@resend.dev доставляет письма ТОЛЬКО на адрес аккаунта Resend. ' +
    'Для другого OWNER_NOTIFY_EMAIL подтвердите домен в Resend и задайте секрет ' +
    'OWNER_NOTIFY_FROM.',
  network:
    'Похоже на сетевой сбой (нет связи с Supabase, блокировщик/файрвол). ' +
    'Попробуйте войти ещё раз с другого соединения.',
  other:
    'Нужно настроить сервис подтверждения: секреты OWNER_NOTIFY_EMAIL + ' +
    'RESEND_API_KEY и деплой Edge Functions login-notify/login-confirm ' +
    '(SETUP_SUPABASE.md, раздел 6). Без письма подтверждения вход в админку закрыт.',
};

function AdminLoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('form');
  const [notify, setNotify] = useState<LoginNotifyResult | null>(null);
  const [pollHint, setPollHint] = useState(WAIT_HINT);

  const navigate = useNavigate();

  const goAdminIfReady = useCallback(async () => {
    const s = await auth.getSession();
    if (!s) return false;
    // hasRole уже требует approved challenge
    const isAdmin = await auth.hasRole(s.user.id, 'admin');
    if (isAdmin) {
      navigate({ to: '/admin' });
      return true;
    }
    return false;
  }, [navigate]);

  /**
   * Единая обработка статуса challenge: первичная проверка, polling и события
   * localStorage идут через неё, иначе ветки расходятся и экран ожидания
   * «залипает» на waiting при уже подтверждённом входе.
   *
   * `allowErrorScreen` — показывать ли экран «Сервис недоступен». При загрузке
   * страницы да; во время ожидания нет: один мигающий сбой RPC не должен
   * останавливать polling и требовать повторного входа.
   */
  const applyChallengeStatus = useCallback(
    async (status: LoginChallengeStatus, opts?: { allowErrorScreen?: boolean }) => {
      const ux = loginChallengeUx(status);

      if (ux.serviceError && !opts?.allowErrorScreen) {
        if (ux.hint) setPollHint(ux.hint);
        return;
      }

      if (ux.phase) setPhase(ux.phase);
      if (ux.hint) setPollHint(ux.hint);
      if (ux.serviceError) {
        setError(
          'Сервис подтверждения входа временно недоступен. Попробуйте позже или обратитесь к владельцу.'
        );
      }
      if (ux.signOut) {
        // denied/expired: сессия не должна пережить отказ.
        await auth.signOut();
      }
      if (ux.openAdmin) {
        // Локальный approved ≠ доступ: hasRole ещё раз спрашивает сервер.
        await goAdminIfReady();
      }
    },
    [goAdminIfReady]
  );

  // Если уже подтверждён — сразу в админку. Если challenge pending — экран ожидания.
  useEffect(() => {
    updateMetaTags({ title: 'Вход в админ-панель', noindex: true });
    let cancelled = false;

    (async () => {
      const s = await auth.getSession();
      if (!s || cancelled) return;

      const ready = await goAdminIfReady();
      if (ready || cancelled) return;

      const status = await auth.getLoginChallengeStatus();
      if (cancelled) return;
      // status none/approved уже обработан выше; иначе остаёмся на форме
      await applyChallengeStatus(status, { allowErrorScreen: true });
    })();

    return () => {
      cancelled = true;
    };
  }, [goAdminIfReady, applyChallengeStatus]);

  /**
   * Реакция на статус в localStorage — главный фикс «залипшего» экрана ожидания.
   *
   * Approve/deny пишут `manga_login_challenge` (в т.ч. соседняя вкладка, где
   * открыли ссылку из письма), а `storage` в текущую вкладку не приходит и
   * polling может вернуть устаревший серверный `pending`. Подписка закрывает
   * обе дыры: phase обновляется сразу по факту смены статуса.
   */
  useEffect(() => {
    if (phase !== 'waiting') return;
    let stopped = false;

    const unsubscribe = subscribeLoginChallenge((challenge) => {
      // null = запись удалена (signOut/новая сессия): ждать нечего, но и
      // перебивать уже показанный denied/expired нельзя — статуса нет.
      if (stopped || !challenge?.status) return;
      void applyChallengeStatus(challenge.status);
    });

    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [phase, applyChallengeStatus]);

  // Polling статуса challenge, пока ждём письмо: единственный путь для
  // подтверждения с ДРУГОГО устройства (серверный RPC), плюс страховка на
  // случай, когда событие localStorage не пришло.
  useEffect(() => {
    if (phase !== 'waiting') return;

    let stopped = false;
    const tick = async () => {
      const status = await auth.getLoginChallengeStatus();
      if (stopped) return;
      await applyChallengeStatus(status);
    };

    void tick();
    const id = window.setInterval(() => void tick(), 2500);

    // Возврат к вкладке: письмо могли подтвердить на телефоне, не ждём тика.
    const onFocus = () => {
      if (document.visibilityState && document.visibilityState !== 'visible') return;
      void tick();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);

    return () => {
      stopped = true;
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [phase, applyChallengeStatus]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotify(null);
    setLoading(true);

    try {
      const result = await auth.signIn(email, password);
      if (result.error) {
        // Login Guard / Resend не настроен — подсказка для админа (не владельца)
        // с точным чек-листом для владельца по виду сбоя.
        const raw = result.error.message || '';
        const kind = result.notify?.errorKind;
        let hint = kind ? OWNER_HINTS[kind] : undefined;
        if (!hint) {
          const isNotifyFail =
            /письмо подтверждения|login-notify|RESEND|OWNER_NOTIFY|сервис подтверждения/i.test(
              raw
            );
          if (isNotifyFail) hint = OWNER_HINTS.other;
        }
        setError(hint ? `${raw}\n\nОбратитесь к владельцу сайта. ${hint}` : raw);
        setPhase('form');
      } else if (result.pendingConfirmation) {
        setNotify(result.notify ?? null);
        setPhase('waiting');
      } else if (result.data.session) {
        // На всякий случай: если когда-нибудь confirmation отключат.
        navigate({ to: '/admin' });
      }
    } catch (err: any) {
      setError(err.message || 'Ошибка входа');
    } finally {
      setLoading(false);
    }
  };

  const handleCancelWait = async () => {
    await auth.signOut();
    setPhase('form');
    setNotify(null);
    setPassword('');
    setError(null);
  };

  const handleRetry = async () => {
    await auth.signOut();
    setPhase('form');
    setNotify(null);
    setError(null);
  };

  return (
    <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-8 rounded-2xl border border-neutral-800 bg-neutral-900/80 p-8 shadow-2xl backdrop-blur-xl">
        <div className="text-center space-y-2">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-600 text-white shadow-lg shadow-rose-600/30">
            {phase === 'waiting' ? (
              <Mail className="h-6 w-6" />
            ) : phase === 'denied' ||
              phase === 'expired' ||
              phase === 'service_error' ? (
              <AlertCircle className="h-6 w-6" />
            ) : (
              <Shield className="h-6 w-6" />
            )}
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            {phase === 'waiting'
              ? 'Подтвердите вход'
              : phase === 'denied'
                ? 'Вход отклонён'
                : phase === 'expired'
                  ? 'Срок истёк'
                  : phase === 'service_error'
                    ? 'Сервис недоступен'
                    : 'Админ-панель'}
          </h1>
          <p className="text-xs text-neutral-400">
            {phase === 'waiting'
              ? 'Письмо отправлено владельцу. Без подтверждения вход не откроется.'
              : phase === 'denied'
                ? 'Владелец отклонил этот вход. Сессия завершена.'
                : phase === 'expired'
                  ? 'Ссылка подтверждения истекла (15 минут). Войдите снова.'
                  : phase === 'service_error'
                    ? 'Не удалось проверить статус подтверждения. Попробуйте позже.'
                    : 'Введите учетные данные администратора'}
          </p>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-red-800/80 bg-red-950/40 p-3 text-xs text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span className="whitespace-pre-line leading-relaxed">{error}</span>
          </div>
        )}

        {phase === 'waiting' && (
          <div className="space-y-4">
            <div className="rounded-xl border border-amber-800/60 bg-amber-950/30 p-4 text-sm text-amber-100/90 space-y-2">
              <div className="flex items-start gap-2">
                <Loader2 className="h-4 w-4 shrink-0 mt-0.5 animate-spin text-amber-400" />
                <div>
                  <p className="font-medium text-amber-200">{pollHint}</p>
                  <p className="text-xs text-amber-200/70 mt-1 leading-relaxed">
                    Откройте почту владельца (OWNER_NOTIFY_EMAIL) и
                    нажмите «Подтвердить — это я». Страница обновится автоматически.
                  </p>
                </div>
              </div>
            </div>

            {notify?.emulated && notify.preview?.approveUrl && (
              <div className="rounded-xl border border-neutral-700 bg-neutral-950/60 p-4 space-y-3">
                <p className="text-xs text-neutral-400">
                  Dev-режим без Resend: письмо эмулировано. Подтвердите вручную:
                </p>
                <div className="flex flex-col gap-2">
                  <a
                    href={notify.preview.approveUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-semibold px-3 py-2"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    Подтвердить (dev)
                    <ExternalLink className="h-3.5 w-3.5 opacity-70" />
                  </a>
                  {notify.preview.denyUrl && (
                    <a
                      href={notify.preview.denyUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center gap-2 rounded-lg bg-red-900/80 hover:bg-red-800 text-red-100 text-sm font-semibold px-3 py-2"
                    >
                      Отклонить (dev)
                    </a>
                  )}
                </div>
              </div>
            )}

            <Button
              type="button"
              variant="outline"
              onClick={handleCancelWait}
              className="w-full border-neutral-700 text-neutral-300"
            >
              Отменить вход
            </Button>
          </div>
        )}

        {(phase === 'denied' ||
          phase === 'expired' ||
          phase === 'service_error') && (
          <Button type="button" onClick={handleRetry} className="w-full gap-2">
            <KeyRound className="h-4 w-4" />
            Войти заново
          </Button>
        )}

        {phase === 'form' && (
          <form onSubmit={handleLogin} className="space-y-4" autoComplete="on">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="username"
                placeholder="admin@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="mt-1.5"
              />
            </div>

            <div>
              <Label htmlFor="password">Пароль</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="mt-1.5"
              />
            </div>

            <Button type="submit" disabled={loading} className="w-full gap-2">
              <KeyRound className="h-4 w-4" />
              {loading ? 'Отправка подтверждения…' : 'Войти'}
            </Button>

            <p className="text-[11px] text-neutral-500 text-center leading-relaxed">
              После верного пароля на почту владельца уйдёт письмо. Пока его не
              подтвердят — доступа к админке нет.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}

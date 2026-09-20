import { useEffect, useRef, useState } from 'react';

/**
 * Обёртка капчи: Turnstile (по умолчанию) или hCaptcha — выбор через
 * VITE_CAPTCHA_PROVIDER, замена провайдера не требует правок кода
 * (см. SETUP_SUPABASE.md, «Приём заявок»).
 *
 * Скрипт провайдера грузится лениво из виджета (не из index.html), чтобы
 * анонимная капча не попадала в initial-бюджет каталога.
 */
const PROVIDER = (import.meta.env.VITE_CAPTCHA_PROVIDER as string | undefined) ?? 'turnstile';
const SITE_KEY =
  PROVIDER === 'hcaptcha'
    ? (import.meta.env.VITE_HCAPTCHA_SITE_KEY as string | undefined) ?? ''
    : (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? '';

const SCRIPT_SRC =
  PROVIDER === 'hcaptcha'
    ? 'https://js.hcaptcha.com/1/api.js'
    : 'https://challenges.cloudflare.com/turnstile/v0/api.js';

// ── Минимальные типы провайдеров ─────────────────────────────────────────────
interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback'?: () => void;
      theme?: 'dark' | 'light' | 'auto';
    }
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
}
interface HCaptchaApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback': () => void;
      theme?: 'dark' | 'light';
    }
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
}

function getApi(): TurnstileApi | HCaptchaApi | null {
  const w = window as unknown as Record<string, unknown>;
  if (PROVIDER === 'hcaptcha') return (w.hcaptcha as HCaptchaApi) ?? null;
  return (w.turnstile as TurnstileApi) ?? null;
}

interface CaptchaWidgetProps {
  /** Токен прошёл проверку пользователем. */
  onVerify: (token: string) => void;
  /** Токен истёк — форма не сабмитится, пока не решит заново. */
  onExpire?: () => void;
}

export function CaptchaWidget({ onVerify, onExpire }: CaptchaWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!SITE_KEY) {
      // Ключ не настроен: честно показываем, а не тихо блокируем сабмит.
      setFailed(true);
      return;
    }

    let cancelled = false;

    const render = () => {
      if (cancelled || !containerRef.current) return;
      const api = getApi();
      if (!api) return;
      const opts = {
        sitekey: SITE_KEY,
        callback: (token: string) => onVerify(token),
        'expired-callback': () => onExpire?.(),
        theme: 'dark' as const,
      };
      widgetIdRef.current = api.render(containerRef.current, opts);
    };

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SCRIPT_SRC}"]`
    );
    if (getApi()) {
      render();
    } else if (existing) {
      existing.addEventListener('load', render, { once: true });
    } else {
      const script = document.createElement('script');
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.addEventListener('load', render, { once: true });
      script.addEventListener('error', () => setFailed(true), { once: true });
      document.head.appendChild(script);
    }

    return () => {
      cancelled = true;
      const api = getApi();
      if (api && widgetIdRef.current) {
        try {
          api.remove(widgetIdRef.current);
        } catch {
          // контейнер уже размонтирован
        }
      }
      widgetIdRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!SITE_KEY) {
    return (
      <div className="rounded-lg border border-amber-800/60 bg-amber-950/30 p-3 text-xs text-amber-300">
        Капча не настроена (VITE_TURNSTILE_SITE_KEY / VITE_HCAPTCHA_SITE_KEY).
        Отправка заявок недоступна — обратитесь к администратору сайта.
      </div>
    );
  }

  return (
    <div>
      <div ref={containerRef} />
      {failed && (
        <div className="rounded-lg border border-red-800/60 bg-red-950/30 p-3 text-xs text-red-400">
          Не удалось загрузить капчу. Проверьте сеть (CSP допускает{' '}
          {PROVIDER === 'hcaptcha' ? 'js.hcaptcha.com' : 'challenges.cloudflare.com'}) и обновите страницу.
        </div>
      )}
    </div>
  );
}
